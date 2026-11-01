import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createSettingsAudit, auditFileName, readAuditTail, lastRevisions, MAX_LINE_BYTES, SECRET_PLACEHOLDER } from "../../src/settings/audit.js";
import { verifyAuditText, GENESIS_HASH } from "../../src/settings/chain.js";
import { SettingsError } from "../../src/settings/contracts.js";
import type { AuditEntryInput } from "../../src/settings/contracts.js";
import { recordRevisions } from "../../src/settings/drift.js";
import { ABSENT_REVISION, replaceAudited, revisionOf } from "../../src/settings/store.js";
import type { ReplaceFs } from "../../src/settings/store.js";
import { readLines, tempDir } from "./helpers.js";

const entry = (over: Partial<AuditEntryInput> = {}): AuditEntryInput => ({
  source: "propose",
  kind: "setting",
  target: { file: "prefs.json", path: "style.tone" },
  diff: [{ path: "style.tone", op: "replace", before: "neutral", after: "friendly" }],
  decision: "approved",
  approver: { kind: "tg", userId: 4242 },
  proposalId: "abcd1234",
  baseRevision: "aaa",
  afterRevision: "bbb",
  ...over,
});

const fixedNow = (iso: string) => () => new Date(iso);

test("line shape: every required field, one line per entry, a monthly file name from the UTC date", () => {
  const dir = tempDir("a7-aud-");
  const audit = createSettingsAudit({ dir, writer: "agent", now: fixedNow("2026-10-31T23:30:00Z") });
  const line = audit.append(entry());
  assert.equal(auditFileName(new Date("2026-10-31T23:30:00Z")), "settings-202610.jsonl");
  assert.deepEqual(readdirSync(dir), ["settings-202610.jsonl"]);
  const [row] = readLines(join(dir, "settings-202610.jsonl"));
  for (const k of ["v", "ts", "writer", "wseq", "prev", "h", "source", "kind", "target", "diff", "decision", "approver", "proposalId", "baseRevision", "afterRevision"]) assert.ok(row?.[k] !== undefined, `field ${k}`);
  assert.equal(row?.["v"], 1);
  assert.equal(row?.["writer"], "agent");
  assert.equal(row?.["wseq"], 1);
  assert.equal(row?.["prev"], GENESIS_HASH);
  assert.equal(line.h, row?.["h"]);
  assert.ok(readFileSync(join(dir, "settings-202610.jsonl"), "utf8").endsWith("\n"));
  createSettingsAudit({ dir, writer: "agent", now: fixedNow("2026-11-01T00:00:01Z") }).append(entry());
  assert.deepEqual(readdirSync(dir).sort(), ["settings-202610.jsonl", "settings-202611.jsonl"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a secret-shaped string never reaches the file (diff value or path), redact is applied, and a long value keeps its hash", () => {
  const dir = tempDir("a7-aud-");
  const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const audit = createSettingsAudit({ dir, writer: "agent", redact: (t) => t.replace(/hunter2/g, "[REDACTED]") });
  audit.append(entry({ diff: [{ path: "style.notes", op: "replace", before: "x", after: secret }], target: { file: "prefs.json", path: secret } }));
  audit.append(entry({ diff: [{ path: "style.notes", op: "replace", before: "x", after: "my word is hunter2" }] }));
  audit.append(entry({ diff: [{ path: "style.notes", op: "replace", before: "x", after: "z ".repeat(2500) }] }));
  const file = join(dir, readdirSync(dir)[0] as string);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes(secret), "no secret in the log");
  assert.ok(text.includes(SECRET_PLACEHOLDER));
  assert.ok(!text.includes("hunter2"));
  const rows = readLines(file);
  const long = (rows[2]?.["diff"] as { after: Record<string, unknown> }[])[0]?.after as Record<string, unknown>;
  assert.equal(typeof long["sha256"], "string");
  assert.equal(typeof long["truncated"], "string");
  assert.ok((long["truncated"] as string).length <= 200);
  assert.ok(Buffer.byteLength(JSON.stringify(rows[2])) < MAX_LINE_BYTES);
  rmSync(dir, { recursive: true, force: true });
});

test("a line that would exceed 8 KB is slimmed to hashes; the chain still verifies", () => {
  const dir = tempDir("a7-aud-");
  const audit = createSettingsAudit({ dir, writer: "jobrunner" });
  const diff = Array.from({ length: 40 }, (_, i) => ({ path: `p${i}`, op: "replace" as const, before: "b".repeat(1500), after: "a".repeat(1500) }));
  audit.append(entry({ diff }));
  const file = join(dir, readdirSync(dir)[0] as string);
  const raw = readFileSync(file, "utf8");
  assert.ok(Buffer.byteLength(raw) <= MAX_LINE_BYTES);
  assert.equal(verifyAuditText(raw).ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test("the chain continues after a simulated restart (the writer re-reads its last line) and each writer has its own chain", () => {
  const dir = tempDir("a7-aud-");
  const now = fixedNow("2026-10-30T10:00:00Z");
  const a1 = createSettingsAudit({ dir, writer: "agent", now });
  const j1 = createSettingsAudit({ dir, writer: "jobrunner", now });
  a1.append(entry());
  j1.append(entry({ source: "ui" }));
  const second = a1.append(entry());
  const a2 = createSettingsAudit({ dir, writer: "agent", now }); // restart
  const third = a2.append(entry());
  assert.equal(third.wseq, 3);
  assert.equal(third.prev, second.h);
  const j2 = createSettingsAudit({ dir, writer: "jobrunner", now });
  assert.equal(j2.append(entry({ source: "ui" })).wseq, 2);
  const report = verifyAuditText(readFileSync(join(dir, "settings-202610.jsonl"), "utf8"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.writers, { agent: { lines: 3, lastWseq: 3 }, jobrunner: { lines: 2, lastWseq: 2 } });
  rmSync(dir, { recursive: true, force: true });
});

test("two processes appending 300 lines each do not interleave inside a line, and both chains verify (U48b, offline)", () => {
  const dir = tempDir("a7-aud-");
  const child = join(dirname(fileURLToPath(import.meta.url)), "auditChild.js");
  const run = (writer: string) => spawnSync(process.execPath, [child, dir, writer, "300", "big"], { encoding: "utf8" });
  const procs = [run("agent"), run("jobrunner")];
  for (const p of procs) assert.equal(p.status, 0, p.stderr);
  const file = join(dir, readdirSync(dir)[0] as string);
  const report = verifyAuditText(readFileSync(file, "utf8"));
  assert.equal(report.ok, true, report.problems.slice(0, 3).join("\n"));
  assert.equal(report.lines, 600);
  rmSync(dir, { recursive: true, force: true });
});

test("an append failure aborts the caller's apply: file and log unchanged, no temp file left", async () => {
  const dir = tempDir("a7-aud-");
  const file = join(dir, "target.json");
  writeFileSync(file, '{"a":1}\n');
  const audit = createSettingsAudit({
    dir: join(dir, "audit"),
    writer: "agent",
    appendLine: () => {
      throw new Error("EACCES");
    },
  });
  await assert.rejects(
    () => replaceAudited({ file, newText: '{"a":2}\n', baseRevision: revisionOf('{"a":1}\n'), audit, entry: { source: "ui", kind: "security", target: { file: "t", path: "a" }, diff: [] } }),
    (e: unknown) => e instanceof SettingsError && e.code === "audit_failed",
  );
  assert.equal(readFileSync(file, "utf8"), '{"a":1}\n');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
  rmSync(dir, { recursive: true, force: true });
});

test("a rename failure leaves the file unchanged and adds exactly one apply_failed line; a stale base changes nothing", async () => {
  const dir = tempDir("a7-aud-");
  const file = join(dir, "target.json");
  writeFileSync(file, '{"a":1}\n');
  const audit = createSettingsAudit({ dir: join(dir, "audit"), writer: "jobrunner" });
  const real: ReplaceFs = {
    readText: (f) => (existsSync(f) ? readFileSync(f, "utf8") : undefined),
    writeText: (f, t) => writeFileSync(f, t, { flag: "wx" }),
    rename: () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
    remove: (f) => rmSync(f, { force: true }),
  };
  const base = revisionOf('{"a":1}\n');
  const slept: number[] = [];
  await assert.rejects(
    () => replaceAudited({ file, newText: '{"a":2}\n', baseRevision: base, audit, fs: real, sleep: async (ms) => void slept.push(ms), entry: { source: "ui", kind: "security", target: { file: "t", path: "a" }, diff: [] } }),
    (e: unknown) => e instanceof SettingsError && e.code === "apply_failed",
  );
  assert.equal(slept.length, 4, "five attempts with four waits");
  assert.equal(readFileSync(file, "utf8"), '{"a":1}\n');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
  const rows = readAuditTail(join(dir, "audit"), 10);
  assert.equal(rows.filter((r) => r.decision === "apply_failed").length, 1);
  const before = rows.length;
  await assert.rejects(
    () => replaceAudited({ file, newText: "x", baseRevision: "stale", audit, entry: { source: "ui", kind: "security", target: { file: "t", path: "a" }, diff: [] } }),
    (e: unknown) => e instanceof SettingsError && e.code === "stale_base",
  );
  assert.equal(readAuditTail(join(dir, "audit"), 10).length, before, "a stale save writes no line");
  rmSync(dir, { recursive: true, force: true });
});

test("a successful replace writes the audit line BEFORE the rename, with both revisions, and removes its temp file", async () => {
  const dir = tempDir("a7-aud-");
  const file = join(dir, "target.json");
  mkdirSync(dir, { recursive: true });
  const audit = createSettingsAudit({ dir: join(dir, "audit"), writer: "jobrunner" });
  const seenAtAudit: boolean[] = [];
  const wrapped = { append: (e: AuditEntryInput) => (seenAtAudit.push(existsSync(file)), audit.append(e)) };
  const r = await replaceAudited({ file, newText: "new\n", baseRevision: ABSENT_REVISION, audit: wrapped, entry: { source: "ui", kind: "security", target: { file: "t", path: "a" }, diff: [] } });
  assert.deepEqual(seenAtAudit, [false], "the target did not exist yet when the line was written");
  assert.equal(readFileSync(file, "utf8"), "new\n");
  assert.equal(r.afterRevision, revisionOf("new\n"));
  assert.equal(readAuditTail(join(dir, "audit"), 5)[0]?.afterRevision, r.afterRevision);
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
  rmSync(dir, { recursive: true, force: true });
});

test("out-of-band edits (I29b): the first sighting is loaded, a changed file is external_edit, an unchanged one writes nothing", () => {
  const dir = tempDir("a7-aud-");
  const audit = createSettingsAudit({ dir, writer: "agent" });
  const files = [{ file: "security.json", kind: "security" as const, revision: "r1" }, { file: "prefs.json", kind: "setting" as const, revision: ABSENT_REVISION }];
  assert.deepEqual(recordRevisions(audit, dir, files).map((l) => [l.target.file, l.decision]), [["security.json", "loaded"]]);
  assert.equal(recordRevisions(audit, dir, files).length, 0);
  const changed = recordRevisions(audit, dir, [{ file: "security.json", kind: "security", revision: "r2" }]);
  assert.equal(changed[0]?.decision, "external_edit");
  assert.equal(changed[0]?.source, "system");
  assert.equal(changed[0]?.baseRevision, "r1");
  assert.equal(lastRevisions(dir)["security.json"], "r2");
  rmSync(dir, { recursive: true, force: true });
});
