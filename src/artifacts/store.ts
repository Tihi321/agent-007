/** REQ-0014 safe reading of job artifacts by relative path. T1 stub: T7 replaces the bodies, keeps the types. */
export type ArtifactRead = { ok: true; bytes: Buffer; mime: "image/png" } | { ok: false; reason: string };

/**
 * root = paths.jobArtifactsDir. Refuses: rel not matching the ArtifactRef pattern, realpath outside root, size > 5 MiB,
 * not a PNG (magic 89 50 4E 47 0D 0A 1A 0A), sha256 mismatch when `expectSha` is given.
 */
export function readArtifact(_root: string, _rel: string, _expectSha?: string): ArtifactRead {
  throw new Error("not implemented: T7");
}

export interface JobManifest {
  jobId: string;
  templateId: string;
  startedAt: number;
  endedAt?: number;
  state: string;
  shots: { path: string; at: number; caption: string }[];
}

/** newest first, default 50, bad files skipped */
export function listManifests(_root: string, _max?: number): JobManifest[] {
  throw new Error("not implemented: T7");
}
