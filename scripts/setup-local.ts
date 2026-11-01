/**
 * `yarn setup:local`: a development setup inside the repo, no deploy and no ProgramData. Creates `.local/` (git-ignored) with
 * `config/config.json` (v2) and `settings/security.json` from `config/config.example.json` (every folder inside `.local/`), plus a
 * `secrets/secrets.json` skeleton. It never overwrites an existing file and never invents a secret: placeholders are printed.
 *
 *   yarn setup:local [--presets strata,claude-sonnet,claude-opus] [--dir <folder>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_PRESET_TEMPLATES } from "../src/models/templates.js";
import { splitConfig } from "../src/settings/split.js";

type Obj = Record<string, unknown>;

export const PLACEHOLDER = "CHANGE-ME";
const KNOWN_PRESETS = ["strata", ...CLAUDE_PRESET_TEMPLATES.map((p) => p.id)];

export interface SetupResult {
  created: string[];
  kept: string[];
  mustFill: string[];
}

export function setupLocal(opts: { repoRoot: string; dir?: string; presets?: readonly string[]; home?: string }): SetupResult {
  const root = opts.dir ?? join(opts.repoRoot, ".local");
  const presets = opts.presets ?? KNOWN_PRESETS;
  for (const id of presets) if (!KNOWN_PRESETS.includes(id)) throw new Error(`unknown preset ${JSON.stringify(id)} (use ${KNOWN_PRESETS.join(", ")})`);
  const home = opts.home ?? homedir();
  const res: SetupResult = { created: [], kept: [], mustFill: [] };
  const write = (file: string, text: string): void => {
    if (existsSync(file)) return void res.kept.push(file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
    res.created.push(file);
  };

  const cfg = JSON.parse(readFileSync(join(opts.repoRoot, "config", "config.example.json"), "utf8")) as Obj;
  for (const k of Object.keys(cfg)) if (k.startsWith("_")) delete cfg[k];
  const data = join(root, "data");
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
  (cfg["telegram"] as Obj)["allowedUserIds"] = [123456789];
  (cfg["folders"] as Obj)["allow"] = [{ alias: "documents", path: join(home, "Documents") }];
  const model = cfg["model"] as Obj;
  model["runner"] = "strata"; // local model; the lmstudio block stays but needs its own token
  const strata = (model["runners"] as Obj)["strata"] as Obj;
  strata["configFile"] = join(root, "strata", "strata.json");
  strata["logDir"] = join(data, "logs");

  const { bootstrap, security } = splitConfig(cfg, join(root, "settings"));
  const wanted = presets.filter((id) => id !== "strata");
  const sp = (security["presets"] as Obj[]).filter((p) => p["id"] === "strata" ? presets.includes("strata") : false);
  const claude = CLAUDE_PRESET_TEMPLATES.filter((p) => wanted.includes(p.id)).map((p) => ({ ...p }));
  security["presets"] = [...sp, ...claude];
  (security["model"] as Obj)["defaultPreset"] = (security["presets"] as Obj[])[0]?.["id"] ?? "strata";
  // termsAccepted.claude stays false: ticking it is the owner's decision (I41); set it to true in security.json by hand to use the Claude presets
  security["termsAccepted"] = { claude: false, antigravity: false };

  write(join(root, "config", "config.json"), `${JSON.stringify(bootstrap, null, 2)}\n`);
  write(join(root, "settings", "security.json"), `${JSON.stringify(security, null, 2)}\n`);
  const secrets: Obj = { telegramBotToken: PLACEHOLDER, strataApiKey: "", proxyApiKey: PLACEHOLDER };
  write(join(root, "secrets", "secrets.json"), `${JSON.stringify(secrets, null, 2)}\n`);
  for (const d of [data, join(data, "web")]) mkdirSync(d, { recursive: true });
  res.mustFill.push("secrets.json proxyApiKey: the ACP proxy key (only for the Claude presets)", "secrets.json strataApiKey: the Strata key, if your Strata asks for one (leave empty otherwise)", "secrets.json telegramBotToken: only for `yarn start:local` (the web gateway ignores it)", "security.json termsAccepted.claude: set true yourself to allow the Claude presets", "config.json telegram.allowedUserIds: only for `yarn start:local`");
  return res;
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const argv = process.argv.slice(2);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  let dir: string | undefined;
  let presets: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") dir = resolve(argv[++i] ?? "");
    else if (argv[i] === "--presets") presets = (argv[++i] ?? "").split(",").filter(Boolean);
    else throw new Error(`unknown argument ${JSON.stringify(argv[i])}`);
  }
  const r = setupLocal({ repoRoot, ...(dir ? { dir } : {}), ...(presets ? { presets } : {}) });
  for (const f of r.created) process.stdout.write(`created ${f}\n`);
  for (const f of r.kept) process.stdout.write(`kept    ${f} (exists, not touched)\n`);
  process.stdout.write(`\nFill in before real use (under ${dir ?? join(repoRoot, ".local")}):\n${r.mustFill.map((m) => `  - ${m}`).join("\n")}\n\nRun: yarn web:local   (then open http://localhost:47009/claim after: yarn web-owner-code --data-dir <dir>/data)\n`);
}
