/**
 * Schemas of the web gateway's stores (S28). Hand-written strict validators in the style of `src/bots/schema.ts` (no dependency):
 * unknown keys, wrong types and out-of-range numbers are errors, and a validator never echoes a stored value in its message (I53).
 */
import { isUserId } from "./ids.js";

export class WebSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSchemaError";
  }
}

export const ROLES = ["owner", "admin", "user"] as const;
export type Role = (typeof ROLES)[number];
export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface Caps {
  /** Preset ids the user's bots may use. */
  presets: string[];
  /** Tool names a user bot may enable (a subset of the non-owner registry). */
  tools: string[];
  maxBots: number;
  maxChatsPerDay: number;
  maxTokensPerDay: number;
  /** Always 0 in this milestone (no `dispatch_job` for users). */
  maxJobsPerDay: 0;
  storageMB: number;
}

export interface WebUser {
  login: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  caps: Caps;
  createdAt: number;
  invitedBy: string;
  /** When the account was disabled (retention clock, UI-44). */
  disabledAt?: number;
}

export interface UsersFile {
  schemaVersion: 1;
  users: Record<string, WebUser>;
}

export interface Invite {
  id: string;
  codeHash: string;
  role: Exclude<Role, "owner">;
  caps: Caps;
  expiresAt: number;
  createdAt: number;
  createdBy: string;
  usedBy?: string;
  usedAt?: number;
  revoked?: boolean;
  tailscaleLoginPin?: string;
}

export interface InvitesFile {
  schemaVersion: 1;
  invites: Invite[];
}

export interface Passkey {
  id: string;
  /** SPKI DER of the ES256 public key, base64url. */
  publicKey: string;
  signCount: number;
  createdAt: number;
  label: string;
}

export interface PasswordCredential {
  hash: string;
  /** AES-GCM sealed base32 TOTP secret. */
  totpSealed: string;
  /** The last accepted TOTP time step (a code is single use). */
  lastTotpStep: number;
}

export interface UserCredentials {
  passkeys: Passkey[];
  password?: PasswordCredential;
  /** sha256 of each unused recovery code. */
  recovery: string[];
}

export interface CredentialsFile {
  schemaVersion: 1;
  users: Record<string, UserCredentials>;
}

export interface SessionRecord {
  idHash: string;
  userId: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  ip: string;
  uaHash: string;
  /** The last fresh passkey or TOTP confirmation (I56). */
  stepUpAt: number;
}

export interface SessionsFile {
  schemaVersion: 1;
  sessions: SessionRecord[];
}

// ---- tiny validator kit -----------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function fail(path: string, why: string): never {
  throw new WebSchemaError(`${path}: ${why}`);
}

function exact(v: unknown, path: string, required: string[], optional: string[] = []): Obj {
  if (!isObj(v)) fail(path, "must be an object");
  for (const k of Object.keys(v)) if (!required.includes(k) && !optional.includes(k)) fail(path, `unknown key "${k.slice(0, 40)}"`);
  for (const k of required) if (!(k in v)) fail(path, `missing "${k}"`);
  return v;
}

function str(v: unknown, path: string, max = 200, min = 0): string {
  if (typeof v !== "string" || v.length > max || v.length < min) fail(path, `must be text of ${min} to ${max} characters`);
  return v;
}
function int(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail(path, `must be an integer ${min} to ${max}`);
  return v;
}
function strs(v: unknown, path: string, maxItems = 100, maxLen = 80): string[] {
  if (!Array.isArray(v) || v.length > maxItems) fail(path, `must be a list of at most ${maxItems}`);
  return v.map((x, i) => str(x, `${path}[${i}]`, maxLen, 1));
}
function oneOf<T extends string>(v: unknown, path: string, set: readonly T[]): T {
  if (typeof v !== "string" || !(set as readonly string[]).includes(v)) fail(path, `must be one of ${set.join(", ")}`);
  return v as T;
}
const time = (v: unknown, path: string): number => int(v, path, 0, 8_640_000_000_000_000);

export function parseCaps(v: unknown, path = "caps"): Caps {
  const o = exact(v, path, ["presets", "tools", "maxBots", "maxChatsPerDay", "maxTokensPerDay", "maxJobsPerDay", "storageMB"]);
  if (o["maxJobsPerDay"] !== 0) fail(`${path}.maxJobsPerDay`, "must be 0 (no jobs for users in this milestone)");
  return {
    presets: strs(o["presets"], `${path}.presets`, 20),
    tools: strs(o["tools"], `${path}.tools`, 40),
    maxBots: int(o["maxBots"], `${path}.maxBots`, 0, 20),
    maxChatsPerDay: int(o["maxChatsPerDay"], `${path}.maxChatsPerDay`, 0, 100_000),
    maxTokensPerDay: int(o["maxTokensPerDay"], `${path}.maxTokensPerDay`, 0, 1_000_000_000),
    maxJobsPerDay: 0,
    storageMB: int(o["storageMB"], `${path}.storageMB`, 0, 100_000),
  };
}

