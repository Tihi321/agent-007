/**
 * REQ-0014 A11 (opt-in): the real BrowserDriver + PlaywrightBackend + egress proxy against a real Chromium and loopback fixtures.
 * Skipped unless A7_BROWSERS_PATH points at a folder that already holds the Chromium build pinned by playwright-core.
 * This test never downloads anything. It is the only user of the egress `testAllowHosts` seam.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { startEgressProxy } from "../../../src/jobrunner/drivers/browser/egress.js";
import type { EgressOptions } from "../../../src/jobrunner/drivers/browser/egress.js";
import { BrowserDriver } from "../../../src/jobrunner/drivers/browser/driver.js";
import { createChromiumInstaller } from "../../../src/jobrunner/drivers/browser/install.js";
import { PlaywrightBackend } from "../../../src/jobrunner/drivers/browser/playwright.js";
import { DEFAULT_BROWSER_SETTINGS } from "../../../src/settings/browser.js";
import { FakeHost, JOB_ID, ROOT, TEMP_BASE, template } from "./fakeBackend.js";

const browsersDir = process.env["A7_BROWSERS_PATH"] ?? "";
const skip =
  browsersDir === ""
    ? "A7_BROWSERS_PATH is not set"
    : createChromiumInstaller({ browsersDir }).status().installed
      ? false
      : "no pinned Chromium found under A7_BROWSERS_PATH";

const PAGE = `<!doctype html><title>Fixture</title><h1>Hello fixture</h1>
<form action="/submit" method="get"><label>Name <input name="who" type="text"></label>
<button type="submit">Place order</button></form>`;

test("real Chromium on loopback fixtures (A11)", { skip, timeout: 120_000 }, async () => {
  const hits: string[] = [];
  const cookies: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/set") res.setHeader("Set-Cookie", "a7=persisted; Max-Age=3600; Path=/");
    if (req.url === "/whoami") cookies.push(req.headers.cookie ?? "");
    res.setHeader("Content-Type", "text/html");
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  mkdirSync(TEMP_BASE, { recursive: true });
  const dir = mkdtempSync(join(TEMP_BASE, "rc-"));
  const artifactsDir = join(dir, "shots");
  let n = 0;

  /** One whole session (own proxy, own driver, same profile folder). */
  async function session(egress: EgressOptions, body: (act: (action: object) => Promise<any>, host: FakeHost) => Promise<void>): Promise<void> {
    const host = new FakeHost();
    const settings = { ...DEFAULT_BROWSER_SETTINGS };
    const driver = new BrowserDriver(
      {
        backend: new PlaywrightBackend({ settings: () => settings }),
        paths: { profileDir: join(dir, "profile"), artifactsDir, browsersDir, lockFile: join(dir, "profile.lock") },
        headless: true,
        idleMin: 10,
        settings: () => settings,
        installer: createChromiumInstaller({ browsersDir }),
        egress: () => startEgressProxy(egress),
      },
      {},
    );
    await driver.start({ jobId: JOB_ID, template: template(), params: {}, brief: "b", prompt: "p", cwd: ROOT, host });
    const act = (action: object) => driver.act(JOB_ID, { jobId: JOB_ID, callId: `c${++n}`, action } as never, host);
    try {
      await body(act, host);
    } finally {
      await act({ op: "done", summary: "finished" });
    }
  }
  const allow: EgressOptions = { testAllowHosts: ["127.0.0.1"] };
  const refOf = (text: string, role: string): string => {
    const m = new RegExp(`\\[(e\\d+)\\] ${role}`).exec(text);
    assert.ok(m, `no ${role} in: ${text}`);
    return m[1] as string;
  };

  try {
    await session(allow, async (act, host) => {
      assert.equal((await act({ op: "goto", url: `${base}/set` })).outcome, "done");
      const read = await act({ op: "read" });
      assert.equal(read.outcome, "done");
      assert.match(read.text, /Hello fixture/);
      const field = refOf(read.text, "textbox");
      const submit = refOf(read.text, "button");

      assert.equal((await act({ op: "type", ref: field, text: "Ada" })).outcome, "done");
      assert.match((await act({ op: "read" })).text, /value="Ada"/);

      host.answer = () => "deny";
      assert.equal((await act({ op: "click", ref: submit })).outcome, "denied");
      assert.equal(host.asked.length, 1);
      assert.equal(host.asked[0]?.kind, "browser");
      assert.ok(!hits.some((h) => h.startsWith("/submit")), "a denied submit must not reach the server");

      const shot = await act({ op: "screenshot" });
      assert.equal(shot.outcome, "done");
      const png = readFileSync(join(artifactsDir, shot.shot.path));
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert.ok(png.length > 100);
    });

    // Second session on the same profile: the cookie set above is sent.
    await session(allow, async (act) => {
      assert.equal((await act({ op: "goto", url: `${base}/whoami` })).outcome, "done");
    });
    assert.match(cookies.join("|"), /a7=persisted/);

    // The default proxy (no seam) refuses the loopback fixture.
    const before = hits.length;
    await session({}, async (act) => {
      const r = await act({ op: "goto", url: `${base}/other` });
      assert.notEqual(r.outcome, "done");
      assert.equal(r.outcome, "refused");
    });
    assert.equal(hits.length, before, "the refused page must not reach the server");
  } finally {
    const closed = new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections();
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});
