/**
 * The persona store (S19.1, I27b, I29c). Two folders, both read as UNTRUSTED input at every change:
 *   - `settings\personas\<id>.json`        user-authored, written by the settings UI (agent R);
 *   - `%LOCALAPPDATA%\agent-007\prefs\personas\<id>.json`   model-proposed and approved in Telegram (agent F).
 * Ids match `[a-z][a-z0-9-]{1,23}` and are immutable (the file name is the id). An id in the user folder SHADOWS the same id in the
 * model folder; a model file may not use a built-in id; at most 12 personas. An invalid file stays LISTED with its reason and is
 * unselectable: it is never clipped, never "repaired". Hand-editing a model-authored file to widen it makes it invalid at the next
 * load, because validity is always checked against the current ceiling.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateAgainstCeiling } from "../settings/ceiling.js";
import type { Ceiling } from "../settings/ceiling.js";
import { MAX_PERSONAS } from "../settings/contracts.js";
import type { Persona } from "../settings/contracts.js";
import { BUILTIN_PERSONA_IDS, parsePersona } from "../settings/personaSchema.js";

export type PersonaSource = "user" | "model";

export interface PersonaFile {
  id: string;
  source: PersonaSource;
  file: string;
  /** `sha256` of the file text, for the audit drift check. */
  revision: string;
  persona?: Persona;
  /** Structural problems of the file (empty when `persona` is set). */
  issues: string[];
}

export interface PersonaEntry extends PersonaFile {
  valid: boolean;
  reasons: string[];
  /** True when a user-authored file of the same id hides this model-authored one. */
  shadowed?: boolean;
}

export interface PersonaStoreOptions {
  userDir: string;
  modelDir: string;
  /** Known tool names (default `KNOWN_TOOLS`). */
  known?: readonly string[];
}

const FILE_RE = /^([a-z][a-z0-9-]{1,23})\.json$/;

function readDir(dir: string, source: PersonaSource): PersonaFile[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: PersonaFile[] = [];
  for (const n of names) {
    const file = join(dir, n);
    const m = FILE_RE.exec(n);
    if (!m) {
      out.push({ id: n.replace(/\.json$/, ""), source, file, revision: "", issues: ["the file name is not a valid persona id (lowercase letters, digits and dashes, starting with a letter)"] });
      continue;
    }
    const id = m[1] as string;
    let text: string;
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > 64 * 1024) {
        out.push({ id, source, file, revision: "", issues: ["not a regular file or larger than 64 KB"] });
        continue;
      }
      text = readFileSync(file, "utf8");
    } catch {
      out.push({ id, source, file, revision: "", issues: ["the file cannot be read"] });
      continue;
    }
    const revision = createHash("sha256").update(text, "utf8").digest("hex");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      out.push({ id, source, file, revision, issues: ["not valid JSON"] });
      continue;
    }
    const p = parsePersona(raw);
    if (!p.persona) out.push({ id, source, file, revision, issues: p.issues });
    else if (p.persona.id !== id) out.push({ id, source, file, revision, issues: [`the file name says "${id}" but the persona id is "${p.persona.id}"`] });
    else out.push({ id, source, file, revision, persona: p.persona, issues: [] });
  }
  return out;
}

export class PersonaStore {
  readonly #o: PersonaStoreOptions;
  #sig = "";
  #files: PersonaFile[] = [];

  constructor(o: PersonaStoreOptions) {
    this.#o = o;
  }

  /** The files of both folders, re-read when a folder's listing or any file's size or mtime changed. */
  files(): PersonaFile[] {
    const sig = [this.#o.userDir, this.#o.modelDir]
      .map((d) => {
        try {
          return readdirSync(d)
            .sort()
            .map((n) => {
              try {
                const st = statSync(join(d, n));
                return `${n}:${st.size}:${st.mtimeMs}`;
              } catch {
                return `${n}:?`;
              }
            })
            .join("|");
        } catch {
          return "absent";
        }
      })
      .join("##");
    if (sig !== this.#sig) {
      this.#files = [...readDir(this.#o.userDir, "user"), ...readDir(this.#o.modelDir, "model")];
      this.#sig = sig;
    }
    return this.#files;
  }

  /** Every persona file with its validity under `ceiling`. A shadowed model file is not listed as selectable. */
  entries(ceiling: Ceiling): PersonaEntry[] {
    const files = this.files();
    const userIds = new Set(files.filter((f) => f.source === "user").map((f) => f.id));
    const out: PersonaEntry[] = [];
    let count = 0;
    for (const f of files) {
      if (f.source === "model" && userIds.has(f.id)) continue; // shadowed by the user's own persona
      const e: PersonaEntry = { ...f, valid: false, reasons: [...f.issues] };
      count++;
      if (BUILTIN_PERSONA_IDS.includes(f.id)) e.reasons.push(`"${f.id}" is a built-in persona id`);
      else if (count > MAX_PERSONAS) e.reasons.push(`more than ${MAX_PERSONAS} personas: this one is not used`);
      else if (f.persona) {
        const v = validateAgainstCeiling(f.persona, ceiling, this.#o.known);
        e.reasons.push(...v.reasons);
      }
      e.valid = f.persona !== undefined && e.reasons.length === 0;
      out.push(e);
    }
    return out;
  }

  /** The entry for an id (user-authored first), valid or not. */
  get(id: string, ceiling: Ceiling): PersonaEntry | undefined {
    return this.entries(ceiling).find((e) => e.id === id);
  }

  /** The id is used by a user-authored file (a model proposal may not take it). */
  isUserAuthored(id: string): boolean {
    return this.files().some((f) => f.source === "user" && f.id === id);
  }

  get modelDir(): string {
    return this.#o.modelDir;
  }

  get userDir(): string {
    return this.#o.userDir;
  }
}
