/**
 * The API of the settings UI (S18.2, I25d, I29, I29d). Routes are plain functions `(ctx) => {status, body}`; the server (server.ts)
 * does the guard, the session and the CSRF check before any of them runs.
 *
 *   GET  /api/schema            the descriptors (security, persona, prefs, job runner limits) and the registered forms
 *   GET  /api/security          the document and its revision
 *   POST /api/security/save     {formId?, section | sections, value?, baseRevision, ack?}  -> the save protocol of I25d
 *   POST /api/security/preview  the personas that would become invalid and the new folders that lack an NTFS grant (never blocks)
 *   GET  /api/templates, POST /api/templates/save      job templates (the S11.2 loader's rules)
 *   GET  /api/personas, POST /api/personas/save|delete user-authored personas (validated against the ceiling)
 *   GET  /api/jobrunner, POST /api/jobrunner/save      job runner limits (jobrunner.json, limits only)
 *   GET  /api/audit?limit=      the tail of the audit log; GET /api/prefs the preference values (from the audit log); GET /api/status
 *
 * The UI NEVER writes `config.json`, the agent profile, `secrets.json`, an ACL, or the kill-switch flag. Every write goes through
 * `saveSecurity` / `saveJsonAudited`: validate, check `baseRevision` (409), temp file, audit line, rename.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isSameOrUnder } from "../../config/paths.js";
import type { DefaultsEnv } from "../../config/schema.js";
import type { FsProbe } from "../../config/validate.js";
import { runIcacls, parseIcacls } from "../../config/secrets.js";
import { lastRevisions, readAuditTail } from "../../settings/audit.js";
import { ceilingFor, validateAgainstCeiling } from "../../settings/ceiling.js";
import type { Ceiling } from "../../settings/ceiling.js";
import { SettingsError } from "../../settings/contracts.js";
import type { AuditLine, Persona, SettingsAudit } from "../../settings/contracts.js";
import { validate } from "../../settings/jsonschema.js";
import { PERSONA_SCHEMA, BUILTIN_PERSONA_IDS, MAX_PERSONAS, parsePersona } from "../../settings/personaSchema.js";
import { defaultPrefs } from "../../settings/prefs.js";
import { PREFS_SCHEMA, SECURITY_SCHEMA, validateSecurityDoc } from "../../settings/schema.js";
import { SecurityValidationError, saveJsonAudited, saveSecurity } from "../../settings/securityWriter.js";
import { ABSENT_REVISION, readTextIfExists, revisionOf } from "../../settings/store.js";
import type { ReplaceFs } from "../../settings/store.js";
import { parseJobRunnerConfig, ConfigError as JobRunnerConfigError } from "../limits.js";
import { parseTemplate } from "../templates.js";
import { FormRegistry } from "./forms/registry.js";
import { JOBRUNNER_LIMITS_SCHEMA } from "./forms/jobrunnerLimits.js";
import type { Session } from "./session.js";

export interface UiPaths {
  securityFile: string;
  settingsDir: string;
  personasDir: string;
  auditDir: string;
  templatesDir: string;
  /** `jobrunner.json`, when the job runner knows where it came from. */
  jobrunnerFile?: string | undefined;
}

export interface RoutesDeps {
  paths: UiPaths;
  audit: SettingsAudit;
  forms: FormRegistry;
  flowServerId: string;
  hubServices: () => readonly string[];
  env?: DefaultsEnv;
  fsProbe?: FsProbe;
  agentUser?: string;
  /** Called after a template was saved so the job runner reloads its registry. */
  reloadTemplates?: () => void;
  /** NTFS read grant of the agent user on a folder (default: parses `icacls`). */
  folderGrant?: (path: string) => "granted" | "missing" | "unknown";
  /** Test seams of the audited replace. */
  replaceFs?: ReplaceFs;
  sleep?: (ms: number) => Promise<void>;
  retryDelayMs?: number;
}

export interface RouteContext {
  session: Session;
  body: unknown;
  query: URLSearchParams;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type Route = (ctx: RouteContext) => Promise<RouteResult> | RouteResult;

const ok = (body: unknown): RouteResult => ({ status: 200, body });
const err = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): RouteResult => ({ status, body: { error, message, ...extra } });

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SECTIONS = new Set(Object.keys(SECURITY_SCHEMA.properties ?? {}).filter((k) => k !== "schemaVersion"));

