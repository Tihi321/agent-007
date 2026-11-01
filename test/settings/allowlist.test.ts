import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ROWS, applyToCopy, checkValue, classify, findRow, getAt, matchRow, parseSettingPath, telegramRows, withRows } from "../../src/settings/allowlist.js";
import type { AllowRow } from "../../src/settings/allowlist.js";
import { SettingsError } from "../../src/settings/contracts.js";
import { schemaPaths } from "../../src/settings/jsonschema.js";
import { defaultPrefs } from "../../src/settings/prefs.js";
import { SECURITY_SCHEMA } from "../../src/settings/schema.js";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof SettingsError ? e.code : "other";
  }
  return undefined;
};

function resolveRow(path: string): AllowRow | undefined {
  return findRow(DEFAULT_ROWS, parseSettingPath(path));
}

test("every key path of security.json (walked from the schema) is not writable", () => {
  const paths = schemaPaths(SECURITY_SCHEMA).filter((p) => !p.includes("[]") && !p.includes("*"));
  assert.ok(paths.length > 40, "the walk covered the schema");
  for (const p of paths) {
    let row: AllowRow | undefined;
    try {
      row = resolveRow(p);
    } catch (e) {
      assert.equal((e as SettingsError).code, "not_writable", p);
      continue;
    }
    assert.equal(row, undefined, `${p} must have no allowlist row`);
  }
  assert.equal(DEFAULT_ROWS.some((r) => (r.class as string) === "security"), false);
});

test("an unknown prefs key, __proto__, constructor, prototype, an empty segment and an array index are refused", () => {
  for (const bad of ["style.unknown", "unknown", "__proto__", "style.__proto__", "constructor", "style.constructor.prototype", "prototype", "style..tone", "", ".style", "style.", "style[0]", "style.0", "defaults.0.x", "style.tone ", "a".repeat(300)]) {
    const c = code(() => {
      const row = resolveRow(bad);
      if (!row) throw new SettingsError("not_writable", "no row");
    });
    assert.equal(c, "not_writable", JSON.stringify(bad));
  }
  assert.equal(code(() => parseSettingPath(42)), "not_writable");
});

test("a wildcard row matches exactly one segment", () => {
  const row: AllowRow = { path: "bots.*.activePreset", label: "Active preset", schema: { type: "string" }, class: "pref", proposable: true, telegram: false };
  assert.equal(matchRow(row, ["bots", "research", "activePreset"]), true);
  assert.equal(matchRow(row, ["bots", "activePreset"]), false);
  assert.equal(matchRow(row, ["bots", "a", "b", "activePreset"]), false);
  assert.equal(matchRow(row, ["bots", "research", "other"]), false);
  assert.equal(code(() => parseSettingPath("bots.*.activePreset")), "not_writable", "the model cannot send a star");
  assert.throws(() => withRows(DEFAULT_ROWS, [DEFAULT_ROWS[0] as AllowRow]), /duplicate row/);
  assert.equal(withRows(DEFAULT_ROWS, [row]).length, DEFAULT_ROWS.length + 1);
});

test("values apply to a copy: the original is untouched and a poisoned key leaves Object.prototype clean", () => {
  const doc = defaultPrefs();
  const next = applyToCopy(doc as Record<string, unknown>, ["style", "tone"], "friendly");
  assert.equal(doc.style.tone, "neutral");
  assert.equal((next["style"] as Record<string, string>)["tone"], "friendly");
  assert.equal(getAt(next, ["style", "tone"]), "friendly");
  assert.equal(code(() => applyToCopy(doc as Record<string, unknown>, ["__proto__", "polluted"], "yes")), "not_writable");
  assert.equal(code(() => applyToCopy(doc as Record<string, unknown>, ["style", "constructor", "prototype", "polluted"], "yes")), "not_writable");
  assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"), false);
});

test("values are checked against the row: enum, length, language tag, and a secret-shaped note is refused", () => {
  const tone = resolveRow("style.tone") as AllowRow;
  assert.equal(code(() => checkValue(tone, "friendly")), undefined);
  assert.equal(code(() => checkValue(tone, "sarcastic")), "invalid_value");
  assert.equal(code(() => checkValue(tone, 7)), "invalid_value");
  const notes = resolveRow("style.notes") as AllowRow;
  assert.equal(code(() => checkValue(notes, "x".repeat(501))), "invalid_value");
  assert.equal(code(() => checkValue(notes, "my token is sk-abcdefghijklmnopqrstuvwxyz123456")), "secret_shaped");
  assert.equal(code(() => checkValue(notes, "call me captain")), undefined);
  const lang = resolveRow("style.language") as AllowRow;
  assert.equal(code(() => checkValue(lang, "de")), undefined);
  assert.equal(code(() => checkValue(lang, "not a tag")), "invalid_value");
});

test("classification: card by default, auto only for a cosmetic row with autoApplyCosmetic on, and a row's own classify wins", () => {
  const tone = resolveRow("style.tone") as AllowRow;
  const notes = resolveRow("style.notes") as AllowRow;
  assert.equal(classify(tone, "neutral", "friendly", { autoApplyCosmetic: false }), "card");
  assert.equal(classify(tone, "neutral", "friendly", { autoApplyCosmetic: true }), "auto");
  assert.equal(classify(notes, "", "hi", { autoApplyCosmetic: true }), "card");
  const own: AllowRow = { ...tone, classify: () => "auto" };
  assert.equal(classify(own, "a", "b", { autoApplyCosmetic: false }), "auto");
  const rej: AllowRow = { ...tone, classify: () => "reject" };
  assert.equal(classify(rej, "a", "b", { autoApplyCosmetic: true }), "reject");
});

test("the Telegram rows are exactly tone, verbosity, language and default persona; none is a security path", () => {
  assert.deepEqual(telegramRows().map((r) => r.path), ["style.tone", "style.verbosity", "style.language", "defaultPersona"]);
  assert.equal(DEFAULT_ROWS.find((r) => r.path === "defaultPersona")?.proposable, false);
  assert.equal(DEFAULT_ROWS.find((r) => r.path === "style.notes")?.telegram, false);
});