/** UI-38 suggestion for a new user: local presets only (Strata), 3 bots, no jobs. */
export function defaultCaps(): Caps {
  return { presets: ["strata"], tools: ["tool_search", "ask_user", "write_file", "read_file", "list_dir", "search_files"], maxBots: 3, maxChatsPerDay: 200, maxTokensPerDay: 200_000, maxJobsPerDay: 0, storageMB: 200 };
}

export const LOGIN_PATTERN = /^[A-Za-z0-9._@+-]{3,120}$/;

function parseUser(v: unknown, path: string): WebUser {
  const o = exact(v, path, ["login", "displayName", "role", "status", "caps", "createdAt", "invitedBy"], ["disabledAt"]);
  const login = str(o["login"], `${path}.login`, 120, 3);
  if (!LOGIN_PATTERN.test(login)) fail(`${path}.login`, "has characters that are not allowed");
  const u: WebUser = {
    login,
    displayName: str(o["displayName"], `${path}.displayName`, 60, 1),
    role: oneOf(o["role"], `${path}.role`, ROLES),
    status: oneOf(o["status"], `${path}.status`, USER_STATUSES),
    caps: parseCaps(o["caps"], `${path}.caps`),
    createdAt: time(o["createdAt"], `${path}.createdAt`),
    invitedBy: str(o["invitedBy"], `${path}.invitedBy`, 40, 1),
  };
  if (o["disabledAt"] !== undefined) u.disabledAt = time(o["disabledAt"], `${path}.disabledAt`);
  return u;
}

export function emptyUsers(): UsersFile {
  return { schemaVersion: 1, users: {} };
}

export function parseUsersFile(v: unknown): UsersFile {
  const o = exact(v, "users.json", ["schemaVersion", "users"]);
  if (o["schemaVersion"] !== 1) fail("users.json.schemaVersion", "must be 1");
  if (!isObj(o["users"])) fail("users.json.users", "must be an object");
  const users: Record<string, WebUser> = {};
  const logins = new Set<string>();
  let owners = 0;
  for (const [id, u] of Object.entries(o["users"])) {
    if (!isUserId(id)) fail("users.json.users", "has a key that is not a user id");
    const user = parseUser(u, `users.${id.slice(0, 8)}`);
    const l = user.login.toLowerCase();
    if (logins.has(l)) fail("users.json.users", "two users share a login");
    logins.add(l);
    if (user.role === "owner") owners++;
    users[id] = user;
  }
  if (owners > 1) fail("users.json.users", "more than one owner");
  return { schemaVersion: 1, users };
}

export function emptyInvites(): InvitesFile {
  return { schemaVersion: 1, invites: [] };
}

export function parseInvitesFile(v: unknown): InvitesFile {
  const o = exact(v, "invites.json", ["schemaVersion", "invites"]);
  if (o["schemaVersion"] !== 1) fail("invites.json.schemaVersion", "must be 1");
  if (!Array.isArray(o["invites"]) || o["invites"].length > 1000) fail("invites.json.invites", "must be a list");
  const invites = o["invites"].map((raw, i): Invite => {
    const p = `invites[${i}]`;
    const x = exact(raw, p, ["id", "codeHash", "role", "caps", "expiresAt", "createdAt", "createdBy"], ["usedBy", "usedAt", "revoked", "tailscaleLoginPin"]);
    const inv: Invite = {
      id: str(x["id"], `${p}.id`, 40, 1),
      codeHash: str(x["codeHash"], `${p}.codeHash`, 64, 64),
      role: oneOf(x["role"], `${p}.role`, ["admin", "user"] as const),
      caps: parseCaps(x["caps"], `${p}.caps`),
      expiresAt: time(x["expiresAt"], `${p}.expiresAt`),
      createdAt: time(x["createdAt"], `${p}.createdAt`),
      createdBy: str(x["createdBy"], `${p}.createdBy`, 40, 1),
    };
    if (x["usedBy"] !== undefined) inv.usedBy = str(x["usedBy"], `${p}.usedBy`, 40, 1);
    if (x["usedAt"] !== undefined) inv.usedAt = time(x["usedAt"], `${p}.usedAt`);
    if (x["revoked"] !== undefined) {
      if (typeof x["revoked"] !== "boolean") fail(`${p}.revoked`, "must be true or false");
      inv.revoked = x["revoked"];
    }
    if (x["tailscaleLoginPin"] !== undefined) {
      const pin = str(x["tailscaleLoginPin"], `${p}.tailscaleLoginPin`, 120, 3);
      if (!LOGIN_PATTERN.test(pin)) fail(`${p}.tailscaleLoginPin`, "has characters that are not allowed");
      inv.tailscaleLoginPin = pin;
    }
    return inv;
  });
  return { schemaVersion: 1, invites };
}

