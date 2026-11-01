/**
 * Helpers for the deploy-script tests (S7). Not a test file itself.
 *
 * SAFETY: these tests never change the system. System-changing scripts are only ever run with `-WhatIf` (the helper
 * refuses anything else, except the explicit "refuses to run unelevated" check, which is skipped when the test process
 * is elevated). Fixture folders live under `<repo>/.claude/temp/`. The only ACL changes are on those fixture folders,
 * made by `icacls` for the read-only `check-acl.ps1` tests.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
export const DEPLOY = join(ROOT, "deploy");
export const TEMP_BASE = join(ROOT, ".claude", "temp");
export const IS_WINDOWS = process.platform === "win32";

export function psScripts(): string[] {
  return readdirSync(DEPLOY).filter((f) => f.endsWith(".ps1")).sort();
}

export function readScript(name: string): string {
  return readFileSync(join(DEPLOY, name), "utf8");
}

export interface PsResult {
  status: number | null;
  stdout: string;
  stderr: string;
  all: string;
}

function hasCommand(cmd: string): boolean {
  const r = spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" });
  return r.status === 0;
}

export const HAS_WINDOWS_POWERSHELL = IS_WINDOWS && hasCommand("powershell.exe");
export const HAS_PWSH = hasCommand("pwsh");

export function isElevated(): boolean {
  if (!HAS_WINDOWS_POWERSHELL) return false;
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "if (([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'yes' } else { 'no' }"],
    { encoding: "utf8" },
  );
  return r.stdout.trim() === "yes";
}

export interface RunOptions {
  /** Only for the "refuses to run unelevated" check. Never set when the process is elevated. */
  allowRealRun?: boolean;
  shell?: "powershell.exe" | "pwsh";
  env?: NodeJS.ProcessEnv;
}

/** Runs `deploy/<script>` with the given args. Refuses to run a system-changing script without -WhatIf. */
export function runDeploy(script: string, args: string[], opts: RunOptions = {}): PsResult {
  const readOnly = script === "check-acl.ps1";
  if (!readOnly && !args.includes("-WhatIf") && !opts.allowRealRun) throw new Error(`test safety: ${script} must be run with -WhatIf`);
  if (!readOnly && !args.includes("-WhatIf") && opts.allowRealRun && isElevated()) throw new Error("test safety: refusing a real run in an elevated process");
  return runPs(["-File", join(DEPLOY, script), ...args], opts);
}

