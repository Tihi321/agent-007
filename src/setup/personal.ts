/**
 * The shared personal-mode setup core (the desktop app's first run and `yarn setup:local`). One Windows user, no deploy, no ProgramData:
 * everything lives under one root folder (`config\`, `settings\`, `secrets\`, `data\`, `logs\`). It never overwrites an existing file and
 * never logs or prints an answer. Answers (the ACP proxy key, the Claude terms, the Telegram token and user id) are applied only to files
 * this call creates; a later change goes through `updatePersonal`.
 *
 * Secret files are created EMPTY, their ACL is set (inheritance off; the current user, SYSTEM and Administrators only), and only then is
 * the content written (the pattern of deploy/new-secrets.ps1).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { IPC_KEY_PATTERN } from "../config/secrets.js";
import { CLAUDE_PRESET_TEMPLATES } from "../models/templates.js";
import { splitConfig } from "../settings/split.js";

type Obj = Record<string, unknown>;

export const PLACEHOLDER = "CHANGE-ME";
/** The `allowedUserIds` value a fresh setup writes when no Telegram user id was given. */
export const PLACEHOLDER_USER_ID = 123456789;
export const KNOWN_PRESETS: readonly string[] = ["strata", ...CLAUDE_PRESET_TEMPLATES.map((p) => p.id)];

export interface SetupResult {
  created: string[];
  kept: string[];
  mustFill: string[];
}

/** Runs `icacls.exe` with these arguments (a test passes a fake that records the calls). */
export type IcaclsApply = (args: string[]) => void;

export const applyIcacls: IcaclsApply = (args) => {
  const exe = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "icacls.exe");
  execFileSync(exe, args, { windowsHide: true, stdio: "ignore" });
};

export interface PersonalAnswers {
  proxyApiKey?: string;
  acceptClaudeTerms?: boolean;
  telegram?: { botToken: string; allowedUserId: number };
}

export interface PersonalPaths {
  root: string;
  configPath: string;
  securityPath: string;
  secretsPath: string;
  dataDir: string;
}

export function personalPaths(root: string): PersonalPaths {
  return {
    root,
    configPath: join(root, "config", "config.json"),
    securityPath: join(root, "settings", "security.json"),
    secretsPath: join(root, "secrets", "secrets.json"),
    dataDir: join(root, "data"),
  };
}

const TELEGRAM_TOKEN = /^\d+:[A-Za-z0-9_-]{20,}$/;

/** Throws without echoing any value. */
function checkAnswers(a: PersonalAnswers): void {
  if (a.proxyApiKey !== undefined && (typeof a.proxyApiKey !== "string" || a.proxyApiKey.trim() === "" || /[\r\n\0]/.test(a.proxyApiKey))) throw new Error("the proxy key must be a single non-empty line");
  if (a.telegram !== undefined) {
    if (typeof a.telegram.botToken !== "string" || !TELEGRAM_TOKEN.test(a.telegram.botToken)) throw new Error("the Telegram bot token does not look like <digits>:<characters>");
    if (!Number.isSafeInteger(a.telegram.allowedUserId) || a.telegram.allowedUserId <= 0) throw new Error("the Telegram user id must be a positive whole number");
  }
}

/** Current user plus SYSTEM and Administrators (well-known SIDs, so a localized Windows works too). */
function aclArgs(path: string, isDir: boolean): string[] {
  const user = userInfo().username;
  const f = isDir ? "(OI)(CI)F" : "F";
  return [path, "/inheritance:r", "/grant:r", `${user}:${f}`, `*S-1-5-18:${f}`, `*S-1-5-32-544:${f}`];
}

/** Creates the file EMPTY, sets its ACL, and only then writes the content. Fails (and leaves nothing behind) if the ACL cannot be set. */
function writeSecretFile(path: string, text: string, icacls: IcaclsApply): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", { flag: "wx" });
  try {
    icacls(aclArgs(path, false));
    writeFileSync(path, text, "utf8");
  } catch (e) {
    rmSync(path, { force: true });
    throw e;
  }
}

