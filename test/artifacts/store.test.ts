/** REQ-0014 A10: readArtifact refuses everything but a real PNG under the root. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readArtifact } from "../../src/artifacts/store.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake image body")]);

test("readArtifact: a valid PNG is read; traversal, absolute, non-PNG, oversize and sha mismatch are refused", () => {
  const base = mkdtempSync(path.join(tmpdir(), "a7-art-"));
  try {
    const root = path.join(base, "root");
    const dir = path.join(root, "job-0123456789ab");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "001.png"), PNG);
    writeFileSync(path.join(dir, "002.png"), "just text, not a png");
    writeFileSync(path.join(dir, "003.png"), Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
    writeFileSync(path.join(base, "x.png"), PNG);
    const sha = createHash("sha256").update(PNG).digest("hex");

    const ok = readArtifact(root, "job-0123456789ab/001.png", sha);
    assert.ok(ok.ok && ok.mime === "image/png" && ok.bytes.equals(PNG));

    const refused: [string, string, string?][] = [
      ["traversal", "../x.png"],
      ["traversal inside a job dir", "job-0123456789ab/../../x.png"],
      ["absolute", path.join(base, "x.png")],
      ["not a PNG", "job-0123456789ab/002.png"],
      ["over 5 MiB", "job-0123456789ab/003.png"],
      ["sha mismatch", "job-0123456789ab/001.png", "0".repeat(64)],
      ["missing", "job-0123456789ab/009.png"],
    ];
    for (const [label, rel, expect] of refused) assert.equal(readArtifact(root, rel, expect).ok, false, label);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
