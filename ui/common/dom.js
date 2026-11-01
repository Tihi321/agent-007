// Shared DOM helper (S35). No innerHTML, no inline style, no inline event strings: every value is set as text or as a checked attribute.
const SAFE_URL = /^(https?:|mailto:|\/(?!\/)|#)/i;

export function safeUrl(u) {
  return typeof u === "string" && SAFE_URL.test(u.trim());
}

/** h("div", {class: "x", onclick: fn}, "text", child) */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) {
      if (typeof v !== "function") throw new Error("event handlers must be functions");
      el.addEventListener(k.slice(2), v);
    } else if (k === "style") throw new Error("inline style is not allowed");
    else if ((k === "href" || k === "src" || k === "action") && !safeUrl(v)) throw new Error("unsafe url");
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const k of kids) {
    if (k === undefined || k === null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(typeof k === "string" || typeof k === "number" ? document.createTextNode(String(k)) : k);
  }
}

export function clear(el, ...kids) {
  el.replaceChildren();
  add(el, kids);
  return el;
}

export function field(label, control, help) {
  const id = control.getAttribute("id") || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.setAttribute("id", id);
  return h("div", { class: "field" }, h("label", { for: id }, label), control, help ? h("p", { class: "help" }, help) : null);
}

export function when(ms) {
  return new Date(ms).toLocaleString();
}
