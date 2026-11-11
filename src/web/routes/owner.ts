/**
 * Owner-only view of the browser job screenshots (REQ-0014 T8). The images are served from this same origin through an authenticated
 * route, so the CSP (`img-src 'self'`) stays as it is. The path is a RELATIVE artifact path; the store refuses anything else.
 */
import { listManifests, readArtifact } from "../../artifacts/store.js";
import type { JobManifest } from "../../artifacts/store.js";
import { SECURITY_HEADERS } from "../http.js";
import type { RouteDef } from "../server.js";
import type { WebStack } from "../stack.js";

export interface OwnerStore {
  readArtifact: typeof readArtifact;
  listManifests: (root: string, max?: number) => JobManifest[];
}

export interface OwnerRouteOptions {
  /** `paths.jobArtifactsDir` of the gateway config. Empty = the routes answer 404. */
  root: string | undefined;
  /** Test seam; the default is the real store. */
  store?: OwnerStore;
}

const REAL_STORE: OwnerStore = { readArtifact, listManifests };

export function ownerRoutes(_stack: WebStack, o: OwnerRouteOptions): Record<string, RouteDef> {
  const store = o.store ?? REAL_STORE;
  const root = o.root;
  return {
    "GET /api/owner/jobs": {
      auth: "owner",
      handler: async () => {
        if (!root) return { status: 404, body: { error: "not_found" } };
        try {
          return { status: 200, body: { jobs: store.listManifests(root) } };
        } catch {
          return { status: 200, body: { jobs: [] } };
        }
      },
    },
    "GET /api/owner/artifact": {
      auth: "owner",
      handler: async (c) => {
        if (!root) return { status: 404, body: { error: "not_found" } };
        const rel = c.url.searchParams.get("path");
        if (!rel || rel.length > 200) return { status: 400, body: { error: "bad_request" } };
        let r;
        try {
          r = store.readArtifact(root, rel);
        } catch {
          return { status: 404, body: { error: "not_found" } };
        }
        if (!r.ok) return { status: 404, body: { error: "not_found" } };
        c.res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": r.mime, "Content-Length": r.bytes.length });
        c.res.end(r.bytes);
        return { handled: true };
      },
    },
  };
}

