/** REQ-0014 safe reading of job artifacts by relative path (Telegram agent and web gateway). */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type ArtifactRead = { ok: true; bytes: Buffer; mime: "image/png" } | { ok: false; reason: string };

const MAX_BYTES = 5 * 1024 * 1024;
const REL_RE = /^job-[0-9a-f]{12}\/\d{3}\.png$/;
const JOB_DIR_RE = /^job-[0-9a-f]{12}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * root = paths.jobArtifactsDir. Refuses: rel not matching the ArtifactRef pattern, realpath outside root, size > 5 MiB,
 * not a PNG (magic 89 50 4E 47 0D 0A 1A 0A), sha256 mismatch when `expectSha` is given.
 */
export function readArtifact(root: string, rel: string, expectSha?: string): ArtifactRead {
  if (typeof rel !== "string" || !REL_RE.test(rel)) return { ok: false, reason: "not a valid artifact path" };
  try {
    const realRoot = realpathSync(root);
    const file = realpathSync(path.join(realRoot, ...rel.split("/")));
    if (!inside(realRoot, file)) return { ok: false, reason: "path is outside the artifacts folder" };
    const st = statSync(file);
    if (!st.isFile()) return { ok: false, reason: "not a file" };
    if (st.size > MAX_BYTES) return { ok: false, reason: "file is larger than 5 MiB" };
    const bytes = readFileSync(file);
    if (bytes.length > MAX_BYTES) return { ok: false, reason: "file is larger than 5 MiB" };
    if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return { ok: false, reason: "not a PNG file" };
    if (expectSha !== undefined && createHash("sha256").update(bytes).digest("hex") !== expectSha.toLowerCase()) return { ok: false, reason: "checksum mismatch" };
    return { ok: true, bytes, mime: "image/png" };
  } catch {
    return { ok: false, reason: "artifact not found" };
  }
}

export interface JobManifest {
  jobId: string;
  templateId: string;
  startedAt: number;
  endedAt?: number;
  state: string;
  shots: { path: string; at: number; caption: string }[];
}

function parseManifest(raw: unknown, dirName: string): JobManifest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  if (m["jobId"] !== dirName || typeof m["templateId"] !== "string" || typeof m["startedAt"] !== "number" || typeof m["state"] !== "string") return undefined;
  if (!Array.isArray(m["shots"])) return undefined;
  const shots: JobManifest["shots"] = [];
  for (const s of m["shots"] as unknown[]) {
    if (typeof s !== "object" || s === null) return undefined;
    const o = s as Record<string, unknown>;
    if (typeof o["path"] !== "string" || !REL_RE.test(o["path"]) || typeof o["at"] !== "number" || typeof o["caption"] !== "string") return undefined;
    shots.push({ path: o["path"], at: o["at"], caption: o["caption"] });
  }
  return {
    jobId: dirName,
    templateId: m["templateId"],
    startedAt: m["startedAt"],
    ...(typeof m["endedAt"] === "number" ? { endedAt: m["endedAt"] } : {}),
    state: m["state"],
    shots,
  };
}

/** newest first, default 50, bad files skipped */
export function listManifests(root: string, max = 50): JobManifest[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: JobManifest[] = [];
  for (const name of names) {
    if (!JOB_DIR_RE.test(name)) continue;
    try {
      const file = path.join(root, name, "manifest.json");
      if (statSync(file).size > 1024 * 1024) continue;
      const m = parseManifest(JSON.parse(readFileSync(file, "utf8")), name);
      if (m) out.push(m);
    } catch {
      // bad or missing manifest: skipped
    }
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out.slice(0, Math.max(0, max));
}
