/** S9.3: framing, parsing, decode checks, nonce cache. Pure, no sockets. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { IpcKey } from "../../src/ipc/hmac.js";
import {
  CLIENT_ACCEPTS,
  EVENT_TYPES,
  IpcProtocolError,
  LineSplitter,
  MAX_CLOCK_SKEW_MS,
  MAX_LINE_BYTES,
  MESSAGE_TYPES,
  NONCE_TTL_MS,
  NonceCache,
  REQUEST_TYPES,
  SERVER_ACCEPTS,
  SERVER_REPLIES_TO,
  assertLoopbackHost,
  decodeLine,
  encodeLine,
  looksLikeHttp,
  parseLine,
  signMessage,
} from "../../src/ipc/protocol.js";
import type { DecodeOptions, IpcMessage, RejectReason } from "../../src/ipc/protocol.js";
import { KEY_TEXT_A, KEY_TEXT_B } from "./helpers.js";

const key = IpcKey.fromBase64Url(KEY_TEXT_A);
const otherKey = IpcKey.fromBase64Url(KEY_TEXT_B);

function opts(over: Partial<DecodeOptions> & { now?: () => number } = {}): DecodeOptions {
  return { keys: () => [{ key, principal: "main" }], nonces: new NonceCache(), accepts: SERVER_ACCEPTS, ...over };
}
function reason(fn: () => unknown): RejectReason {
  try {
    fn();
  } catch (e) {
    if (e instanceof IpcProtocolError) return e.reason;
    throw e;
  }
  assert.fail("expected a rejection");
}
const line = (m: IpcMessage): string => JSON.stringify(m);

test("the message types are exactly the plan's six requests plus flow_estimate, four events and the reply", () => {
  assert.deepEqual([...REQUEST_TYPES], ["submit", "cancel", "status", "list_templates", "hub_status", "hub_start", "flow_estimate"]);
  assert.deepEqual([...EVENT_TYPES], ["job_event", "permission_request", "permission_decision", "job_done"]);
  assert.equal(MESSAGE_TYPES.length, 12);
  // direction: the runner never accepts runner-to-agent pushes, the agent never accepts requests
  assert.equal(SERVER_ACCEPTS.has("job_event"), false);
  assert.equal(SERVER_ACCEPTS.has("job_done"), false);
  assert.equal(SERVER_ACCEPTS.has("reply"), false);
  assert.equal(CLIENT_ACCEPTS.has("submit"), false);
  assert.equal(CLIENT_ACCEPTS.has("permission_decision"), false);
  assert.equal(SERVER_REPLIES_TO.has("permission_decision"), false);
  assert.equal(SERVER_REPLIES_TO.has("permission_request"), true, "the permission helper gets a reply");
});

test("a valid message round trips through encode, parse and decode", () => {
  const msg = signMessage(key, "submit", { jobId: "j1", nested: { a: [1, 2] } });
  const wire = encodeLine(msg);
  assert.equal(wire[wire.length - 1], 0x0a);
  const parsed = parseLine(wire.toString("utf8").trimEnd());
  assert.deepEqual(parsed, msg);
  const d = decodeLine(wire.toString("utf8").trimEnd(), opts());
  assert.equal(d.principal, "main");
  assert.equal(d.msg.type, "submit");
  assert.deepEqual(d.msg.body, { jobId: "j1", nested: { a: [1, 2] } });
});

test("LineSplitter joins chunks, handles several lines in one chunk, drops \\r", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push(Buffer.from('{"a":')), []);
  assert.deepEqual(s.push(Buffer.from('1}\r\n{"b":2}\n{"c"')), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(s.push(Buffer.from(":3}\n")), ['{"c":3}']);
  assert.deepEqual(s.push(Buffer.from("\n")), [""]);
});

test("LineSplitter rejects a line over the limit, also while it is still incomplete", () => {
  const s = new LineSplitter(100);
  assert.deepEqual(s.push(Buffer.alloc(100, 0x41)), []);
  assert.equal(reason(() => s.push(Buffer.from("B"))), "oversize");
  const t = new LineSplitter(100);
  assert.equal(reason(() => t.push(Buffer.concat([Buffer.alloc(101, 0x41), Buffer.from("\n")]))), "oversize");
  // a complete line exactly at the limit is fine
  const u = new LineSplitter(100);
  assert.equal(u.push(Buffer.concat([Buffer.alloc(100, 0x41), Buffer.from("\n")]))[0]?.length, 100);
  assert.equal(MAX_LINE_BYTES, 1024 * 1024);
});

test("an HTTP-shaped request line is recognised; JSON lines are not", () => {
  for (const l of ["POST / HTTP/1.1", "GET /status HTTP/1.1", "get / http/1.0", "OPTIONS * HTTP/1.1", "PRI * HTTP/2.0", "POST /submit"]) assert.equal(looksLikeHttp(l), true, l);
  for (const l of ['{"v":1}', "", "hello", "POSTER x"]) assert.equal(looksLikeHttp(l), false, l);
  assert.equal(reason(() => parseLine("POST / HTTP/1.1")), "http_shaped");
  assert.equal(reason(() => parseLine("GET /x HTTP/1.1")), "http_shaped");
});

test("parseLine refuses anything but the exact field set and types", () => {
  const good = signMessage(key, "status", {});
  const bad = (patch: Record<string, unknown>, drop?: string): string => {
    const o: Record<string, unknown> = { ...good, ...patch };
    if (drop) delete o[drop];
    return JSON.stringify(o);
  };
  assert.equal(reason(() => parseLine("not json")), "malformed");
  assert.equal(reason(() => parseLine("[1,2]")), "malformed");
  assert.equal(reason(() => parseLine("null")), "malformed");
  assert.equal(reason(() => parseLine(bad({ extra: 1 }))), "malformed", "unauthenticated extra field");
  for (const f of ["v", "id", "ts", "nonce", "type", "body", "mac"]) assert.equal(reason(() => parseLine(bad({}, f))), f === "v" ? "malformed" : "malformed", "missing " + f);
  assert.equal(reason(() => parseLine(bad({ v: 2 }))), "unsupported_version");
  assert.equal(reason(() => parseLine(bad({ id: "has space" }))), "malformed");
  assert.equal(reason(() => parseLine(bad({ nonce: "short" }))), "malformed");
  assert.equal(reason(() => parseLine(bad({ ts: "now" }))), "malformed");
  assert.equal(reason(() => parseLine(bad({ ts: 1.5 }))), "malformed");
  assert.equal(reason(() => parseLine(bad({ type: "format_disk" }))), "bad_type");
  assert.equal(reason(() => parseLine(bad({ body: [] }))), "malformed");
  assert.equal(reason(() => parseLine(bad({ body: null }))), "malformed");
  assert.equal(reason(() => parseLine(bad({ mac: "abc" }))), "malformed");
});

test("decode: a wrong MAC, a tampered body, and a wrong key are bad_mac", () => {
  const msg = signMessage(key, "cancel", { jobId: "j1" });
  assert.equal(reason(() => decodeLine(line({ ...msg, mac: "0".repeat(64) }), opts())), "bad_mac");
  assert.equal(reason(() => decodeLine(line({ ...msg, body: { jobId: "j2" } }), opts())), "bad_mac");
  assert.equal(reason(() => decodeLine(line({ ...msg, type: "submit" }), opts())), "bad_mac");
  assert.equal(reason(() => decodeLine(line(signMessage(otherKey, "cancel", { jobId: "j1" })), opts())), "bad_mac");
  assert.equal(reason(() => decodeLine(line(msg), opts({ keys: () => [] }))), "bad_mac");
});

test("decode: ts off by more than 60 s either way is stale; 60 s exactly is accepted", () => {
  const t0 = 1_730_000_000_000;
  const at = (ts: number): IpcMessage => signMessage(key, "status", {}, { now: () => ts });
  assert.equal(MAX_CLOCK_SKEW_MS, 60_000);
  assert.equal(reason(() => decodeLine(line(at(t0 - 60_001)), opts({ now: () => t0 }))), "stale");
  assert.equal(reason(() => decodeLine(line(at(t0 + 60_001)), opts({ now: () => t0 }))), "stale");
  assert.equal(decodeLine(line(at(t0 - 60_000)), opts({ now: () => t0 })).msg.type, "status");
  assert.equal(decodeLine(line(at(t0 + 60_000)), opts({ now: () => t0 })).msg.type, "status");
});

test("decode: a nonce seen before is a replay, also with a fresh id; a different nonce is fine", () => {
  const o = opts();
  const msg = signMessage(key, "status", {});
  decodeLine(line(msg), o);
  assert.equal(reason(() => decodeLine(line(msg), o)), "replay");
  // same nonce, re-signed with another id (an attacker cannot do this without the key, but the cache must still say no)
  const again = signMessage(key, "status", {}, { nonce: msg.nonce });
  assert.equal(reason(() => decodeLine(line(again), o)), "replay");
  decodeLine(line(signMessage(key, "status", {})), o);
});

test("decode: a bad MAC does not use up a nonce (unauthenticated traffic cannot fill the cache)", () => {
  const o = opts();
  const msg = signMessage(key, "status", {});
  assert.equal(reason(() => decodeLine(line({ ...msg, mac: "1".repeat(64) }), o)), "bad_mac");
  assert.equal(o.nonces.size, 0);
  decodeLine(line(msg), o);
  assert.equal(o.nonces.size, 1);
});

test("decode: a type that this side does not accept is bad_type even with a valid MAC", () => {
  assert.equal(reason(() => decodeLine(line(signMessage(key, "job_event", {})), opts())), "bad_type");
  assert.equal(reason(() => decodeLine(line(signMessage(key, "submit", {})), opts({ accepts: CLIENT_ACCEPTS }))), "bad_type");
});

test("decode: the key list sees the type and body, so a per-job key can be picked from body.jobId (I28)", () => {
  const jobKey = IpcKey.fromBase64Url(KEY_TEXT_B);
  const keys: DecodeOptions["keys"] = (peek) => {
    const jobId = typeof peek.body["jobId"] === "string" ? peek.body["jobId"] : undefined;
    return [{ key, principal: "main" }, ...(jobId === "job-1" ? [{ key: jobKey, principal: "job:job-1" }] : [])];
  };
  const ok = decodeLine(line(signMessage(jobKey, "permission_request", { jobId: "job-1", requestId: "r" })), opts({ keys }));
  assert.equal(ok.principal, "job:job-1");
  // another job's token does not verify for this job id
  const wrong = signMessage(jobKey, "permission_request", { jobId: "job-2", requestId: "r" });
  assert.equal(reason(() => decodeLine(line(wrong), opts({ keys }))), "bad_mac");
  // the job token does not authenticate a non-permission request as main
  assert.equal(decodeLine(line(signMessage(key, "status", {})), opts({ keys })).principal, "main");
});

test("NonceCache: entries expire after the TTL and the cache is bounded", () => {
  let now = 1000;
  const c = new NonceCache(NONCE_TTL_MS, 3, () => now);
  assert.equal(NONCE_TTL_MS, 300_000);
  c.remember("a");
  assert.equal(c.has("a"), true);
  now += NONCE_TTL_MS - 1;
  assert.equal(c.has("a"), true);
  now += 2;
  assert.equal(c.has("a"), false, "expired");
  now += 10;
  for (const n of ["n1", "n2", "n3", "n4"]) c.remember(n);
  assert.equal(c.size, 3);
  assert.equal(c.has("n1"), false, "the oldest was evicted");
  assert.equal(c.has("n4"), true);
});

test("encode refuses a message over 1 MiB; the loopback assertion accepts only 127.0.0.1", () => {
  const huge = signMessage(key, "submit", { text: "x".repeat(MAX_LINE_BYTES) });
  assert.throws(() => encodeLine(huge), /larger than/);
  assertLoopbackHost("127.0.0.1");
  for (const h of ["localhost", "0.0.0.0", "::", "::1", "192.168.1.5", "example.com", ""]) assert.throws(() => assertLoopbackHost(h), /127\.0\.0\.1/, h);
});
