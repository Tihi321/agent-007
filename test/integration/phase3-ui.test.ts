/**
 * S18 integration (offline): the REAL job runner (`startJobRunner`, the settings UI on an ephemeral loopback port), the REAL agent
 * startup on a migrated fixture install, a fake Telegram and a scripted model. Both processes share the fixture settings folder
 * and its audit log, like the real install does. Live parts (the deployed port, a real browser) are a user step.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runMigration } from "../../scripts/migrate-settings.js";
import { IpcKey } from "../../src/ipc/hmac.js";
import { parseJobRunnerConfig } from "../../src/jobrunner/limits.js";
import { runSettingsLink, startJobRunner } from "../../src/jobrunner/main.js";
import type { RunningJobRunner } from "../../src/jobrunner/main.js";
import { readAuditTail } from "../../src/settings/audit.js";
import { verifyAuditText } from "../../src/settings/chain.js";
import { SETTINGS_TOOL_NAMES } from "../../src/settings/tools.js";
import { memLogger, request, sessionOf } from "../settingsUi/helpers.js";
import { ROOT } from "../settings/helpers.js";
import { E2e, USER_ID, viaToolSearch, waitFor } from "./rig.js";
import { freePort } from "./phase2-rig.js";

const model = viaToolSearch(
  ({ lastUser, afterTool, lastToolText }) => {
    if (afterTool) return { type: "text", text: `tool said: ${lastToolText}` };
    if (/be more concise/.test(lastUser)) return { type: "tool_calls", calls: [{ name: "propose_setting", args: { path: "style.verbosity", value: "normal", reason: "the user asked for a different length" } }] };
    return { type: "text", text: `echo: ${lastUser}` };
  },
  { extraDeferred: (n) => (SETTINGS_TOOL_NAMES as readonly string[]).includes(n) },
);

interface Both {
  rig: E2e;
  jr: RunningJobRunner;
  restarts: number[];
  port: number;
  configFile: string;
  settingsDir: string;
  out: string[];
  close(): Promise<void>;
}

async function both(): Promise<Both> {
  const restarts: number[] = [];
  const rig = await E2e.open({ behavior: model, start: { onRestart: (c: number) => void restarts.push(c) } });
  await rig.stop();
  const settingsDir = join(rig.dirs.programData, "settings");
  mkdirSync(join(settingsDir, "audit"), { recursive: true });
  const out: string[] = [];
  const code = await runMigration({ config: rig.dirs.configPath, agentUser: "agent007", apply: true, rollback: false }, { out: (l) => void out.push(l), env: rig.dirs.env, checkAcl: () => [] });
  assert.equal(code, 0, out.join("\n"));
  await rig.start();

  const root = join(rig.dirs.root, "jr");
  const hub = join(root, "hub");
  const templatesDir = join(root, "templates");
  for (const d of [hub, templatesDir, join(root, "data")]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const ipcPort = await freePort();
  const configFile = join(root, "jobrunner.json");
  const raw = {
    ipcPort,
    paths: { dataDir: join(root, "data"), configDir: root, templatesDir, settingsDir },
    cwdAllowlist: [hub],
    denyPaths: [],
    engines: { claude: { enabled: false }, dsh: { enabled: false }, hub: { enabled: true } },
    hub: { dir: hub, services: [], pwsh: "pwsh-fake" },
    settingsUi: { enabled: true, port },
  };
  writeFileSync(configFile, JSON.stringify(raw, null, 2));
  const jr = await startJobRunner({
    config: parseJobRunnerConfig(raw),
    secrets: { ipcKey: IpcKey.generate(), redactValues: [] },
    drivers: {},
    logger: memLogger(),
    configFile,
    settingsUi: { assetsDir: join(ROOT, "ui", "settings") },
  });
  return {
    rig,
    jr,
    restarts,
    port,
    configFile,
    settingsDir,
    out,
    async close() {
      await jr.stop();
      await rig.close();
      rmSync(rig.dirs.root, { recursive: true, force: true });
    },
  };
}

async function signInViaLink(b: Both) {
  const lines: string[] = [];
  assert.equal(runSettingsLink(["--config", b.configFile], (l) => void lines.push(l)), 0);
  const link = lines.find((l) => l.startsWith("http://"))!;
  assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${b.port}/#code=[A-Za-z0-9_-]{30,}$`));
  const code = link.split("#code=")[1]!;
  const r = await request({ port: b.port }, "POST", "/api/login", { body: { code } });
  assert.equal(r.status, 200, r.text);
  return sessionOf({ port: b.port }, (r.headers["set-cookie"]?.[0] ?? "").split(";")[0]!, String(r.json()["csrf"]));
}

test("the job runner hosts the UI on loopback; settings-link signs in once; a save through the UI is audited and the agent reports restart required until /applysettings", async () => {
  const b = await both();
  try {
    assert.ok(b.jr.settingsUi, "the UI is running");
    assert.equal((b.jr.settingsUi!.server.address() as { address: string }).address, "127.0.0.1");
    const s = await signInViaLink(b);
    const cur = (await s.get("/api/security")).json() as { doc: Record<string, any>; revision: string };
    // the agent started with exactly this revision
    assert.equal(b.rig.agent.settings.securityRevision, cur.revision);
    await b.rig.say("/status", 1);
    await b.rig.seen((t) => /Settings: running rev [0-9a-f]{8}, file rev [0-9a-f]{8}$/.test(t), "/status settings line");
    // a UI save
    const save = await s.post("/api/security/save", { formId: "shell", sections: { shell: { ...cur.doc["shell"], approvalTimeoutSec: 300 } }, baseRevision: cur.revision });
    assert.equal(save.status, 200, save.text);
    const lines = readAuditTail(join(b.settingsDir, "audit"), 50);
    const ui = lines.filter((l) => l.source === "ui");
    assert.equal(ui.length, 1);
    assert.equal(ui[0]?.afterRevision, (save.json() as { revision: string }).revision);
    assert.equal(ui[0]?.writer, "jobrunner");
    // the agent sees the file revision move; its running revision stays
    await b.rig.say("/status", 2);
    await b.rig.seen((t) => /running rev [0-9a-f]{8}, file rev [0-9a-f]{8} \(restart required: \/applysettings\)/.test(t), "restart required in /status");
    const st1 = (await s.get("/api/status")).json() as Record<string, unknown>;
    assert.equal(st1["restartRequired"], true, "the UI knows the agent runs the older revision (from its running audit line)");
    // /applysettings: validated, asked once, then the host is told to exit with code 4
    await b.rig.say("/applysettings", 3);
    await waitFor(() => b.rig.tg.of("sendMessage").some((c) => JSON.stringify(c.payload["reply_markup"] ?? "").includes("se:ay")), 10_000, "the confirm button");
    assert.deepEqual(b.restarts, []);
    await b.rig.tap("se:ay");
    await waitFor(() => b.restarts.length === 1, 10_000, "requestRestart");
    assert.deepEqual(b.restarts, [4]);
    // the restart: both revisions are equal again and the UI agrees
    await b.rig.restart();
    await b.rig.say("/status", 4);
    await b.rig.seen((t) => /Settings: running rev ([0-9a-f]{8}), file rev \1$/.test(t), "equal revisions after the restart");
    const st2 = (await s.get("/api/status")).json() as Record<string, unknown>;
    assert.equal(st2["restartRequired"], false);
    assert.equal(b.rig.agent.config.shell.approvalTimeoutSec, 300, "the restarted agent runs the new setting");
    const log = readFileSync(join(b.settingsDir, "audit", readdirAudit(b)), "utf8");
    assert.equal(verifyAuditText(log).ok, true, "the shared log's chains verify: agent and job runner interleaved");
  } finally {
    await b.close();
  }
});

function readdirAudit(b: Both): string {
  const names = readdirSync(join(b.settingsDir, "audit")).filter((n) => /^settings-\d{6}\.jsonl$/.test(n));
  assert.equal(names.length, 1);
  return names[0]!;
}

test("the model proposes through the real Telegram card: Approve applies and audits; the same flow works in the UI's audit view", async () => {
  const b = await both();
  try {
    await b.rig.say("be more concise", 11);
    const card = await b.rig.card(1);
    assert.match(card.text, /^Settings change requested by the model/);
    assert.match(card.approve, /^st:[A-Za-z0-9]{8}:y$/);
    await b.rig.tap(card.approve);
    const prefsFile = join(b.rig.dirs.data, "prefs", "prefs.json");
    await waitFor(() => {
      try {
        return JSON.parse(readFileSync(prefsFile, "utf8")).style.verbosity === "normal";
      } catch {
        return false;
      }
    }, 10_000, "prefs.json updated");
    await b.rig.seen((t) => /Approved\./.test(t) && /Settings change requested/.test(t), "the card edited to the outcome");
    const s = await signInViaLink(b);
    const audit = (await s.get("/api/audit?limit=50")).json() as { lines: { source: string; decision: string; approver?: { userId?: number } }[] };
    const approved = audit.lines.filter((l) => l.source === "propose" && l.decision === "approved");
    assert.equal(approved.length, 1);
    assert.equal(approved[0]?.approver?.userId, USER_ID);
    const prefs = (await s.get("/api/prefs")).json() as { prefs: { style: { verbosity: string } } };
    assert.equal(prefs.prefs.style.verbosity, "normal", "the UI shows it too (rebuilt from the audit log)");
  } finally {
    await b.close();
  }
});

test("a deny path saved in the UI reaches the job runner's next job (the shared security.json)", async () => {
  const b = await both();
  try {
    const s = await signInViaLink(b);
    const cur = (await s.get("/api/security")).json() as { doc: Record<string, any>; revision: string };
    const secret = join(b.rig.dirs.root, "TopSecret");
    mkdirSync(secret, { recursive: true });
    const r = await s.post("/api/security/save", { formId: "folders", sections: { folders: { ...cur.doc["folders"], deny: [secret] } }, baseRevision: cur.revision });
    assert.equal(r.status, 200, r.text);
    const { effectiveDenyPaths } = await import("../../src/jobrunner/settingsUi/denyPaths.js");
    assert.deepEqual(effectiveDenyPaths({ ownDeny: [], securityFile: join(b.settingsDir, "security.json") }), [secret]);
  } finally {
    await b.close();
  }
});
