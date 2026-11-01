/** S11.3 done-check: the cwd allowlist (realpath-equal), with real folders and junctions under .claude/temp. */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkCwd, cwdSyntaxProblem } from "../../../src/jobrunner/cwd.js";
import { makeEnv } from "./helpers.js";

const IS_WIN = process.platform === "win32";

function policy(env: ReturnType<typeof makeEnv>) {
  return { allowlist: [env.hub], denyPaths: [env.pixotope] };
}

test("the hub folder itself is accepted, and the result is its real path", () => {
  const env = makeEnv();
  try {
    const r = checkCwd(env.hub, policy(env));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.cwd.toLowerCase(), env.hub.toLowerCase());
    // case and trailing separators do not matter
    assert.equal(checkCwd(env.hub.toUpperCase() + "\\", policy(env)).ok, true);
  } finally {
    env.cleanup();
  }
});

test("a sibling that shares the hub's name as a prefix (creative-hub2) is refused", () => {
  const env = makeEnv();
  try {
    const sibling = env.hub + "2";
    mkdirSync(sibling);
    const r = checkCwd(sibling, policy(env));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /not in the job runner's cwd allowlist/);
  } finally {
    env.cleanup();
  }
});

test("a subfolder of the hub is refused: the cwd must be EQUAL to an allowlist entry", () => {
  const env = makeEnv();
  try {
    mkdirSync(join(env.hub, "runs"));
    assert.equal(checkCwd(join(env.hub, "runs"), policy(env)).ok, false);
  } finally {
    env.cleanup();
  }
});

test("a Pixotope path is refused, and so is anything under it", () => {
  const env = makeEnv();
  try {
    mkdirSync(join(env.pixotope, "Sub"), { recursive: true });
    for (const p of [env.pixotope, join(env.pixotope, "Sub")]) {
      const r = checkCwd(p, policy(env));
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, /denied path/);
    }
  } finally {
    env.cleanup();
  }
});

test("the deny list wins even over an allowlist entry that is under a denied path", () => {
  const env = makeEnv();
  try {
    const inside = join(env.pixotope, "hub-copy");
    mkdirSync(inside, { recursive: true });
    const r = checkCwd(inside, { allowlist: [inside], denyPaths: [env.pixotope] });
    assert.equal(r.ok, false);
  } finally {
    env.cleanup();
  }
});

test("a junction inside the hub that points outside is refused (the real path differs)", { skip: !IS_WIN && "junctions are Windows-only" }, () => {
  const env = makeEnv();
  try {
    const outside = join(env.root, "elsewhere");
    mkdirSync(outside);
    const link = join(env.hub, "escape");
    symlinkSync(outside, link, "junction");
    const r = checkCwd(link, policy(env));
    assert.equal(r.ok, false);
  } finally {
    env.cleanup();
  }
});

test("a junction that points into a denied (Pixotope) folder is refused as a denied path", { skip: !IS_WIN && "junctions are Windows-only" }, () => {
  const env = makeEnv();
  try {
    const link = join(env.root, "innocent");
    symlinkSync(env.pixotope, link, "junction");
    const r = checkCwd(link, { allowlist: [link], denyPaths: [env.pixotope] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /denied path/);
  } finally {
    env.cleanup();
  }
});

test("a junction that points AT the hub is accepted as the hub (realpath-equal)", { skip: !IS_WIN && "junctions are Windows-only" }, () => {
  const env = makeEnv();
  try {
    const link = join(env.root, "hub-alias");
    symlinkSync(env.hub, link, "junction");
    const r = checkCwd(link, policy(env));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.cwd.toLowerCase(), env.hub.toLowerCase());
  } finally {
    env.cleanup();
  }
});

test("syntax problems are refused before the file system is touched", () => {
  for (const bad of ["", "relative\\path", "\\\\server\\share\\hub", "\\\\?\\C:\\hub", "\\\\.\\C:\\hub", "C:\\hub\\..\\other", "C:\\hub:stream", "C:\\hub\\CON", "C:\\hub\\nul.txt", "C:\\hub\\a*b", "C:hub", "C:\\hub\0x"]) {
    assert.notEqual(cwdSyntaxProblem(bad), undefined, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(cwdSyntaxProblem("C:\\projects\\Personal\\creative-hub"), undefined);
});

test("a missing folder, a file, and an unresolvable allowlist entry are refused", () => {
  const env = makeEnv();
  try {
    assert.equal(checkCwd(join(env.root, "nope"), policy(env)).ok, false);
    const file = join(env.hub, "f.txt");
    writeFileSync(file, "x");
    assert.equal(checkCwd(file, policy(env)).ok, false);
    assert.equal(checkCwd(env.hub, { allowlist: [join(env.root, "gone")], denyPaths: [] }).ok, false);
  } finally {
    env.cleanup();
  }
});
