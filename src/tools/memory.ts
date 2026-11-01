/**
 * Memory (S2.5): `remember` appends `- YYYY-MM-DD: <note>` to MEMORY.md and tells the user through the Notifier
 * (exactly once per write). The file is capped at 16 KB: when full the tool refuses and asks the user to prune.
 * Notes that look like secrets are refused. `replay: "unsafe"`. `USER.md` is read-only: no tool writes it.
 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { win32 } from "node:path";
import type { Logger, Notifier } from "../contracts.js";
import { defineTool } from "../pi/adapter.js";
import type { Static, ToolExecutionApi } from "../pi/adapter.js";
import { ToolRefusal, guarded, toolDescription } from "./folders.js";
import { rememberParameters } from "./schemas.js";

export const MEMORY_MAX_BYTES = 16 * 1024;
export const NOTE_MAX_CHARS = 500;

const SECRET_PATTERNS: RegExp[] = [
  /[A-Za-z0-9+/_-]{32,}={0,2}/, // long base64 / base64url / hex runs
  /\b[0-9a-fA-F]{24,}\b/, // shorter hex runs (hashes, keys)
  /bot\d+:/i, // Telegram bot tokens
  /\bsk-[A-Za-z0-9]/i, // OpenAI-style keys
  /pass(?:word|wd|phrase)/i,
  /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/,
  /\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{10,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
];

/** True if the text looks like it contains a secret. */
export function looksLikeSecret(note: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(note));
}

/** Where a persona's `remember` writes (S19.5). The default persona: the shared file, exactly as in Phase 1. */
export interface MemoryTarget {
  write: "shared" | "scope" | "none";
  file: string;
  /** For `write: "scope"`: the scope name, shown in the announcement. */
  scope?: string;
}

export interface MemoryDeps {
  /** `config.paths.memoryFile`. */
  memoryFile: string;
  /** A persona's memory target for a conversation; absent = always the shared file (Phase 1). */
  resolveTarget?: ((conversationId: string) => MemoryTarget) | undefined;
  notifier: Notifier;
  logger?: Logger | undefined;
  /** Test seams. */
  now?: () => Date;
  maxBytes?: number;
}

function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface RememberOutcome {
  ok: boolean;
  /** Text for the model. */
  text: string;
}

/**
 * Writes one note. Writes are serialised through a promise chain so two calls never interleave.
 * Returns the outcome; throws `ToolRefusal` for a refusal (the tool turns it into an error result).
 */
export function createRemember(deps: MemoryDeps): (conversationId: string, note: string) => Promise<RememberOutcome> {
  const max = deps.maxBytes ?? MEMORY_MAX_BYTES;
  let chain: Promise<unknown> = Promise.resolve();

  const writeOne = async (conversationId: string, rawNote: string): Promise<RememberOutcome> => {
    const target: MemoryTarget = deps.resolveTarget?.(conversationId) ?? { write: "shared", file: deps.memoryFile };
    if (target.write === "none") throw new ToolRefusal("memory writes are turned off in the current persona; nothing was saved.");
    const file = target.file;
    const announce = target.scope ? `Saved to memory (scope ${target.scope})` : "Saved to memory";
    const note = rawNote.replace(/\s+/g, " ").trim();
    if (note === "") throw new ToolRefusal("the note is empty.");
    if (note.length > NOTE_MAX_CHARS) throw new ToolRefusal(`the note is longer than ${NOTE_MAX_CHARS} characters; shorten it.`);
    if (looksLikeSecret(note)) {
      deps.logger?.warn("memory.refused", { reason: "secret-shaped" });
      throw new ToolRefusal("refused: the note looks like it contains a secret (token, key, password). Nothing was saved. Never store secrets; describe the fact without the secret value.");
    }

    let existing = "";
    try {
      const st = lstatSync(file);
      if (!st.isFile()) throw new ToolRefusal("the memory file is not a regular file; nothing was saved.");
      existing = readFileSync(file, "utf8");
    } catch (e) {
      if (e instanceof ToolRefusal) throw e;
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    const prefix = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
    const line = `${prefix}- ${localDate((deps.now ?? (() => new Date()))())}: ${note}\n`;
    if (Buffer.byteLength(existing, "utf8") + Buffer.byteLength(line, "utf8") > max) {
      deps.logger?.warn("memory.full", { limitBytes: max });
      throw new ToolRefusal(`memory is full (limit ${Math.round(max / 1024)} KB), so nothing was saved. Ask the user to prune MEMORY.md, then try again.`);
    }

    mkdirSync(win32.dirname(file), { recursive: true });
    writeFileSync(file, existing + line, "utf8");
    deps.logger?.info("memory.saved", { bytes: Buffer.byteLength(line, "utf8") });

    let notified = true;
    try {
      await deps.notifier.notify(conversationId, `${announce}: ${note}`);
    } catch (e) {
      notified = false;
      deps.logger?.warn("memory.notify_failed", { error: (e as Error | undefined)?.message ?? String(e) });
    }
    return {
      ok: true,
      text: notified ? `${announce}: ${note}` : `${announce}: ${note} (the user could not be notified; mention it in your answer).`,
    };
  };

  return (conversationId, note) => {
    const next = chain.then(() => writeOne(conversationId, note));
    chain = next.catch(() => undefined);
    return next;
  };
}

export function createRememberTool(deps: MemoryDeps) {
  const remember = createRemember(deps);
  return defineTool({
    name: "remember",
    description: toolDescription("remember"),
    parameters: rememberParameters,
    replay: "unsafe",
    execute: (args: Static<typeof rememberParameters>, api: ToolExecutionApi) =>
      guarded("remember", deps.logger, async () => (await remember(String(api.conversationId), args.note)).text),
  });
}