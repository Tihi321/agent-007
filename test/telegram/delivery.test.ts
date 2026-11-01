import assert from "node:assert/strict";
import { test } from "node:test";
import { GrammyError, HttpError } from "grammy";
import { isNotModified, isPermanentTelegramError, requestIdFor, unansweredNotice, withTelegramRetry } from "../../src/telegram/delivery.js";

const grammy = (code: number, description: string, retry_after?: number) =>
  new GrammyError(description, { ok: false, error_code: code, description, ...(retry_after !== undefined ? { parameters: { retry_after } } : {}) } as never, "sendMessage", {});

function policy(sleeps: number[]) {
  return { attempts: 4, baseDelayMs: 10, maxDelayMs: 10_000, sleep: async (ms: number) => void sleeps.push(ms) };
}

test("retry: a network error is retried with backoff and then succeeds", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const out = await withTelegramRetry(async () => {
    if (++calls < 3) throw new HttpError("net", new Error("ECONNRESET"));
    return "ok";
  }, policy(sleeps));
  assert.equal(out, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test("retry: 429 honours retry_after, 5xx is retried", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await withTelegramRetry(async () => {
    calls++;
    if (calls === 1) throw grammy(429, "Too Many Requests: retry after 3", 3);
    if (calls === 2) throw grammy(502, "Bad Gateway");
    return 1;
  }, policy(sleeps));
  assert.equal(calls, 3);
  assert.equal(sleeps[0], 3000);
  assert.equal(sleeps[1], 20);
});

test("retry: a permanent error (400, 403) is not retried; an unknown error is not retried; attempts are capped", async () => {
  let calls = 0;
  await assert.rejects(
    withTelegramRetry(async () => {
      calls++;
      throw grammy(403, "Forbidden: bot was blocked by the user");
    }, policy([])),
    GrammyError,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    withTelegramRetry(async () => {
      calls++;
      throw new TypeError("bug");
    }, policy([])),
    TypeError,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    withTelegramRetry(async () => {
      calls++;
      throw new HttpError("net", new Error("x"));
    }, policy([])),
    HttpError,
  );
  assert.equal(calls, 4);
});

test("error classification and notices", () => {
  assert.equal(isPermanentTelegramError(grammy(400, "Bad Request")), true);
  assert.equal(isPermanentTelegramError(grammy(429, "slow down", 1)), false);
  assert.equal(isPermanentTelegramError(new Error("x")), false);
  assert.equal(isNotModified(grammy(400, "Bad Request: message is not modified: specified new message content...")), true);
  assert.equal(isNotModified(grammy(400, "Bad Request: chat not found")), false);
  assert.equal(requestIdFor(5, 9), "tg:5:9");
  assert.equal(unansweredNotice("aborted"), undefined);
  assert.match(unansweredNotice("model_error") ?? "", /model returned an error/);
  assert.match(unansweredNotice("restart_limit") ?? "", /restart_limit/);
});
