import assert from "node:assert/strict";
import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "../settings/helpers.js";
import { draft, personaFixture, security } from "./helpers.js";

test("both folders load; a persona in prefs\\personas listing shell while shell is off is invalid and unselectable", () => {
  const f = personaFixture({ sec: security({ shell: { enabled: false } }) });
  f.write("user", draft({ id: "research" }));
  f.write("model", draft({ id: "ops", toolAllow: ["shell", "read_file"] }));
  const e = f.store.entries(f.ceiling());
  assert.deepEqual(e.map((x) => [x.id, x.source, x.valid]), [["research", "user", true], ["ops", "model", false]]);
  assert.match(e[1]!.reasons.join(), /tool "shell" is outside .*shell is turned off/);
  assert.equal(f.resolver.list().find((p) => p.id === "ops")?.valid, false);
  f.cleanup();
});

test("a user-authored id shadows a model-authored one; a model file using a built-in id is invalid", () => {
  const f = personaFixture();
  f.write("user", draft({ id: "research", name: "User version" }));
  f.write("model", draft({ id: "research", name: "Model version" }));
  f.write("model", draft({ id: "readonly", name: "Evil readonly" }));
  f.write("model", draft({ id: "default", name: "Evil default" }));
  const e = f.store.entries(f.ceiling());
  const research = e.filter((x) => x.id === "research");
  assert.equal(research.length, 1, "the model file is shadowed");
  assert.equal(research[0]?.persona?.name, "User version");
  assert.equal(research[0]?.source, "user");
  for (const id of ["readonly", "default"]) {
    const x = e.find((y) => y.id === id)!;
    assert.equal(x.valid, false);
    assert.match(x.reasons.join(), /built-in persona id/);
  }
  assert.equal(f.store.isUserAuthored("research"), true);
  assert.equal(f.store.isUserAuthored("other"), false);
  const list = f.resolver.list();
  assert.equal(list.find((p) => p.id === "readonly")?.source, "builtin", "a built-in cannot be shadowed");
  assert.equal(list.filter((p) => p.id === "readonly").length, 2, "the evil file is listed (invalid), the built-in stays selectable");
  assert.equal(f.resolver.effectiveOf("readonly")?.memory.write, "none");
  f.cleanup();
});

test("hand-editing a model-authored persona to widen it makes it invalid at the next load (I29c)", () => {
  const f = personaFixture();
  const file = f.write("model", draft({ id: "research" }));
  assert.equal(f.store.entries(f.ceiling())[0]?.valid, true);
  const widened = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  widened["toolAllow"] = ["read_file", "teleport"];
  widened["budgets"] = { maxJobsPerDay: 500 };
  writeFileSync(file, JSON.stringify(widened));
  utimesSync(file, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
  const e = f.store.entries(f.ceiling())[0]!;
  assert.equal(e.valid, false);
  assert.match(e.reasons.join("\n"), /not a known tool/);
  assert.match(e.reasons.join("\n"), /maxJobsPerDay 500/);
  assert.equal(f.resolver.effectiveOf("research"), undefined, "an invalid persona has no effective set: it is never clipped");
  f.cleanup();
});

test("garbage files stay listed with a reason: bad JSON, a wrong file name, an id that differs from the file name, unknown keys, more than 12", () => {
  const f = personaFixture();
  writeFileSync(join(f.modelDir, "broken.json"), "{not json");
  writeFileSync(join(f.modelDir, "Bad Name.json"), "{}");
  f.write("model", draft({ id: "other" }), "mismatch");
  f.write("model", { ...draft({ id: "extra" }), superpower: true });
  const e = f.store.entries(f.ceiling());
  assert.equal(e.every((x) => !x.valid), true);
  const text = e.map((x) => `${x.id}: ${x.reasons.join(";")}`).join("\n");
  assert.match(text, /broken: not valid JSON/);
  assert.match(text, /Bad Name: the file name is not a valid persona id/);
  assert.match(text, /mismatch: the file name says "mismatch" but the persona id is "other"/);
  assert.match(text, /extra: .*superpower/);
  const g = personaFixture();
  for (let i = 0; i < 14; i++) g.write("model", draft({ id: `p${String(i).padStart(2, "0")}`, name: `P${i}` }));
  const valid = g.store.entries(g.ceiling()).filter((x) => x.valid);
  assert.equal(valid.length, 12, "at most 12 personas are usable");
  assert.match(g.store.entries(g.ceiling()).at(-1)!.reasons.join(), /more than 12/);
  f.cleanup();
  g.cleanup();
});

test("each example draft parses and is valid against a ceiling with shell on; ops is invalid when shell is off", () => {
  const f = personaFixture();
  for (const id of ["research", "ops", "creative"]) {
    const doc = JSON.parse(readFileSync(join(ROOT, "config", "personas", `${id}.example.json`), "utf8")) as Record<string, unknown>;
    assert.equal(doc["id"], id);
    assert.equal(typeof doc["_comment"], "string");
    f.write("user", doc);
  }
  const e = f.store.entries(f.ceiling());
  assert.deepEqual(e.map((x) => [x.id, x.valid, x.reasons]), [["creative", true, []], ["ops", true, []], ["research", true, []]]);
  assert.ok(e.find((x) => x.id === "ops")!.persona!.toolAllow.includes("shell"));
  assert.ok(!e.find((x) => x.id === "research")!.persona!.toolAllow.includes("shell"));
  f.sec.v = security({ shell: { enabled: false } });
  const off = f.store.entries(f.ceiling());
  assert.deepEqual(off.map((x) => [x.id, x.valid]), [["creative", true], ["ops", false], ["research", true]]);
  assert.match(off.find((x) => x.id === "ops")!.reasons.join(), /shell is turned off/);
  // none of the examples is installed by code: the example folder is not a persona folder
  rmSync(join(f.userDir, "ops.json"));
  assert.equal(f.store.entries(f.ceiling()).some((x) => x.id === "ops"), false);
  f.cleanup();
});
