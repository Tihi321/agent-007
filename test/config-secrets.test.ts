import assert from "node:assert/strict";
import { test } from "node:test";
import { aclViolations, assertAclSafe, isForbiddenPrincipal, loadSecrets, parseIcacls, parseSecrets, SecretsError, secretValues } from "../src/config/secrets.js";

const SECRETS_PATH = "C:\\ProgramData\\agent-007\\secrets\\secrets.json";
const STRATA_PATH = "C:\\ProgramData\\agent-007\\strata\\strata.json";

// Fixtures in the format of `icacls <file>` on Windows 11.
const GOOD = (p: string) =>
  `${p} NT AUTHORITY\\SYSTEM:(F)\r\n${" ".repeat(p.length + 1)}BUILTIN\\Administrators:(F)\r\n${" ".repeat(p.length + 1)}PC\\agent007:(R)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`;
const WITH_USERS = (p: string) => GOOD(p).replace("PC\\agent007:(R)", "BUILTIN\\Users:(I)(RX)");
const WITH_AUTH = (p: string) => GOOD(p).replace("PC\\agent007:(R)", "NT AUTHORITY\\Authenticated Users:(I)(M)");
const WITH_EVERYONE = (p: string) => GOOD(p).replace("PC\\agent007:(R)", "Everyone:(R)");
const WITH_USERS_DENY = (p: string) => GOOD(p).replace("PC\\agent007:(R)", "BUILTIN\\Users:(DENY)(R)");

const fixtureRunner = (map: Record<string, string>) => (p: string) => {
  const out = map[p];
  if (out === undefined) throw new Error(`no fixture for ${p}`);
  return out;
};

test("parseIcacls reads principals and flags, including a path with spaces", () => {
  const p = "C:\\Program Data\\a b\\secrets.json";
  const entries = parseIcacls(GOOD(p), p);
  assert.deepEqual(entries.map((e) => e.principal), ["NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators", "PC\\agent007"]);
  assert.equal(entries.every((e) => !e.deny), true);
  const inherited = parseIcacls(WITH_AUTH(p), p).find((e) => e.principal.includes("Authenticated"));
  assert.deepEqual(inherited?.flags, ["I", "M"]);
});

test("forbidden principals: Everyone, Users, Authenticated Users, BUILTIN\\Users and their SIDs", () => {
  for (const p of ["Everyone", "BUILTIN\\Users", "NT AUTHORITY\\Authenticated Users", "Users", "*S-1-1-0", "*S-1-5-11", "*S-1-5-32-545"]) {
    assert.equal(isForbiddenPrincipal(p), true, p);
  }
  for (const p of ["NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators", "PC\\agent007", "PC\\Powerusers"]) assert.equal(isForbiddenPrincipal(p), false, p);
});

test("secrets.json ACL: a good ACL passes; Users, Authenticated Users and Everyone are refused; Deny ACEs are not access", () => {
  assert.doesNotThrow(() => assertAclSafe(SECRETS_PATH, fixtureRunner({ [SECRETS_PATH]: GOOD(SECRETS_PATH) })));
  assert.doesNotThrow(() => assertAclSafe(SECRETS_PATH, fixtureRunner({ [SECRETS_PATH]: WITH_USERS_DENY(SECRETS_PATH) })));
  for (const f of [WITH_USERS, WITH_AUTH, WITH_EVERYONE]) {
    assert.throws(() => assertAclSafe(SECRETS_PATH, fixtureRunner({ [SECRETS_PATH]: f(SECRETS_PATH) })), SecretsError);
  }
  assert.deepEqual(aclViolations(parseIcacls(WITH_USERS(SECRETS_PATH), SECRETS_PATH)), ["BUILTIN\\Users"]);
});

test("an icacls failure or empty output refuses to start", () => {
  assert.throws(() => assertAclSafe(SECRETS_PATH, () => { throw new Error("boom"); }), /cannot check the ACL/);
  assert.throws(() => assertAclSafe(SECRETS_PATH, () => "garbage"), /no ACL entries/);
});

