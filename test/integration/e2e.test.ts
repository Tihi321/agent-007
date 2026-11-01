/**
 * S6.2 / S8 end-to-end tests, offline: the real startup sequence, the real Harness on a temp SQLite file, the real
 * `a7` extension (tools, sections, approval gate), the real Telegram bridge, the real PowerShell shell runner, a FAKE
 * OpenAI-compatible runner (with scripted tool calls) and a FAKE Telegram API. Live runners and a real Telegram are
 * covered by the manual steps in `phase1-acceptance.md`.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ALWAYS_LOADED } from "../../src/jobs/contracts.js";
import { startFakeOpenAi } from "../helpers/fakeOpenAi.js";
import { sleep } from "../telegram/helpers/fakeTelegram.js";
import { E2e, LM_TOKEN, MODEL_ID, e2eBehavior, readLogs, waitFor } from "./rig.js";

async function withRig(fn: (rig: E2e) => Promise<void>, o: Parameters<typeof E2e.open>[0] = {}): Promise<void> {
  const rig = await E2e.open(o);
  try {
    await fn(rig);
  } finally {
    await rig.close();
    rmSync(rig.dirs.root, { recursive: true, force: true });
  }
}

const events = (rig: E2e, name: string) => rig.audit().filter((e) => e["event"] === name);

test("e2e: a question gets an answer, and the runner saw the bearer token and the 10 always-loaded tools", async () => {
  await withRig(async (rig) => {
    await rig.say("what is up", 1);
    await rig.seen((t) => t === "echo: what is up", "the answer");
    const req = rig.fake.chatRequests()[0];
    assert.equal(req?.authorization, `Bearer ${LM_TOKEN}`);
    assert.deepEqual([...rig.toolNamesOfLastRequest()].sort(), [...ALWAYS_LOADED].sort());
    assert.match(rig.lastSystemPrompt(), /The user likes tea\./, "USER.md is in the prompt");
    assert.match(rig.lastSystemPrompt(), /Model: fake-model/);
    assert.match(rig.lastSystemPrompt(), /Allowed folder aliases: notes, workspace/);
    assert.equal(rig.agent.health.status().up, true, "the health monitor started and sees the runner");
  });
});

test("e2e: message -> tool call -> approval -> shell -> answer (whoami runs as the current user, fully audited)", async () => {
  await withRig(async (rig) => {
    await rig.say("please run whoami", 11);
    const card = await rig.card(1);
    assert.match(card.text, /^Approve shell command\?/);
    assert.match(card.text, /\nwhoami\n/);
    assert.equal(events(rig, "started").length, 0, "nothing runs before the tap");

    await rig.tap(card.approve);
    const answer = await rig.seen((t) => t.startsWith("After the tool:"), "the answer after the shell ran");
    const me = userInfo().username.toLowerCase();
    assert.ok(answer.toLowerCase().includes(me), `whoami output names ${me}: ${answer}`);
    assert.match(answer, /Exit code: 0/);
    assert.match(answer, /<untrusted_content source="shell">/);

    const requested = events(rig, "requested");
    const decided = events(rig, "decided");
    const started = events(rig, "started");
    const finished = events(rig, "finished");
    assert.equal(requested.length, 1);
    assert.equal(decided.length, 1);
    assert.equal(started.length, 1);
    assert.equal(finished.length, 1);
    assert.equal(decided[0]?.["approved"], true);
    assert.equal(decided[0]?.["by"], "user");
    assert.equal(decided[0]?.["userId"], 4242);
    assert.equal(new Set([requested[0]?.["id"], decided[0]?.["id"], started[0]?.["id"], finished[0]?.["id"]]).size, 1, "one id ties the four lines together");
    assert.equal(finished[0]?.["exitCode"], 0);
    assert.ok(readdirOutput(rig), "the full output was saved under workspace\\shell-output");
    await rig.agent.bridge.delivery()!.idle();
  });
});

function readdirOutput(rig: E2e): boolean {
  return existsSync(join(rig.dirs.data, "workspace", "shell-output"));
}

test("e2e: Deny blocks the command; the model is told, nothing runs", async () => {
  await withRig(async (rig) => {
    await rig.say("please run whoami", 21);
    const card = await rig.card(1);
    await rig.tap(card.deny);
    const answer = await rig.seen((t) => t.startsWith("After the tool:"), "the answer after the denial");
    assert.match(answer, /The user denied this shell command/);
    assert.equal(events(rig, "started").length, 0);
    const decided = events(rig, "decided");
    assert.equal(decided.length, 1);
    assert.equal(decided[0]?.["approved"], false);
    assert.equal(decided[0]?.["by"], "user");
    assert.ok(rig.texts().some((t) => t.startsWith("Denied.")), "the card was edited to the outcome");
  });
});

test("e2e: after /new a shell request is still gated (the hook is in the host default)", async () => {
  await withRig(async (rig) => {
    await rig.say("please run whoami", 31);
    await rig.tap((await rig.card(1)).approve);
    await rig.seen((t) => t.startsWith("After the tool:"), "first answer");
    await rig.agent.bridge.delivery()!.idle();

    await rig.say("/new", 32);
    await rig.seen((t) => t === "Started a new conversation.", "the /new reply");
    await rig.say("please run whoami", 33);
    const second = await rig.card(2);
    assert.notEqual(second.approve, (await rig.card(1)).approve);
    assert.equal(events(rig, "started").length, 1, "the second command has not run");
    await rig.tap(second.deny);
    await waitFor(() => rig.texts().filter((t) => t.startsWith("After the tool:")).length >= 2, 15_000, "second answer");
    assert.equal(events(rig, "started").length, 1, "still only the first command ran");
    assert.equal(events(rig, "requested").length, 2);
  });
});

test("e2e: /stop while an approval is pending cancels the card and tells the model", async () => {
  await withRig(async (rig) => {
    await rig.say("please run whoami", 41);
    await rig.card(1);
    await rig.say("/stop", 42);
    await rig.seen((t) => t.startsWith("Cancelled (/stop)."), "the card edit");
    await waitFor(() => events(rig, "decided").length === 1, 10_000, "the decided audit line");
    assert.equal(events(rig, "decided")[0]?.["by"], "stop");
    assert.equal(events(rig, "started").length, 0);
  });
});

test("e2e: the kill switch cancels the pending card, blocks the next shell request at once, and survives in the flag file", async () => {
  await withRig(async (rig) => {
    await rig.say("please run whoami", 51);
    await rig.card(1);
    await rig.say("/killshell", 52);
    await rig.seen((t) => t.startsWith("Shell disabled. Re-enable locally by deleting"), "the /killshell reply");
    await rig.seen((t) => t.startsWith("Cancelled (kill switch)."), "the card edit");
    await rig.seen((t) => t.startsWith("After the tool:") && /Shell is disabled/.test(t), "the model was told shell is disabled");
    assert.equal(events(rig, "started").length, 0);
    assert.equal(rig.agent.killSwitch.isOn(), true);
    const flag = rig.agent.killSwitch.flagPath;
    assert.ok(existsSync(flag), "the flag file exists in the control dir");

    // The next shell request: no card, a blocked audit line, a "disabled" answer.
    const cardsBefore = rig.cards().length;
    await rig.say("please run whoami", 53);
    await waitFor(() => rig.texts().filter((t) => t.startsWith("After the tool:")).length >= 2, 15_000, "the second answer");
    assert.equal(rig.cards().length, cardsBefore, "no approval card for a disabled shell");
    assert.ok(events(rig, "blocked").some((e) => e["reason"] === "killswitch" && e["command"] === "whoami"), "a blocked audit line for the command");

    await rig.say("/status", 54);
    await rig.seen((t) => /^Runner: LM Studio/.test(t) && /Shell: disabled \(kill switch is on/.test(t), "/status shows shell disabled");

    // Re-enabling is local only: a restart with the flag file in place keeps shell off.
    await rig.agent.bridge.delivery()!.idle();
    await rig.restart();
    assert.equal(rig.agent.killSwitch.isOn(), true, "the flag file keeps the kill switch on after a restart");
  });
});

test("e2e: restart mid-turn -> resume -> a new approval card with the SAME deadline, old buttons expired, answer delivered once", async () => {
  await withRig(async (rig) => {
    await rig.say("please run whoami", 61);
    const oldCard = await rig.card(1);
    const firstTg = rig.tg;
    const deadline = rig.audit().find((e) => e["event"] === "requested")?.["deadline"];
    assert.equal(typeof deadline, "number");

    await rig.stop(); // the process ends between "approval requested" and "decided"
    await rig.start(); // the next process: open, resume, attach, start

    const newCard = await rig.card(1);
    assert.notEqual(newCard.approve, oldCard.approve, "a new card with new button ids");
    const requested = rig.audit().filter((e) => e["event"] === "requested");
    assert.equal(requested.length, 2, "the gate asked again after the restart");
    assert.equal(requested[1]?.["deadline"], deadline, "the deadline survived the restart");
    assert.equal(rig.audit().filter((e) => e["event"] === "decided").length, 0, "nothing was decided by the restart");

    // The old card's button answers "expired" and cannot approve anything.
    await rig.tap(oldCard.approve);
    assert.ok(
      rig.tg.of("answerCallbackQuery").some((c) => String(c.payload["text"]).startsWith("Expired")),
      "the old button answers Expired",
    );
    assert.equal(rig.audit().filter((e) => e["event"] === "started").length, 0);

    await rig.tap(newCard.approve);
    await rig.seen((t) => t.startsWith("After the tool:"), "the answer after the restart");
    await rig.agent.bridge.delivery()!.idle();
    const allTexts = [...firstTg.messageTexts(), ...rig.tg.messageTexts()].map((m) => m.text);
    assert.equal(allTexts.filter((t) => t.startsWith("After the tool:")).length, 1, "the answer arrived exactly once");
    assert.equal(rig.audit().filter((e) => e["event"] === "started").length, 1, "the command ran once");
  });
});

test("e2e: a pending answer is delivered after a restart without re-running the model", async () => {
  await withRig(async (rig) => {
    const original = rig.tg;
    original.failNext("sendMessage", { kind: "network" }, Infinity);
    original.failNext("editMessageText", { kind: "network" }, Infinity);
    await rig.say("tell me a thing", 71);
    await waitFor(() => readLogs(rig.dirs).some((l) => l["event"] === "telegram.delivery_failed"), 15_000, "a failed delivery");
    await rig.agent.bridge.delivery()!.idle();
    assert.equal(original.sentTexts(4242).length, 0, "nothing reached the user in the first life");
    await rig.restart(); // a new Telegram fake that works
    await waitFor(() => rig.texts().some((t) => t === "echo: tell me a thing"), 15_000, "the delivery after restart");
    assert.equal(rig.fake.chatRequests().length, 1, "the model did not run again");
  });
});

test("e2e: remember writes MEMORY.md, the notifier fires once, and a new conversation sees the fact", async () => {
  await withRig(async (rig) => {
    await rig.say("please remember tea", 81);
    await rig.seen((t) => t.startsWith("After the tool:"), "the answer after remember");
    await rig.agent.bridge.delivery()!.idle();
    const memory = readFileSync(join(rig.dirs.data, "memory", "MEMORY.md"), "utf8");
    assert.match(memory, /^- \d{4}-\d{2}-\d{2}: The user's favourite drink is tea\.$/m);
    const saved = rig.tg.sentTexts(4242).filter((t) => t === "Saved to memory: The user's favourite drink is tea.");
    assert.equal(saved.length, 1, "the chat got exactly one 'Saved to memory' notice");

    await rig.say("/new", 82);
    await rig.seen((t) => t === "Started a new conversation.", "the /new reply");
    await rig.say("what do you know", 83);
    await rig.seen((t) => t === "echo: what do you know", "the answer in the new conversation");
    assert.match(rig.lastSystemPrompt(), /favourite drink is tea/, "MEMORY.md is in the prompt after /new");
  });
});

test("e2e: folder tools work through the extension: list an allowed folder, write then read back from the workspace, refuse a path outside", async () => {
  await withRig(async (rig) => {
    await rig.say("list notes", 91);
    const listed = await rig.seen((t) => t.startsWith("After the tool:") && /a\.txt/.test(t), "the listing");
    assert.match(listed, /<untrusted_content/);

    await rig.say("write hello", 92);
    await rig.seen((t) => t.startsWith("After the tool:") && /hello from the agent/.test(t), "the read-back of what write_file wrote");
    assert.equal(readFileSync(join(rig.dirs.data, "workspace", "hello.txt"), "utf8"), "hello from the agent");

    await rig.say("read secrets", 93);
    await rig.seen((t) => t.startsWith("After the tool:") && /access denied|not inside an allowed folder/.test(t), "the refusal");
  });
});

test("e2e: runner offline -> one 'model offline' notice and the message queued -> recovery -> the answer arrives", async () => {
  const fake = await startFakeOpenAi({ behavior: e2eBehavior, modelId: MODEL_ID, requireKey: LM_TOKEN });
  const port = fake.port;
  let revived: Awaited<ReturnType<typeof startFakeOpenAi>> | undefined;
  await withRig(
    async (rig) => {
      await waitFor(() => rig.agent.health.status().up, 10_000, "health up");
      await fake.close();
      const down = await rig.agent.health.check();
      assert.equal(down.up, false, "the monitor sees the runner go down");

      await rig.say("hello while offline", 101);
      await rig.seen((t) => /^The model is offline \(LM Studio not running\)\. Your message is queued/.test(t), "the offline notice");
      await rig.say("and another one", 102);
      await sleep(300);
      assert.equal(rig.texts().filter((t) => t.startsWith("The model is offline")).length, 1, "one notice per outage, no spam");
      assert.equal(rig.texts().some((t) => t.startsWith("echo:")), false, "nothing is answered while the runner is down");

      revived = await startFakeOpenAi({ port, behavior: e2eBehavior, modelId: MODEL_ID, requireKey: LM_TOKEN });
      const up = await rig.agent.health.check();
      assert.equal(up.up, true, "the monitor sees the runner come back");
      await rig.seen((t) => t === "echo: hello while offline", "the first queued answer", 30_000);
      await rig.seen((t) => t === "echo: and another one", "the second queued answer", 30_000);
      const errors = readLogs(rig.dirs).filter((l) => l["level"] === "error" && l["event"] === "agent.fatal");
      assert.equal(errors.length, 0);
    },
    { fake },
  );
  await revived?.close();
});
