import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { BrowserAction } from "../../../src/jobs/browserContracts.js";
import type { JobEvent } from "../../../src/jobs/contracts.js";
import { INSTALL_DENIED_MESSAGE } from "../../../src/jobrunner/drivers/browser/driver.js";
import { JOB_ID, facts, rig } from "./fakeBackend.js";
import type { Rig } from "./fakeBackend.js";

let n = 0;
const act = (r: Rig, action: BrowserAction) => r.driver.act(JOB_ID, { jobId: JOB_ID, callId: `c${++n}`, action }, r.host);

test("submit asks: deny leaves the page alone, allow clicks (A2)", async () => {
  const r = rig({ elements: [facts({ ref: "e1", tag: "button", name: "Place order", isSubmit: true, inForm: true })] });
  await r.start();
  assert.equal((await act(r, { op: "read" })).outcome, "done");

  r.host.answer = () => "deny";
  const denied = await act(r, { op: "click", ref: "e1" });
  assert.equal(denied.outcome, "denied");
  assert.equal(r.backend.session?.count("click"), 0);
  assert.equal(r.host.asked.length, 1);
  const card = r.host.asked[0];
  assert.equal(card?.kind, "browser");
  assert.equal(card?.attachments?.length, 1);
  assert.deepEqual(card?.input, { op: "click", ref: "e1" });

  r.host.answer = () => "allow_once";
  assert.equal((await act(r, { op: "click", ref: "e1" })).outcome, "done");
  assert.equal(r.backend.session?.count("click"), 1);
  assert.equal(r.host.asked.length, 2);
  await r.finish();
});

test("credential refused: nobody is asked, nothing typed, the value is in no record (A4)", async () => {
  const secret = "hunter2-correct-horse";
  const r = rig({ elements: [facts({ ref: "e1", tag: "input", type: "password", role: "textbox", name: "Password", inForm: true, formHasPassword: true })] });
  await r.start();
  await act(r, { op: "read" });
  const reply = await act(r, { op: "type", ref: "e1", text: secret });
  assert.equal(reply.outcome, "refused");
  assert.equal(r.host.asked.length, 0);
  assert.equal(r.backend.session?.count("type"), 0);

  const events = await r.finish();
  const manifest = readFileSync(join(r.artifactsDir, "job-0123456789ab", "manifest.json"), "utf8");
  const everything = JSON.stringify({ events, asked: r.host.asked, reply, manifest });
  assert.ok(!everything.includes(secret));
  assert.ok(events.some((e: JobEvent) => e.kind === "tool_call"), "the refused call is still logged, masked");
});

test("install: owner-confirmed download, clear failure on deny (A9)", async () => {
  const denied = rig({ installed: false });
  denied.host.answer = () => "deny";
  await denied.start();
  const events = await denied.events();
  assert.equal(denied.host.asked[0]?.tool, "browser_install");
  assert.equal(denied.installer.installs, 0);
  const last = events[events.length - 1];
  assert.deepEqual(last && last.kind === "state" ? [last.state, last.detail] : undefined, ["failed", INSTALL_DENIED_MESSAGE]);

  const allowed = rig({ installed: false });
  await allowed.start();
  assert.equal((await act(allowed, { op: "read" })).outcome, "done");
  assert.equal(allowed.installer.installs, 1);
  assert.equal(allowed.host.asked[0]?.tool, "browser_install");
  assert.equal(allowed.backend.launches.length, 1);
  await allowed.finish();
});

test("a newline in typed text is refused; Enter is judged on the focused element; a page change while asking cancels the action (F3, F4, F8)", async () => {
  const link = facts({ ref: "e1", tag: "a", name: "Next page" });
  const box = facts({ ref: "e2", tag: "input", type: "text", role: "textbox", name: "Search" });
  const r = rig({ elements: [link, box] });
  await r.start();
  await act(r, { op: "read" });

  assert.equal((await act(r, { op: "type", ref: "e2", text: "cats\n" })).outcome, "refused");
  assert.equal(r.backend.session?.count("type"), 0);

  const session = r.backend.session;
  assert.ok(session);
  session.focused = facts({ ref: "e9", tag: "button", name: "Buy now" });
  assert.equal((await act(r, { op: "press", key: "Enter" })).outcome, "done");
  assert.equal(r.host.asked.length, 1, "Enter on a risky button without a ref asks");
  session.focused = "unreadable";
  await act(r, { op: "press", key: "Tab" });
  assert.equal(r.host.asked.length, 2, "an unreadable focus fails closed to ask");
  session.focused = undefined;

  r.host.answer = () => {
    Object.assign(link, { name: "Delete account", isSubmit: true });
    return "allow_once";
  };
  link.name = "Buy now";
  const changed = await act(r, { op: "click", ref: "e1" });
  assert.equal(changed.outcome, "denied");
  assert.match(changed.message ?? "", /page changed while waiting/);
  assert.equal(session.count("click"), 0);
  await r.finish();
});
