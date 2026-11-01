import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Notifier } from "../../src/contracts.js";
import { ToolRefusal } from "../../src/tools/folders.js";
import { MEMORY_MAX_BYTES, createRemember, createRememberTool, looksLikeSecret } from "../../src/tools/memory.js";
import { cleanup, tempBase } from "./fixture.js";

let base: string;
let n = 0;

before(() => {
  base = tempBase("memory");
});
after(() => cleanup(base));

function fakeNotifier(fail = false): Notifier & { calls: { conversationId: string; text: string }[] } {
  const calls: { conversationId: string; text: string }[] = [];
  return {
    calls,
    async notify(conversationId, text) {
      calls.push({ conversationId, text });
      if (fail) throw new Error("telegram down");
    },
  };
}

function setup(opts: { maxBytes?: number; notifier?: ReturnType<typeof fakeNotifier> } = {}) {
  const memoryFile = join(base, `m${++n}`, "memory", "MEMORY.md");
  const notifier = opts.notifier ?? fakeNotifier();
  const remember = createRemember({ memoryFile, notifier, now: () => new Date(2026, 9, 29, 12, 0, 0), ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}) });
  return { memoryFile, notifier, remember };
}

test("appends '- YYYY-MM-DD: <note>' lines and creates the file and its folder", async () => {
  const { memoryFile, remember } = setup();
  assert.equal(existsSync(memoryFile), false);
  const r1 = await remember("conv-1", "The user prefers short answers.");
  assert.equal(r1.ok, true);
  await remember("conv-1", "Main PC is named STRIX.");
  assert.equal(readFileSync(memoryFile, "utf8"), "- 2026-10-29: The user prefers short answers.\n- 2026-10-29: Main PC is named STRIX.\n");
});

test("notes are collapsed to one line, and an existing file without a trailing newline stays well-formed", async () => {
  const { memoryFile, remember } = setup();
  await remember("c", "line one\n- 1999-01-01: forged entry\r\n   line   three");
  assert.equal(readFileSync(memoryFile, "utf8"), "- 2026-10-29: line one - 1999-01-01: forged entry line three\n");
  writeFileSync(memoryFile, "- 2026-01-01: old without newline");
  await remember("c", "next");
  assert.equal(readFileSync(memoryFile, "utf8"), "- 2026-01-01: old without newline\n- 2026-10-29: next\n");
});

test("the notifier is called exactly once per write, with the conversation id and the note", async () => {
  const { notifier, remember } = setup();
  await remember("conv-42", "Likes tea.");
  assert.equal(notifier.calls.length, 1);
  assert.deepEqual(notifier.calls[0], { conversationId: "conv-42", text: "Saved to memory: Likes tea." });
  await remember("conv-43", "Likes coffee.");
  assert.equal(notifier.calls.length, 2);
});

test("a notifier failure keeps the write, tells the model, and does not retry", async () => {
  const notifier = fakeNotifier(true);
  const { memoryFile, remember } = setup({ notifier });
  const r = await remember("c", "A fact.");
  assert.equal(r.ok, true);
  assert.match(r.text, /could not be notified/);
  assert.equal(notifier.calls.length, 1);
  assert.equal(readFileSync(memoryFile, "utf8").split("\n").filter(Boolean).length, 1);
});

test("the 16 KB cap refuses with a prune message, writes nothing and does not notify", async () => {
  assert.equal(MEMORY_MAX_BYTES, 16 * 1024);
  const { memoryFile, notifier, remember } = setup({ maxBytes: 200 });
  await remember("c", "short note ".repeat(9).trim());
  const before = readFileSync(memoryFile, "utf8");
  await assert.rejects(remember("c", "another note ".repeat(11).trim()), (e: unknown) => e instanceof ToolRefusal && /full.*prune/i.test(e.message));
  assert.equal(readFileSync(memoryFile, "utf8"), before);
  assert.equal(notifier.calls.length, 1, "only the first write was announced");
});

