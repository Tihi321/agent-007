// Schema-driven form renderer (S18.2). A form is built from a JSON-Schema-subset descriptor, never from hand-written markup, so a
// new form (Phase 4's presets, routes, edges) is a descriptor. Everything the user or the server supplies is set with
// textContent or setAttribute on a fixed attribute list: this file never builds HTML from a string.

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALLOWED_ATTRS = new Set(["class", "id", "for", "type", "name", "value", "placeholder", "min", "max", "step", "maxlength", "rows", "role", "href", "title", "autocomplete", "spellcheck", "aria-label", "aria-describedby", "aria-invalid", "aria-live", "aria-current", "aria-labelledby", "aria-expanded", "data-key", "scope"]);

let counter = 0;
export const nextId = (prefix) => `${prefix}-${++counter}`;

/** Builds an element. Strings become text nodes; attributes outside the fixed list are refused. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "hidden") el.hidden = Boolean(v);
    else if (k === "disabled") el.disabled = Boolean(v);
    else if (k === "checked") el.checked = Boolean(v);
    else if (k === "required") el.required = Boolean(v);
    else if (ALLOWED_ATTRS.has(k)) el.setAttribute(k, v === true ? "" : String(v));
    else throw new Error(`attribute not allowed: ${k}`);
  }
  for (const kid of kids.flat()) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function humanize(key) {
  const spaced = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function defaultValue(schema) {
  if (schema.default !== undefined) return JSON.parse(JSON.stringify(schema.default));
  switch (schema.type) {
    case "object": {
      const o = {};
      for (const [k, sub] of Object.entries(schema.properties || {})) if ((schema.required || []).includes(k) || sub.default !== undefined) o[k] = defaultValue(sub);
      return o;
    }
    case "array": return [];
    case "string": return "";
    case "integer": case "number": return schema.minimum ?? 0;
    case "boolean": return false;
    default: return null;
  }
}

function ui(schema) {
  return schema["x-ui"] || {};
}

/** The shared wrapper: label, control, help text and an error line, registered under its path for server errors. */
function wrap(ctx, path, labelText, control, helpText, opts = {}) {
  const id = control.id || nextId("f");
  control.id = id;
  const err = h("p", { class: "field-error", id: `${id}-err`, hidden: true });
  const help = helpText ? h("p", { class: "help", id: `${id}-help` }, helpText) : null;
  control.setAttribute("aria-describedby", [help ? `${id}-help` : "", `${id}-err`].filter(Boolean).join(" "));
  ctx.fields.set(path, { control, error: err });
  const label = opts.noLabel ? null : h("label", { for: id, class: ctx.hideLabel ? "sr-only" : undefined }, labelText);
  return h("div", { class: "field" }, label, control, help, err);
}

function buildString(schema, value, path, ctx, name, required) {
  const u = ui(schema);
  let control;
  if (schema.enum) {
    control = h("select", { name: path });
    if (!required && value === undefined) control.append(h("option", { value: "" }, "(not set)"));
    for (const opt of schema.enum) {
      const o = h("option", { value: String(opt) }, String(opt));
      if (value === opt) o.selected = true;
      control.append(o);
    }
  } else if (u.widget === "textarea") {
    control = h("textarea", { name: path, maxlength: schema.maxLength, rows: 6 });
    control.value = value ?? "";
  } else {
    control = h("input", { type: "text", name: path, maxlength: schema.maxLength, placeholder: u.placeholder, spellcheck: "false", autocomplete: "off" });
    control.value = value ?? "";
  }
  let touched = value !== undefined;
  control.addEventListener("input", () => { touched = true; });
  control.addEventListener("change", () => { touched = true; });
  const el = wrap(ctx, path, u.label || humanize(name), control, u.help || schema.description);
  return {
    el,
    get() {
      if (!touched && !required) return undefined;
      const v = control.value;
      if (v === "" && !required) return undefined;
      return v;
    },
  };
}

function buildNumber(schema, value, path, ctx, name, required) {
  const u = ui(schema);
  const control = h("input", { type: "number", name: path, min: schema.minimum, max: schema.maximum, step: schema.type === "integer" ? 1 : "any" });
  control.value = value === undefined ? "" : String(value);
  let touched = value !== undefined;
  control.addEventListener("input", () => { touched = true; });
  const el = wrap(ctx, path, u.label || humanize(name), control, u.help || schema.description);
  return {
    el,
    get() {
      if (!touched && !required) return undefined;
      if (control.value === "") return undefined;
      const n = Number(control.value);
      return Number.isFinite(n) ? n : undefined;
    },
  };
}

