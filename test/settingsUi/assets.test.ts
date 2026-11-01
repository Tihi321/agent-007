import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ASSET_FILES, loadAssets } from "../../src/jobrunner/settingsUi/assets.js";
import { ROOT, request, startRig } from "./helpers.js";

test("the asset map is built from the fixed file list; the index serves at / and /index.html", async () => {
  const rig = await startRig();
  try {
    const map = loadAssets(join(ROOT, "ui", "settings"));
    assert.deepEqual([...map.keys()].sort(), ["/", ...ASSET_FILES.map((f) => `/${f}`)].sort());
    const root = await request(rig, "GET", "/");
    const index = await request(rig, "GET", "/index.html");
    assert.equal(root.status, 200);
    assert.equal(root.text, index.text);
    assert.match(String(root.headers["content-type"]), /^text\/html/);
    assert.match(String((await request(rig, "GET", "/app.js")).headers["content-type"]), /^text\/javascript/);
    assert.match(String((await request(rig, "GET", "/app.css")).headers["content-type"]), /^text\/css/);
    assert.match(String((await request(rig, "GET", "/icon.svg")).headers["content-type"]), /^image\/svg\+xml/);
    assert.equal(root.text, readFileSync(join(ROOT, "ui", "settings", "index.html"), "utf8"));
  } finally {
    await rig.cleanup();
  }
});

test("a URL is looked up in the map, never joined to a path: traversal and odd paths are 404", async () => {
  const rig = await startRig();
  try {
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%5cpackage.json", "/ui/settings/app.js", "//app.js", "/app.js%00", "/forms.js.map", "/src/main.js", "/.env", "/security.json"]) {
      const r = await request(rig, "GET", p);
      assert.ok(r.status === 404 || r.status === 400, `${p}: ${r.status}`);
      assert.ok(!r.text.includes('"name": "agent-007"'));
    }
    assert.equal((await request(rig, "GET", "/app.js?x=1")).status, 200, "a query string is ignored for static files");
    assert.equal((await request(rig, "POST", "/app.js", { body: {} })).status, 404);
  } finally {
    await rig.cleanup();
  }
});

test("npm run build leaves dist/ui/settings/* equal to ui/settings/*", () => {
  const from = join(ROOT, "ui", "settings");
  const to = join(ROOT, "dist", "ui", "settings");
  assert.ok(existsSync(to), "dist/ui/settings exists (run npm run build)");
  assert.deepEqual(readdirSync(to).sort(), readdirSync(from).sort());
  for (const f of readdirSync(from)) assert.ok(readFileSync(join(from, f)).equals(readFileSync(join(to, f))), `${f} is the same in dist`);
});

test("the deployed copy is what the compiled server reads by default", () => {
  const dist = join(ROOT, "dist", "ui", "settings");
  const map = loadAssets(dist);
  assert.ok(map.get("/app.js")?.body.length);
});