test("the Strata config copy has the same ACL check when runner is strata and a key is set", () => {
  const secretsJson = JSON.stringify({ telegramBotToken: "111:AAA-bbbb", strataApiKey: "sk-strata-1234" });
  const good = fixtureRunner({ [SECRETS_PATH]: GOOD(SECRETS_PATH), [STRATA_PATH]: GOOD(STRATA_PATH) });
  const loaded = loadSecrets({ secretsPath: SECRETS_PATH, runner: "strata", strataConfigFile: STRATA_PATH, icacls: good, readFile: () => secretsJson });
  assert.equal(loaded.secrets.strataApiKey, "sk-strata-1234");
  assert.equal(loaded.warnings.length, 0);

  const worldReadable = fixtureRunner({ [SECRETS_PATH]: GOOD(SECRETS_PATH), [STRATA_PATH]: WITH_USERS(STRATA_PATH) });
  assert.throws(
    () => loadSecrets({ secretsPath: SECRETS_PATH, runner: "strata", strataConfigFile: STRATA_PATH, icacls: worldReadable, readFile: () => secretsJson }),
    /Strata config copy.*BUILTIN\\Users/,
  );
});

test("runner strata loads with no lmStudioApiToken; without a key it warns and skips the config copy check", () => {
  const json = JSON.stringify({ telegramBotToken: "111:AAA-bbbb" });
  const onlySecrets = fixtureRunner({ [SECRETS_PATH]: GOOD(SECRETS_PATH) });
  const r = loadSecrets({ secretsPath: SECRETS_PATH, runner: "strata", strataConfigFile: STRATA_PATH, icacls: onlySecrets, readFile: () => json });
  assert.equal(r.secrets.lmStudioApiToken, undefined);
  assert.match(r.warnings.join(), /Strata without an API key/);
});

test("runner lmstudio requires lmStudioApiToken", () => {
  const json = JSON.stringify({ telegramBotToken: "111:AAA-bbbb" });
  const run = fixtureRunner({ [SECRETS_PATH]: GOOD(SECRETS_PATH) });
  assert.throws(() => loadSecrets({ secretsPath: SECRETS_PATH, runner: "lmstudio", icacls: run, readFile: () => json }), /lmStudioApiToken/);
});

test("secrets are never put into process.env and never echoed in errors", () => {
  const token = "999888:SECRET-token-zzz";
  const lm = "lm-token-abcdefg";
  const key = "strata-key-hijklmn";
  const before = { ...process.env };
  const json = JSON.stringify({ telegramBotToken: token, lmStudioApiToken: lm, strataApiKey: key });
  const run = fixtureRunner({ [SECRETS_PATH]: GOOD(SECRETS_PATH) });
  const { secrets } = loadSecrets({ secretsPath: SECRETS_PATH, runner: "lmstudio", icacls: run, readFile: () => json });
  assert.deepEqual(secretValues(secrets).sort(), [token, lm, key].sort());
  const values = Object.values(process.env).filter((v): v is string => typeof v === "string");
  for (const s of [token, lm, key]) assert.equal(values.some((v) => v.includes(s)), false);
  assert.deepEqual(Object.keys(process.env).sort(), Object.keys(before).sort());
  // invalid JSON does not echo the text
  try {
    parseSecrets(`{"telegramBotToken":"${token}"`);
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof SecretsError);
    assert.equal(String(e.message).includes(token), false);
  }
});

test("parseSecrets validates types", () => {
  assert.throws(() => parseSecrets("[]"), SecretsError);
  assert.throws(() => parseSecrets("{}"), /telegramBotToken is required/);
  assert.throws(() => parseSecrets(JSON.stringify({ telegramBotToken: "1:a", strataApiKey: 5 })), /strataApiKey must be a string/);
  assert.equal(parseSecrets(JSON.stringify({ telegramBotToken: "1:a", strataApiKey: "" })).strataApiKey, undefined);
});