function buildBoolean(schema, value, path, ctx, name, required) {
  const u = ui(schema);
  const id = nextId("f");
  const control = h("input", { type: "checkbox", id, name: path });
  control.checked = value === true;
  let touched = value !== undefined;
  control.addEventListener("change", () => { touched = true; });
  const err = h("p", { class: "field-error", id: `${id}-err`, hidden: true });
  const help = u.help || schema.description ? h("p", { class: "help", id: `${id}-help` }, u.help || schema.description) : null;
  control.setAttribute("aria-describedby", [help ? `${id}-help` : "", `${id}-err`].filter(Boolean).join(" "));
  ctx.fields.set(path, { control, error: err });
  const el = h("div", { class: "field" }, h("label", { class: "check", for: id }, control, h("span", {}, u.label || humanize(name))), help, err);
  return { el, get: () => (touched || required ? control.checked : undefined) };
}

function buildObject(schema, value, path, ctx, name, required, root) {
  const u = ui(schema);
  const map = schema.additionalProperties && typeof schema.additionalProperties === "object" && !schema.properties;
  if (map) return buildMap(schema, value, path, ctx, name);
  const kids = [];
  const box = root ? h("div", { class: "form-root" }) : h("fieldset", {}, h("legend", {}, u.label || humanize(name)));
  if (u.help || schema.description) box.append(h("p", { class: "help" }, u.help || schema.description));
  for (const [k, sub] of Object.entries(schema.properties || {})) {
    if (ui(sub).hidden) continue;
    const child = build(sub, value ? value[k] : undefined, path ? `${path}.${k}` : k, ctx, k, (schema.required || []).includes(k));
    kids.push([k, child]);
    box.append(child.el);
  }
  return {
    el: box,
    get() {
      const o = {};
      let any = false;
      for (const [k, c] of kids) {
        const v = c.get();
        if (v !== undefined) { o[k] = v; any = true; }
      }
      if (!any && !required && !root) return undefined;
      return o;
    },
  };
}

function buildMap(schema, value, path, ctx, name) {
  const u = ui(schema);
  const rows = [];
  const list = h("div", { class: "row-list" });
  const fs = h("fieldset", {}, h("legend", {}, u.label || humanize(name)));
  if (u.help || schema.description) fs.append(h("p", { class: "help" }, u.help || schema.description));
  const add = (k, v) => {
    const keyInput = h("input", { type: "text", "aria-label": "Name", placeholder: "name", spellcheck: "false", autocomplete: "off" });
    keyInput.value = k;
    const inner = build(schema.additionalProperties, v, `${path}.${k || "*"}`, ctx, "value", true);
    const remove = h("button", { type: "button", class: "btn btn-small btn-danger" }, "Remove");
    const row = h("div", { class: "row-map" }, keyInput, inner.el, remove);
    const rec = { keyInput, inner, row };
    rows.push(rec);
    list.append(row);
    remove.addEventListener("click", () => { rows.splice(rows.indexOf(rec), 1); row.remove(); ctx.notify(); });
  };
  for (const [k, v] of Object.entries(value || {})) add(k, v);
  const addBtn = h("button", { type: "button", class: "btn btn-small" }, "Add entry");
  addBtn.addEventListener("click", () => { add("", defaultValue(schema.additionalProperties)); ctx.notify(); });
  fs.append(list, addBtn);
  return {
    el: fs,
    get() {
      const o = {};
      for (const r of rows) {
        const k = r.keyInput.value.trim();
        if (k === "" || FORBIDDEN_KEYS.has(k)) continue;
        const v = r.inner.get();
        if (v !== undefined) Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
      }
      return o;
    },
  };
}

