/**
 * The shared, read-only facts and skills (S20.3, I43): `<programData>\shared\FACTS.md` and `shared\skills\`, written only by the user
 * or an admin (agent user R, no W; `check-acl.ps1` fails a writable one), loaded into the prompt like `USER.md` for the bots whose
 * config has `shared.read: true`. No bot tool writes there: the write policy has only the bot's own workspace.
 *
 * The section is `shared_facts`. S26 places it with the other sections (`afterPreamble`, after `user_profile`). A bot without
 * `shared.read` has no such section at all, so another bot's facts are never in its prompt.
 */
import { readFile, readdir } from "node:fs/promises";
import { section } from "../pi/adapter.js";
import { NONE_TEXT, capText, neutralizeTags } from "../prompt/sections.js";
import type { SharedPaths } from "./paths.js";
import type { ResolvedBot } from "./schema.js";

export const SHARED_FACTS_MAX_BYTES = 8 * 1024;
export const SHARED_SKILLS_MAX_LISTED = 40;
export const SHARED_SECTION_KEY = "shared_facts";

const OWN_TAG = /<\s*(\/?)\s*shared_facts\b/gi;

/** The inner text of the section: FACTS.md (capped, our own tag neutralised) and the names of the shared skill files. */
export async function renderSharedFacts(shared: SharedPaths): Promise<string> {
  let facts = "";
  try {
    facts = (await readFile(shared.factsFile, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
  } catch {
    /* absent or unreadable: shown as none */
  }
  let skills: string[] = [];
  try {
    skills = (await readdir(shared.skillsDir)).sort((a, b) => a.localeCompare(b, "en")).slice(0, SHARED_SKILLS_MAX_LISTED);
  } catch {
    /* no skills folder */
  }
  if (facts === "" && skills.length === 0) return NONE_TEXT;
  const parts: string[] = [];
  if (facts !== "") parts.push(`Facts the user keeps for every bot (read only):\n${capText(neutralizeTags(facts).replace(OWN_TAG, (_m, slash: string) => `&lt;${slash}shared_facts`), SHARED_FACTS_MAX_BYTES).text}`);
  if (skills.length > 0) parts.push(`Shared skills you may read with read_file (shared:skills/<name>): ${skills.join(", ")}`);
  return parts.join("\n\n");
}

/** The `shared_facts` prompt section for a bot with `shared.read`; `undefined` for every other bot. */
export function createSharedSection(bot: Pick<ResolvedBot, "shared">, shared: SharedPaths): ReturnType<typeof section> | undefined {
  return bot.shared.read ? section(SHARED_SECTION_KEY, () => renderSharedFacts(shared)) : undefined;
}
