/** Shared helpers for the IPC tests. Not a test file. */
import { Socket, connect } from "node:net";
import type { Logger } from "../../src/contracts.js";

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  fields: object | undefined;
}

export function captureLogger(): { logger: Logger; lines: LogLine[]; text(): string } {
  const lines: LogLine[] = [];
  const mk = (level: LogLine["level"]) => (event: string, fields?: object) => void lines.push({ level, event, fields });
  return {
    logger: { debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error") },
    lines,
    text: () => JSON.stringify(lines),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export interface RawConn {
  socket: Socket;
  received: Buffer[];
  closed: Promise<void>;
  isClosed(): boolean;
  write(data: string | Buffer): void;
  text(): string;
}

/** A plain TCP connection that records every byte the server sends and whether it closed. */
export function rawConnect(port: number): Promise<RawConn> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const received: Buffer[] = [];
    let closed = false;
    const closedP = new Promise<void>((res) => socket.once("close", () => ((closed = true), res())));
    socket.on("data", (c) => received.push(c));
    socket.on("error", () => undefined);
    socket.once("connect", () =>
      resolve({
        socket,
        received,
        closed: closedP,
        isClosed: () => closed,
        write: (d) => void socket.write(d),
        text: () => Buffer.concat(received).toString("utf8"),
      }),
    );
    socket.once("error", reject);
  });
}

/** A fixed key text (43 base64url characters = 32 bytes), for tests only. */
export const KEY_TEXT_A = Buffer.from("abcdefghijklmnopqrstuvwxyz012345").toString("base64url");
export const KEY_TEXT_B = Buffer.from("ZYXWVUTSRQPONMLKJIHGFEDCBA987654").toString("base64url");