function buildArray(schema, value, path, ctx, name, required) {
  const u = ui(schema);
  const items = schema.items || { type: "string" };
  const scalar = items.type !== "object" && items.type !== "array";
  if (u.widget === "tags" && scalar) {
    const control = h("input", { type: "text", name: path, spellcheck: "false", autocomplete: "off", placeholder: "comma separated" });
    control.value = (value || []).join(", ");
    const el = wrap(ctx, path, u.label || humanize(name), control, (u.help || schema.description || "") + " Separate entries with commas.");
    return {
      el,
      get() {
        const parts = control.value.split(",").map((s) => s.trim()).filter(Boolean);
        return items.type === "integer" || items.type === "number" ? parts.map(Number).filter(Number.isFinite) : parts;
      },
    };
  }
  const entries = [];
  const list = h("div", { class: "row-list" });
  const fs = h("fieldset", {}, h("legend", {}, u.label || humanize(name)));
  if (u.help || schema.description) fs.append(h("p", { class: "help" }, u.help || schema.description));
  const addEntry = (v) => {
    const idx = entries.length;
    const childPath = `${path}[${idx}]`;
    ctx.hideLabel = scalar;
    const child = build(items, v, childPath, ctx, ui(schema).label ? `${ui(schema).label} entry` : "Entry", true, items.type === "object");
    ctx.hideLabel = false;
    const remove = h("button", { type: "button", class: "btn btn-small btn-danger" }, "Remove");
    let row;
    if (scalar) row = h("div", { class: "row-inline" }, child.el, remove);
    else {
      const title = u.titleKey && v && typeof v[u.titleKey] === "string" && v[u.titleKey] !== "" ? v[u.titleKey] : `Entry ${idx + 1}`;
      row = h("div", { class: "row-item" }, h("div", { class: "row-head" }, h("strong", {}, title), remove), child.el);
    }
    const rec = { child, row };
    entries.push(rec);
    list.append(row);
    remove.addEventListener("click", () => {
      entries.splice(entries.indexOf(rec), 1);
      row.remove();
      ctx.notify();
    });
  };
  for (const v of value || []) addEntry(v);
  const addBtn = h("button", { type: "button", class: "btn btn-small" }, scalar ? "Add" : "Add entry");
  addBtn.addEventListener("click", () => { addEntry(defaultValue(items)); ctx.notify(); });
  fs.append(list, addBtn);
  return { el: fs, get: () => entries.map((e) => e.child.get()).filter((v) => v !== undefined) };
}

function build(schema, value, path, ctx, name, required, root = false) {
  switch (schema.type) {
    case "object": return buildObject(schema, value, path, ctx, name, required, root);
    case "array": return buildArray(schema, value, path, ctx, name, required);
    case "boolean": return buildBoolean(schema, value, path, ctx, name, required);
    case "integer": case "number": return buildNumber(schema, value, path, ctx, name, required);
    default: return buildString(schema, value, path, ctx, name, required);
  }
}

/**
 * Renders `schema` (an object schema) for `value`. Returns the element, a `get()` of the current value, `dirty()`,
 * `setErrors(issues)` (issues are `path: message` strings or `{path, message}`; it returns the messages it could not place on a field)
 * and `markClean()`.
 */
export function renderForm(schema, value, opts = {}) {
  const ctx = { fields: new Map(), notify: () => opts.onChange && opts.onChange() };
  const root = build(schema, value, "", ctx, "", true, true);
  root.el.addEventListener("input", () => ctx.notify());
  root.el.addEventListener("change", () => ctx.notify());
  let baseline = JSON.stringify(root.get());
  return {
    element: root.el,
    get: () => root.get(),
    dirty: () => JSON.stringify(root.get()) !== baseline,
    markClean: () => { baseline = JSON.stringify(root.get()); },
    setErrors(issues) {
      for (const { control, error } of ctx.fields.values()) {
        error.hidden = true;
        error.textContent = "";
        control.removeAttribute("aria-invalid");
      }
      const unplaced = [];
      let first = null;
      for (const raw of issues || []) {
        const issue = typeof raw === "string" ? parseIssue(raw) : raw;
        const f = ctx.fields.get(issue.path);
        if (f) {
          f.error.textContent = issue.message;
          f.error.hidden = false;
          f.control.setAttribute("aria-invalid", "true");
          first = first || f.control;
        } else unplaced.push(issue.path && issue.path !== "(root)" ? `${issue.path}: ${issue.message}` : issue.message);
      }
      if (first) first.focus();
      return unplaced;
    },
  };
}

function parseIssue(s) {
  const m = /^([^\s:][^:]*?): (.*)$/.exec(s);
  return m ? { path: m[1], message: m[2] } : { path: "", message: s };
}

/** A group of checkboxes for a fixed set of options. `get()` returns the ticked values in option order. */
export function checklist(options, selected, label, help) {
  const set = new Set(selected || []);
  const boxes = [];
  const group = h("div", { class: "check-list", role: "group", "aria-label": label });
  for (const opt of options) {
    const id = nextId("c");
    const box = h("input", { type: "checkbox", id });
    box.checked = set.has(opt);
    boxes.push([opt, box]);
    group.append(h("label", { class: "check", for: id }, box, h("span", {}, opt)));
  }
  if (options.length === 0) group.append(h("span", { class: "muted" }, "Nothing is available."));
  const gid = nextId("g");
  const el = h("div", { class: "field" }, h("span", { class: "label", id: gid }, label), help ? h("p", { class: "help" }, help) : null, group);
  group.setAttribute("aria-labelledby", gid);
  return { el, get: () => boxes.filter(([, b]) => b.checked).map(([o]) => o) };
}
