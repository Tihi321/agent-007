/**
 * Owner CLI of the web gateway (S31). Run on the PC by the Windows owner account; it only needs the data directory.
 *
 *   node dist/src/web/cli.js owner-code --data-dir <dir> [--reset]   print a one-time claim code (valid 10 minutes). --reset = re-enrol
 *   node dist/src/web/cli.js lockdown   --data-dir <dir>             end every web session at once (the gateway also stops accepting them)
 *
 * The code is printed once and only its hash is stored. With --reset the next claim REPLACES the owner's credentials (recovery path).
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError } from "./auth.js";
import { createWebStack } from "./stack.js";

export interface CliIo {
  out(line: string): void;
}

export function runWebCli(argv: readonly string[], io: CliIo, port = 47009): number {
  const cmd = argv[0];
  let dataDir = "";
  let reset = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir" && argv[i + 1] !== undefined) dataDir = argv[++i] as string;
    else if (a === "--reset") reset = true;
    else {
      io.out(`unknown argument: ${String(a)}`);
      return 2;
    }
  }
  if ((cmd !== "owner-code" && cmd !== "lockdown") || dataDir === "") {
    io.out("usage: web-cli owner-code|lockdown --data-dir <dir> [--reset]");
    return 2;
  }
  const stack = createWebStack({ dataDir, port, publicHosts: [] });
  try {
    if (cmd === "lockdown") {
      const n = stack.sessions.revokeAll();
      stack.audit.write({ kind: "lockdown", detail: { sessions: n, via: "cli" } });
      io.out(`ended ${n} web session(s)`);
      return 0;
    }
    const { code, expiresAt } = stack.auth.issueOwnerCode({ reset });
    io.out(`One-time owner code (valid until ${new Date(expiresAt).toLocaleTimeString()}, shown once):`);
    io.out(code);
    io.out(`Open http://localhost:${port}/claim in a browser ON THIS PC and enter it.${reset ? " This replaces the owner's sign-in methods." : ""}`);
    return 0;
  } catch (e) {
    io.out(e instanceof AuthError ? e.message : "failed (the web stores could not be read)");
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runWebCli(process.argv.slice(2), { out: (l) => console.log(l) });