/** The preference values, rebuilt from the audit log (the agent profile is not readable by the main user). */
export function reconstructPrefs(lines: readonly AuditLine[]): Record<string, unknown> {
  const prefs = defaultPrefs() as Record<string, unknown>;
  for (const l of lines) {
    if (l.target.file !== "prefs.json" || !(l.decision === "approved" || l.decision === "auto" || l.decision === "applied")) continue;
    for (const d of l.diff) {
      if (d.op === "remove" || typeof d.after !== "string") continue;
      const segs = d.path.split(".");
      if (segs.length === 2 && segs[0] === "style" && ["tone", "verbosity", "language", "notes"].includes(segs[1] as string)) (prefs["style"] as Record<string, unknown>)[segs[1] as string] = d.after;
      if (segs.length === 1 && segs[0] === "defaultPersona") prefs["defaultPersona"] = d.after;
    }
  }
  return prefs;
}

export function createRoutes(deps: RoutesDeps): Record<string, Route> {
  const { paths } = deps;
  const approver = (s: Session) => ({ kind: "ui" as const, sessionHash: s.hash });
  const replaceOpts = { ...(deps.replaceFs ? { fs: deps.replaceFs } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.retryDelayMs !== undefined ? { retryDelayMs: deps.retryDelayMs } : {}) };

  const readSecurity = (): { doc: Record<string, unknown>; text: string; revision: string } | undefined => {
    const text = readTextIfExists(paths.securityFile);
    if (text === undefined) return undefined;
    return { doc: JSON.parse(text) as Record<string, unknown>, text, revision: revisionOf(text) };
  };

  const templateIds = (): string[] => {
    const out: string[] = [];
    try {
      for (const n of readdirSync(paths.templatesDir)) {
        if (!n.toLowerCase().endsWith(".json")) continue;
        try {
          const id = (JSON.parse(readFileSync(join(paths.templatesDir, n), "utf8")) as { id?: unknown }).id;
          if (typeof id === "string") out.push(id);
        } catch {
          /* skipped */
        }
      }
    } catch {
      /* no templates folder */
    }
    return out;
  };

  const ceilingOf = (doc: Record<string, unknown>): Ceiling => ceilingFor(doc as never, { templates: templateIds() });

  const readPersonas = (): { id: string; file: string; doc: unknown; revision: string; text: string }[] => {
    const out: { id: string; file: string; doc: unknown; revision: string; text: string }[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(paths.personasDir).filter((n) => n.endsWith(".json")).sort();
    } catch {
      return out;
    }
    for (const n of names) {
      const file = join(paths.personasDir, n);
      try {
        const text = readFileSync(file, "utf8");
        out.push({ id: n.replace(/\.json$/, ""), file, doc: JSON.parse(text), revision: revisionOf(text), text });
      } catch {
        out.push({ id: n.replace(/\.json$/, ""), file, doc: undefined, revision: ABSENT_REVISION, text: "" });
      }
    }
    return out;
  };

  const personaStatus = (rec: { id: string; doc: unknown }, c: Ceiling): { valid: boolean; reasons: string[] } => {
    const parsed = parsePersona(rec.doc);
    if (!parsed.persona) return { valid: false, reasons: parsed.issues };
    if (parsed.persona.id !== rec.id) return { valid: false, reasons: [`the file name does not match the persona id "${parsed.persona.id}"`] };
    const v = validateAgainstCeiling(parsed.persona, c);
    return { valid: v.ok, reasons: v.reasons };
  };

  const mapError = (e: unknown): RouteResult => {
    if (e instanceof SecurityValidationError) return err(422, "invalid", e.message, { issues: e.issues });
    if (e instanceof SettingsError) {
      if (e.code === "stale_base") return err(409, "stale", "The settings changed since you loaded them. Reload and apply your change again.");
      if (e.code === "invalid_value") return err(422, "invalid", e.message, { issues: [e.message] });
      if (e.code === "audit_failed") return err(500, "audit_failed", "The audit log could not be written, so nothing was changed.");
      if (e.code === "apply_failed") return err(500, "apply_failed", e.message);
      return err(400, e.code, e.message);
    }
    return err(500, "error", "The save failed.");
  };

  /** Applies the requested sections onto the current document. */
  const sectionsFrom = (body: Record<string, unknown>): { sections: Record<string, unknown> } | RouteResult => {
    let sections: Record<string, unknown>;
    if (isObj(body["sections"])) sections = body["sections"];
    else if (typeof body["section"] === "string") sections = { [body["section"]]: body["value"] };
    else return err(400, "bad_request", "send {section, value, baseRevision} or {sections, baseRevision}");
    const keys = Object.keys(sections);
    if (keys.length === 0 || keys.length > 8) return err(400, "bad_request", "no sections to save");
    for (const k of keys) if (!SECTIONS.has(k)) return err(400, "bad_request", `"${k.slice(0, 40)}" is not a section of the security settings`);
    return { sections };
  };

  const applySections = (doc: Record<string, unknown>, sections: Record<string, unknown>): Record<string, unknown> => {
    const next: Record<string, unknown> = { ...doc };
    for (const [k, v] of Object.entries(sections)) Object.defineProperty(next, k, { value: v, enumerable: true, writable: true, configurable: true });
    return next;
  };

  const folderGrant =
    deps.folderGrant ??
    ((p: string): "granted" | "missing" | "unknown" => {
      try {
        const entries = parseIcacls(runIcacls(p), p);
        const agent = (deps.agentUser ?? "agent007").toLowerCase();
        const mine = entries.filter((e) => !e.deny && (e.principal.toLowerCase().endsWith(`\\${agent}`) || e.principal.toLowerCase() === agent));
        return mine.some((e) => e.flags.some((f) => f.split(",").some((t) => ["R", "RX", "M", "F", "GR", "GA"].includes(t.trim().toUpperCase())))) ? "granted" : "missing";
      } catch {
        return "unknown";
      }
    });

  const routes: Record<string, Route> = {
    "GET /api/schema": () =>
      ok({
        security: SECURITY_SCHEMA,
        persona: PERSONA_SCHEMA,
        prefs: PREFS_SCHEMA,
        jobrunnerLimits: JOBRUNNER_LIMITS_SCHEMA,
        forms: deps.forms.list(),
        builtinPersonas: [...BUILTIN_PERSONA_IDS],
        absentRevision: ABSENT_REVISION,
      }),

    "GET /api/security": () => {
      try {
        const cur = readSecurity();
        if (!cur) return err(404, "not_migrated", "security.json does not exist yet. Run migrate-settings first.");
        return ok({ doc: cur.doc, revision: cur.revision });
      } catch {
        return err(500, "unreadable", "security.json cannot be read or is not valid JSON.");
      }
    },

    "POST /api/security/save": async (ctx) => {
      const body = ctx.body;
      if (!isObj(body) || typeof body["baseRevision"] !== "string") return err(400, "bad_request", "baseRevision is required");
      const secs = sectionsFrom(body);
      if ("status" in secs) return secs;
      let formNote: string | undefined;
      if (body["formId"] !== undefined) {
        const form = typeof body["formId"] === "string" ? deps.forms.get(body["formId"]) : undefined;
        if (!form || form.target !== "security") return err(404, "unknown_form", "unknown form");
        for (const k of Object.keys(secs.sections)) if (!form.section.includes(k)) return err(400, "bad_request", `the form "${form.id}" does not edit "${k}"`);
        if (form.ack) {
          if (body["ack"] !== true) return err(422, "ack_required", form.ack.text);
          formNote = `ack: ${form.ack.text.slice(0, 180)}`;
        }
      }
      // `termsAccepted` is set only through a form that carries the acknowledgment text, and only with `ack: true` (I41, UI-24)
      if (Object.keys(secs.sections).includes("termsAccepted")) {
        const f = typeof body["formId"] === "string" ? deps.forms.get(body["formId"]) : undefined;
        if (!f?.ack) return err(422, "ack_required", "termsAccepted can be saved only through its own form, with the acknowledgment");
        if (body["ack"] !== true) return err(422, "ack_required", f.ack.text);
      }
      let cur: ReturnType<typeof readSecurity>;
      try {
        cur = readSecurity();
      } catch {
        return err(500, "unreadable", "security.json cannot be read or is not valid JSON.");
      }
      if (!cur) return err(404, "not_migrated", "security.json does not exist yet. Run migrate-settings first.");
      try {
        const r = await saveSecurity({
          securityFile: paths.securityFile,
          doc: applySections(cur.doc, secs.sections),
          baseRevision: body["baseRevision"],
          audit: deps.audit,
          source: "ui",
          approver: approver(ctx.session),
          section: Object.keys(secs.sections).join("+"),
          ...(formNote ? { note: formNote } : {}),
          validation: { ...(deps.env ? { env: deps.env } : {}), ...(deps.fsProbe ? { fs: deps.fsProbe } : {}) },
          ...replaceOpts,
        });
        return ok({ revision: r.afterRevision, restartRequired: true, message: "Saved. The agent uses it after it restarts: send /applysettings in Telegram." });
      } catch (e) {
        return mapError(e);
      }
    },

    "POST /api/security/preview": (ctx) => {
      const body = ctx.body;
      if (!isObj(body)) return err(400, "bad_request", "expected an object");
      const secs = sectionsFrom(body);
      if ("status" in secs) return secs;
      let cur: ReturnType<typeof readSecurity>;
      try {
        cur = readSecurity();
      } catch {
        return err(500, "unreadable", "security.json cannot be read or is not valid JSON.");
      }
      if (!cur) return err(404, "not_migrated", "security.json does not exist yet. Run migrate-settings first.");
      const next = applySections(cur.doc, secs.sections);
      const v = validateSecurityDoc(next, { ...(deps.env ? { env: deps.env } : {}), ...(deps.fsProbe ? { fs: deps.fsProbe } : {}) });
      const before = ceilingOf(cur.doc);
      const after = ceilingOf(next);
      const invalidPersonas: { id: string; reasons: string[] }[] = [];
      for (const rec of readPersonas()) {
        const was = personaStatus(rec, before);
        const will = personaStatus(rec, after);
        if (was.valid && !will.valid) invalidPersonas.push({ id: rec.id, reasons: will.reasons });
      }
      const oldAllow = new Set((((cur.doc["folders"] as { allow?: { path: string }[] } | undefined)?.allow) ?? []).map((a) => a.path.toLowerCase()));
      const folderWarnings: string[] = [];
      for (const a of ((next["folders"] as { allow?: { alias: string; path: string }[] } | undefined)?.allow) ?? []) {
        if (oldAllow.has(String(a.path).toLowerCase())) continue;
        if (folderGrant(a.path) !== "granted") folderWarnings.push(`The agent user has no read access to "${a.alias}" yet. Run deploy\\grant-folder-acls.ps1 for it.`);
      }
      // A new deny path that sits inside an allowed folder is fine (deny wins); say so once.
      const deny = (((next["folders"] as { deny?: string[] } | undefined)?.deny) ?? []).filter((d) => ((next["folders"] as { allow: { path: string }[] }).allow ?? []).some((a) => isSameOrUnder(d, a.path)));
      return ok({ valid: v.ok, issues: v.issues, warnings: v.warnings, invalidPersonas, folderWarnings, denyInsideAllowed: deny, restartRequired: true });
    },

    "GET /api/templates": () => {
      const items: { file: string; doc: unknown; revision: string; errors: string[] }[] = [];
      let names: string[] = [];
      try {
        names = readdirSync(paths.templatesDir).filter((n) => n.toLowerCase().endsWith(".json")).sort();
      } catch {
        /* no templates folder */
      }
      for (const n of names) {
        try {
          const text = readFileSync(join(paths.templatesDir, n), "utf8");
          const doc = JSON.parse(text) as unknown;
          const r = parseTemplate(doc, { flowServerId: deps.flowServerId, hubServices: deps.hubServices() });
          items.push({ file: n, doc, revision: revisionOf(text), errors: r.ok ? [] : r.errors });
        } catch {
          items.push({ file: n, doc: null, revision: ABSENT_REVISION, errors: ["not valid JSON"] });
        }
      }
      return ok({ items });
    },

    "POST /api/templates/save": async (ctx) => {
      const body = ctx.body;
      if (!isObj(body) || typeof body["baseRevision"] !== "string" || !isObj(body["doc"])) return err(400, "bad_request", "send {doc, baseRevision}");
      const r = parseTemplate(body["doc"], { flowServerId: deps.flowServerId, hubServices: deps.hubServices() });
      if (!r.ok) return err(422, "invalid", "The template is not valid.", { issues: r.errors });
      const file = join(paths.templatesDir, `${r.template.id}.json`);
      try {
        mkdirSync(paths.templatesDir, { recursive: true });
        const saved = await saveJsonAudited({
          file,
          doc: body["doc"],
          baseRevision: body["baseRevision"],
          audit: deps.audit,
          entry: { source: "ui", kind: "template", target: { file: `templates/${r.template.id}.json`, path: "(document)" }, approver: approver(ctx.session) },
          ...replaceOpts,
        });
        deps.reloadTemplates?.();
        return ok({ revision: saved.afterRevision, message: "Saved. The job runner loaded it." });
      } catch (e) {
        return mapError(e);
      }
    },

    "GET /api/personas": () => {
      let cur: ReturnType<typeof readSecurity>;
      try {
        cur = readSecurity();
      } catch {
        return err(500, "unreadable", "security.json cannot be read or is not valid JSON.");
      }
      const c = cur ? ceilingOf(cur.doc) : undefined;
      const personas = readPersonas().map((rec) => ({ id: rec.id, doc: rec.doc, revision: rec.revision, ...(c ? personaStatus(rec, c) : { valid: false, reasons: ["no security settings"] }) }));
      return ok({
        personas,
        max: MAX_PERSONAS,
        builtin: [...BUILTIN_PERSONA_IDS],
        ceiling: c ? { tools: c.tools, presets: c.presets, jobTemplates: c.jobTemplates, mcp: c.mcp, maxJobsPerDay: Number.isFinite(c.maxJobsPerDay) ? c.maxJobsPerDay : null, defaultPreset: c.defaultPreset } : null,
      });
    },

    "POST /api/personas/save": async (ctx) => {
      const body = ctx.body;
      if (!isObj(body) || typeof body["baseRevision"] !== "string") return err(400, "bad_request", "send {persona, baseRevision}");
      const parsed = parsePersona(body["persona"]);
      if (!parsed.persona) return err(422, "invalid", "The persona is not valid.", { issues: parsed.issues });
      const p: Persona = parsed.persona;
      if (BUILTIN_PERSONA_IDS.includes(p.id)) return err(422, "invalid", `"${p.id}" is a built-in persona id`, { issues: [`id: "${p.id}" is built in`] });
      let cur: ReturnType<typeof readSecurity>;
      try {
        cur = readSecurity();
      } catch {
        return err(500, "unreadable", "security.json cannot be read or is not valid JSON.");
      }
      if (!cur) return err(404, "not_migrated", "security.json does not exist yet. Run migrate-settings first.");
      const v = validateAgainstCeiling(p, ceilingOf(cur.doc));
      if (!v.ok) return err(422, "persona_invalid", "A persona can only narrow what the security settings allow.", { issues: v.reasons });
      const existing = readPersonas();
      if (!existing.some((e) => e.id === p.id) && existing.length >= MAX_PERSONAS) return err(422, "invalid", `At most ${MAX_PERSONAS} personas.`, { issues: [`at most ${MAX_PERSONAS} personas`] });
      try {
        const saved = await saveJsonAudited({
          file: join(paths.personasDir, `${p.id}.json`),
          doc: p,
          baseRevision: body["baseRevision"],
          audit: deps.audit,
          entry: { source: "ui", kind: "persona", persona: p.id, target: { file: `personas/${p.id}.json`, path: "(document)" }, approver: approver(ctx.session) },
          ...replaceOpts,
        });
        return ok({ revision: saved.afterRevision, message: "Saved. A chat uses it the next time the persona is applied." });
      } catch (e) {
        return mapError(e);
      }
    },

    "POST /api/personas/delete": async (ctx) => {
      const body = ctx.body;
      if (!isObj(body) || typeof body["id"] !== "string" || typeof body["baseRevision"] !== "string") return err(400, "bad_request", "send {id, baseRevision}");
      const id = body["id"];
      if (!/^[a-z][a-z0-9-]{1,23}$/.test(id)) return err(400, "bad_request", "not a persona id");
      const file = join(paths.personasDir, `${id}.json`);
      const text = readTextIfExists(file);
      if (text === undefined) return err(404, "not_found", "no such persona");
      try {
        // The audit line goes in first; if it cannot be written the file stays.
        deps.audit.append({
          source: "ui",
          kind: "persona",
          persona: id,
          target: { file: `personas/${id}.json`, path: "(document)" },
          diff: [{ path: "(persona)", op: "remove", before: id }],
          decision: "applied",
          approver: approver(ctx.session),
          baseRevision: body["baseRevision"],
          afterRevision: ABSENT_REVISION,
        });
        if (revisionOf(text) !== body["baseRevision"]) return err(409, "stale", "The persona changed since you loaded it.");
        rmSync(file, { force: true });
        return ok({ message: "Deleted." });
      } catch (e) {
        return mapError(e);
      }
    },

    "GET /api/jobrunner": () => {
      if (!paths.jobrunnerFile) return err(404, "unavailable", "The job runner does not know where jobrunner.json is.");
      const text = readTextIfExists(paths.jobrunnerFile);
      if (text === undefined) return err(404, "unavailable", "jobrunner.json does not exist.");
      try {
        const doc = JSON.parse(text) as Record<string, unknown>;
        const parsed = parseJobRunnerConfig(doc);
        return ok({ doc: { limits: parsed.limits }, revision: revisionOf(text) });
      } catch {
        return err(500, "unreadable", "jobrunner.json is not valid.");
      }
    },

    "POST /api/jobrunner/save": async (ctx) => {
      const body = ctx.body;
      if (!paths.jobrunnerFile) return err(404, "unavailable", "The job runner does not know where jobrunner.json is.");
      if (!isObj(body) || typeof body["baseRevision"] !== "string" || !isObj(body["limits"])) return err(400, "bad_request", "send {limits, baseRevision}");
      const text = readTextIfExists(paths.jobrunnerFile);
      if (text === undefined) return err(404, "unavailable", "jobrunner.json does not exist.");
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return err(500, "unreadable", "jobrunner.json is not valid JSON.");
      }
      const limitsCheck = validateLimits(body["limits"]);
      if (limitsCheck.length > 0) return err(422, "invalid", "The job runner limits are not valid.", { issues: limitsCheck });
      const next = { ...raw, limits: body["limits"] };
      try {
        parseJobRunnerConfig(next);
      } catch (e) {
        if (e instanceof JobRunnerConfigError) return err(422, "invalid", "The job runner limits are not valid.", { issues: e.problems });
        throw e;
      }
      try {
        const saved = await saveJsonAudited({
          file: paths.jobrunnerFile,
          doc: next,
          baseRevision: body["baseRevision"],
          audit: deps.audit,
          entry: { source: "ui", kind: "security", target: { file: "jobrunner.json", path: "limits" }, approver: approver(ctx.session) },
          ...replaceOpts,
        });
        return ok({ revision: saved.afterRevision, message: "Saved. The job runner uses it after it restarts." });
      } catch (e) {
        return mapError(e);
      }
    },

    "GET /api/audit": (ctx) => {
      const limit = Math.max(1, Math.min(200, Number(ctx.query.get("limit") ?? "50") || 50));
      return ok({ lines: readAuditTail(paths.auditDir, limit) });
    },

    "GET /api/prefs": () => ok({ prefs: reconstructPrefs(readAuditTail(paths.auditDir, 500)), source: "audit", note: "The preferences live in the agent's own profile, which this UI cannot read. This is rebuilt from the audit log." }),

    "GET /api/status": () => {
      let file: string | undefined;
      try {
        const t = readTextIfExists(paths.securityFile);
        file = t === undefined ? undefined : revisionOf(t);
      } catch {
        file = undefined;
      }
      const lines = readAuditTail(paths.auditDir, 500);
      const running = [...lines].reverse().find((l) => l.writer === "agent" && l.decision === "loaded" && l.target.file === "security.json" && l.target.path === "(running)")?.afterRevision ?? null;
      let invalidPersonas: { id: string; reasons: string[] }[] = [];
      try {
        const cur = readSecurity();
        if (cur) {
          const c = ceilingOf(cur.doc);
          invalidPersonas = readPersonas().flatMap((rec) => {
            const s = personaStatus(rec, c);
            return s.valid ? [] : [{ id: rec.id, reasons: s.reasons }];
          });
        }
      } catch {
        /* reported as no revision */
      }
      return ok({
        fileRevision: file ?? null,
        runningRevision: running,
        restartRequired: file !== undefined && running !== null && file !== running,
        lastAudited: lastRevisions(paths.auditDir)["security.json"] ?? null,
        invalidPersonas,
        killSwitchNote: "The kill-switch flag is not visible here. If /killshell was used, delete the flag file on the agent's machine to re-enable shell.",
      });
    },
  };
  return routes;
}

/** Structural checks of `limits` against the descriptors, so a message names the path. */
function validateLimits(limits: Record<string, unknown>): string[] {
  return validate(JOBRUNNER_LIMITS_SCHEMA, { limits }).map((i) => `${i.path}: ${i.message}`);
}
