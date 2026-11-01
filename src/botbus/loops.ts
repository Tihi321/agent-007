/**
 * Loop detection (S21.3, I33): a bot already in `path[]` is not asked again (a revisit), the second identical message of a chain
 * is blocked (SHA-256 of `(from, to, normalised body)`), and an A-B-A-B ping-pong is blocked. All of them are `loop_detected`.
 * Pure: node:crypto only.
 */
import { createHash } from "node:crypto";
import { BusError } from "./contracts.js";

export const normaliseBody = (body: string): string => body.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export function messageHash(from: string, to: string, body: string): string {
  return createHash("sha256").update(`${from}\n${to}\n${normaliseBody(body)}`, "utf8").digest("hex");
}

export const edgeKey = (from: string, to: string): string => `${from}>${to}`;

/** What a chain remembers for loop detection: hashes and edges, never bodies. */
export interface LoopMemory {
  hashes: readonly string[];
  edges: readonly string[];
}

/** Why the candidate ask is a loop, or undefined. */
export function loopReason(path: readonly string[], mem: LoopMemory, from: string, to: string, body: string): "revisit" | "identical" | "ping_pong" | undefined {
  if (path.includes(to)) return "revisit";
  if (mem.hashes.includes(messageHash(from, to, body))) return "identical";
  const e = mem.edges;
  const n = e.length;
  // A-B-A-B: the candidate is the fourth message of x>y, y>x, x>y, y>x
  if (n >= 3 && e[n - 1] === e[n - 3] && e[n - 2] === edgeKey(from, to) && e[n - 1] === edgeKey(to, from)) return "ping_pong";
  return undefined;
}

export function assertNoLoop(path: readonly string[], mem: LoopMemory, from: string, to: string, body: string): void {
  const r = loopReason(path, mem, from, to, body);
  if (r) throw new BusError("loop_detected", r);
}
