// Copies ui/settings/* to dist/ui/settings/* (S18.1). Run by `yarn build`, after tsc. Plain Node, no dependency.
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

// Milestone 2 (S35): the web UI. ui/common/* and ui/web/* are copied FLAT into dist/ui/web so the browser imports "./dom.js" next to "/app.js".
{
  const web = join(root, "ui", "web");
  const common = join(root, "ui", "common");
  const out = join(root, "dist", "ui", "web");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  let m = 0;
  for (const dir of [common, web]) {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      copyFileSync(join(dir, f.name), join(out, f.name));
      m++;
    }
  }
  process.stdout.write(`copied ${m} web UI files to dist/ui/web
`);
}

// Desktop launcher page: ui/common/tokens.css + ui/desktop/* copied FLAT into dist/ui/desktop (a file: page next to the tokens).
{
  const out = join(root, "dist", "ui", "desktop");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(join(root, "ui", "common", "tokens.css"), join(out, "tokens.css"));
  let k = 1;
  for (const f of readdirSync(join(root, "ui", "desktop"), { withFileTypes: true })) {
    if (!f.isFile()) continue;
    copyFileSync(join(root, "ui", "desktop", f.name), join(out, f.name));
    k++;
  }
  process.stdout.write(`copied ${k} desktop UI files to dist/ui/desktop\n`);
}
