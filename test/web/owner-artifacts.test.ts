/** REQ-0014 A10 (web side): the owner screenshot route serves the image CSP-safe to the owner only. Fake store; no disk. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryWebAudit } from "../../src/web/audit.js";
import { SECURITY_HEADERS, csrfFor } from "../../src/web/http.js";
import { ownerRoutes } from "../../src/web/routes/owner.js";
import type { OwnerStore } from "../../src/web/routes/owner.js";
import { startGateway } from "../../src/web/server.js";
import type { AuthedSession } from "../../src/web/server.js";
import type { WebStack } from "../../src/web/stack.js";
import { http } from "./helpers.js";

const SID = "session-one";
const PNG = Buffer.from("89504e470d0a1a0a00", "hex");
const PATH = "job-0123456789ab/001.png";

const store: OwnerStore = {
  readArtifact: (_root, rel) => (rel === PATH ? { ok: true, bytes: PNG, mime: "image/png" } : { ok: false, reason: "refused" }),
  listManifests: () => [{ jobId: "job-0123456789ab", templateId: "browser-session", startedAt: 1, state: "succeeded", shots: [{ path: PATH, at: 1, caption: "page" }] }],
};

async function rig(role: AuthedSession["role"]) {
  const session: AuthedSession = { userId: "u1", role, login: "a@x.com", idHash: "h", csrf: csrfFor(SID), stepUpAt: Date.now() };
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    publicHosts: [],
    audit: memoryWebAudit(),
    sessions: { resolve: (c) => (c === SID ? session : undefined) },
    identify: async () => ({ ok: true, identity: { kind: "tailscale", login: "a@x.com" } }),
    routes: ownerRoutes({} as WebStack, { root: "/artifacts", store }),
  });
  return { gw, headers: { cookie: `__Host-a7web=${SID}` } };
}

test("owner artifact route: the owner gets the PNG with the unchanged CSP; a non-owner gets 403; a bad path is 404", async () => {
  const owner = await rig("owner");
  const user = await rig("user");
  try {
    const q = (p: string) => `/api/owner/artifact?path=${encodeURIComponent(p)}`;
    const ok = await http(owner.gw.port, "GET", q(PATH), { headers: owner.headers });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["content-type"], "image/png");
    assert.equal(ok.headers["content-security-policy"], SECURITY_HEADERS["Content-Security-Policy"]);
    assert.equal(ok.headers["x-content-type-options"], "nosniff");
    assert.equal((await http(owner.gw.port, "GET", q("../x.png"), { headers: owner.headers })).status, 404);
    assert.equal((await http(owner.gw.port, "GET", "/api/owner/jobs", { headers: owner.headers })).json().jobs.length, 1);
    assert.equal((await http(user.gw.port, "GET", q(PATH), { headers: user.headers })).status, 403);
    assert.equal((await http(user.gw.port, "GET", "/api/owner/jobs", { headers: user.headers })).status, 403);
  } finally {
    await owner.gw.close();
    await user.gw.close();
  }
});
