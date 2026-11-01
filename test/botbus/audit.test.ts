/**
 * S21.5 done-check: one line per message with the I45 fields, a body hash and no body; append-only (the U48 pattern); a
 * secret-shaped string in a body does not appear; notes (model switch, fallback, breaker) share the file; the hash chain verifies.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyAuditText } from "../../src/settings/chain.js";
import { BusAudit, busAuditFileName } from "../../src/botbus/audit.js";
import { BusError } from "../../src/botbus/contracts.js";
import { chainRig, mkBot, edge } from "./helpers.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "a7-busaudit-"));
const lines = (dir: string): Record<string, any>[] => {
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  return readFileSync(join(dir, files[0] as string), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
};
function srcAudit(): string {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++, d = dirname(d)) if (existsSync(join(d, "src", "botbus", "audit.ts"))) return join(d, "src", "botbus", "audit.ts");
  throw new Error("src/botbus/audit.ts not found");
}
const KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";

test("one line per bus message with the I45 fields and a body hash, never the body", async () => {
  const dir = tmp();
  const { bus } = chainRig({ audit: new BusAudit({ dir }) });
  bus.beginUserTurn("a", "conv-a");
  await bus.channel("a").send({ to: "b", message: `PRIVATE-BODY please use ${KEY}` }, { conversationId: "conv-a" });
  const rows = lines(dir);
  assert.deepEqual(rows.map((r) => r["type"]), ["ask", "reply"]);
  const ask = rows[0] as Record<string, any>;
  for (const k of ["ts", "chain_id", "from", "to", "hop", "origin", "taint", "body_sha256", "decision"]) assert.ok(k in ask, `field ${k}`);
  assert.equal(ask["from"], "a");
  assert.equal(ask["to"], "b");
  assert.equal(ask["origin"], "peer");
  assert.equal(ask["decision"], "delivered");
  assert.match(ask["body_sha256"], /^[0-9a-f]{64}$/);
  const raw = readFileSync(join(dir, readdirSync(dir)[0] as string), "utf8");
  assert.ok(!raw.includes("PRIVATE-BODY"), "no body in the log");
  assert.ok(!raw.includes(KEY), "a secret-shaped string in a body never appears");
  assert.ok(!raw.includes("echo:"), "no reply text either");
});

test("a denied ask is a line too, with the code and reason", async () => {
  const dir = tmp();
  const { bus } = chainRig({ audit: new BusAudit({ dir }) });
  bus.beginUserTurn("a", "conv-a");
  await assert.rejects(bus.channel("a").send({ to: "c", message: "x" }, { conversationId: "conv-a" }), (e: unknown) => e instanceof BusError && e.code === "edge_denied");
  const r = lines(dir)[0] as Record<string, any>;
  assert.equal(r["type"], "denied");
  assert.equal(r["decision"], "denied");
  assert.equal(r["reason"], "edge_denied:no_edge");
});

test("append-only: the chain verifies, an edit in the middle is detected, a new writer continues the chain", async () => {
  const dir = tmp();
  const audit = new BusAudit({ dir });
  const { bus } = chainRig({ audit });
  bus.beginUserTurn("a", "conv-a");
  for (const m of ["one", "two", "three"]) await bus.channel("a").send({ to: "b", message: m }, { conversationId: "conv-a" });
  const file = join(dir, readdirSync(dir)[0] as string);
  assert.equal(verifyAuditText(readFileSync(file, "utf8"), "bus").ok, true);
  // a second writer (a restart) appends and the chain still verifies
  const { bus: bus2 } = chainRig({ audit: new BusAudit({ dir }) });
  bus2.beginUserTurn("a", "conv-z");
  await bus2.channel("a").send({ to: "b", message: "after restart" }, { conversationId: "conv-z" });
  const text = readFileSync(file, "utf8");
  const rep = verifyAuditText(text, "bus");
  assert.equal(rep.ok, true, rep.problems.join("; "));
  assert.equal(rep.lines, 8);
  // tampering
  writeFileSync(file, text.replace('"from":"a"', '"from":"x"'), "utf8");
  assert.equal(verifyAuditText(readFileSync(file, "utf8"), "bus").ok, false);
  // the writer only appends: no rewrite mode in its source
  const src = readFileSync(srcAudit(), "utf8");
  assert.match(src, /openSync\(path, "a"\)/);
  assert.ok(!/writeFileSync|"w"|"r\+"|truncate|unlinkSync|renameSync/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "no API rewrites a line");
  appendFileSync(file, "", "utf8");
});

test("notes (model switch, fallback, breaker) go to the same file; a secret-shaped detail is omitted", () => {
  const dir = tmp();
  const { bus } = chainRig({ audit: new BusAudit({ dir }) });
  bus.recordNote({ event: "model_switch", bot: "a", detail: "lmstudio to strata" });
  bus.recordNote({ event: "fallback", bot: "b", detail: `used ${KEY}` });
  const rows = lines(dir);
  assert.equal(rows[0]?.["type"], "note");
  assert.equal(rows[0]?.["event"], "model_switch");
  assert.equal(rows[0]?.["detail"], "lmstudio to strata");
  assert.equal(rows[1]?.["detail"], "[secret-shaped text omitted]");
  assert.equal(readdirSync(dir)[0], busAuditFileName(new Date(Date.UTC(2026, 0, 1))), "the file is named by the bus clock");
  assert.equal(readdirSync(dir)[0], "bus-202601.jsonl");
});

test("a failing append fails the ask closed and counts nothing as delivered", async () => {
  const audit = new BusAudit({
    dir: tmp(),
    appendLine: () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    },
  });
  const { bus, runtimes } = chainRig({ audit });
  bus.beginUserTurn("a", "conv-a");
  await assert.rejects(bus.channel("a").send({ to: "b", message: "x" }, { conversationId: "conv-a" }), (e: unknown) => e instanceof BusError && e.code === "unavailable" && e.reason === "audit_failed");
  assert.equal(runtimes.get("b")?.calls.length, 0);
  const rig2 = chainRig({}, [mkBot("a", { edges: [edge("b")] }), mkBot("b")]);
  rig2.bus.recordNote({ event: "breaker", bot: "a", detail: "no sink is fine" });
});
