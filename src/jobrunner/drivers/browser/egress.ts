/** REQ-0014 egress proxy. T1 stub: T2 replaces `startEgressProxy`, keeps the types. */
import type { Resolver } from "../../../web/runtime/ssrf.js";

export interface EgressOptions {
  /** default: dns.promises.lookup(host, {all:true}) */
  resolver?: Resolver;
  /** TEST SEAM ONLY: hosts (e.g. "127.0.0.1") that skip the address check. Never read from config. */
  testAllowHosts?: readonly string[];
  onRefused?: (host: string, reason: string) => void;
}

export interface EgressProxy {
  server: string;
  username: string;
  password: string;
  close(): Promise<void>;
}

export function startEgressProxy(_o?: EgressOptions): Promise<EgressProxy> {
  return Promise.reject(new Error("not implemented: T2"));
}
