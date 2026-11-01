/**
 * Static files of the settings UI (S18.1, I25a). The map is built ONCE at start from a FIXED file list: a URL is only ever looked
 * up in the map, never joined to a path, so there is nothing to traverse. `npm run build` copies `ui/settings/*` to
 * `dist/ui/settings/*` (`scripts/settings/copy-ui.mjs`), which is where the deployed code finds them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ASSET_FILES = ["index.html", "app.css", "app.js", "forms.js", "views.js", "icon.svg"] as const;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface Asset {
  body: Buffer;
  type: string;
}

/** `dist/ui/settings` next to the compiled job runner (`dist/src/jobrunner/settingsUi/assets.js`). */
export function defaultAssetsDir(): string {
  return fileURLToPath(new URL("../../../ui/settings/", import.meta.url));
}

export function loadAssets(dir: string = defaultAssetsDir()): Map<string, Asset> {
  const map = new Map<string, Asset>();
  for (const name of ASSET_FILES) {
    const ext = name.slice(name.lastIndexOf("."));
    map.set(`/${name}`, { body: readFileSync(join(dir, name)), type: TYPES[ext] ?? "application/octet-stream" });
  }
  const index = map.get("/index.html");
  if (index) map.set("/", index);
  return map;
}
