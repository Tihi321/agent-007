/**
 * Boundary checks (P0.2 done-check, S1.0, S9.2). Run: `yarn check:adapter`.
 *
 * 1. Adapter check: only `src/pi/adapter.ts` may import the Pi packages (the whole earendil-works scope, which includes
 *    pi-mcp) or `typebox`. Everything else imports from the adapter.
 * 2. ACP check (Phase 2, S9.2): the Agent Client Protocol SDK package scope (the `@agentclient` + `protocol/` prefix,
 *    written in pieces here so this file does not match itself) may appear only in `src/jobrunner/drivers/dsh/**`
 *    and `test/jobrunner/dsh/**` (the fake ACP agent of S13.2).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER = "src/pi/adapter.ts";
/** Prefixes (forward slashes, with trailing slash) where the ACP SDK may be imported. */
export const ACP_ALLOWED_PREFIXES: readonly string[] = ["src/jobrunner/drivers/dsh/", "test/jobrunner/dsh/"];
// Built from pieces so this file does not match its own patterns.
const TB = "type" + "box";
const FORBIDDEN = [
  new RegExp("@earendil" + "-works/"),
  new RegExp(String.raw`from\s+["']` + TB + String.raw`["']`),
  new RegExp(String.raw`import\s*\(\s*["']` + TB + String.raw`["']`),
  new RegExp(String.raw`require\(\s*["']` + TB + String.raw`["']`),
];
const ACP_PATTERN = new RegExp("@agentclient" + "protocol/");

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|cts|tsx|js|mjs|cjs)$/.test(name)) out.push(p);
  }
}

export interface Violation {
  file: string;
  line: number;
  text: string;
}

function collect(root: string, dirs: readonly string[]): string[] {
  const files: string[] = [];
  for (const d of dirs) {
    try {
      walk(join(root, d), files);
    } catch {
      /* directory absent */
    }
  }
  return files;
}

export function findBoundaryViolations(root: string, dirs: readonly string[] = ["src", "scripts", "test"]): Violation[] {
  const violations: Violation[] = [];
  for (const f of collect(root, dirs)) {
    const rel = relative(root, f).split(sep).join("/");
    if (rel === ADAPTER) continue;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      if (FORBIDDEN.some((re) => re.test(text))) violations.push({ file: rel, line: i + 1, text: text.trim() });
    });
  }
  return violations;
}

/** The ACP SDK appears only under `ACP_ALLOWED_PREFIXES`. Everything else (including this script's own tests) is a violation. */
export function findAcpViolations(root: string, dirs: readonly string[] = ["src", "scripts", "test"]): Violation[] {
  const violations: Violation[] = [];
  for (const f of collect(root, dirs)) {
    const rel = relative(root, f).split(sep).join("/");
    if (ACP_ALLOWED_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      if (ACP_PATTERN.test(text)) violations.push({ file: rel, line: i + 1, text: text.trim() });
    });
  }
  return violations;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // dist/scripts/check-adapter-boundary.js -> project root is two levels up; sources are checked in place.
  const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
  let failed = false;

  const v = findBoundaryViolations(root);
  if (v.length === 0) {
    console.log(`ADAPTER BOUNDARY PASS (only ${ADAPTER} imports the Pi packages)`);
  } else {
    for (const x of v) console.error(`${x.file}:${x.line}: ${x.text}`);
    console.log(`ADAPTER BOUNDARY FAIL (${v.length} import(s) outside ${ADAPTER})`);
    failed = true;
  }

  const a = findAcpViolations(root);
  if (a.length === 0) {
    console.log(`ACP BOUNDARY PASS (the ACP SDK appears only in ${ACP_ALLOWED_PREFIXES.map((p) => p + "**").join(" and ")})`);
  } else {
    for (const x of a) console.error(`${x.file}:${x.line}: ${x.text}`);
    console.log(`ACP BOUNDARY FAIL (${a.length} reference(s) outside ${ACP_ALLOWED_PREFIXES.map((p) => p + "**").join(" and ")})`);
    failed = true;
  }
  if (failed) process.exitCode = 1;
}
