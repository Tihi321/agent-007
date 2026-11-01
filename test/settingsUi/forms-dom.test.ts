/**
 * The browser form framework (ui/settings/forms.js) run against a tiny DOM stand-in (there is no browser or jsdom here): every shipped
 * form renders from its descriptor, `get()` round-trips the real document, edits make the form dirty, a server error lands on its
 * field, and lists and maps add and remove. This catches script errors that the server-side tests cannot see. A real browser check
 * is a user step (S18.5).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { shippedForms } from "../../src/jobrunner/settingsUi/forms/registry.js";
import { PERSONA_SCHEMA } from "../../src/settings/personaSchema.js";
import { splitConfig } from "../../src/settings/split.js";
import { ROOT, phase2Config } from "../settings/helpers.js";

class FNode {
  childNodes: FNode[] = [];
  parent: FNode | null = null;
  append(...kids: (FNode | string)[]): void {
    for (const k of kids) {
      const n = typeof k === "string" ? new FText(k) : k;
      n.parent = this;
      this.childNodes.push(n);
    }
  }
  replaceChildren(...kids: (FNode | string)[]): void {
    this.childNodes = [];
    this.append(...kids);
  }
  remove(): void {
    if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((c) => c !== this);
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.childNodes = [];
    if (v !== "") this.append(v);
  }
}
class FText extends FNode {
  constructor(readonly data: string) {
    super();
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(_v: string) {}
}
class FElement extends FNode {
  tagName: string;
  attrs = new Map<string, string>();
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  hidden = false;
  disabled = false;
  checked = false;
  required = false;
  selected = false;
  id = "";
  #value = "";
  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }
  get value(): string {
    if (this.tagName === "SELECT") {
      const opts = this.childNodes.filter((c): c is FElement => c instanceof FElement && c.tagName === "OPTION");
      const sel = opts.find((o) => o.selected) ?? opts[0];
      return sel ? (sel.attrs.get("value") ?? "") : "";
    }
    return this.#value;
  }
  set value(v: string) {
    if (this.tagName === "SELECT") {
      for (const o of this.childNodes) if (o instanceof FElement) o.selected = o.attrs.get("value") === v;
      return;
    }
    this.#value = v;
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
    if (k === "id") this.id = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  addEventListener(t: string, fn: (e: unknown) => void): void {
    (this.listeners[t] ??= []).push(fn);
  }
  /** Fires the event here and lets it bubble up, like a browser. */
  fire(t: string): void {
    for (let n: FNode | null = this; n; n = n.parent) if (n instanceof FElement) for (const fn of n.listeners[t] ?? []) fn({ target: this });
  }
  focus(): void {}
  all(pred: (e: FElement) => boolean, out: FElement[] = []): FElement[] {
    for (const c of this.childNodes) if (c instanceof FElement) {
      if (pred(c)) out.push(c);
      c.all(pred, out);
    }
    return out;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
g["Node"] = FNode;
g["document"] = { createElement: (t: string) => new FElement(t), createTextNode: (t: string) => new FText(t) };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const forms = (await import(pathToFileURL(join(ROOT, "ui", "settings", "forms.js")).href)) as Record<string, any>;

const strip = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(strip);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v as object).filter(([k]) => !k.startsWith("_")).map(([k, x]) => [k, strip(x)]));
  return v;
};

const securityDoc = (): Record<string, any> => strip(splitConfig(phase2Config("C:\\Users\\main\\notes"), "C:\\ProgramData\\agent-007\\settings").security) as Record<string, any>;

test("every shipped security form renders from its descriptor and get() round-trips the real document", () => {
  const doc = securityDoc();
  for (const f of shippedForms().list().filter((x) => x.target === "security")) {
    const value = Object.fromEntries(f.section.map((s) => [s, doc[s] !== undefined ? doc[s] : forms.defaultValue(f.schema.properties![s]!)]));
    const rf = forms.renderForm(f.schema, value);
    assert.ok((rf.element as unknown as FElement).childNodes.length > 0, `${f.id} rendered fields`);
    assert.deepEqual(rf.get(), value, `${f.id} round-trips`);
    assert.equal(rf.dirty(), false, `${f.id} starts clean`);
  }
});

test("the job runner limits form and the persona descriptor render too", () => {
  const forms2 = shippedForms().list().find((x) => x.id === "jobrunner")!;
  const limits = { dailyJobCap: 20, dailyCreditCap: 0, perTemplateMaxCredits: { "short-video": 100 }, maxConcurrent: { claude: 1, dsh: 1, hub: 1 }, maxDurationMin: 360, outputCapBytes: 5242880, maxEventTextChars: 8000, permissionTimeoutSec: 1800, cancelGraceSec: 10 };
  const rf = forms.renderForm(forms2.schema, { limits });
  assert.deepEqual(rf.get(), { limits });
  const persona = { id: "research", name: "Research", prompt: "p", toolAllow: ["read_file", "list_dir"], mcpAllow: { vibetts: ["speak"] }, jobTemplates: [], modelPreset: "lmstudio", memory: { write: "scope", scope: "research", sharedRead: true }, budgets: {} };
  const pf = forms.renderForm(PERSONA_SCHEMA, persona);
  assert.deepEqual(pf.get(), persona);
});