test("the default cap is 16384 bytes of file content", async () => {
  const { memoryFile, remember } = setup();
  const chunk = "word ".repeat(90).trim(); // 449 chars, under the 500 note limit, no secret shape
  let writes = 0;
  for (;;) {
    try {
      await remember("c", chunk);
      writes++;
    } catch (e) {
      assert.ok(e instanceof ToolRefusal);
      break;
    }
    assert.ok(writes < 100, "must hit the cap");
  }
  const size = readFileSync(memoryFile).length;
  assert.ok(size <= MEMORY_MAX_BYTES && size > MEMORY_MAX_BYTES - 600, `size ${size}`);
});

test("secret-shaped notes are refused: base64/hex runs, bot tokens, sk- keys, password, PEM, JWT, cloud keys", async () => {
  const secrets = [
    "key is dGhpc2lzYXZlcnlsb25nYmFzZTY0c3RyaW5nMTIzNDU2Nzg5MA==",
    "hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "token 123456789:AAFgh-ijkLmnOpQrStuVwxyz_0123456789ab",
    "bot123456:ABC",
    "my key sk-abc123",
    "OpenAI sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    "The Password is hunter2",
    "my passphrase is long",
    "-----BEGIN RSA PRIVATE KEY-----",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
    "aws AKIAIOSFODNN7EXAMPLE",
    "github ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  ];
  const { memoryFile, notifier, remember } = setup();
  for (const s of secrets) {
    await assert.rejects(remember("c", s), (e: unknown) => e instanceof ToolRefusal && /secret/.test(e.message), s);
    assert.equal(looksLikeSecret(s), true, s);
  }
  assert.equal(existsSync(memoryFile), false, "nothing written");
  assert.equal(notifier.calls.length, 0, "nothing announced");
  // ordinary notes pass
  for (const ok of ["Prefers dark mode and short answers.", "Wife's name is Anna, birthday 12 May.", "Uses C:\\projects\\Personal for hobby code.", "Task-tracking app is called desk-top-notes."]) {
    assert.equal(looksLikeSecret(ok), false, ok);
  }
});

test("an empty or over-long note is refused", async () => {
  const { remember } = setup();
  await assert.rejects(remember("c", "   \n "), ToolRefusal);
  await assert.rejects(remember("c", "z ".repeat(300)), ToolRefusal);
});

test("concurrent writes are serialised: every note lands once, in order, with one announcement each", async () => {
  const { memoryFile, notifier, remember } = setup();
  await Promise.all(Array.from({ length: 10 }, (_, i) => remember("c", `fact number ${i}`)));
  const lines = readFileSync(memoryFile, "utf8").trim().split("\n");
  assert.deepEqual(
    lines,
    Array.from({ length: 10 }, (_, i) => `- 2026-10-29: fact number ${i}`),
  );
  assert.equal(notifier.calls.length, 10);
});

test("a refused write after a good one does not break the queue", async () => {
  const { remember } = setup();
  const results = await Promise.allSettled([remember("c", "good one"), remember("c", "password is x"), remember("c", "good two")]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
});

test("remember tool: replay unsafe, conversation id reaches the notifier, refusals are error results", async () => {
  const notifier = fakeNotifier();
  const memoryFile = join(base, "tool", "memory", "MEMORY.md");
  const tool = createRememberTool({ memoryFile, notifier, now: () => new Date(2026, 0, 2) });
  assert.equal(tool.name, "remember");
  assert.equal(tool.replay, "unsafe");
  const api = { conversationId: 17 } as never;
  const ok = await tool.execute({ note: "Has a cat named Miso." }, api, {} as never);
  assert.equal(ok.isError, undefined);
  assert.match(JSON.stringify(ok.output), /Saved to memory: Has a cat named Miso\./);
  assert.deepEqual(notifier.calls, [{ conversationId: "17", text: "Saved to memory: Has a cat named Miso." }]);
  assert.equal(readFileSync(memoryFile, "utf8"), "- 2026-01-02: Has a cat named Miso.\n");
  const bad = await tool.execute({ note: "api key sk-live-12345" }, api, {} as never);
  assert.equal(bad.isError, true);
  assert.equal(notifier.calls.length, 1);
});
