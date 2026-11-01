/** S30: the identity verifier matrix (I49), whois parsing, version pin, and the serve script (dry run, fake tailscale shim). Offline. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { SERVE_COMMAND, SERVE_REMOVE_COMMAND, aclSnippet, cliWhois, isTailnetIp, makeIdentityVerifier, meetsMinVersion, parseWhoisJson } from "../../src/web/tailscale.js";
import type { WhoisResult } from "../../src/web/tailscale.js";
import { HAS_WINDOWS_POWERSHELL, ROOT, stripComments } from "../deploy/_fixture.js";
import { tempDir } from "../settings/helpers.js";

const PORT = 47009;
const HOST = "pc.tail1234.ts.net";
const ALICE: WhoisResult = { login: "alice@example.com", tagged: false, addresses: ["100.101.102.103"] };

/** Runs the verifier on a real incoming request (so socket.remoteAddress is the real loopback peer). */
async function verify(headers: Record<string, string>, whois: (ip: string) => Promise<WhoisResult | undefined>, hostHeader = HOST) {
  const verifier = makeIdentityVerifier({ port: PORT, publicHosts: [HOST], whois });
  let result: unknown;
  const server = createServer((req: IncomingMessage, res) => {
    void verifier(req).then((r) => {
      result = r;
      res.end("x");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => {
    void import("node:http").then(({ request }) => {
      const req = request({ host: "127.0.0.1", port, headers: { host: hostHeader, ...headers }, setHost: false }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end();
    });
  });
  server.close();
  return result as { ok: boolean; reason?: string; identity?: { kind: string; login?: string } };
}

const serveShape = { "x-forwarded-for": "100.101.102.103", "x-forwarded-proto": "https", "x-forwarded-host": HOST };
const withLogin = (login = "alice@example.com") => ({ ...serveShape, "tailscale-user-login": login, "tailscale-user-name": "Alice" });

test("I49 matrix: loopback + serve shape + whois agrees = ok; every other case is rejected with a reason", async () => {
  const ok = await verify(withLogin(), async () => ALICE);
  assert.deepEqual([ok.ok, ok.identity?.kind, ok.identity?.login], [true, "tailscale", "alice@example.com"]);
  assert.equal((await verify(withLogin("ALICE@Example.com"), async () => ALICE)).ok, true, "login compare is case-insensitive");

  const no = async (headers: Record<string, string>, who: (ip: string) => Promise<WhoisResult | undefined>, re: RegExp, host?: string) => {
    const r = await verify(headers, who, host);
    assert.equal(r.ok, false, JSON.stringify(headers));
    assert.match(r.reason ?? "", re);
  };
  await no(withLogin("mallory@example.com"), async () => ALICE, /disagrees/);
  await no(withLogin(), async () => ({ ...ALICE, tagged: true }), /tagged/);
  await no(withLogin(), async () => undefined, /whois failed/);
  await no(withLogin(), async () => { throw new Error("cli down"); }, /whois failed/);
  await no(withLogin(), async () => ({ ...ALICE, addresses: ["100.1.1.1"] }), /mismatch/);
  // a forged header straight to the loopback port: no serve shape
  await no({ "tailscale-user-login": "alice@example.com" }, async () => ALICE, /without the serve shape/, `127.0.0.1:${PORT}`);
  await no({ "tailscale-user-login": "alice@example.com", "x-forwarded-for": "100.101.102.103" }, async () => ALICE, /without the serve shape/);
  // a shape with a wrong host, a non-tailnet client address, a Funnel marker, a missing identity
  await no({ ...withLogin(), "x-forwarded-host": "evil.example" }, async () => ALICE, /not ours/);
  await no({ ...withLogin(), "x-forwarded-for": "203.0.113.9" }, async () => ALICE, /not a tailnet address/);
  await no({ ...withLogin(), "tailscale-funnel-request": "?1" }, async () => ALICE, /funnel/);
  await no(serveShape, async () => ALICE, /tagged device or funnel/);
  await no({}, async () => ALICE, /no identity on a public host/);
  // direct local use: only the exact loopback Host, and no forwarding header
  const local = await verify({}, async () => undefined, `127.0.0.1:${PORT}`);
  assert.deepEqual([local.ok, local.identity?.kind], [true, "local"]);
  assert.equal((await verify({}, async () => undefined, `localhost:${PORT}`)).identity?.kind, "local");
  await no({ "x-forwarded-for": "1.2.3.4" }, async () => undefined, /tagged device or funnel/, `127.0.0.1:${PORT}`);
  await no({}, async () => undefined, /no identity/, "127.0.0.1:1");
});

test("whois parsing and the tailnet address range", () => {
  const w = parseWhoisJson(JSON.stringify({ Node: { Name: "phone.ts.net.", Addresses: ["100.101.102.103/32", "fd7a:115c:a1e0::1/128"], Tags: null }, UserProfile: { LoginName: "alice@example.com", DisplayName: "Alice" } }));
  assert.deepEqual(w, { login: "alice@example.com", tagged: false, addresses: ["100.101.102.103", "fd7a:115c:a1e0::1"], displayName: "Alice" });
  assert.equal(parseWhoisJson(JSON.stringify({ Node: { Tags: ["tag:server"] }, UserProfile: { LoginName: "tagged-devices" } }))?.tagged, true);
  for (const bad of ["", "nope", "[]", "{}", JSON.stringify({ Node: {}, UserProfile: {} }), JSON.stringify({ Node: {}, UserProfile: { LoginName: "" } })]) assert.equal(parseWhoisJson(bad), undefined, bad);
  for (const ip of ["100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::5"]) assert.equal(isTailnetIp(ip), true, ip);
  for (const ip of ["100.63.0.1", "100.128.0.1", "127.0.0.1", "192.168.1.1", "10.0.0.1", "", "100.64.0.999", "fd00::1"]) assert.equal(isTailnetIp(ip), false, ip);
});

test("cliWhois calls `tailscale whois --json <ip>` only for tailnet addresses", async () => {
  const calls: string[][] = [];
  const who = cliWhois(async (args) => {
    calls.push(args);
    return JSON.stringify({ Node: { Addresses: ["100.101.102.103/32"] }, UserProfile: { LoginName: "a@x.com" } });
  });
  assert.equal((await who("100.101.102.103"))?.login, "a@x.com");
  assert.equal(await who("8.8.8.8"), undefined);
  assert.deepEqual(calls, [["whois", "--json", "100.101.102.103"]]);
  assert.equal(await cliWhois(async () => undefined)("100.101.102.103"), undefined);
});

test("minimum Tailscale version: fail closed on an unreadable or older version", () => {
  assert.equal(meetsMinVersion("1.78.1-t1234", "1.60.0"), true);
  assert.equal(meetsMinVersion("1.60.0", "1.60.0"), true);
  assert.equal(meetsMinVersion("1.59.9", "1.60.0"), false);
  assert.equal(meetsMinVersion("0.99", "1.60.0"), false);
  assert.equal(meetsMinVersion("2.0", "1.60.0"), true);
  assert.equal(meetsMinVersion(undefined, "1.60.0"), false);
  assert.equal(meetsMinVersion("garbage", "1.60.0"), false);
});

const SCRIPT = join(ROOT, "deploy", "web", "tailscale-serve.ps1");
const skipPs = HAS_WINDOWS_POWERSHELL ? false : "Windows PowerShell is not available";

function shim(dir: string, status: string): { exe: string; log: string } {
  const log = join(dir, "calls.log");
  const exe = join(dir, "tailscale.cmd");
  writeFileSync(join(dir, "status.json"), status);
  writeFileSync(exe, `@echo off\r\necho %* >> "${log}"\r\nif "%1"=="serve" if "%2"=="status" type "${join(dir, "status.json")}"\r\nexit /b 0\r\n`);
  return { exe, log };
}
const ps = (args: string[]) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args], { encoding: "utf8", timeout: 60_000 });

test("tailscale-serve.ps1: ASCII, never mentions `funnel` as a command, refuses 47007 and 47008, and the printed command matches the code", () => {
  const raw = readFileSync(SCRIPT);
  assert.equal([...raw].findIndex((b) => b > 126 || (b < 32 && b !== 9 && b !== 10 && b !== 13)), -1, "ASCII only");
  const code = stripComments(raw.toString("utf8"));
  assert.ok(!/tailscale\s+funnel|'funnel'/i.test(code), "the script never runs funnel");
  assert.ok(code.includes(SERVE_COMMAND(PORT).replace(String(PORT), "$Port")));
  assert.ok(code.includes(SERVE_REMOVE_COMMAND));
  assert.match(code, /47007 -or \$Port -eq 47008/);
  assert.match(aclSnippet(), /"tag:agent007-host:443"/);
  assert.match(code, /tag:agent007-host/);
  assert.match(code, /group:agent007-users/);
});

test("tailscale-serve.ps1 dry run (the default): prints the ACL and the command, calls the shim zero times", { skip: skipPs }, () => {
  const dir = tempDir("a7-ts-");
  const s = shim(dir, "{}");
  const r = ps(["-TailscaleExe", s.exe]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:47009/);
  assert.match(r.stdout, /"dst": \["tag:agent007-host:443"\]/);
  assert.match(r.stdout, /DRY RUN: nothing was run/);
  assert.equal(existsSync(s.log), false, "tailscale was not called");
  const rm = ps(["-TailscaleExe", s.exe, "-Remove"]);
  assert.match(rm.stdout, /tailscale serve --https=443 off/);
  assert.equal(existsSync(s.log), false);
  const bad = ps(["-TailscaleExe", s.exe, "-Port", "47008", "-Apply"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /refusing port 47008/);
  assert.equal(existsSync(s.log), false);
});

test("tailscale-serve.ps1 -Apply against a fake shim: runs the serve command only; refuses when Funnel is on; -Remove runs the off command", { skip: skipPs }, () => {
  const dir = tempDir("a7-ts-");
  const good = shim(dir, "{}");
  const r = ps(["-TailscaleExe", good.exe, "-Apply"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const calls = readFileSync(good.log, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.ok(calls.includes("serve --bg --https=443 http://127.0.0.1:47009"), calls.join("|"));
  assert.ok(calls.every((c) => c.startsWith("serve")), "only serve subcommands, never funnel");
  assert.ok(!calls.some((c) => /funnel/i.test(c)));
  const dir2 = tempDir("a7-ts-");
  const funnel = shim(dir2, JSON.stringify({ AllowFunnel: { "pc.t.ts.net:443": true } }));
  const f = ps(["-TailscaleExe", funnel.exe, "-Apply"]);
  assert.notEqual(f.status, 0);
  assert.match(f.stdout + f.stderr, /Funnel entry is already on/);
  assert.ok(!readFileSync(funnel.log, "utf8").includes("--bg"), "the serve command was not run");
  const dir3 = tempDir("a7-ts-");
  const rm = shim(dir3, "{}");
  assert.equal(ps(["-TailscaleExe", rm.exe, "-Remove", "-Apply"]).status, 0);
  assert.match(readFileSync(rm.log, "utf8"), /serve --https=443 off/);
});
