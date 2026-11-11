// Verifies the unpacked Windows build (release/win-unpacked): the file layout, the bundled node.exe, setupPersonal from the packaged
// tree, and the packaged gateway started by the bundled node.exe exactly like the launcher does (--mode local, secrets ACL check ON,
// IPC channel), answering GET / and exiting 0 on an IPC shutdown. Exit 0 = pass. Usage: node scripts/desktop/verify-package.mjs [unpackedDir]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const unpacked = resolve(process.argv[2] ?? join(repo, "release", "win-unpacked"));
const res = join(unpacked, "resources");
const appDir = join(res, "app");
const nodeExe = join(res, "node", "node.exe");

const failures = [];
const check = (ok, msg) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures.push(msg);
};
const done = () => {
  if (failures.length) {
    console.error(`\nverify-package FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("\nverify-package passed");
};

// 1. files
for (const f of [
  join(unpacked, "agent-007.exe"),
  join(res, "app.asar"),
  nodeExe,
  join(appDir, "package.json"),
  join(appDir, "dist", "src", "web", "main.js"),
  join(appDir, "dist", "src", "web", "cli.js"),
  join(appDir, "dist", "src", "main.js"),
  join(appDir, "dist", "src", "jobrunner", "main.js"),
  join(appDir, "dist", "src", "setup", "personal.js"),
  join(appDir, "dist", "ui", "web", "index.html"),
  join(appDir, "prompts", "preamble.md"),
  join(appDir, "config", "config.example.json"),
  join(appDir, "config", "jobrunner.example.json"),
  join(appDir, "node_modules", "grammy", "package.json"),
]) {
  check(existsSync(f), `present: ${f.slice(unpacked.length + 1)}`);
}
check(!existsSync(join(appDir, "dist", "test")), "dist/test is not shipped");
if (failures.length) {
  done();
}

// 1b. playwright-core ships at the exact pinned version; no browser is bundled (Chromium is downloaded on first use)
{
  const pinned = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).dependencies?.["playwright-core"];
  const pwPkg = join(appDir, "node_modules", "playwright-core", "package.json");
  check(existsSync(pwPkg), "present: resources/app/node_modules/playwright-core/package.json");
  const shipped = existsSync(pwPkg) ? JSON.parse(readFileSync(pwPkg, "utf8")).version : undefined;
  check(typeof pinned === "string" && /^\d+\.\d+\.\d+$/.test(pinned) && shipped === pinned, `playwright-core ${shipped} equals the exact pinned version ${pinned}`);
  const stray = [];
  const scan = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.name.toLowerCase() === "ms-playwright" || e.name.toLowerCase() === "chrome.exe") stray.push(p.slice(unpacked.length + 1));
      else if (e.isDirectory()) scan(p);
    }
  };
  scan(res);
  check(stray.length === 0, `no ms-playwright folder or chrome.exe under resources/${stray.length ? ": " + stray.slice(0, 3).join(", ") : ""}`);
}
if (failures.length) {
  done();
}

// 2. node.exe version within engines
const engines = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).engines.node;
const m = /^>=(\d+)\.(\d+)\.(\d+)\s+<(\d+)$/.exec(engines);
const ver = execFileSync(nodeExe, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20000 }).trim();
const v = ver.replace(/^v/, "").split(".").map(Number);
const inRange = !!m && (v[0] - Number(m[1]) || v[1] - Number(m[2]) || v[2] - Number(m[3])) >= 0 && v[0] < Number(m[4]);
check(inRange, `bundled node.exe ${ver} satisfies engines "${engines}"`);

const freePort = () =>
  new Promise((ok, bad) => {
    const s = net.createServer();
    s.once("error", bad);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => (port === 47009 ? freePort().then(ok, bad) : ok(port)));
    });
  });

const temp = mkdtempSync(join(tmpdir(), "agent007-verify-"));
let child;
try {
  // 3. setupPersonal from the packaged tree (run with the current node; it is the same code the launcher imports from app.asar)
  const { setupPersonal } = await import(pathToFileURL(join(appDir, "dist", "src", "setup", "personal.js")).href);
  const r = setupPersonal({ root: temp, resourcesDir: appDir });
  check(existsSync(r.configPath) && existsSync(r.secretsPath), "setupPersonal created config.json and secrets.json in a temp root");

  // 4. start the packaged gateway: bundled node.exe, ACL check ON, IPC channel
  const port = await freePort();
  let out = "";
  child = spawn(nodeExe, [join(appDir, "dist", "src", "web", "main.js"), "--config", r.configPath, "--secrets", r.secretsPath, "--mode", "local", "--port", String(port)], {
    cwd: appDir,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const exited = new Promise((ok) => child.once("exit", (code, sig) => ok({ code, sig })));
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));

  // 5. GET / answers 200 HTML
  let status = 0;
  let type = "";
  const end = Date.now() + 30_000;
  while (Date.now() < end && !status) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      status = resp.status;
      type = resp.headers.get("content-type") ?? "";
    } catch {
      await new Promise((ok) => setTimeout(ok, 300));
    }
  }
  check(status === 200 && /html/i.test(type), `GET / on port ${port} -> ${status} ${type}`);
  if (status !== 200) console.log(out.slice(-1500));

  // 6. IPC shutdown -> exit 0 within 10 s
  child.send({ type: "shutdown" });
  const r2 = await Promise.race([exited, new Promise((ok) => setTimeout(() => ok(null), 10_000))]);
  check(!!r2 && r2.code === 0, `IPC shutdown -> exit ${r2 ? r2.code : "none within 10 s"}`);
} catch (e) {
  check(false, `unexpected error: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
  }
  // 7. delete the temp root
  rmSync(temp, { recursive: true, force: true });
  check(!existsSync(temp), "temp root deleted");
}
done();
