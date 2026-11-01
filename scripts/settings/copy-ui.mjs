// Copies ui/settings/* to dist/ui/settings/* (S18.1). Run by `npm run build`, after tsc. Plain Node, no dependency.
// deploy-app.ps1 copies dist/, so the settings UI is deployed with no change to the deploy scripts.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const from = join(root, "ui", "settings");
const to = join(root, "dist", "ui", "settings");

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
let n = 0;
for (const name of readdirSync(from, { withFileTypes: true })) {
  if (!name.isFile()) continue;
  copyFileSync(join(from, name.name), join(to, name.name));
  n++;
}
process.stdout.write(`copied ${n} settings UI files to dist/ui/settings\n`);
