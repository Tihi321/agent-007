/**
 * Risky-action classifier (REQ-0014 T3). Pure: it decides from element facts the runner read from the DOM, never from what
 * the model says about an element. Rules, first match wins (see the plan, T3):
 *   1 refuse type/fill/press into a credential field      2 refuse a file click or a ref not in the last snapshot
 *   3 ask every write action on an `askDomains` host       4 ask a click on a submit or a risky label/link
 *   5 ask Enter in a form / fill of a risky form           6 ask type into a risky form      7 allow
 */
import type { BrowserAction } from "../../../jobs/browserContracts.js";
import type { Json } from "../../../jobs/contracts.js";
import type { BrowserSettings } from "../../../settings/browser.js";
import type { ElementFacts } from "./backend.js";

export type Verdict = { verdict: "allow" } | { verdict: "ask"; reason: string } | { verdict: "refuse"; reason: string };

const CREDENTIAL_AUTOCOMPLETE = ["password", "one-time-code", "cc-number", "cc-csc", "cc-exp"];
const CREDENTIAL_NAME = /pass(word|wd)?|pwd|otp|2fa|totp|cvv|cvc|card.?num|iban|ssn|pin\b/i;
const RISKY_WORDS =
  /\b(send|submit|post|publish|reply|pay|buy|purchase|order|checkout|check out|confirm|delete|remove|cancel subscription|transfer|subscribe|sign ?up|register|book|reserve|donate|log ?in|sign ?in|accept|agree|authori[sz]e|allow|install|upload|share)\b/i;
const RISKY_FORM_PATH = /login|signin|sign-in|auth|checkout|payment|pay|billing|wallet|account/i;
const PERSONAL_AUTOCOMPLETE = new Set(["email", "username", "tel", "street-address", "address-line1", "postal-code", "cc-name", "bday"]);
const READ_ONLY_OPS = new Set(["read", "screenshot", "back", "done"]);

export const CREDENTIAL_REFUSAL = "credential fields are filled by you in browser-login, never by the agent";

/** `example.com` matches that host only; `*.example.com` matches its subdomains (not the bare domain). */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (p === "") return false;
    if (p.startsWith("*.")) return h.length > p.length - 1 && h.endsWith(p.slice(1));
    return h === p;
  });
}

export function isCredentialField(f: ElementFacts): boolean {
  if (f.type === "password" || f.type === "file") return true;
  const ac = f.autocomplete.toLowerCase();
  if (CREDENTIAL_AUTOCOMPLETE.some((t) => ac.includes(t))) return true;
  return CREDENTIAL_NAME.test(f.nameAttr) || CREDENTIAL_NAME.test(f.idAttr);
}

function urlParts(pageUrl: string): { host: string; path: string } {
  try {
    const u = new URL(pageUrl);
    return { host: u.hostname, path: u.pathname };
  } catch {
    return { host: "", path: "" };
  }
}

function riskyContext(f: ElementFacts, pagePath: string): boolean {
  if (f.inForm && (f.formHasPassword || RISKY_FORM_PATH.test(f.formAction) || RISKY_FORM_PATH.test(pagePath))) return true;
  return f.autocomplete
    .toLowerCase()
    .split(/\s+/)
    .some((t) => PERSONAL_AUTOCOMPLETE.has(t));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function refsOf(action: BrowserAction): string[] {
  switch (action.op) {
    case "click":
    case "type":
      return [action.ref];
    case "fill":
      return action.fields.map((f) => f.ref);
    case "press":
      return action.ref !== undefined ? [action.ref] : [];
    default:
      return [];
  }
}

/**
 * `facts` is one entry per ref of the action, in order (`fill`: one per field). An entry is `undefined` when the ref is not in
 * the last snapshot. For `press` without a ref, the driver passes the facts of the last element it touched, if any.
 */
export function classifyAction(
  action: BrowserAction,
  facts: ReadonlyArray<ElementFacts | undefined>,
  pageUrl: string,
  settings: BrowserSettings,
): Verdict {
  const known = facts.filter((f): f is ElementFacts => f !== undefined);
  const { host, path } = urlParts(pageUrl);

  // 1 credentials are never typed
  if (action.op === "type" || action.op === "fill" || action.op === "press") {
    if (known.some(isCredentialField)) return { verdict: "refuse", reason: CREDENTIAL_REFUSAL };
  }
  // 2 files, unknown refs
  if (action.op === "click" && known.some((f) => f.tag === "input" && f.type === "file")) {
    return { verdict: "refuse", reason: "file pickers are not available to the agent" };
  }
  const wanted = refsOf(action).length;
  if (wanted > 0 && (facts.length < wanted || facts.some((f) => f === undefined))) {
    return { verdict: "refuse", reason: "that element is not in the last page snapshot (call browser_read first)" };
  }
  // 3 owner-listed hosts: every write action asks
  if (!READ_ONLY_OPS.has(action.op) && host !== "" && hostMatches(host, settings.askDomains)) {
    return { verdict: "ask", reason: `the owner listed ${host} as always-ask` };
  }
  // 4 clicks that send something
  if (action.op === "click") {
    const f = known[0];
    if (f !== undefined) {
      if (f.isSubmit) return { verdict: "ask", reason: "this submits a form" };
      const extra = settings.extraRiskyWords.map((w) => w.trim()).filter((w) => w !== "");
      const extraRe = extra.length > 0 ? new RegExp(`\\b(${extra.map(escapeRe).join("|")})\\b`, "i") : undefined;
      for (const text of [f.name, f.href]) {
        if (RISKY_WORDS.test(text) || extraRe?.test(text) === true) {
          return { verdict: "ask", reason: "the label or link looks like a send, pay, login or delete action" };
        }
      }
    }
  }
  // 5 Enter in a form, fill of a risky form
  if (action.op === "press" && action.key === "Enter") {
    const f = known[0];
    if (f === undefined) return { verdict: "ask", reason: "Enter with no known target element" };
    if (f.inForm) return { verdict: "ask", reason: "Enter in a form submits it" };
  }
  if (action.op === "fill" && known.some((f) => riskyContext(f, path))) {
    return { verdict: "ask", reason: "this fills a login, payment or personal-data form" };
  }
  // 6 type into a risky form
  if (action.op === "type" && known.some((f) => riskyContext(f, path))) {
    return { verdict: "ask", reason: "this types into a login, payment or personal-data form" };
  }
  // 7
  return { verdict: "allow" };
}

function maskedText(n: number): string {
  return `‹masked, ${n} chars›`;
}

function stripUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    u.username = "";
    u.password = "";
    return u.href;
  } catch {
    return "‹invalid url›";
  }
}

/** The action as it may appear in events, permission cards, journal and audit: typed values masked, URLs without query. */
export function maskAction(action: BrowserAction): Json {
  switch (action.op) {
    case "type":
      return { op: "type", ref: action.ref, text: maskedText(action.text.length), clear: action.clear === true };
    case "fill":
      return { op: "fill", fields: action.fields.map((f) => ({ ref: f.ref, value: maskedText(f.value.length) })) };
    case "goto":
      return { op: "goto", url: stripUrl(action.url) };
    case "press":
      return action.ref !== undefined ? { op: "press", key: action.key, ref: action.ref } : { op: "press", key: action.key };
    case "click":
      return { op: "click", ref: action.ref };
    case "read":
      return action.maxChars !== undefined ? { op: "read", maxChars: action.maxChars } : { op: "read" };
    case "screenshot":
      return { op: "screenshot", fullPage: action.fullPage === true };
    case "done":
      return { op: "done", summary: action.summary };
    case "back":
      return { op: "back" };
  }
}
