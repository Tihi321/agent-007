/**
 * Owner CLI of the web gateway (S31). Run on the PC by the Windows owner account; it only needs the data directory.
 *
 *   node dist/src/web/cli.js owner-code --data-dir <dir> [--reset]   print a one-time claim code (valid 10 minutes). --reset = re-enrol
 *   node dist/src/web/cli.js lockdown   --data-dir <dir>             end every web session at once (the gateway also stops accepting them)
 *   node dist/src/web/cli.js reset-password --data-dir <dir> --login <email> [--stdin]   new password (asked twice, no echo)
 *   node dist/src/web/cli.js reset-totp     --data-dir <dir> --login <email> [--begin | --finish --stdin]   new authenticator
 *
 * The code is printed once and only its hash is stored. With --reset the next claim REPLACES the owner's credentials (recovery path).
 * --stdin, --begin and --finish are the machine mode of the desktop launcher: one JSON line on stdout, the secrets on stdin.
 * A password is never an argument (argv is visible to other processes).
 */
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AuthError } from "./auth.js";
import { createWebStack } from "./stack.js";

export interface CliIo {
  out(line: string): void;
  /** Ask the person one line. hidden = no echo (passwords). Absent = not interactive. */
  ask?(question: string, hidden: boolean): Promise<string>;
  /** The whole of stdin as text (used with --stdin). */
  readStdin?(): Promise<string>;
}

const USAGE = "usage: web-cli owner-code|lockdown|reset-password|reset-totp --data-dir <dir> [--reset] [--login <email>] [--stdin] [--begin|--finish]";

export async function runWebCli(argv: readonly string[], io: CliIo, port = 47009): Promise<number> {
  const cmd = argv[0];
  let dataDir = "";
  let login = "";
  let reset = false;
  let machine = false;
  let begin = false;
  let finish = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--data-dir" && argv[i + 1] !== undefined) dataDir = argv[++i] as string;
    else if (a === "--login" && argv[i + 1] !== undefined) login = argv[++i] as string;
    else if (a === "--reset") reset = true;
    else if (a === "--stdin") machine = true;
    else if (a === "--begin") begin = true;
    else if (a === "--finish") finish = true;
    else if (a === "--password" || (typeof a === "string" && a.startsWith("--password="))) {
      io.out("The password is never taken as an argument; you will be asked for it.");
      return 2;
    } else {
      io.out(`unknown argument: ${String(a)}`);
      return 2;
    }
  }
  const resetCmd = cmd === "reset-password" || cmd === "reset-totp";
  if ((cmd !== "owner-code" && cmd !== "lockdown" && !resetCmd) || dataDir === "" || (resetCmd && login.trim() === "")) {
    io.out(USAGE);
    return 2;
  }
  if (cmd === "reset-totp" && ((begin && finish) || (finish && !machine))) {
    io.out(USAGE);
    return 2;
  }
  const stack = createWebStack({ dataDir, port, publicHosts: [] });
  // machine mode answers in one JSON line; interactive mode in sentences
  const jsonMode = machine || begin;
  const fail = (message: string, code = 1): number => {
    io.out(jsonMode ? JSON.stringify({ ok: false, message }) : message);
    return code;
  };
  try {
    if (cmd === "lockdown") {
      const n = stack.sessions.revokeAll();
      stack.audit.write({ kind: "lockdown", detail: { sessions: n, via: "cli" } });
      io.out(`ended ${n} web session(s)`);
      return 0;
    }
    if (cmd === "owner-code") {
      const { code, expiresAt } = stack.auth.issueOwnerCode({ reset });
      io.out(`One-time owner code (valid until ${new Date(expiresAt).toLocaleTimeString()}, shown once):`);
      io.out(code);
      io.out(`Open http://localhost:${port}/claim in a browser ON THIS PC and enter it.${reset ? " This replaces the owner's sign-in methods." : ""}`);
      return 0;
    }

    const targetId = stack.auth.userIdForLogin(login);
    if (targetId === undefined) return fail("No user with that login.");

    // machine mode input: parse the JSON on stdin once
    let input: Record<string, unknown> = {};
    if (machine) {
      if (!io.readStdin) return fail("No input.", 2);
      try {
        const parsed: unknown = JSON.parse(await io.readStdin());
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        input = parsed as Record<string, unknown>;
      } catch {
        return fail("The input is not valid JSON.", 2);
      }
    }

    if (cmd === "reset-password") {
      let password: string;
      if (machine) {
        password = typeof input.password === "string" ? input.password : "";
      } else {
        if (!io.ask) {
          io.out("Run this in a terminal, or pass --stdin.");
          return 2;
        }
        password = await io.ask("New password (12+ characters): ", true);
        const again = await io.ask("Repeat it: ", true);
        if (password !== again) {
          io.out("The two passwords differ. Nothing changed.");
          return 1;
        }
      }
      const { ended } = await stack.auth.resetPassword({ targetId, newPassword: password, channel: machine ? "desktop" : "cli" });
      if (machine) io.out(JSON.stringify({ ok: true, ended }));
      else io.out(`Password reset for ${login}. Ended ${ended} web session(s). The authenticator and passkeys are unchanged.`);
      return 0;
    }

    // reset-totp
    if (machine && finish) {
      const { ended } = stack.auth.finishTotpReset({ targetId, secret: String(input.secret ?? ""), code: String(input.code ?? ""), channel: "desktop" });
      io.out(JSON.stringify({ ok: true, ended }));
      return 0;
    }
    if (begin) {
      const { secret, uri } = stack.auth.beginTotpReset(targetId);
      io.out(JSON.stringify({ ok: true, secret, uri }));
      return 0;
    }
    if (machine) return fail(USAGE, 2);
    if (!io.ask) {
      io.out("Run this in a terminal, or pass --stdin.");
      return 2;
    }
    const fresh = stack.auth.beginTotpReset(targetId);
    io.out(`New authenticator key for ${login} (shown once):`);
    io.out(fresh.secret);
    io.out(fresh.uri);
    io.out("Add it to your authenticator app. The old entry keeps working until you confirm here.");
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = (await io.ask("6-digit code from the NEW entry: ", false)).trim();
      try {
        const { ended } = stack.auth.finishTotpReset({ targetId, secret: fresh.secret, code, channel: "cli" });
        io.out(`Authenticator replaced for ${login}. Ended ${ended} web session(s). The password and passkeys are unchanged.`);
        return 0;
      } catch (e) {
        if (!(e instanceof AuthError) || e.code !== "invalid") throw e;
        io.out(e.message);
      }
    }
    io.out("Nothing changed. The old authenticator still works.");
    return 1;
  } catch (e) {
    if (e instanceof AuthError) return fail(e.message);
    return fail("failed (the web stores could not be read)");
  }
}

/** One line from the terminal without echo: raw mode, Enter ends, Backspace deletes one character, Ctrl+C exits 130. */
function askHidden(question: string): Promise<string> {
  return new Promise((done) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          done(buf);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function askVisible(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const io: CliIo = {
    out: (l) => console.log(l),
    readStdin: readAllStdin,
    ...(process.stdin.isTTY ? { ask: (q: string, hidden: boolean) => (hidden ? askHidden(q) : askVisible(q)) } : {}),
  };
  void runWebCli(process.argv.slice(2), io).then((c) => {
    process.exitCode = c;
  });
}
