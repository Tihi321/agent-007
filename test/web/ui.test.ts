/** S35: the web UI. Static rules (CSP, no innerHTML, size budget), the safe Markdown parser, accessibility checks, and the whole journey (claim, bot, chat, sign out) driven in a fake DOM against the REAL gateway. Offline. */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { totpAt, totpStep } from "../../src/web/totp.js";
import { ROOT } from "../settings/helpers.js";
import { ScriptedEngine, makeApp, until } from "./app.js";
import { FElement, all, buttonByText, byName, byTag, fakeDocument } from "./fakeDom.js";
import { http } from "./helpers.js";

const DIST = join(ROOT, "dist", "ui", "web");
const SRC = [join(ROOT, "ui", "web"), join(ROOT, "ui", "common")];
const load = async (name: string): Promise<any> => import(pathToFileURL(join(DIST, name)).href);

function srcFiles(): string[] {
  return SRC.flatMap((d) => readdirSync(d).map((f) => join(d, f)));
}

test("static: index.html has no inline script, style or event attribute and loads only same-origin files; no innerHTML, eval, inline style or external fetch anywhere", () => {
  const html = readFileSync(join(ROOT, "ui", "web", "index.html"), "utf8");
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "no inline script");
  assert.ok(!/<style/i.test(html) && !/\sstyle=/i.test(html), "no inline style");
  assert.ok(!/\son\w+=/i.test(html), "no inline handlers");
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok((m[1] as string).startsWith("/"), `same-origin only: ${m[1]}`);
  for (const f of srcFiles().filter((x) => /\.(js|html)$/.test(x))) {
    const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(|setAttribute\(\s*["']style["']|\.style\./.test(code), f);
    assert.ok(!/(fetch|import)\(\s*["'`]https?:/.test(code), `no external request in ${f}`);
    assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(code), `no browser storage of secrets in ${f}`);
  }
  for (const f of srcFiles().filter((x) => x.endsWith(".css"))) assert.ok(!/@import|url\(\s*["']?https?:/.test(readFileSync(f, "utf8")), `no external CSS in ${f}`);
});

test("size budget: the whole UI is small (under 130 KB, no file over 30 KB)", () => {
  let total = 0;
  for (const f of readdirSync(DIST)) {
    const n = statSync(join(DIST, f)).size;
    assert.ok(n < 30 * 1024, `${f} is ${n} bytes`);
    total += n;
  }
  assert.ok(total < 130 * 1024, `total ${total}`);
});

test("safe Markdown: HTML stays text, javascript: links are not links, images never render, code and lists work", async () => {
  const { parseMarkdown, parseInline } = await load("markdown-parse.js");
  const flat = (n: any): string => JSON.stringify(n);
  const xss = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '[click](javascript:alert(1))', '[x](data:text/html;base64,AAAA)', '![pic](http://evil.example/p.png)', '[a](vbscript:x)', '[ok](https://example.com/a?b=1)', '[m](mailto:a@b.co)', '<a href="https://x">y</a>'];
  const tree = parseMarkdown(xss.join("\n\n"));
  const links = (tree as any[]).flatMap((b) => b.c ?? []).filter((n: any) => n.t === "link");
  assert.deepEqual(links.map((l: any) => l.href), ["https://example.com/a?b=1", "mailto:a@b.co"]);
  const text = (tree as any[]).flatMap((b) => b.c ?? []).filter((n: any) => n.t === "text").map((n: any) => n.v).join("|");
  assert.match(text, /<script>alert\(1\)<\/script>/, "HTML is kept as literal text");
  assert.ok(!flat(tree).includes('"t":"img"') && !/"t":"html"/.test(flat(tree)));
  assert.match(text, /\[image: pic\]/);
  assert.deepEqual(parseInline("a **b** *c* `d`").map((n: any) => n.t), ["text", "strong", "text", "em", "text", "code"]);
  const b = parseMarkdown("# T\n\n- one\n- two\n\n1. x\n2. y\n\n```js\nlet a = '<b>';\n```\n\n> q\n> more");
  assert.deepEqual(b.map((x: any) => x.t), ["h", "ul", "ol", "pre", "quote"]);
  assert.equal(b[3].v, "let a = '<b>';");
  assert.equal(b[1].items.length, 2);
  // pathological input is linear, not catastrophic
  const t0 = Date.now();
  parseMarkdown("*".repeat(20000) + "[".repeat(20000) + "`".repeat(20000));
  assert.ok(Date.now() - t0 < 2000);
});

test("dom.js refuses inline style, string event handlers and unsafe URLs", async () => {
  (globalThis as any).document = fakeDocument;
  const { h, safeUrl } = await load("dom.js");
  assert.throws(() => h("div", { style: "x" }), /inline style/);
  assert.throws(() => h("div", { onclick: "alert(1)" }), /functions/);
  assert.throws(() => h("a", { href: "javascript:alert(1)" }), /unsafe url/);
  assert.throws(() => h("a", { href: "//evil.example" }), /unsafe url/);
  assert.throws(() => h("img", { src: "data:image/png;base64,AA" }), /unsafe url/);
  assert.ok(h("a", { href: "https://ok.example", rel: "noopener" }));
  assert.equal(safeUrl("/x"), true);
  assert.equal(safeUrl("JavaScript:1"), false);
  const el = h("p", {}, "<b>not bold</b>");
  assert.equal(el.textContent, "<b>not bold</b>");
  const { renderMarkdown } = await load("markdown.js");
  const md = renderMarkdown("[x](https://a.example) <i>t</i>");
  const link = all(md).find((e) => e.tagName === "a")!;
  assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.ok(!all(md).some((e) => e.tagName === "i"), "no element came from the text");
});

/** A browser-like fetch against the real gateway: a cookie jar, a same-origin Origin header. */
function browser(port: number) {
  let cookie = "";
  return async (path: string, init: any = {}): Promise<Response> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method ?? "GET", headers: { ...(init.headers ?? {}), origin: `http://127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) }, body: init.body, signal: init.signal });
    for (const sc of res.headers.getSetCookie()) cookie = /Max-Age=0/.test(sc) ? "" : sc.split(";")[0] as string;
    return res;
  };
}

function envFor(port: number) {
  const body = new FElement("body");
  const handlers: (() => unknown)[] = [];
  let hash = "";
  const location = {
    pathname: "/",
    get hash() {
      return hash;
    },
    set hash(v: string) {
      hash = v;
      for (const h of handlers) void h();
    },
  };
  const downloads: { name: string; text: string }[] = [];
  const answers: string[] = [];
  const env = {
    root: body,
    location,
    fetch: browser(port),
    replaceHash: (v: string) => {
      hash = v;
    },
    onHashChange: (fn: () => unknown) => handlers.push(fn),
    prompt: () => answers.shift() ?? "",
    confirm: () => true,
    download: (name: string, text: string) => downloads.push({ name, text }),
  };
  return { env, body, location, downloads, answers };
}

function checkAccessibility(root: FElement, where: string): void {
  const elements = all(root);
  const ids = new Set(elements.map((e) => e.getAttribute("id")).filter(Boolean));
  const labelFor = new Set(elements.filter((e) => e.tagName === "label").map((e) => e.getAttribute("for")));
  for (const e of elements.filter((x) => ["input", "textarea", "select"].includes(x.tagName) && x.getAttribute("type") !== "checkbox")) {
    const labelled = e.hasAttribute("aria-label") || (e.getAttribute("id") !== null && labelFor.has(e.getAttribute("id")));
    assert.ok(labelled, `${where}: <${e.tagName} name=${e.getAttribute("name")}> has no label`);
  }
  for (const e of elements.filter((x) => x.tagName === "input" && x.getAttribute("type") === "checkbox")) assert.ok(e.parent && (e.parent as FElement).tagName === "label", `${where}: checkbox without its label`);
  for (const b of elements.filter((x) => x.tagName === "button")) assert.ok(b.textContent.trim() !== "" || b.hasAttribute("aria-label"), `${where}: a button without a name`);
  for (const f of elements.filter((x) => x.tagName === "label")) assert.ok(ids.has(f.getAttribute("for")) || f.childNodes.length > 1, `${where}: label for a missing control`);
  assert.ok(elements.filter((x) => x.tagName === "h1").length <= 1, `${where}: at most one h1`);
}

test("the whole journey in the UI, against the real gateway: claim the owner, create a bot, chat with streaming, reload keeps history, sign out", async () => {
  (globalThis as any).document = fakeDocument;
  const engine = new ScriptedEngine(async (tr) => {
    tr.emit({ type: "delta", text: "Hello " });
    tr.emit({ type: "delta", text: "**world**" });
  });
  const t = await makeApp({ engine, claim: false, mode: "local" });
  try {
    const { code } = t.app.stack.auth.issueOwnerCode();
    const { env, body, location } = envFor(t.port);
    const { start } = await load("app.js");
    const app = await start(env);
    // unclaimed + on the PC: the claim screen
    await until(() => byTag(body, "form").length > 0);
    assert.match(body.textContent, /Claim this agent/);
    checkAccessibility(body, "claim");
    byName(body, "code").value = code;
    await byTag(body, "form")[0]!.fire("submit");
    await until(() => /Create the owner account/.test(body.textContent));
    const secret = all(body).find((e) => e.getAttribute("class") === "secret")!.textContent;
    checkAccessibility(body, "claim step 2");
    byName(body, "displayName").value = "Olive";
    byName(body, "login").value = "owner@example.com";
    byName(body, "password").value = "an owner password long";
    byName(body, "totp").value = totpAt(secret, totpStep(Date.now()));
    await byTag(body, "form")[0]!.fire("submit");
    await until(() => /Save your recovery codes/.test(body.textContent)).catch((e) => { throw new Error(`${e.message}: screen says: ${body.textContent.slice(0, 400)}`); });
    const codes = all(body).find((e) => e.tagName === "pre")!.textContent.split("\n");
    assert.equal(codes.length, 10);
    await buttonByText(body, "I saved them").fire("click");
    await until(() => /Your bots/.test(body.textContent));
    assert.match(body.textContent, /No bots yet/);
    // navigation is only shown once signed in
    assert.ok(byTag(body, "a").some((a) => a.textContent === "Account"));
    // create a bot with the editor
    await buttonByText(body, "New bot").fire("click");
    await until(() => /New bot/.test(body.textContent) && byTag(body, "form").length > 0);
    checkAccessibility(body, "editor");
    const preset = byName(body, "preset");
    assert.deepEqual(preset.options.map((o) => o.textContent), ["strata", "Claude Sonnet (cloud)"]);
    assert.ok(!all(body).some((e) => ["readRoots", "edges", "telegramTokenRef", "shell"].includes(e.getAttribute("name") ?? "") || e.getAttribute("value") === "shell"), "no field for roots, peers, tokens or the shell");
    byName(body, "name").value = "Helper";
    byName(body, "tagline").value = "my bot";
    byName(body, "persona").value = "You love tea.";
    byName(body, "avatar").value = "robot";
    preset.value = "claude-sonnet";
    await preset.fire("change");
    assert.match(body.textContent, /Claude|cloud|leave/i, "the egress note shows for a cloud model");
    byName(body, "fallback").value = "strata";
    await byTag(body, "form")[0]!.fire("submit");
    await until(() => /Your bots/.test(body.textContent) && /Helper/.test(body.textContent));
    assert.match(body.textContent, /Claude Sonnet \(cloud\)/, "the cloud badge on the card");
    checkAccessibility(body, "bots");
    // chat
    await buttonByText(body, "Chat").fire("click");
    await until(() => byTag(body, "textarea").length > 0 && /Start a chat/.test(body.textContent));
    checkAccessibility(body, "chat");
    const log = all(body).find((e) => e.getAttribute("role") === "log")!;
    assert.equal(log.getAttribute("aria-live"), "polite");
    byName(body, "message").value = "Say hello";
    await all(body).find((e) => e.tagName === "form" && e.className === "composer")!.fire("submit");
    await until(() => /Hello/.test(log.textContent) && !all(body).some((e) => e.tagName === "button" && e.textContent === "Stop" && !e.hidden) , 4000);
    await until(() => all(log).some((e) => e.tagName === "strong" && e.textContent === "world"));
    assert.match(location.hash, /^#\/chat\/helper\/[0-9a-f]{24}$/, "the URL follows the thread");
    assert.match(body.textContent, /Say hello/);
    assert.ok(all(body).some((e) => e.tagName === "progress"), "usage meter");
    await until(() => /1\/100000 messages/.test(body.textContent));
    // "reload": a fresh app instance on the same gateway session finds the history
    const second = envFor(t.port);
    second.env.fetch = env.fetch; // same browser (cookie jar)
    second.location.hash = location.hash;
    await start(second.env);
    await until(() => /Say hello/.test(second.body.textContent) && /Hello/.test(second.body.textContent));
    // account page and sign out
    location.hash = "#/account";
    await until(() => /Devices and sessions/.test(body.textContent));
    checkAccessibility(body, "account");
    assert.match(body.textContent, /This device/);
    await buttonByText(body, "Sign out").fire("click");
    await until(() => /Sign in/.test(body.textContent) && byName(body, "login") !== undefined);
    checkAccessibility(body, "sign-in");
    assert.ok(!byTag(body, "a").some((a) => a.textContent === "Account"), "navigation hidden when signed out");
    void app;
  } finally {
    await t.close();
  }
});

test("the gateway serves the built UI: index with the strict headers, scripts and styles with the right types, nothing outside the map", async () => {
  const t = await makeApp({ mode: "local" });
  const { startWebApp } = await import("../../src/web/app.js");
  void startWebApp;
  await t.close();
  const t2 = await makeAppWithAssets();
  try {
    const idx = await http(t2.port, "GET", "/", { host: `localhost:${t2.port}` });
    assert.equal(idx.status, 200);
    assert.match(String(idx.headers["content-type"]), /text\/html/);
    assert.match(idx.text, /<script type="module" src="\/app\.js">/);
    assert.match(String(idx.headers["content-security-policy"]), /script-src 'self'/);
    for (const [path, type] of [["/app.js", /javascript/], ["/dom.js", /javascript/], ["/tokens.css", /css/], ["/app.css", /css/], ["/icon.svg", /svg/]] as const) {
      const r = await http(t2.port, "GET", path, { host: `localhost:${t2.port}` });
      assert.equal(r.status, 200, path);
      assert.match(String(r.headers["content-type"]), type, path);
    }
    for (const bad of ["/../package.json", "/%2e%2e/package.json", "/app.js/../../x", "/secrets.json", "/..%5cwindows/win.ini", "/dist/ui/web/app.js"]) {
      const r = await http(t2.port, "GET", bad, { host: `localhost:${t2.port}` });
      assert.ok(r.status === 404 || r.status === 400 || (r.status === 200 && r.text.includes('<script type="module"')), `${bad} -> ${r.status}`);
      assert.ok(!r.text.includes('"name": "agent-007"') && !r.text.includes("[extensions]"), bad);
    }
    // a deep link like /claim serves the app shell (the client routes it)
    assert.match((await http(t2.port, "GET", "/claim", { host: `localhost:${t2.port}` })).text, /<script type="module"/);
  } finally {
    await t2.close();
  }
});

async function makeAppWithAssets() {
  const { startWebApp } = await import("../../src/web/app.js");
  const { PRESETS, freePort } = await import("./app.js");
  const { tempDir } = await import("../settings/helpers.js");
  const port = await freePort();
  const app = await startWebApp({ dataDir: tempDir("a7-assets-"), port, mode: "local", publicHosts: [], presets: () => PRESETS, terms: () => ({ claude: true, antigravity: false }), engine: new ScriptedEngine(), assetsDir: DIST });
  return { port, close: () => app.close() };
}