test("editing makes the form dirty, and the new value is what get() returns", () => {
  const doc = securityDoc();
  const f = shippedForms().get("shell")!;
  const rf = forms.renderForm(f.schema, { shell: doc["shell"] });
  const root = rf.element as unknown as FElement;
  let changes = 0;
  const rf2 = forms.renderForm(f.schema, { shell: doc["shell"] }, { onChange: () => changes++ });
  const num = (rf2.element as unknown as FElement).all((e) => e.tagName === "INPUT" && e.attrs.get("name") === "shell.approvalTimeoutSec")[0]!;
  num.value = "321";
  num.fire("input");
  assert.ok(changes >= 1);
  assert.equal(rf2.dirty(), true);
  assert.equal((rf2.get() as { shell: { approvalTimeoutSec: number } }).shell.approvalTimeoutSec, 321);
  const box = (rf2.element as unknown as FElement).all((e) => e.tagName === "INPUT" && e.attrs.get("name") === "shell.enabled")[0]!;
  box.checked = !box.checked;
  box.fire("change");
  assert.equal((rf2.get() as { shell: { enabled: boolean } }).shell.enabled, !doc["shell"].enabled);
  rf2.markClean();
  assert.equal(rf2.dirty(), false);
  assert.equal(root.childNodes.length > 0, true);
});

test("a server error lands on its field (aria-invalid, message), the rest is returned to be shown in a banner", () => {
  const doc = securityDoc();
  const f = shippedForms().get("shell")!;
  const rf = forms.renderForm(f.schema, { shell: doc["shell"] });
  const root = rf.element as unknown as FElement;
  const unplaced = rf.setErrors(["shell.approvalTimeoutSec: must be at least 10", "folders.allow: is empty", { path: "", message: "something general" }]);
  const field = root.all((e) => e.tagName === "INPUT" && e.attrs.get("name") === "shell.approvalTimeoutSec")[0]!;
  assert.equal(field.getAttribute("aria-invalid"), "true");
  const err = root.all((e) => e.id === `${field.id}-err`)[0]!;
  assert.equal(err.textContent, "must be at least 10");
  assert.equal(err.hidden, false);
  assert.deepEqual(unplaced, ["folders.allow: is empty", "something general"]);
  rf.setErrors([]);
  assert.equal(field.getAttribute("aria-invalid"), null);
  assert.equal(err.hidden, true);
});

test("lists add and remove entries, maps do too, and tags split on commas", () => {
  const doc = securityDoc();
  const f = shippedForms().get("folders")!;
  const rf = forms.renderForm(f.schema, { folders: doc["folders"] });
  const root = rf.element as unknown as FElement;
  const buttons = root.all((e) => e.tagName === "BUTTON");
  const addEntry = buttons.find((b) => b.textContent === "Add entry")!;
  addEntry.fire("click");
  const value = rf.get() as { folders: { allow: { alias: string; path: string }[]; deny: string[] } };
  assert.equal(value.folders.allow.length, doc["folders"].allow.length + 1, "a new entry was added (empty fields are returned as defaults)");
  const remove = root.all((e) => e.tagName === "BUTTON" && e.textContent === "Remove");
  remove[remove.length - 1]!.fire("click");
  assert.equal((rf.get() as typeof value).folders.allow.length, doc["folders"].allow.length);
  // tags
  const mcp = shippedForms().get("mcp")!;
  const m = forms.renderForm(mcp.schema, { mcp: doc["mcp"], flow: doc["flow"] });
  const tags = (m.element as unknown as FElement).all((e) => e.tagName === "INPUT" && /allowTools$/.test(e.attrs.get("name") ?? ""))[0]!;
  tags.value = "speak, list_voices ,  ";
  tags.fire("input");
  assert.deepEqual((m.get() as { mcp: { servers: { allowTools: string[] }[] } }).mcp.servers[0]!.allowTools, ["speak", "list_voices"]);
});

test("no markup is built from strings: values with markup stay plain text, and the allowed-attribute list refuses event handlers and style", () => {
  const el = forms.h("p", { class: "x" }, "<img src=x onerror=alert(1)>") as unknown as FElement;
  assert.equal(el.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(el.childNodes[0] instanceof FText, true);
  assert.throws(() => forms.h("p", { onclick: "x()" }), /attribute not allowed/);
  assert.throws(() => forms.h("p", { style: "color:red" }), /attribute not allowed/);
  assert.throws(() => forms.h("a", { onerror: "x" }), /attribute not allowed/);
  const src = readFileSync(join(ROOT, "ui", "settings", "views.js"), "utf8") + readFileSync(join(ROOT, "ui", "settings", "app.js"), "utf8");
  const used = new Set<string>();
  for (const m of src.matchAll(/\bh\(\s*"[a-z0-9]+"\s*,\s*\{([^{}]*)\}/g)) for (const k of (m[1] as string).matchAll(/(?:^|,)\s*"?([A-Za-z][A-Za-z0-9-]*)"?\s*:/g)) used.add(k[1] as string);
  const allowed = new Set(["class", "id", "for", "type", "name", "value", "placeholder", "min", "max", "step", "maxlength", "rows", "role", "href", "title", "autocomplete", "spellcheck", "aria-label", "aria-describedby", "aria-invalid", "aria-live", "aria-current", "aria-labelledby", "aria-expanded", "data-key", "scope", "hidden", "disabled", "checked", "required"]);
  for (const k of used) assert.ok(allowed.has(k), `h() is called with the attribute ${k}, which is not allowed`);
  assert.ok(used.size > 5);
});
