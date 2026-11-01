import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsError } from "../../src/settings/contracts.js";
import type { AuditEntryInput, SettingsAudit } from "../../src/settings/contracts.js";
import { applyToCopy } from "../../src/settings/allowlist.js";
import { parsePrefsText } from "../../src/settings/prefs.js";
import { diffValues, replaceAudited, serialize, updateAudited, withFileLock } from "../../src/settings/store.js";
import { tempDir } from "./helpers.js";

function fakeAudit(): SettingsAudit & { lines: AuditEntryInput[] } {
  const lines: AuditEntryInput[] = [];
  return { lines, append: (e: AuditEntryInput) => void lines.push(e) } as unknown as SettingsAudit & { lines: AuditEntryInput[] };
}

const setPreset = (file: string, audit: SettingsAudit, bot: string, preset: string) =>
  updateAudited({
    file,
    audit,
    compute: (text) => {
      const cur = parsePrefsText(text);
      const next = applyToCopy(cur.prefs as Record<string, unknown>, ["bots", bot, "activePreset"], preset);
      return {
        newText: serialize(next),
        entry: { source: "telegram", kind: "setting", target: { file: "prefs.json", path: `bots.${bot}.activePreset` }, diff: diffValues(cur.prefs, next), decision: "applied" } as never,
      };
    },
  });

test("two bots write prefs.json at the same time: both changes survive, the file is valid, no temp file is left", async () => {
  const dir = tempDir();
  const file = join(dir, "prefs", "prefs.json");
  mkdirSync(join(dir, "prefs"), { recursive: true });
  writeFileSync(file, serialize(parsePrefsText(undefined).prefs));
  const audit = fakeAudit();
  const bots = Array.from({ length: 12 }, (_, i) => `bot${i}`);
  await Promise.all(bots.map((b, i) => setPreset(file, audit, b, `preset${i}`)));
  const loaded = parsePrefsText(readFileSync(file, "utf8"));
  assert.equal(loaded.fellBack, false, loaded.warning);
  const stored = (loaded.prefs as Record<string, unknown>)["bots"] as Record<string, { activePreset: string }>;
  for (const [i, b] of bots.entries()) assert.equal(stored[b]?.activePreset, `preset${i}`, `${b} kept its write`);
  assert.equal(audit.lines.length, bots.length);
  assert.deepEqual(readdirSync(join(dir, "prefs")).filter((n) => n.endsWith(".tmp")), []);
});

test("writes are queued per file path; another file is not blocked; a failed job does not stop the next; stale base still refused", async () => {
  const dir = tempDir();
  const a = join(dir, "a.json");
  const b = join(dir, "b.json");
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = withFileLock(a, async () => {
    order.push("a1 start");
    await gate;
    order.push("a1 end");
  });
  const second = withFileLock(a, async () => void order.push("a2"));
  await withFileLock(b, async () => void order.push("b"));
  assert.deepEqual(order, ["a1 start", "b"], "same file waits, another file does not");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a1 start", "b", "a1 end", "a2"]);
  await assert.rejects(withFileLock(a, () => Promise.reject(new Error("x"))));
  assert.equal(await withFileLock(a, async () => 7), 7);
  writeFileSync(a, "one\n");
  await assert.rejects(
    replaceAudited({ file: a, newText: "two\n", baseRevision: "wrong", audit: fakeAudit(), entry: { source: "telegram", kind: "setting", target: { file: "a.json", path: "x" }, diff: [] } as never }),
    (e) => e instanceof SettingsError && e.code === "stale_base",
  );
  assert.equal(readFileSync(a, "utf8"), "one\n");
  assert.ok(!existsSync(`${a}.tmp`));
});

test("updateAudited resolves undefined and writes nothing when compute has no change", async () => {
  const dir = tempDir();
  const file = join(dir, "prefs.json");
  const audit = fakeAudit();
  assert.equal(await updateAudited({ file, audit, compute: () => undefined }), undefined);
  assert.equal(existsSync(file), false);
  assert.equal(audit.lines.length, 0);
});
