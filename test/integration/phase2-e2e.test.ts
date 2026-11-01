/**
 * S15 end to end, offline: the REAL Harness on SQLite, the real startup sequence, the fake OpenAI server issuing
 * `dispatch_job`, a REAL job runner process over the HMAC IPC on loopback (production `startJobRunner`, the production
 * Claude driver around the fake `claude` script of test/jobrunner/claude) and a fake Telegram. Nothing contacts Telegram,
 * creative-hub or the real `claude`.
 *
 * Covered: approve card -> job runs -> progress -> final message -> the result goes back to the model (wrapped); a
 * permission prompt and an agent restart mid-job (the job is re-attached to and finishes, one submit); cancel (no process left);
 * a Flow tool call with no approved Flow job is blocked and never reaches the server; the always-loaded cap against the real
 * registry; /status; the second-opinion tool is not registered.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ALWAYS_LOADED, checkToolCap } from "../../src/jobs/contracts.js";
import type { Behavior, Reply } from "../helpers/fakeOpenAi.js";
import { FakeMcpServer } from "../mcp/fakeMcpServer.js";
import { Phase2Rig, isAlive, jobIdFromHistory, sleep, waitFor } from "./phase2-rig.js";
import type { Phase2RigOptions } from "./phase2-rig.js";

const text = (t: string): Reply => ({ type: "text", text: t });
const call = (name: string, args: unknown): Reply => ({ type: "tool_calls", calls: [{ name, args }] });

/** The scripted model of these tests: it routes by keyword and reports what the tools told it. */
const behavior: Behavior = (i) => {
  const { lastUser, afterTool, lastToolText } = i;
  if (/^\[agent-007 notice/.test(lastUser)) return text(`Job outcome relayed: ${/ended: (\w+)/.exec(lastUser)?.[1] ?? "?"}`);
  if (/cancel it/i.test(lastUser)) {
    if (afterTool) return text(`Cancel requested: ${lastToolText.slice(0, 60)}`);
    return call("cancel_job", { jobId: jobIdFromHistory(i) ?? "job-unknown" });
  }
  if (/flow clip/i.test(lastUser)) {
    if (afterTool) return text(`Flow said: ${lastToolText}`);
    return call("mcp__flow-music-mcp__generate_clip", { prompt: "a cat", max_credits: 5 });
  }
  if (/make a loop/i.test(lastUser)) {
    if (afterTool) return text(`Queued: ${lastToolText.slice(0, 50)}`);
    return call("dispatch_job", { templateId: "list-runs", params: { topic: "runs" }, brief: "List what is in the runs folder, please." });
  }
  return text(`echo: ${lastUser}`);
};

async function withRig(o: Partial<Phase2RigOptions> & { scenario: string }, fn: (p: Phase2Rig) => Promise<void>): Promise<void> {
  const p = await Phase2Rig.open({ behavior, ...o });
  try {
    await fn(p);
  } catch (e) {
    process.stderr.write(`\n--- phase2 diagnostics ---\n${p.diagnostics()}\n`);
    throw e;
  } finally {
    await p.close();
  }
}

const submitted = (p: Phase2Rig) => p.runner.audit().filter((e) => e["event"] === "submitted");

test("phase2 e2e: dispatch_job -> approve card -> job runner runs the fake claude -> progress -> final message -> the wrapped result goes back to the model", async () => {
  await withRig({ scenario: "slow" }, async (p) => {
    const rig = p.e2e;
    await rig.say("please make a loop of the runs folder", 1);

    const card = await rig.card(1);
    assert.match(card.text, /^Approve this job\?/);
    assert.match(card.text, /list-runs/);
    assert.match(card.text, /List what is in the runs folder, please\./, "the full brief is on the card");
    assert.match(card.text, /Claude/i, "the card says which cloud it uses");
    assert.match(card.approve, /^jb:[0-9a-f]{8}:y$/);
    assert.equal(submitted(p).length, 0, "nothing reaches the job runner before the tap");
    await rig.seen((t) => t.startsWith("Queued: Job job-"), "the model's answer to dispatch_job");

    await rig.tap(card.approve);
    await rig.seen((t) => t.startsWith("Job List the runs folder: "), "a progress message", 30_000);
    const final = await rig.seen((t) => /^Job job-[0-9a-f]{12} succeeded\./.test(t), "the final message", 30_000);
    assert.match(final, /Two files: a\.txt and b\.txt\./, "the job's summary reaches the user");
    await rig.seen((t) => t === "Job outcome relayed: succeeded", "the model's answer to the job result", 30_000);

    // The model saw the result as ONE untrusted block, in a message that says it is not from the user.
    const reqs = rig.fake.chatRequests();
    const last = JSON.stringify(reqs[reqs.length - 1]?.body?.messages ?? []);
    assert.match(last, /<untrusted_content source=\\"job:job-[0-9a-f]{12}\/claude\\">/);
    assert.match(last, /Two files: a\.txt and b\.txt\./);
    assert.match(last, /not written by the user/);

    const audit = p.runner.audit();
    assert.equal(audit.filter((e) => e["event"] === "submitted").length, 1, "one submit");
    assert.equal(audit.filter((e) => e["event"] === "started").length, 1);
    assert.equal(audit.filter((e) => e["event"] === "finished").length, 1);
    await rig.agent.bridge.delivery()!.idle();
  });
});

test("phase2 e2e: Reject on the card means nothing reaches the job runner, and the model is not woken", async () => {
  await withRig({ scenario: "ok" }, async (p) => {
    const rig = p.e2e;
    await rig.say("please make a loop of the runs folder", 11);
    const card = await rig.card(1);
    await rig.tap(card.deny);
    await rig.seen((t) => t.startsWith("Rejected. The job was not started."), "the card edit");
    await sleep(500);
    assert.equal(submitted(p).length, 0);
    assert.equal(
      rig.texts().some((t) => t.startsWith("Job outcome relayed")),
      false,
    );
  });
});

test("phase2 e2e: a permission prompt, then the agent restarts mid-job: the job is re-attached to (one submit), the prompt is asked again, the job finishes", async () => {
  await withRig({ scenario: "askperm" }, async (p) => {
    const rig = p.e2e;
    await rig.say("please make a loop of the runs folder", 21);
    await rig.tap((await rig.card(1)).approve);
    const perm = await rig.card(2);
    assert.match(perm.text, /^Allow this tool use in job job-/);
    assert.match(perm.text, /Tool: Write/);
    assert.match(perm.approve, /^jb:[0-9a-f]{8}:a$/);
    assert.equal(submitted(p).length, 1);

    // The agent stops while the job waits for the answer, and a new process starts on the same SQLite file.
    await rig.stop();
    await rig.start();
    await waitFor(() => rig.agent.phase2.client.state === "online", 15_000, "the new agent to reach the job runner");
    const asked = await rig.card(1); // the permission card, asked again by the resumed task
    assert.match(asked.text, /^Allow this tool use in job job-/);
    assert.notEqual(asked.approve, perm.approve, "a new card with new button ids");
    await rig.tap(perm.approve); // the old button is dead
    assert.ok(rig.tg.of("answerCallbackQuery").some((c) => String(c.payload["text"]).startsWith("Expired")), "the old button answers Expired");

    await rig.tap(asked.deny);
    const final = await rig.seen((t) => /^Job job-[0-9a-f]{12} succeeded\./.test(t), "the final message after the restart", 30_000);
    assert.match(final, /decision=deny/, "the denial reached the job");
    await rig.seen((t) => t === "Job outcome relayed: succeeded", "the model was told once", 30_000);
    assert.equal(submitted(p).length, 1, "still exactly one submit: the restart attached, it did not submit again");
    const decided = p.runner.audit().filter((e) => e["event"] === "permission_decided");
    assert.equal(decided.length, 1, "one decision in the runner's audit");
    await rig.agent.bridge.delivery()!.idle();
  });
});

test("phase2 e2e: cancel_job stops a running job: the process tree is gone and the job ends cancelled", async () => {
  await withRig({ scenario: "hang" }, async (p) => {
    const rig = p.e2e;
    await rig.say("please make a loop of the runs folder", 31);
    await rig.tap((await rig.card(1)).approve);
    await waitFor(() => {
      try {
        return JSON.parse(readFileSync(p.pidFile, "utf8")).childPid !== undefined;
      } catch {
        return false;
      }
    }, 30_000, "the fake claude to be running with its child");
    const { pid, childPid } = JSON.parse(readFileSync(p.pidFile, "utf8")) as { pid: number; childPid: number };
    assert.ok(isAlive(pid) && isAlive(childPid));

    await rig.say("cancel it", 32);
    await rig.seen((t) => t.startsWith("Cancel requested: "), "the cancel_job answer");
    await rig.seen((t) => /^Job job-[0-9a-f]{12} cancelled\./.test(t), "the final message", 30_000);
    await waitFor(() => !isAlive(pid) && !isAlive(childPid), 15_000, "the fake claude process tree to be gone");
    assert.equal(rig.agent.phase2.jobs.tracker.summary().running, 0, "/status counts no running job");
    await rig.seen((t) => t === "Job outcome relayed: cancelled", "the model was told", 30_000);
    await rig.say("/status", 33);
    await rig.seen((t) => /Job runner: online/.test(t) && /Jobs: 0 running, 0 queued, 0 awaiting approval/.test(t), "/status shows the job runner and the job counts");
    await rig.agent.bridge.delivery()!.idle();
  });
});

test("phase2 e2e: a Flow tool call with no approved Flow job (no ledger entry) is blocked, whatever max_credits says, and the server is never called", async () => {
  const mcp = await FakeMcpServer.start({
    tools: [
      {
        name: "generate_clip",
        description: "Generate a short video clip with Google Flow. Spends credits; pass max_credits.",
        inputSchema: { type: "object", properties: { prompt: { type: "string" }, max_credits: { type: "number" } }, required: ["prompt", "max_credits"] },
        handler: () => "clip made",
      },
    ],
  });
  try {
    await withRig({ scenario: "ok", mcpServers: [{ id: "flow-music-mcp", url: mcp.url, allowTools: ["generate_clip"], macros: [] }] }, async (p) => {
      const rig = p.e2e;
      assert.ok(rig.agent.phase2.hub.tools().some((t) => t.name === "mcp__flow-music-mcp__generate_clip"), "the Flow tool is registered (deferred)");
      await rig.say("please make a flow clip of a cat", 41);
      const answer = await rig.seen((t) => t.startsWith("Flow said: "), "the model's report of the Flow call", 30_000);
      assert.match(answer, /Blocked/, answer);
      assert.match(answer, /approved/i, "the block names the missing approval");
      assert.equal(mcp.calls.length, 0, "the Flow server was never called");

      // /new does not shed the hook: the same call is blocked in the new conversation too.
      await rig.say("/new", 42);
      await rig.seen((t) => t === "Started a new conversation.", "the /new reply");
      await rig.say("another flow clip please", 43);
      await waitFor(() => rig.texts().filter((t) => t.startsWith("Flow said: ")).length >= 2, 30_000, "the second Flow answer");
      assert.equal(mcp.calls.length, 0, "still never called");
      await rig.agent.bridge.delivery()!.idle();
    });
  } finally {
    await mcp.close();
  }
});

test("phase2 e2e: the whole registry has exactly the 10 always-loaded tools; the rest is deferred; there is no second-opinion tool", async () => {
  await withRig({ scenario: "ok" }, async (p) => {
    const rig = p.e2e;
    const tools = rig.agent.registry.snapshot().tools().map((t) => t.tool as { name: string; deferred?: boolean });
    const report = checkToolCap(tools);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual([...report.nonDeferred].sort(), [...ALWAYS_LOADED].sort());
    assert.equal(report.nonDeferred.length, 10);
    const deferred = tools.filter((t) => t.deferred === true).map((t) => t.name);
    for (const name of ["search_files", "write_file", "remember", "shell", "hub_start"]) assert.ok(deferred.includes(name), `${name} is deferred`);
    assert.equal(
      tools.some((t) => t.name === "ask_second_opinion"),
      false,
      "S15.3 is not built: the second-opinion tool is not registered",
    );
    // and what the model is actually offered on its first request
    await rig.say("hello", 51);
    await rig.seen((t) => t === "echo: hello", "an answer");
    assert.deepEqual([...rig.toolNamesOfLastRequest()].sort(), [...ALWAYS_LOADED].sort());
  });
});

test("phase2 e2e: /status shows the job runner, the job counts, Flow credits and the MCP servers", async () => {
  const mcp = await FakeMcpServer.start({ tools: [{ name: "stop", description: "Stop playback." }] });
  try {
    await withRig({ scenario: "ok", mcpServers: [{ id: "vibetts", url: mcp.url, allowTools: ["stop"], macros: [] }] }, async (p) => {
      const rig = p.e2e;
      await rig.say("/status", 61);
      const status = await rig.seen((t) => /^Runner: /.test(t) && /Job runner:/.test(t), "/status");
      assert.match(status, /Job runner: online/);
      assert.match(status, /Jobs: 0 running, 0 queued, 0 awaiting approval/);
      assert.match(status, /Flow credits today: 0 approved, 0 charged/);
      assert.match(status, /MCP servers: vibetts up/);
      await mcp.close();
      await rig.say("/status", 62);
      await waitFor(() => rig.texts().some((t) => /MCP servers: vibetts DOWN/.test(t)), 15_000, "vibetts shown as down");
    });
  } finally {
    await mcp.close().catch(() => undefined);
  }
});

test("phase2 e2e: a stopped job runner shows as offline in /status, and the agent reconnects when it is back", async () => {
  await withRig({ scenario: "ok" }, async (p) => {
    const rig = p.e2e;
    await p.runner.stop();
    await waitFor(() => rig.agent.phase2.client.state === "offline", 15_000, "the client to notice the job runner is gone");
    await rig.say("/status", 71);
    await rig.seen((t) => /Job runner: job runner offline/.test(t), "/status says the job runner is offline");
    await p.runner.restart();
    await waitFor(() => rig.agent.phase2.client.state === "online", 30_000, "the client to reconnect");
    await rig.say("/status", 72);
    await waitFor(() => rig.texts().some((t) => /Job runner: online/.test(t)), 15_000, "/status says online again");
  });
});
