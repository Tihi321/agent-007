// Stages the production node_modules in build/stage/ (package.json, yarn.lock and .yarnrc.yml copied there, then
// `yarn workspaces focus --production`). Never run in the repo root: that would strip the devDependencies.
// Downloads from the npm registry (served from the yarn cache when it is warm).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stage = join(root, "build", "stage");

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ["package.json", "yarn.lock", ".yarnrc.yml"]) copyFileSync(join(root, f), join(stage, f));

const run = (args) => execFileSync(process.platform === "win32" ? "yarn.cmd" : "yarn", args, { cwd: stage, stdio: "inherit", shell: process.platform === "win32" });
run(["workspaces", "focus", "--production"]);

if (!existsSync(join(stage, "node_modules", "grammy", "package.json"))) {
  console.error("stage-modules: node_modules/grammy missing after the focus install");
  process.exit(1);
}
console.log(`stage-modules: production node_modules staged in ${stage}`);