/** Replaces an existing secret file atomically: a new empty temp file with the ACL, the content, then a rename over the old one. */
function replaceSecretFile(path: string, text: string, icacls: IcaclsApply): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, "", { flag: "w" });
    icacls(aclArgs(tmp, false));
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function replaceFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function setupPersonal(o: {
  root: string;
  /** The folder that holds `config\config.example.json` (the repo root, or `resources\app` in the installed app). */
  resourcesDir: string;
  home?: string;
  presets?: readonly string[];
  answers?: PersonalAnswers;
  icacls?: IcaclsApply;
}): SetupResult & { configPath: string; secretsPath: string; dataDir: string } {
  const { root } = o;
  const answers = o.answers ?? {};
  checkAnswers(answers);
  const icacls = o.icacls ?? applyIcacls;
  const presets = o.presets ?? KNOWN_PRESETS;
  for (const id of presets) if (!KNOWN_PRESETS.includes(id)) throw new Error(`unknown preset ${JSON.stringify(id)} (use ${KNOWN_PRESETS.join(", ")})`);
  const home = o.home ?? homedir();
  const p = personalPaths(root);
  const res: SetupResult = { created: [], kept: [], mustFill: [] };
  const write = (file: string, text: string): void => {
    if (existsSync(file)) return void res.kept.push(file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
    res.created.push(file);
  };

  const cfg = JSON.parse(readFileSync(join(o.resourcesDir, "config", "config.example.json"), "utf8")) as Obj;
  for (const k of Object.keys(cfg)) if (k.startsWith("_")) delete cfg[k];
  const data = p.dataDir;
  cfg["paths"] = {
    programDataDir: root,
    dataDir: data,
    stateDir: join(data, "state"),
    workspaceDir: join(data, "workspace"),
    memoryFile: join(data, "memory", "MEMORY.md"),
    userFile: join(root, "config", "USER.md"),
    logsDir: join(data, "logs"),
    auditDir: join(data, "audit"),
    controlDir: join(data, "control"),
    runDir: join(data, "run"),
  };
  cfg["mainUserProfile"] = home;
  (cfg["telegram"] as Obj)["allowedUserIds"] = [answers.telegram?.allowedUserId ?? PLACEHOLDER_USER_ID];
  (cfg["folders"] as Obj)["allow"] = [{ alias: "documents", path: join(home, "Documents") }];
  const model = cfg["model"] as Obj;
  model["runner"] = "strata"; // local model; the lmstudio block stays but needs its own token
  const strata = (model["runners"] as Obj)["strata"] as Obj;
  strata["configFile"] = join(root, "strata", "strata.json");
  strata["logDir"] = join(data, "logs");

  const { bootstrap, security } = splitConfig(cfg, join(root, "settings"));
  const wanted = presets.filter((id) => id !== "strata");
  const sp = (security["presets"] as Obj[]).filter((x) => (x["id"] === "strata" ? presets.includes("strata") : false));
  const claude = CLAUDE_PRESET_TEMPLATES.filter((t) => wanted.includes(t.id)).map((t) => ({ ...t }));
  security["presets"] = [...sp, ...claude];
  (security["model"] as Obj)["defaultPreset"] = (security["presets"] as Obj[])[0]?.["id"] ?? "strata";
  // termsAccepted.claude is the owner's decision (I41): true only when the owner ticked it in the setup window
  security["termsAccepted"] = { claude: answers.acceptClaudeTerms === true, antigravity: false };

  write(p.configPath, `${JSON.stringify(bootstrap, null, 2)}\n`);
  write(p.securityPath, `${JSON.stringify(security, null, 2)}\n`);
  const secrets: Obj = { telegramBotToken: answers.telegram?.botToken ?? PLACEHOLDER, strataApiKey: "", proxyApiKey: answers.proxyApiKey ?? PLACEHOLDER };
  if (existsSync(p.secretsPath)) res.kept.push(p.secretsPath);
  else {
    writeSecretFile(p.secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, icacls);
    res.created.push(p.secretsPath);
  }
  // the gateway creates web.key here: the folder gets the same owner-only ACL first
  const webDir = join(data, "web");
  const webExisted = existsSync(webDir);
  mkdirSync(webDir, { recursive: true });
  if (!webExisted) icacls(aclArgs(webDir, true));
  for (const d of [join(root, "logs")]) mkdirSync(d, { recursive: true });

  if (answers.proxyApiKey === undefined) res.mustFill.push("secrets.json proxyApiKey: the ACP proxy key (only for the Claude presets)");
  res.mustFill.push("secrets.json strataApiKey: the Strata key, if your Strata asks for one (leave empty otherwise)");
  if (answers.telegram === undefined) res.mustFill.push("secrets.json telegramBotToken: only for `yarn start:local` (the web gateway ignores it)");
  if (answers.acceptClaudeTerms !== true) res.mustFill.push("security.json termsAccepted.claude: set true yourself to allow the Claude presets");
  if (answers.telegram === undefined) res.mustFill.push("config.json telegram.allowedUserIds: only for `yarn start:local`");
  return { ...res, configPath: p.configPath, secretsPath: p.secretsPath, dataDir: data };
}

/** Rewrites only the given fields of the existing files, atomically. Throws if a file is missing or not valid JSON. Never logs a value. */
export function updatePersonal(root: string, answers: PersonalAnswers, icacls: IcaclsApply = applyIcacls): void {
  checkAnswers(answers);
  const p = personalPaths(root);
  const read = (file: string): Obj => {
    let v: unknown;
    try {
      v = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`cannot read ${file} as JSON`);
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${file} must be a JSON object`);
    return v as Obj;
  };
  const json = (o: Obj): string => `${JSON.stringify(o, null, 2)}\n`;

  if (answers.proxyApiKey !== undefined || answers.telegram !== undefined) {
    const s = read(p.secretsPath);
    if (answers.proxyApiKey !== undefined) s["proxyApiKey"] = answers.proxyApiKey;
    if (answers.telegram !== undefined) s["telegramBotToken"] = answers.telegram.botToken;
    replaceSecretFile(p.secretsPath, json(s), icacls);
  }
  // the `telegram` block and `termsAccepted` live in settings\security.json (the split puts them there)
  if (answers.telegram !== undefined || answers.acceptClaudeTerms !== undefined) {
    const sec = read(p.securityPath);
    if (answers.telegram !== undefined) {
      const t = typeof sec["telegram"] === "object" && sec["telegram"] !== null ? (sec["telegram"] as Obj) : {};
      t["allowedUserIds"] = [answers.telegram.allowedUserId];
      sec["telegram"] = t;
    }
    if (answers.acceptClaudeTerms !== undefined) {
      const terms = typeof sec["termsAccepted"] === "object" && sec["termsAccepted"] !== null ? (sec["termsAccepted"] as Obj) : {};
      terms["claude"] = answers.acceptClaudeTerms;
      sec["termsAccepted"] = terms;
    }
    replaceFileAtomic(p.securityPath, json(sec));
  }
}

/** True while the Telegram token or the allowed user id is still a setup placeholder (the launcher must not start the Telegram agent then). */
export function hasTelegramPlaceholders(root: string): boolean {
  const p = personalPaths(root);
  try {
    const secrets = JSON.parse(readFileSync(p.secretsPath, "utf8")) as Obj;
    const token = secrets["telegramBotToken"];
    if (typeof token !== "string" || token === "" || token === PLACEHOLDER) return true;
    const cfg = JSON.parse(readFileSync(p.securityPath, "utf8")) as { telegram?: { allowedUserIds?: unknown } };
    const ids = cfg.telegram?.allowedUserIds;
    return !Array.isArray(ids) || ids.length === 0 || ids.includes(PLACEHOLDER_USER_ID);
  } catch {
    return true;
  }
}

export interface JobrunnerSetup {
  configPath: string;
  secretsPath: string;
  dataDir: string;
  created: string[];
}

/**
 * The job runner's own config and secrets under the personal root (T7), created on the first time the owner turns the job runner on.
 * `<root>\jobrunner\jobrunner.json` (settings UI on, every path under the root) and `<root>\jobrunner-data\secrets.json` (ACL first).
 * `ipcHmacKey` is the agent's; when neither side has one, 32 random bytes (base64url) go into both. Idempotent: existing files are kept.
 */
export function ensureJobrunner(root: string, o: { resourcesDir: string; icacls?: IcaclsApply }): JobrunnerSetup {
  const icacls = o.icacls ?? applyIcacls;
  const created: string[] = [];
  const jrDir = join(root, "jobrunner");
  const dataDir = join(root, "jobrunner-data");
  const configPath = join(jrDir, "jobrunner.json");
  const secretsPath = join(dataDir, "secrets.json");
  const agentSecretsPath = personalPaths(root).secretsPath;

  if (!existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(join(o.resourcesDir, "config", "jobrunner.example.json"), "utf8")) as Obj;
    for (const k of Object.keys(cfg)) if (k.startsWith("_")) delete cfg[k];
    cfg["paths"] = { configDir: jrDir, dataDir, templatesDir: join(jrDir, "templates"), settingsDir: join(root, "settings") };
    cfg["cwdAllowlist"] = [join(root, "data", "workspace")]; // must not be empty; the owner changes it in the settings UI
    cfg["denyPaths"] = [root];
    const hub = (cfg["hub"] ?? {}) as Obj;
    hub["dir"] = join(jrDir, "hub");
    hub["services"] = [];
    delete hub["ports"];
    cfg["hub"] = hub;
    const ui = (cfg["settingsUi"] ?? {}) as Obj;
    ui["enabled"] = true;
    cfg["settingsUi"] = ui;
    mkdirSync(join(jrDir, "templates"), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    created.push(configPath);
  }

  const keyOf = (file: string): string | undefined => {
    try {
      const v = (JSON.parse(readFileSync(file, "utf8")) as Obj)["ipcHmacKey"];
      return typeof v === "string" && IPC_KEY_PATTERN.test(v) ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const agentHasFile = existsSync(agentSecretsPath);
  const jrHasFile = existsSync(secretsPath);
  const agentKey = agentHasFile ? keyOf(agentSecretsPath) : undefined;
  const jrKey = jrHasFile ? keyOf(secretsPath) : undefined;
  const key = agentKey ?? jrKey ?? randomBytes(32).toString("base64url");

  if (!jrHasFile) {
    writeSecretFile(secretsPath, `${JSON.stringify({ ipcHmacKey: key }, null, 2)}\n`, icacls);
    created.push(secretsPath);
  } else if (jrKey === undefined) {
    throw new Error(`the job runner secrets file has no valid ipcHmacKey: ${secretsPath}`);
  }
  if (agentHasFile && agentKey === undefined) {
    const s = JSON.parse(readFileSync(agentSecretsPath, "utf8")) as Obj;
    s["ipcHmacKey"] = key;
    replaceSecretFile(agentSecretsPath, `${JSON.stringify(s, null, 2)}\n`, icacls);
  }
  return { configPath, secretsPath, dataDir, created };
}
