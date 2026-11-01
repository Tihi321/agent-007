/**
 * Adapts the bus's event stream (`BusObserver.onMessage`, S21) to the room mirror's read-only `BusAuditSource` (S24, deviation S24-1).
 *
 * What passes: the kind (`ask`, `reply`, `refused` for a denied ask, `failed`), the two bot ids, the hop, the chain id, the ask or
 * reply text for `ask` and `reply`, and a short machine reason for `refused` and `failed`. What never passes: the taint flag, the
 * origin, the body hash, any attachment, any approval, the body of a refused ask, or a breaker or note event (the mirror does not
 * show them, and they are not published by the bus). A refused ask carries its reason only, never the text that was refused.
 */
import type { BusEvent, BusObserver } from "../botbus/contracts.js";
import type { BusAuditEvent } from "../botroom/format.js";
import type { BusAuditSource } from "../botroom/mirror.js";

export function toAuditEvent(ev: BusEvent): BusAuditEvent | undefined {
  switch (ev.type) {
    case "ask":
      return { kind: "ask", from: ev.from, to: ev.to, hop: ev.hop, chainId: ev.chainId, ...(ev.text !== undefined ? { text: ev.text } : {}) };
    case "reply":
      return { kind: "reply", from: ev.from, to: ev.to, hop: ev.hop, chainId: ev.chainId, ...(ev.text !== undefined ? { text: ev.text } : {}) };
    case "denied":
      return { kind: "refused", from: ev.from, to: ev.to, hop: ev.hop, chainId: ev.chainId, ...(ev.reason !== undefined ? { reason: ev.reason } : {}) };
    case "failed":
      return { kind: "failed", from: ev.from, to: ev.to, hop: ev.hop, chainId: ev.chainId, ...(ev.reason !== undefined ? { reason: ev.reason } : {}) };
    default:
      return undefined;
  }
}

export function busAuditSource(bus: BusObserver): BusAuditSource {
  return {
    subscribe(listener) {
      return bus.onMessage((ev) => {
        const mapped = toAuditEvent(ev);
        if (mapped) listener(mapped);
      });
    },
  };
}
