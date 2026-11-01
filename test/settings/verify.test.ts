import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verifyPath } from "../../scripts/settings/verify-audit.js";
import { createSettingsAudit } from "../../src/settings/audit.js";
import { verifyAuditText } from "../../src/settings/chain.js";
import { tempDir } from "./helpers.js";

function build(): { dir: string; file: string; lines: string[] } {
  const dir = tempDir("a7-ver-");
  const now = () => new Date("2026-10-30T10:00:00Z");
  const agent = createSettingsAudit({ dir, writer: "agent", now });
  const jr = createSettingsAudit({ dir, writer: "jobrunner", now });
  for (let i = 0; i < 5; i++) {
    (i % 2 === 0 ? agent : jr).append({
      source: i % 2 === 0 ? "propose" : "ui",
      kind: "setting",
      target: { file: "prefs.json", path: `style.n${i}` },
      diff: [{ path: "style.tone", op: "replace", before: "a", after: `v${i}` }],
      decision: "applied",
      baseRevision: "a",
      afterRevision: `b${i}`,
    });
  }
  const file = join(dir, readdirSync(dir)[0] as string);
  return { dir, file, lines: readFileSync(file, "utf8").trimEnd().split("\n") };
}

test("an untouched file passes and two writers' chains verify independently", () => {
  const { dir, lines } = build();
  const r = verifyAuditText(`${lines.join("\n")}\n`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.writers, { agent: { lines: 3, lastWseq: 3 }, jobrunner: { lines: 2, lastWseq: 2 } });
  const v = verifyPath(dir);
  assert.equal(v.exitCode, 0);
  assert.match(v.lines.join("\n"), /OK/);
  rmSync(dir, { recursive: true, force: true });
});

test("a middle line edited, a middle line removed and a swapped pair are all detected", () => {
  const { dir, file, lines } = build();
  const edited = [...lines];
  edited[2] = (edited[2] as string).replace("v2", "v9");
  assert.equal(verifyAuditText(`${edited.join("\n")}\n`).ok, false);
  assert.match(verifyAuditText(`${edited.join("\n")}\n`).problems.join("\n"), /hash mismatch/);
  const removed = lines.filter((_, i) => i !== 2);
  const rr = verifyAuditText(`${removed.join("\n")}\n`);
  assert.equal(rr.ok, false);
  assert.match(rr.problems.join("\n"), /missing, repeated or reordered|prev does not match/);
  const swapped = [...lines];
  [swapped[0], swapped[2]] = [swapped[2] as string, swapped[0] as string]; // both are the agent's: wseq 1 and 2
  assert.equal(verifyAuditText(`${swapped.join("\n")}\n`).ok, false);
  writeFileSync(file, `${edited.join("\n")}\n`);
  const v = verifyPath(file);
  assert.equal(v.exitCode, 1);
  assert.match(v.lines.join("\n"), /BROKEN/);
  assert.equal(verifyPath(join(dir, "nope")).exitCode, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("a line that is not JSON and a line with missing chain fields are problems", () => {
  const { dir, lines } = build();
  assert.equal(verifyAuditText(`${lines.join("\n")}\nnot json\n`).ok, false);
  assert.equal(verifyAuditText(`${lines.join("\n")}\n{"writer":"agent"}\n`).ok, false);
  rmSync(dir, { recursive: true, force: true });
});
