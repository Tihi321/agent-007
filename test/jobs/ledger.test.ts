/** S14.4: the Flow ledger (pure edits). The guard on the real Harness is in flowGuard.test.ts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chargeDirect,
  closeEntry,
  dayKey,
  emptyLedger,
  entryRemaining,
  findBudget,
  isCredits,
  openEntry,
  readLedger,
  recordJobCharge,
  recordReported,
  totalsForDay,
} from "../../src/jobs/ledger.js";

const open = (doc = emptyLedger(), over: Partial<Parameters<typeof openEntry>[1]> = {}) =>
  openEntry(doc, { jobId: "job-1", conversationId: "1", templateId: "video-short", approved: 40, userId: 4242, at: Date.parse("2026-10-29T10:00:00"), ...over });

test("isCredits: only a finite number above zero", () => {
  for (const v of [1, 0.5, 150]) assert.equal(isCredits(v), true);
  for (const v of [0, -1, NaN, Infinity, "10", null, undefined, {}]) assert.equal(isCredits(v), false);
});

test("openEntry: creates the entry with the approved number, idempotent, refuses a zero number", () => {
  const doc = emptyLedger();
  const e = open(doc);
  assert.equal(e.approved, 40);
  assert.equal(e.open, true);
  assert.equal(e.day, "2026-10-29");
  assert.equal(entryRemaining(e), 40);
  open(doc, { approved: 9999 });
  assert.equal(doc.entries["job-1"]?.approved, 40, "a rerun never raises the approved number");
  assert.throws(() => open(emptyLedger(), { approved: 0 }), RangeError);
  assert.throws(() => open(emptyLedger(), { approved: Number.NaN }), RangeError);
});

test("findBudget: no entry blocks, however small the call", () => {
  const v = findBudget(emptyLedger(), "1", 1);
  assert.equal(v.ok, false);
  if (!v.ok) {
    assert.equal(v.reason, "no_entry");
    assert.match(v.text, /no approved Flow job/);
  }
});

test("findBudget: under, exactly at and over the remaining credits", () => {
  const doc = emptyLedger();
  open(doc);
  assert.equal(findBudget(doc, "1", 39.5).ok, true);
  assert.equal(findBudget(doc, "1", 40).ok, true, "exactly at budget is allowed");
  const over = findBudget(doc, "1", 40.01);
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.reason, "over_budget");
});

test("findBudget: only an open entry of the same conversation counts", () => {
  const doc = emptyLedger();
  open(doc);
  assert.equal(findBudget(doc, "2", 1).ok, false, "another conversation has no budget");
  closeEntry(doc, "job-1");
  assert.equal(findBudget(doc, "1", 1).ok, false, "a closed entry is not spendable");
});

test("findBudget: with several open entries the oldest one that covers the call is used", () => {
  const doc = emptyLedger();
  open(doc, { jobId: "job-a", approved: 10, at: 1 });
  open(doc, { jobId: "job-b", approved: 50, at: 2 });
  const v = findBudget(doc, "1", 30);
  assert.equal(v.ok && v.jobId, "job-b");
  const small = findBudget(doc, "1", 5);
  assert.equal(small.ok && small.jobId, "job-a");
});

test("chargeDirect: charges before the call, once per call key, and never past the approved number", () => {
  const doc = emptyLedger();
  open(doc);
  const a = chargeDirect(doc, "1", "1/call-1", 30, 5);
  assert.deepEqual(a.ok && [a.jobId, a.remaining, a.duplicate], ["job-1", 10, false]);
  const again = chargeDirect(doc, "1", "1/call-1", 30, 6);
  assert.equal(again.ok && again.duplicate, true);
  assert.equal(doc.entries["job-1"]?.directCharged, 30, "the same call is not charged twice");
  const over = chargeDirect(doc, "1", "1/call-2", 11, 7);
  assert.equal(over.ok, false);
  assert.equal(doc.entries["job-1"]?.directCharged, 30, "a refused call charges nothing");
  assert.equal(chargeDirect(doc, "1", "1/call-3", 10, 8).ok, true);
  assert.equal(entryRemaining(doc.entries["job-1"]!), 0);
  assert.equal(chargeDirect(doc, "1", "1/call-4", 0.1, 9).ok, false);
});

test("the job runner's charges and the agent's own calls draw on the same approved number", () => {
  const doc = emptyLedger();
  open(doc);
  recordJobCharge(doc, "job-1", 25);
  recordJobCharge(doc, "job-1", 20); // an older total never lowers it
  assert.equal(doc.entries["job-1"]?.jobCharged, 25);
  assert.equal(entryRemaining(doc.entries["job-1"]!), 15);
  assert.equal(chargeDirect(doc, "1", "1/c", 16, 1).ok, false);
  assert.equal(chargeDirect(doc, "1", "1/c", 15, 1).ok, true);
  recordJobCharge(doc, "nope", 5); // an unknown job is ignored
  assert.equal(doc.entries["nope"], undefined);
});

test("totalsForDay: approved, charged and reported credits of one local day", () => {
  const doc = emptyLedger();
  open(doc, { jobId: "a", approved: 40, at: Date.parse("2026-10-29T09:00:00") });
  open(doc, { jobId: "b", approved: 20, at: Date.parse("2026-10-29T12:00:00") });
  open(doc, { jobId: "c", approved: 99, at: Date.parse("2026-10-28T12:00:00") });
  recordJobCharge(doc, "a", 30);
  recordReported(doc, "a", 22);
  recordReported(doc, "a", -5); // refused
  assert.deepEqual(totalsForDay(doc, "2026-10-29"), { day: "2026-10-29", jobs: 2, approved: 60, charged: 30, reported: 22 });
  assert.equal(totalsForDay(undefined, "2026-10-29").jobs, 0);
  assert.equal(dayKey(Date.parse("2026-01-05T08:00:00")), "2026-01-05");
});

test("readLedger: undefined becomes an empty ledger and the copy is detached", () => {
  assert.deepEqual(readLedger(undefined), { entries: {}, calls: {} });
  const doc = emptyLedger();
  open(doc);
  const copy = readLedger(doc);
  assert.notEqual(copy.entries, doc.entries);
});
