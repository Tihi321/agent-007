/**
 * Screenshot writer and manifest (REQ-0014 T3). Files live at `<artifactsDir>/<jobId>/NNN.png` plus `manifest.json`.
 * `ArtifactRef.path` is always the RELATIVE `<jobId>/NNN.png`. No typed values and no URL query strings go in here.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRef } from "../../../jobs/contracts.js";

export const MAX_SHOT_BYTES = 5 * 1024 * 1024;

export interface ManifestShot {
  path: string;
  at: number;
  caption: string;
}
export interface Manifest {
  jobId: string;
  templateId: string;
  startedAt: number;
  endedAt?: number;
  state: string;
  shots: ManifestShot[];
}

/** `host/path` of a URL without scheme, query, fragment or credentials; "" when it is not a URL. */
export function safeUrlLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 120);
  } catch {
    return "";
  }
}

export function safeCaption(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, (m) => safeUrlLabel(m) || "link").slice(0, 200);
}

export class ArtifactWriter {
  private readonly dir: string;
  private readonly manifest: Manifest;
  private n = 0;

  constructor(
    private readonly root: string,
    readonly jobId: string,
    templateId: string,
    private readonly now: () => number,
  ) {
    this.dir = join(root, jobId);
    mkdirSync(this.dir, { recursive: true });
    this.manifest = { jobId, templateId, startedAt: now(), state: "running", shots: [] };
    this.write();
  }

  get count(): number {
    return this.n;
  }

  /** Reserves the next file. Call `commit` after the file was written. */
  next(): { rel: string; abs: string } {
    const name = `${String(this.n + 1).padStart(3, "0")}.png`;
    return { rel: `${this.jobId}/${name}`, abs: join(this.dir, name) };
  }

  /** Reads the written file back and records it in the manifest. Throws when it is missing or over 5 MiB. */
  commit(slot: { rel: string; abs: string }, caption: string): ArtifactRef {
    const size = statSync(slot.abs).size;
    if (size > MAX_SHOT_BYTES) throw new Error("the screenshot is larger than 5 MiB");
    const sha256 = createHash("sha256").update(readFileSync(slot.abs)).digest("hex");
    const cap = safeCaption(caption);
    this.n += 1;
    this.manifest.shots.push({ path: slot.rel, at: this.now(), caption: cap });
    this.write();
    return { path: slot.rel, mime: "image/png", bytes: size, sha256, caption: cap };
  }

  finish(state: string): void {
    this.manifest.state = state;
    this.manifest.endedAt = this.now();
    this.write();
  }

  private write(): void {
    const file = join(this.dir, "manifest.json");
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.manifest, null, 2));
    renameSync(tmp, file);
  }
}
