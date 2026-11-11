import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserAction } from "../../../src/jobs/browserContracts.js";
import { classifyAction } from "../../../src/jobrunner/drivers/browser/classify.js";
import type { ElementFacts } from "../../../src/jobrunner/drivers/browser/backend.js";
import { ACTIVE_FACTS_SCRIPT, FACTS_SCRIPT, SNAPSHOT_SCRIPT } from "../../../src/jobrunner/drivers/browser/snapshot.js";
import { DEFAULT_BROWSER_SETTINGS } from "../../../src/settings/browser.js";
import { facts } from "./fakeBackend.js";

// A3: one row per rule (1-7) plus the plain cases that must stay allowed.
const SHOP = "https://shop.example.com/products";
const field = (over: Partial<ElementFacts> = {}): ElementFacts => facts({ ref: "e1", tag: "input", type: "text", role: "textbox", ...over });
const type = (ref = "e1"): BrowserAction => ({ op: "type", ref, text: "x" });

const rows: Array<{ name: string; action: BrowserAction; el: ElementFacts | undefined; url?: string; settings?: Partial<typeof DEFAULT_BROWSER_SETTINGS>; want: "allow" | "ask" | "refuse" }> = [
  { name: "1 password field is refused", action: type(), el: field({ type: "password" }), want: "refuse" },
  { name: "1 card number by autocomplete is refused", action: { op: "fill", fields: [{ ref: "e1", value: "x" }] }, el: field({ autocomplete: "cc-number" }), want: "refuse" },
  { name: "1 otp by name is refused", action: type(), el: field({ nameAttr: "otp_code" }), want: "refuse" },
  { name: "1 password_confirm is refused", action: type(), el: field({ nameAttr: "password_confirm" }), want: "refuse" },
  { name: "1 passenger_name is not a credential", action: type(), el: field({ nameAttr: "passenger_name", idAttr: "bypass-note" }), want: "allow" },
  ...["passphrase", "newpwd", "otpcode", "smsotp", "cardcvv", "ssnlast4", "userpin"].map((n) => ({ name: `1 ${n} is refused`, action: type(), el: field({ nameAttr: n }), want: "refuse" as const })),
  ...["passenger_name", "footprint", "classname"].map((n) => ({ name: `1 ${n} is allowed`, action: type(), el: field({ nameAttr: n }), want: "allow" as const })),
  { name: "2b press Enter with focus in an iframe asks", action: { op: "press", key: "Enter" }, el: facts({ ref: "e1", tag: "iframe", role: "generic" }), want: "ask" },
  { name: "5 Enter in a contenteditable outside a form asks", action: { op: "press", key: "Enter", ref: "e1" }, el: facts({ ref: "e1", tag: "div", role: "textbox", contentEditable: true }), want: "ask" },
  { name: "4 Enter on a risky-label button asks like a click", action: { op: "press", key: "Enter", ref: "e1" }, el: facts({ ref: "e1", tag: "button", name: "Buy now" }), want: "ask" },
  { name: "5 Enter with unreadable focus asks", action: { op: "press", key: "Enter" }, el: undefined, want: "ask" },
  { name: "2 click on a file input is refused", action: { op: "click", ref: "e1" }, el: field({ type: "file" }), want: "refuse" },
  { name: "2 a ref not in the last snapshot is refused", action: { op: "click", ref: "e9" }, el: undefined, want: "refuse" },
  { name: "3 write on an askDomains host asks", action: { op: "click", ref: "e1" }, el: facts({ ref: "e1", name: "About" }), settings: { askDomains: ["*.example.com"] }, want: "ask" },
  { name: "3 read on an askDomains host is allowed", action: { op: "read" }, el: undefined, settings: { askDomains: ["*.example.com"] }, want: "allow" },
  { name: "4 submit button asks", action: { op: "click", ref: "e1" }, el: facts({ ref: "e1", tag: "button", name: "Go", isSubmit: true, inForm: true }), want: "ask" },
  { name: "4 risky word asks", action: { op: "click", ref: "e1" }, el: facts({ ref: "e1", tag: "button", name: "Buy now" }), want: "ask" },
  { name: "4 extraRiskyWords ask", action: { op: "click", ref: "e1" }, el: facts({ ref: "e1", name: "Wire money" }), settings: { extraRiskyWords: ["wire money"] }, want: "ask" },
  { name: "5 Enter in a form asks", action: { op: "press", key: "Enter", ref: "e1" }, el: field({ inForm: true, formAction: "https://shop.example.com/search" }), want: "ask" },
  { name: "5 fill in a login form asks", action: { op: "fill", fields: [{ ref: "e1", value: "x" }] }, el: field({ inForm: true, formAction: "https://shop.example.com/login" }), want: "ask" },
  { name: "6 typing an email address asks", action: type(), el: field({ autocomplete: "email" }), want: "ask" },
  { name: "7 plain link is allowed", action: { op: "click", ref: "e1" }, el: facts({ ref: "e1", name: "About us", href: "https://shop.example.com/about" }), want: "allow" },
  { name: "7 plain search box typing is allowed", action: type(), el: field({ nameAttr: "q", inForm: true, formAction: "https://shop.example.com/search" }), want: "allow" },
];

test("classifier rules 1-7 (A3); the credential test embedded in the page scripts still parses", () => {
  assert.doesNotThrow(() => new Function(`return ${SNAPSHOT_SCRIPT}`));
  assert.doesNotThrow(() => new Function(`return ${FACTS_SCRIPT}`));
  assert.doesNotThrow(() => new Function(`return ${ACTIVE_FACTS_SCRIPT}`));
  for (const r of rows) {
    const got = classifyAction(r.action, r.el === undefined && r.action.op === "read" ? [] : [r.el], r.url ?? SHOP, { ...DEFAULT_BROWSER_SETTINGS, ...r.settings });
    assert.equal(got.verdict, r.want, r.name);
  }
});
