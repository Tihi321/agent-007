/**
 * `whoami-telegram` (S4.7, UI-4): prints the numeric `from.id`, `chat.id` and `chat.type` of every message the bot
 * receives during a 120 s long poll, so the user can copy their id into `telegram.allowedUserIds`.
 * It NEVER replies and never stores anything. The token comes from the dev secrets file:
 *   %LOCALAPPDATA%\agent-007-dev\secrets.json   (`A7_DEV_DIR` overrides the folder, `--secrets <file>` the file)
 * with a `telegramBotToken` field. Stop the real agent first: two pollers on one token get HTTP 409.
 *
 *   node dist/scripts/whoami-telegram.js [--secrets <file>] [--seconds 120]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { createRedactor } from "../src/logging/redact.js";

export interface WhoamiOptions {
  durationMs: number;
  print: (line: string) => void;
  botInfo?: UserFromGetMe | undefined;
}

export interface WhoamiResult {
  seen: number;
}

/** One line per received message. Only ids and the chat type: no message text, no names. */
export function whoamiLine(fromId: number | undefined, chatId: number, chatType: string): string {
  return `from.id=${fromId ?? "unknown"} chat.id=${chatId} chat.type=${chatType}`;
}

/** Polls `bot` for `durationMs` and prints each message sender. Resolves when the time is up. */
export async function runWhoami(bot: Bot, opts: WhoamiOptions): Promise<WhoamiResult> {
  let seen = 0;
  bot.on("message", (ctx) => {
    seen++;
    opts.print(whoamiLine(ctx.from?.id, ctx.chat.id, ctx.chat.type));
    // No reply, by design.
  });
  let started!: () => void;
  const startedP = new Promise<void>((r) => (started = r));
  const done = bot.start({ allowed_updates: ["message"], onStart: () => started() });
  const failed = done.then(
    () => undefined,
    (e: unknown) => e,
  );
  const first = await Promise.race([startedP.then(() => "started" as const), failed.then((e) => ({ error: e }))]);
  if (typeof first === "object") throw first.error;
  await new Promise<void>((r) => setTimeout(r, opts.durationMs));
  await bot.stop();
  const err = await failed;
  if (err) throw err;
  return { seen };
}

export function devSecretsPath(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const i = argv.indexOf("--secrets");
  const given = i >= 0 ? argv[i + 1] : undefined;
  if (given) return resolve(given);
  const dir = env["A7_DEV_DIR"] ?? join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "agent-007-dev");
  return join(dir, "secrets.json");
}

function readToken(file: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`cannot read a JSON secrets file at ${file}`);
  }
  const token = (raw as { telegramBotToken?: unknown } | null)?.telegramBotToken;
  if (typeof token !== "string" || token.trim() === "") throw new Error(`no telegramBotToken in ${file}`);
  return token;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const si = argv.indexOf("--seconds");
  const seconds = si >= 0 ? Number(argv[si + 1]) : 120;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error("--seconds must be a positive number");
    return 2;
  }
  const file = devSecretsPath(argv, process.env);
  let token: string;
  try {
    token = readToken(file);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  const redact = createRedactor([token]);
  console.log(`Polling for ${seconds} s. Send any message to the bot from your account; ids are printed below. The bot never replies.`);
  try {
    const res = await runWhoami(new Bot(token), { durationMs: seconds * 1000, print: (l) => console.log(l) });
    console.log(res.seen === 0 ? "No messages received." : `Done. ${res.seen} message(s) seen.`);
    return 0;
  } catch (e) {
    const text = redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    console.error(`Polling failed: ${text}`);
    if (/409/.test(text)) console.error("Another poller uses this token. Stop the agent (or any other bot process) and retry.");
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error("whoami-telegram crashed:", e instanceof Error ? e.name : String(e));
      process.exit(1);
    },
  );
}
