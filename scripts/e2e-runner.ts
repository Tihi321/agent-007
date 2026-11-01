/**
 * Manual `@runner` end-to-end suite (S6.2 done-check, S8.2). NOT part of `npm test`.
 *
 * The real startup sequence and the real Harness on a temp SQLite file, a FAKE Telegram API (nothing contacts
 * Telegram), and the REAL configured model runner, read like the smoke scripts do from
 * `%LOCALAPPDATA%\agent-007-dev\config.json` and `secrets.json` (`A7_DEV_DIR` overrides; `--runner lmstudio|strata`,
 * `--model <id>` as in the smoke scripts). Tokens stay in memory and are never printed.
 *
 *   npm run e2e:runner
 *
 * Checks (each prints `E2E <id> PASS|FAIL <reason>`; the exit code is 0 only if all pass):
 *   question, shell-approve, shell-deny, new-gated, restart-deadline, remember
 * A small local model may need a second run for a check that depends on it calling the right tool; a tool-calling
 * failure is reported as FAIL with the answer it gave.
 */
import { readFileSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { checkRunnerReachable, isMain, loadSmokeRunner, parseArgs } from "./smoke/config.js";
import { E2e, readAudit, waitFor } from "../test/integration/rig.js";

interface Result {
  id: string;
  pass: boolean;
  reason: string;
}

const results: Result[] = [];
function report(id: string, pass: boolean, reason: string): void {
  results.push({ id, pass, reason });
  console.log(`E2E ${id} ${pass ? "PASS" : "FAIL"} ${reason}`);
}

async function check(id: string, fn: () => Promise<string>): Promise<void> {
  try {
    report(id, true, await fn());
  } catch (e) {
    report(id, false, e instanceof Error ? e.message : String(e));
  }
}

const ANSWER_MS = 240_000;

export async function runSuite(argv: readonly string[]): Promise<number> {
  results.length = 0;
  const args = parseArgs(argv);
  const cfg = loadSmokeRunner(args);
  const reach = await checkRunnerReachable(cfg);
  if (!reach.reachable) {
    report("runner", false, `runner unreachable (${reach.detail} at ${cfg.baseUrl}); nothing was started. Start the runner first. LIVE: UNTESTED`);
    return 1;
  }

  const rig = await E2e.openExternal(
    {
      baseUrl: cfg.baseUrl,
      modelId: cfg.modelId,
      runner: cfg.runner,
      apiKey: cfg.apiKey,
      contextWindow: cfg.contextWindow,
      maxTokens: cfg.maxTokens,
      streamTimeoutMs: cfg.streamTimeoutMs ?? 600_000,
    },
    { healthIntervalMs: 30_000 },
  );
  const me = userInfo().username.toLowerCase();
  const events = (name: string) => rig.audit().filter((e) => e["event"] === name);
  let msg = 1000;
  const next = () => ++msg;
  try {
    await check("question", async () => {
      await rig.say("What is 12 plus 30? Answer with just the number.", next());
      const t = await rig.seen((x) => /\b42\b/.test(x), "an answer containing 42", ANSWER_MS);
      return `answered: ${t.slice(0, 80)}`;
    });

    await check("shell-approve", async () => {
      await rig.say("Run the PowerShell command whoami and tell me its output.", next());
      const card = await rig.card(1);
      if (!/whoami/i.test(card.text)) throw new Error(`the approval card does not show whoami: ${card.text.slice(0, 120)}`);
      if (events("started").length !== 0) throw new Error("the command started before the tap");
      await rig.tap(card.approve);
      await waitFor(() => events("finished").length >= 1, 60_000, "the finished audit line");
      const t = await rig.seen((x) => x.toLowerCase().includes(me), `an answer naming ${me}`, ANSWER_MS);
      const lines = ["requested", "decided", "started", "finished"].map((n) => events(n).length);
      return `ran whoami after approval (audit requested/decided/started/finished = ${lines.join("/")}): ${t.slice(0, 80)}`;
    });

    await check("shell-deny", async () => {
      const before = events("started").length;
      await rig.say("Run the PowerShell command hostname and tell me the result.", next());
      const card = await rig.card(2);
      await rig.tap(card.deny);
      await waitFor(() => events("decided").length >= 2, 30_000, "the decided audit line");
      if (events("started").length !== before) throw new Error("a denied command ran");
      const last = events("decided").at(-1);
      if (last?.["approved"] !== false) throw new Error("the decision was not a denial");
      return "denied: nothing ran";
    });

    await check("new-gated", async () => {
      await rig.say("/new", next());
      await rig.seen((x) => x === "Started a new conversation.", "the /new reply", 30_000);
      const before = rig.cards().length;
      await rig.say("Run the PowerShell command Get-Date.", next());
      const card = await rig.card(before + 1);
      await rig.tap(card.deny);
      await waitFor(() => events("decided").length >= 3, 30_000, "the decided audit line");
      return "a shell request after /new produced an approval card";
    });

    await check("restart-deadline", async () => {
      const before = rig.cards().length;
      const requestedBefore = events("requested").length;
      await rig.say("Run the PowerShell command Get-Process | Select-Object -First 3.", next());
      const old = await rig.card(before + 1);
      const deadline = events("requested")[requestedBefore]?.["deadline"];
      await rig.restart();
      const fresh = await rig.card(1);
      if (fresh.approve === old.approve) throw new Error("the card after the restart reused the old button id");
      const reqs = events("requested");
      const again = reqs[reqs.length - 1]?.["deadline"];
      if (typeof deadline !== "number" || again !== deadline) throw new Error(`the deadline changed across the restart (${String(deadline)} -> ${String(again)})`);
      await rig.tap(fresh.deny);
      return "after a restart a new request appeared with the same deadline";
    });

    await check("remember", async () => {
      await rig.say("Remember that my favourite colour is green.", next());
      await rig.seen((x) => x.startsWith("Saved to memory:"), "the 'Saved to memory' notice", ANSWER_MS);
      const memory = readFileSync(join(rig.dirs.data, "memory", "MEMORY.md"), "utf8");
      if (!/green/i.test(memory)) throw new Error("MEMORY.md has no line about green");
      return "MEMORY.md gained a line and the chat was notified";
    });
  } finally {
    await rig.close();
    try {
      rmSync(rig.dirs.root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`E2E SUMMARY ${results.length - failed}/${results.length} passed runner=${cfg.runner} model=${cfg.modelId}`);
  return failed === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  runSuite(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`E2E error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
