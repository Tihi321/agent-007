/**
 * `yarn web:local` / `yarn start:local`: runs the web gateway or the main agent against the `.local/` setup made by `yarn setup:local`
 * (AGENT007_CONFIG / AGENT007_SECRETS point there, ACL checks off because the files are in the repo, not in locked-down ProgramData).
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const local = join(repoRoot, ".local");
const [target, ...rest] = process.argv.slice(2);
const entry = target === "web" ? "dist/src/web/main.js" : target === "start" ? "dist/src/main.js" : undefined;
if (!entry) {
  process.stderr.write("usage: local-run.js web|start [args]\n");
  process.exit(2);
}
const child = spawn(process.execPath, [join(repoRoot, entry), "--skip-acl-check", ...rest], {
  stdio: "inherit",
  env: { ...process.env, AGENT007_CONFIG: join(local, "config", "config.json"), AGENT007_SECRETS: join(local, "secrets", "secrets.json") },
});
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 1));
