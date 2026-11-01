/**
 * The `RefReader` the bus uses for `attach_refs` (S26.1, S21 deviation 82): reads `workspace:<relative path>` in the SENDER's own
 * workspace through the sender's read policy (`botReadPolicy` over `configForBot`), so every deny of the path policy applies (sibling
 * bots, the data root, `folders.deny`, links and `..`). With `cloudSafe` the policy is built over the sender's cloud-safe roots only
 * (plus the workspace alias, which is the one thing a ref names), so nothing outside them can ever be inlined for a cloud receiver.
 *
 * The result is plain text, at most `maxBytes`; a binary file, a folder or anything the policy refuses throws (the router turns every
 * failure into `refused: unreadable_ref`, so no path or reason reaches the model).
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { RefReader, RefReadResult } from "../botbus/refs.js";
import { botPathScope } from "../bots/paths.js";
import { configForBot } from "../bots/config.js";
import type { PresetConfig, ResolvedBot } from "../bots/schema.js";
import type { Config } from "../config/schema.js";
import { botReadPolicy } from "../tools/pathPolicy.js";

export interface RefReaderDeps {
  config: Config;
  bots: readonly ResolvedBot[];
  presets: readonly PresetConfig[];
}

export function createRefReader(deps: RefReaderDeps): RefReader {
  const byId = new Map(deps.bots.map((b) => [b.id, b] as const));
  return {
    async readWorkspaceFile(botId: string, relPath: string, opts: { maxBytes: number; cloudSafe: boolean }): Promise<RefReadResult> {
      const bot = byId.get(botId);
      if (!bot) throw new Error("unknown bot");
      const cfg = configForBot(deps.config, bot, deps.presets);
      const scoped: Config = opts.cloudSafe ? { ...cfg, folders: { allow: bot.cloudSafeRoots.map((r) => ({ ...r })), deny: [...cfg.folders.deny] } } : cfg;
      const policy = botReadPolicy(scoped, botPathScope(deps.config.paths.dataDir, deps.config.paths.programDataDir, bot));
      const r = policy.resolve(`workspace:${relPath}`);
      if (!r.exists) throw new Error("not found");
      const fd = openSync(r.real, "r");
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) throw new Error("not a file");
        const len = Math.min(st.size, opts.maxBytes);
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, 0);
        const head = buf.subarray(0, Math.min(n, 4096));
        if (head.includes(0)) throw new Error("binary");
        return { text: buf.subarray(0, n).toString("utf8"), truncated: st.size > opts.maxBytes };
      } finally {
        closeSync(fd);
      }
    },
  };
}
