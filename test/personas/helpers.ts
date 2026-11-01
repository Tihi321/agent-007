/** Fixtures for the persona tests (S19): a ceiling, persona folders, and a resolver without a Harness (in-memory map). Not a test file. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PersonaResolver } from "../../src/personas/resolver.js";
import { PersonaStore } from "../../src/personas/store.js";
import { ceilingFor } from "../../src/settings/ceiling.js";
import type { Ceiling, SecurityLike } from "../../src/settings/ceiling.js";
import { PrefsStore } from "../../src/settings/prefs.js";
import { draft, tempDir } from "../settings/helpers.js";

export { draft };

export const TEMPLATES = ["tts-line", "chiptune-loop", "short-video-from-idea", "visual-novel-from-idea", "list-runs"];

export function security(over: Partial<SecurityLike> = {}): SecurityLike {
  return {
    shell: { enabled: true },
    mcp: { servers: [{ id: "vibetts", allowTools: ["speak", "list_voices"], macros: ["tts_line", "chiptune_loop", "comfy_image"] }] },
    presets: [{ id: "lmstudio" }, { id: "strata" }],
    model: { defaultPreset: "lmstudio", runner: "lmstudio" },
    budgets: { maxJobsPerDay: 20 },
    ...over,
  };
}

export interface PersonaFixture {
  dir: string;
  userDir: string;
  modelDir: string;
  sec: { v: SecurityLike };
  store: PersonaStore;
  prefs: PrefsStore;
  prefsFile: string;
  clock: { t: number };
  chatOf: Map<string, number>;
  resolver: PersonaResolver;
  ceiling: () => Ceiling;
  write(where: "user" | "model", persona: Record<string, unknown>, fileId?: string): string;
  cleanup(): void;
}

export function personaFixture(over: { sec?: SecurityLike; defaultPersona?: string } = {}): PersonaFixture {
  const dir = tempDir("a7-pers-");
  const userDir = join(dir, "settings", "personas");
  const modelDir = join(dir, "prefs", "personas");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  const prefsFile = join(dir, "prefs", "prefs.json");
  if (over.defaultPersona) writeFileSync(prefsFile, JSON.stringify({ defaultPersona: over.defaultPersona }));
  const sec = { v: over.sec ?? security() };
  const ceiling = (): Ceiling => ceilingFor(sec.v, { templates: TEMPLATES });
  const store = new PersonaStore({ userDir, modelDir });
  const prefs = new PrefsStore(prefsFile);
  const clock = { t: Date.parse("2026-10-30T10:00:00") };
  const chatOf = new Map<string, number>([["7", 4242], ["8", 4242]]);
  const resolver = new PersonaResolver({ store, ceiling, chats: { chatForConversation: (id) => chatOf.get(id) }, prefs, getHarness: () => undefined, now: () => clock.t });
  return {
    dir,
    userDir,
    modelDir,
    sec,
    store,
    prefs,
    prefsFile,
    clock,
    chatOf,
    resolver,
    ceiling,
    write(where, persona, fileId) {
      const file = join(where === "user" ? userDir : modelDir, `${fileId ?? String(persona["id"])}.json`);
      writeFileSync(file, JSON.stringify(persona, null, 2));
      return file;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
