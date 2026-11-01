/**
 * MA4: the comparison-eval harness on `claude/sonnet` through the proxy, OFFLINE: a fake proxy stands in. The real run (U67 to U70, a
 * logged-in proxy and the user's go) is UNTESTED here.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { caseOf as routingCase } from "../scripts/routing-eval/cases.js";
import { runRoutingEval } from "../scripts/routing-eval/run.js";
import { caseOf } from "../scripts/multibot-eval/cases.js";
import { stubBehavior } from "../scripts/multibot-eval/model.js";
import { runCaseOnce } from "../scripts/multibot-eval/world.js";
import { checkProxyTarget, loadSmokeRunner, parseArgs } from "../scripts/smoke/config.js";
import { startFakeOpenAi } from "./helpers/fakeOpenAi.js";
import { FAKE_KEY, startFakeProxy } from "./proxy/helpers.js";

const dev = (secrets: unknown): string => {
  const d = mkdtempSync(join(tmpdir(), "a7-ma4-"));
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "secrets.json"), JSON.stringify(secrets));
  return d;
};
const health = (m?: string) => ({ status: "ok", providers: { claude: { active: 0, queued: 0, max_concurrent: 2, ...(m ? { auth_method: m } : {}) } } });

test("--proxy-port: loopback proxy URL, claude/sonnet by default, the proxy key from the dev secrets, never another key", () => {
  const d = dev({ proxyApiKey: FAKE_KEY, strataApiKey: "other" });
  try {
    const c = loadSmokeRunner(parseArgs(["--proxy-port", "8787"]), d);
    assert.equal(c.baseUrl, "http://127.0.0.1:8787/v1");
    assert.equal(c.modelId, "claude/sonnet");
    assert.equal(c.apiKey, FAKE_KEY);
    assert.deepEqual(c.viaProxy, { port: 8787 });
    assert.equal(loadSmokeRunner(parseArgs(["--proxy-port", "8787", "--model", "claude/opus"]), d).modelId, "claude/opus");
    assert.throws(() => loadSmokeRunner(parseArgs(["--proxy-port", "99999"]), d), /1 to 65535/);
    assert.equal(loadSmokeRunner(parseArgs([]), d).viaProxy, undefined);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("checkProxyTarget: ok on the subscription login; refuses an API-key login, a missing key and an unlisted model", async () => {
  const d = dev({ proxyApiKey: FAKE_KEY });
  try {
    const run = async (h: unknown, ids: string[], args: string[] = []) => {
      const px = await startFakeProxy({ health: h, modelIds: ids });
      try {
        return await checkProxyTarget(loadSmokeRunner(parseArgs(["--proxy-port", String(px.port), ...args]), d));
      } finally {
        await px.close();
      }
    };
    assert.equal((await run(health("subscription"), ["claude/sonnet"])).reachable, true);
    const api = await run(health("api_key"), ["claude/sonnet"]);
    assert.equal(api.reachable, false);
    assert.match(api.detail, /NEEDS ATTENTION/);
    assert.equal((await run(health("subscription"), ["claude/other"])).reachable, false);
    assert.equal((await run(health("subscription"), ["claude/sonnet", "claude/opus"], ["--model", "claude/opus"])).reachable, true);
    assert.equal(FAKE_KEY.length > 0 && !(await run(health("api_key"), ["claude/sonnet"])).detail.includes(FAKE_KEY), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("multi-bot eval live path with the proxy as the target: main's calls reach the proxy with its key and claude/sonnet", async () => {
  for (const id of ["MR4", "MS1"]) {
    const c = caseOf(id)!;
    const px = await startFakeOpenAi({ modelId: "claude/sonnet", requireKey: FAKE_KEY, behavior: (i) => stubBehavior(c, { onMainAfterTool: () => undefined })(i) });
    try {
      const r = await runCaseOnce(c, 1, { mode: "live", live: { baseUrl: px.baseUrl, apiKey: FAKE_KEY, modelId: "claude/sonnet", contextWindow: 190000, maxTokens: 8192 }, timeoutMs: 30_000, settleMs: 800 });
      assert.ok(r.record.pass, `${id}: ${r.record.reason}`);
      assert.ok(px.chatRequests().length >= 2);
      assert.ok(px.chatRequests().every((q) => q.body?.model === "claude/sonnet"));
      assert.ok(px.requests.every((q) => q.authorization === `Bearer ${FAKE_KEY}`));
    } finally {
      await px.close();
    }
  }
});

test("routing eval (tool use) against the proxy target: a scripted claude/sonnet answers a plain prompt through the real Harness", async () => {
  const px = await startFakeOpenAi({ modelId: "claude/sonnet", requireKey: FAKE_KEY, behavior: () => ({ type: "text", text: "15 percent of 240 is 36." }) });
  const out = mkdtempSync(join(tmpdir(), "a7-ma4-out-"));
  try {
    const cfg = { runner: "lmstudio" as const, baseUrl: px.baseUrl, modelId: "claude/sonnet", contextWindow: 190000, maxTokens: 8192, apiKey: FAKE_KEY, viaProxy: { port: 1 } };
    assert.ok(routingCase("R1"));
    const s = await runRoutingEval(cfg, { label: "claude-sonnet", runs: 1, only: ["R1"], outDir: out, timeoutMs: 30_000 });
    assert.equal(s.records[0]?.pass, true, s.records[0]?.reason);
    assert.equal(s.modelId, "claude/sonnet");
    assert.ok(px.chatRequests().every((q) => q.body?.model === "claude/sonnet"));
  } finally {
    await px.close();
    rmSync(out, { recursive: true, force: true });
  }
});
