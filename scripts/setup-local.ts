/**
 * `yarn setup:local`: a development setup inside the repo, no deploy and no ProgramData. Creates `.local/` (git-ignored) with
 * `config/config.json` (v2) and `settings/security.json` from `config/config.example.json` (every folder inside `.local/`), plus a
 * `secrets/secrets.json` skeleton. It never overwrites an existing file and never invents a secret: placeholders are printed.
 *
 *   yarn setup:local [--presets strata,claude-sonnet,claude-opus] [--dir <folder>]
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACEHOLDER, setupPersonal } from "../src/setup/personal.js";
import type { IcaclsApply, SetupResult } from "../src/setup/personal.js";

export { PLACEHOLDER };
export type { SetupResult };

/** A thin wrapper over the shared personal setup core (`src/setup/personal.ts`): root = `<repo>\.local`, no answers. */
export function setupLocal(opts: { repoRoot: string; dir?: string; presets?: readonly string[]; home?: string; icacls?: IcaclsApply }): SetupResult {
  const r = setupPersonal({
    root: opts.dir ?? join(opts.repoRoot, ".local"),
    resourcesDir: opts.repoRoot,
    home: opts.home ?? homedir(),
    ...(opts.presets ? { presets: opts.presets } : {}),
    ...(opts.icacls ? { icacls: opts.icacls } : {}),
  });
  return { created: r.created, kept: r.kept, mustFill: r.mustFill };
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
