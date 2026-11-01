import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditFileName, createAuditLog, missingAuditFields, sha256Hex } from "../src/logging/audit.js";
import { createLogger, logFileName, pruneLogs } from "../src/logging/logger.js";
import { createRedactor, errorFields, redactDeep } from "../src/logging/redact.js";
import type { AuditEvent } from "../src/contracts.js";

const TG = "123456789:AAH-secret_telegram-token";
const LM = "lm-studio-token-0123456789";
const SK = "strata-api-key-ABCDEFGHIJ";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "a7-log-"));
}

test("redaction covers all three secrets and the bot URL pattern", () => {
  const redact = createRedactor([TG, LM, SK]);
  const text = `tg=${TG} lm=${LM} sk=${SK} url=https://api.telegram.org/bot987654:ZZZ_yyy-123/getUpdates`;
  const out = redact(text);
  for (const s of [TG, LM, SK, "987654:ZZZ_yyy-123"]) assert.equal(out.includes(s), false, s);
  assert.match(out, /api\.telegram\.org\/bot\[REDACTED\]\/getUpdates/);
  // the pattern works even when the token is not a known secret
  assert.equal(redact("x bot42:abc-DEF_9 y"), "x bot[REDACTED] y");
  // regex metacharacters in a secret are literal
  assert.equal(createRedactor(["a.b*c(d)"])("see a.b*c(d) and aXb"), "see [REDACTED] and aXb");
  // empty or tiny secrets never wipe the text
  assert.equal(createRedactor(["", "a"])("abc"), "abc");
});

test("redactDeep and errorFields redact nested strings", () => {
  const redact = createRedactor([LM]);
  const out = redactDeep({ a: [`x ${LM}`, { b: LM }], n: 5 }, redact);
  assert.equal(JSON.stringify(out).includes(LM), false);
  assert.equal(out.n, 5);
  const f = errorFields(new Error(`failed with ${LM}`), redact);
  assert.equal(f.error.includes(LM), false);
});

test("logger writes JSONL to a daily file, redacts, and drops message text unless debug", () => {
  const dir = tmp();
  try {
    const now = new Date("2026-10-29T10:00:00Z");
    const redact = createRedactor([TG, LM, SK]);
    const log = createLogger({ dir, redact, now: () => now });
    log.info("hello", { token: TG, text: "private message text", n: 1 });
    log.debug("not written", {});
    log.error("boom", { err: `url https://api.telegram.org/bot55:abcDEF/send ${LM}` });
    const file = join(dir, "agent-2026-10-29.jsonl");
    assert.equal(logFileName(now), "agent-2026-10-29.jsonl");
    const raw = readFileSync(file, "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.["event"], "hello");
    assert.equal(lines[0]?.["text"], undefined);
    assert.equal(lines[0]?.["n"], 1);
    for (const s of [TG, LM, SK, "55:abcDEF"]) assert.equal(raw.includes(s), false, s);

    const dbg = createLogger({ dir, redact, level: "debug", now: () => now });
    dbg.debug("dbg", { text: "now visible" });
    assert.match(readFileSync(file, "utf8"), /now visible/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logger keeps 14 days: older agent-*.jsonl files are pruned, others are left alone", () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    for (const n of ["agent-2026-10-01.jsonl", "agent-2026-10-14.jsonl", "agent-2026-10-15.jsonl", "agent-2026-10-29.jsonl", "notes.txt"]) writeFileSync(join(dir, n), "x");
    const removed = pruneLogs(dir, new Date("2026-10-29T00:00:00Z"), 14);
    assert.deepEqual(removed.sort(), ["agent-2026-10-01.jsonl", "agent-2026-10-14.jsonl"]);
    assert.deepEqual(readdirSync(dir).sort(), ["agent-2026-10-15.jsonl", "agent-2026-10-29.jsonl", "notes.txt"]);
    // a new day triggers pruning through the logger itself
    const log = createLogger({ dir, redact: createRedactor([]), now: () => new Date("2026-10-30T00:00:00Z") });
    log.info("x");
    assert.equal(existsSync(join(dir, "agent-2026-10-15.jsonl")), false);
    assert.equal(existsSync(join(dir, "agent-2026-10-30.jsonl")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const REQUESTED: AuditEvent = { event: "requested", ts: "2026-10-29T10:00:00.000Z", id: "a1", conversationId: "c1", chatId: 7, command: "Get-Process", reason: "check", cwd: "C:\\w", deadline: 1 };

test("audit: monthly file, append-only JSON lines with the required fields, secrets redacted", () => {
  const dir = tmp();
  try {
    const now = new Date("2026-10-29T10:00:00Z");
    const audit = createAuditLog({ dir, redact: createRedactor([LM]), now: () => now });
    const full = "line1\nline2";
    const events: AuditEvent[] = [
      { ...REQUESTED, command: `echo ${LM}` },
      { event: "decided", ts: "t", id: "a1", approved: true, by: "user", userId: 7, at: 5 },
      { event: "started", ts: "t", id: "a1", command: "Get-Process", cwd: "C:\\w", timeoutSec: 120 },
      { event: "finished", ts: "t", id: "a1", exitCode: 0, durationMs: 12, bytes: full.length, sha256: sha256Hex(full) },
      { event: "blocked", ts: "t", id: "a2", command: "dir", reason: "killswitch" },
    ];
    for (const e of events) audit.write(e);
    assert.equal(auditFileName(now), "shell-202610.jsonl");
    const raw = readFileSync(join(dir, "shell-202610.jsonl"), "utf8");
    assert.equal(raw.includes(LM), false);
    const parsed = raw.trim().split("\n").map((l) => JSON.parse(l) as AuditEvent);
    assert.deepEqual(parsed.map((p) => p.event), ["requested", "decided", "started", "finished", "blocked"]);
    for (const p of parsed) assert.deepEqual(missingAuditFields(p), []);
    // a second writer appends rather than truncating
    createAuditLog({ dir, redact: createRedactor([]), now: () => now }).write(events[4] as AuditEvent);
    assert.equal(readFileSync(join(dir, "shell-202610.jsonl"), "utf8").trim().split("\n").length, 6);
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit refuses an event with a missing required field", () => {
  const dir = tmp();
  try {
    const audit = createAuditLog({ dir, redact: createRedactor([]) });
    const bad = { event: "finished", ts: "t", id: "x", exitCode: 0 } as unknown as AuditEvent;
    assert.deepEqual(missingAuditFields(bad).sort(), ["bytes", "durationMs", "sha256"]);
    assert.throws(() => audit.write(bad), /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
