/**
 * Atomic JSON stores for the web gateway (S28, I55). A missing file is the empty document; a file that does not parse or does not
 * validate is a `WebStoreError` (the loader never "repairs" it, and the gateway refuses to start on it). Writes go to a temp file in the
 * same folder and are renamed over the target, so a crash leaves either the old or the new file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { emptyCredentials, emptyInvites, emptySessions, emptyUsers, parseCredentialsFile, parseInvitesFile, parseSessionsFile, parseUsersFile } from "./schemas.js";
import type { CredentialsFile, InvitesFile, SessionsFile, UsersFile } from "./schemas.js";

export class WebStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebStoreError";
  }
}

let counter = 0;

export function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++counter}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* no temp file to remove */
    }
    throw e;
  }
}

export class JsonStore<T> {
  readonly #file: string;
  readonly #parse: (v: unknown) => T;
  readonly #empty: () => T;
  readonly #name: string;

  constructor(name: string, file: string, parse: (v: unknown) => T, empty: () => T) {
    this.#name = name;
    this.#file = file;
    this.#parse = parse;
    this.#empty = empty;
  }

  get file(): string {
    return this.#file;
  }

  exists(): boolean {
    return existsSync(this.#file);
  }

  /** The stored document, or the empty one when the file is missing. Throws `WebStoreError` for a corrupt file (fail closed, I55). */
  read(): T {
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return this.#empty();
      throw new WebStoreError(`${this.#name}: the file cannot be read`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^﻿/, ""));
    } catch {
      throw new WebStoreError(`${this.#name}: the file is not valid JSON`);
    }
    try {
      return this.#parse(raw);
    } catch (e) {
      throw new WebStoreError(`${this.#name}: ${e instanceof Error ? e.message : "invalid"}`);
    }
  }

  /** Read, change, validate, write atomically. The change function may return a replacement or mutate and return nothing. */
  update<R = void>(fn: (doc: T) => R): R {
    const doc = this.read();
    const result = fn(doc);
    let checked: T;
    try {
      checked = this.#parse(JSON.parse(JSON.stringify(doc)));
    } catch (e) {
      throw new WebStoreError(`${this.#name}: refusing to write an invalid document (${e instanceof Error ? e.message : "invalid"})`);
    }
    atomicWriteJson(this.#file, checked);
    return result;
  }
}

export const usersStore = (file: string): JsonStore<UsersFile> => new JsonStore("users.json", file, parseUsersFile, emptyUsers);
export const invitesStore = (file: string): JsonStore<InvitesFile> => new JsonStore("invites.json", file, parseInvitesFile, emptyInvites);
export const credentialsStore = (file: string): JsonStore<CredentialsFile> => new JsonStore("credentials.json", file, parseCredentialsFile, emptyCredentials);
export const sessionsStore = (file: string): JsonStore<SessionsFile> => new JsonStore("sessions.json", file, parseSessionsFile, emptySessions);
