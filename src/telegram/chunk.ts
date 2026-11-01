/**
 * Message chunking (S4.3). Telegram allows at most 4096 characters (UTF-16 code units) per text message.
 * `chunkText` splits without losing a character, never splits a surrogate pair, and prefers a newline,
 * then a space, near the end of each window.
 */

export const TELEGRAM_LIMIT = 4096;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Splits `text` into pieces of at most `limit` UTF-16 code units whose concatenation equals `text`.
 * Returns `[]` for an empty string.
 */
export function chunkText(text: string, limit: number = TELEGRAM_LIMIT): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError("chunk limit must be an integer of at least 2");
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (text.length - start <= limit) {
      out.push(text.slice(start));
      break;
    }
    let end = start + limit;
    // Prefer a soft break (after a newline, else after a space) in the last half of the window.
    const floor = start + Math.floor(limit / 2);
    let soft = -1;
    for (let i = end; i > floor; i--) {
      if (text.charCodeAt(i - 1) === 10) {
        soft = i;
        break;
      }
    }
    if (soft < 0) {
      for (let i = end; i > floor; i--) {
        if (text.charCodeAt(i - 1) === 32) {
          soft = i;
          break;
        }
      }
    }
    if (soft > 0) end = soft;
    // Never cut between a high and a low surrogate.
    if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}

/** Chunks that Telegram would accept: whitespace-only pieces are dropped. */
export function sendableChunks(text: string, limit: number = TELEGRAM_LIMIT): string[] {
  return chunkText(text, limit).filter((c) => c.trim() !== "");
}

/** The last `limit` characters of `text` (never starting inside a surrogate pair), with a leading ellipsis if cut. */
export function tailText(text: string, limit: number = TELEGRAM_LIMIT - 16): string {
  if (text.length <= limit) return text;
  let from = text.length - limit;
  if (isLowSurrogate(text.charCodeAt(from)) && isHighSurrogate(text.charCodeAt(from - 1))) from += 1;
  return `…${text.slice(from)}`;
}