export function runPs(psArgs: string[], opts: RunOptions = {}): PsResult {
  // A PSModulePath inherited from another PowerShell edition can hide the built-in modules of this one.
  const env = { ...(opts.env ?? process.env) };
  delete env["PSModulePath"];
  const r = spawnSync(opts.shell ?? "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...psArgs], {
    encoding: "utf8",
    env,
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", all: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

export function whoami(): string {
  return execFileSync("whoami.exe", { encoding: "utf8" }).trim();
}

export function icacls(...args: string[]): string {
  return execFileSync("icacls.exe", args, { encoding: "utf8" });
}

// ---- fixtures -------------------------------------------------------------------------------

export interface Fixture {
  root: string;
  allow: string;
  deny: string;
  profile: string;
  lmstudio: string;
  pd: string;
  configDir: string;
  secretsDir: string;
  secretsFile: string;
  data: string;
  pf: string;
  strataInstall: string;
  strataData: string;
  strataDir: string;
  strataConfig: string;
  strataLog: string;
  configPath: string;
  cleanup(): void;
}

export interface FixtureOptions {
  runner?: "lmstudio" | "strata";
  /** extra folders.deny entries (after the fixture deny folder) */
  extraDeny?: string[];
  /** replace folders.deny entirely */
  denyOverride?: string[] | ((f: Fixture) => string[]);
}

/** A fixture tree under .claude/temp with a config.json that points every path into it. Nothing is ACL-protected yet. */
export function makeFixture(opts: FixtureOptions = {}): Fixture {
  mkdirSync(TEMP_BASE, { recursive: true });
  const root = mkdtempSync(join(TEMP_BASE, "deploy-test-"));
  const f: Fixture = {
    root,
    allow: join(root, "allow"),
    deny: join(root, "deny"),
    profile: join(root, "Users", "main"),
    lmstudio: join(root, "Users", "main", ".lmstudio"),
    pd: join(root, "ProgramData", "agent-007"),
    configDir: join(root, "ProgramData", "agent-007", "config"),
    secretsDir: join(root, "ProgramData", "agent-007", "secrets"),
    secretsFile: join(root, "ProgramData", "agent-007", "secrets", "secrets.json"),
    data: join(root, "Local", "agent-007"),
    pf: join(root, "Program Files", "agent-007"),
    strataInstall: join(root, "strata"),
    strataData: join(root, "strata-data"),
    strataDir: join(root, "ProgramData", "agent-007", "strata"),
    strataConfig: join(root, "ProgramData", "agent-007", "strata", "strata.json"),
    strataLog: join(root, "ProgramData", "agent-007", "logs"),
    configPath: join(root, "config.json"),
    cleanup: () => cleanupDir(root),
  };
  for (const d of [f.allow, f.deny, f.lmstudio, f.configDir, f.secretsDir, f.data, f.pf]) mkdirSync(d, { recursive: true });
  const deny = typeof opts.denyOverride === "function" ? opts.denyOverride(f) : (opts.denyOverride ?? [f.deny, ...(opts.extraDeny ?? [])]);
  const config = {
    telegram: { allowedUserIds: [1] },
    model: {
      runner: opts.runner ?? "lmstudio",
      runners: {
        lmstudio: {},
        strata: { installDir: f.strataInstall, dataDir: f.strataData, configFile: f.strataConfig, logDir: f.strataLog },
      },
    },
    folders: { allow: [{ alias: "docs", path: f.allow }], deny },
    paths: { programDataDir: f.pd, dataDir: f.data },
    mainUserProfile: f.profile,
  };
  writeFileSync(f.configPath, JSON.stringify(config, null, 2));
  return f;
}

export function cleanupDir(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    // reset any ACL a test changed on the fixture (also removes Deny ACEs), then delete
    spawnSync("icacls.exe", [dir, "/reset", "/T", "/C", "/Q"], { encoding: "utf8" });
  } catch {
    /* best effort */
  }
  rmSync(dir, { recursive: true, force: true });
}

/** A git repo that stands in for D:\Strata: pinned commit, clean tree, the files S7.9 reads. Returns the full HEAD hash. */
export function makeStrataRepo(f: Fixture, logKey = "log"): string {
  mkdirSync(join(f.strataInstall, ".venv", "Scripts"), { recursive: true });
  mkdirSync(join(f.strataInstall, "serve"), { recursive: true });
  mkdirSync(f.strataData, { recursive: true });
  writeFileSync(join(f.strataInstall, ".venv", "Scripts", "python.exe"), "");
  writeFileSync(join(f.strataInstall, "serve", "server.py"), "# fixture\n");
  writeFileSync(join(f.strataData, "model.gguf"), "x");
  writeFileSync(
    join(f.strataInstall, "strata-iq3_s.json"),
    JSON.stringify({ backend: "hip", port: 8080, model: "fixture-model", [logKey]: join(f.strataInstall, "strata-iq3_s.log"), open_browser: true, flags: ["--kv", "int8"] }, null, 2),
  );
  const git = (...args: string[]) => execFileSync("git.exe", ["-C", f.strataInstall, "-c", "user.email=test@example.invalid", "-c", "user.name=test", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return git("rev-parse", "HEAD").trim();
}

/** Path -> sha256 (or "dir") for every file and folder under `dir`: to prove a dry run changed nothing. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        out[p] = "dir";
        walk(p);
      } else out[p] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** Applies the exact ACL of a protected fixture folder: inheritance off, `me` rights, SYSTEM F, Administrators F. */
export function protect(path: string, me: string, meRights: string): void {
  const isDir = statSync(path).isDirectory();
  const inh = isDir ? "(OI)(CI)" : "";
  icacls(path, "/inheritance:r", "/grant:r", `${me}:${inh}${meRights}`, `*S-1-5-18:${inh}F`, `*S-1-5-32-544:${inh}F`);
}

export function scriptFile(name: string): string {
  return join(DEPLOY, basename(name));
}

/** Removes PowerShell block comments (`<# ... #>`) and whole-line `#` comments, so static checks look at code only. */
export function stripComments(text: string): string {
  return text.replace(/<#[\s\S]*?#>/g, "").replace(/^\s*#.*$/gm, "");
}