export function emptyCredentials(): CredentialsFile {
  return { schemaVersion: 1, users: {} };
}

export function parseCredentialsFile(v: unknown): CredentialsFile {
  const o = exact(v, "credentials.json", ["schemaVersion", "users"]);
  if (o["schemaVersion"] !== 1) fail("credentials.json.schemaVersion", "must be 1");
  if (!isObj(o["users"])) fail("credentials.json.users", "must be an object");
  const users: Record<string, UserCredentials> = {};
  for (const [id, raw] of Object.entries(o["users"])) {
    if (!isUserId(id)) fail("credentials.json.users", "has a key that is not a user id");
    const p = `credentials.${id.slice(0, 8)}`;
    const x = exact(raw, p, ["passkeys", "recovery"], ["password"]);
    if (!Array.isArray(x["passkeys"]) || x["passkeys"].length > 20) fail(`${p}.passkeys`, "must be a list of at most 20");
    const passkeys = x["passkeys"].map((k, i): Passkey => {
      const q = exact(k, `${p}.passkeys[${i}]`, ["id", "publicKey", "signCount", "createdAt", "label"]);
      return { id: str(q["id"], `${p}.passkeys[${i}].id`, 1400, 1), publicKey: str(q["publicKey"], `${p}.passkeys[${i}].publicKey`, 400, 1), signCount: int(q["signCount"], `${p}.passkeys[${i}].signCount`, 0, 4_294_967_295), createdAt: time(q["createdAt"], `${p}.passkeys[${i}].createdAt`), label: str(q["label"], `${p}.passkeys[${i}].label`, 60) };
    });
    const c: UserCredentials = { passkeys, recovery: strs(x["recovery"], `${p}.recovery`, 20, 64) };
    if (x["password"] !== undefined) {
      const q = exact(x["password"], `${p}.password`, ["hash", "totpSealed", "lastTotpStep"]);
      c.password = { hash: str(q["hash"], `${p}.password.hash`, 400, 10), totpSealed: str(q["totpSealed"], `${p}.password.totpSealed`, 400, 10), lastTotpStep: int(q["lastTotpStep"], `${p}.password.lastTotpStep`, 0, 1e12) };
    }
    users[id] = c;
  }
  return { schemaVersion: 1, users };
}

export function emptySessions(): SessionsFile {
  return { schemaVersion: 1, sessions: [] };
}

export function parseSessionsFile(v: unknown): SessionsFile {
  const o = exact(v, "sessions.json", ["schemaVersion", "sessions"]);
  if (o["schemaVersion"] !== 1) fail("sessions.json.schemaVersion", "must be 1");
  if (!Array.isArray(o["sessions"]) || o["sessions"].length > 5000) fail("sessions.json.sessions", "must be a list");
  const sessions = o["sessions"].map((raw, i): SessionRecord => {
    const p = `sessions[${i}]`;
    const x = exact(raw, p, ["idHash", "userId", "createdAt", "lastSeen", "expiresAt", "ip", "uaHash", "stepUpAt"]);
    const userId = str(x["userId"], `${p}.userId`, 32, 32);
    if (!isUserId(userId)) fail(`${p}.userId`, "is not a user id");
    return { idHash: str(x["idHash"], `${p}.idHash`, 64, 64), userId, createdAt: time(x["createdAt"], `${p}.createdAt`), lastSeen: time(x["lastSeen"], `${p}.lastSeen`), expiresAt: time(x["expiresAt"], `${p}.expiresAt`), ip: str(x["ip"], `${p}.ip`, 64), uaHash: str(x["uaHash"], `${p}.uaHash`, 64), stepUpAt: time(x["stepUpAt"], `${p}.stepUpAt`) };
  });
  return { schemaVersion: 1, sessions };
}
