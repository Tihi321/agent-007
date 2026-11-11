/**
 * The in-page scripts (REQ-0014 T3), kept as strings so the file is plain TypeScript with no DOM types. Each script is a
 * function expression: Playwright's `page.evaluate(script, arg)` calls it in the page.
 *   - SNAPSHOT_SCRIPT(maxChars): numbers the interactive elements (data-a7-ref="eN"), returns visible text and the element list.
 *     A password input's value is never read; no element value of a file input is read.
 *   - FACTS_SCRIPT(ref): the facts the classifier decides on, read from the DOM (never from what the model claims).
 */
import type { ElementFacts, PageSnapshot } from "./backend.js";

const HELPERS = `
  const clip = (s, n) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, n);
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const typeOf = (el) => {
    const t = el.tagName.toLowerCase();
    if (t === 'input') return String(el.type || 'text').toLowerCase();
    return String(el.getAttribute('type') || '').toLowerCase();
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = typeOf(el);
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'submit' || ty === 'button' || ty === 'reset' || ty === 'image') return 'button';
      if (ty === 'search') return 'searchbox';
      return 'textbox';
    }
    return 'generic';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria, 120);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const txt = by.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : ''; }).join(' ');
      if (clip(txt, 120)) return clip(txt, 120);
    }
    if (el.labels && el.labels.length > 0) {
      const l = clip(el.labels[0].textContent, 120);
      if (l) return l;
    }
    const t = el.tagName.toLowerCase();
    if (t === 'input') {
      const ty = typeOf(el);
      if (ty === 'submit' || ty === 'button' || ty === 'reset') return clip(el.value, 120);
      if (ty === 'image') return clip(el.alt || el.title, 120);
    }
    const ph = el.getAttribute('placeholder');
    if (ph) return clip(ph, 120);
    if (t !== 'input' && t !== 'textarea' && t !== 'select') {
      const txt = clip(el.innerText || el.textContent, 120);
      if (txt) return txt;
    }
    return clip(el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '', 120);
  };
`;

export const SNAPSHOT_SCRIPT = `(maxChars) => {
  ${HELPERS}
  const MAX_ELEMENTS = 400;
  for (const old of document.querySelectorAll('[data-a7-ref]')) old.removeAttribute('data-a7-ref');
  const selector = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=combobox],[role=textbox],[role=option],[contenteditable=""],[contenteditable="true"]';
  const elements = [];
  let overflow = false;
  for (const el of document.querySelectorAll(selector)) {
    if (!isVisible(el)) continue;
    if (elements.length >= MAX_ELEMENTS) { overflow = true; break; }
    const ref = 'e' + (elements.length + 1);
    el.setAttribute('data-a7-ref', ref);
    const type = typeOf(el);
    const item = { ref, role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase(), inForm: !!el.form };
    if (type) item.type = type;
    const tag = item.tag;
    if (type === 'checkbox' || type === 'radio') item.value = el.checked ? 'checked' : 'unchecked';
    else if (tag === 'select') item.value = clip(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].textContent : '', 120);
    else if ((tag === 'input' || tag === 'textarea') && type !== 'password' && type !== 'file' && type !== 'submit' && type !== 'button' && type !== 'reset' && type !== 'image') item.value = clip(el.value, 200);
    elements.push(item);
  }
  let text = (document.body ? document.body.innerText : '') || '';
  text = text.replace(/[ \\t]+/g, ' ').replace(/\\n[ \\t]+/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  const truncated = overflow || text.length > maxChars;
  return { url: location.href, title: document.title || '', text: text.slice(0, maxChars), elements, truncated };
}`;

export const FACTS_SCRIPT = `(ref) => {
  ${HELPERS}
  const el = document.querySelector('[data-a7-ref="' + ref + '"]');
  if (!el) return null;
  const tag = el.tagName.toLowerCase();
  const type = typeOf(el);
  const form = el.form || null;
  const isSubmit = (tag === 'input' && (type === 'submit' || type === 'image')) || (tag === 'button' && !!form && String(el.type).toLowerCase() === 'submit');
  const anchor = el.closest ? el.closest('a[href]') : null;
  return {
    ref, tag, type, role: roleOf(el), name: nameOf(el),
    autocomplete: el.getAttribute('autocomplete') || '',
    nameAttr: el.getAttribute('name') || '',
    idAttr: el.getAttribute('id') || '',
    inForm: !!form, isSubmit,
    formAction: form ? String(form.action || '') : '',
    formHasPassword: !!form && form.querySelector('input[type=password]') !== null,
    href: anchor ? String(anchor.href || '') : '',
    contentEditable: el.isContentEditable === true,
    visible: isVisible(el),
  };
}`;

/** The text the model gets for `read`: page text, then the numbered elements. Password values are dropped again here. */
export function formatSnapshot(s: PageSnapshot, cap: number): string {
  const lines = s.elements.map((e) => {
    const value = e.type === "password" || e.type === "file" || e.value === undefined || e.value === "" ? "" : ` value=${JSON.stringify(e.value)}`;
    const type = e.type !== undefined && e.type !== "" ? ` type=${e.type}` : "";
    return `[${e.ref}] ${e.role}${type} ${JSON.stringify(e.name)}${value}${e.inForm ? " (in form)" : ""}`;
  });
  const out = `${s.text}\n\nInteractive elements (use these refs):\n${lines.length > 0 ? lines.join("\n") : "(none)"}${s.truncated ? "\n\n(page text or element list truncated)" : ""}`;
  return out.length > cap ? out.slice(0, cap) : out;
}

export type { ElementFacts };
