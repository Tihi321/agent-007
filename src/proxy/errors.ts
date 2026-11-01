/**
 * S23.3: a typed mapping of the proxy's errors (plan I39, notes-multibot section 4) to what the S22.3 fallback engine and `/status` need.
 *
 * The proxy answers with the OpenAI error envelope `{ error: { message, type, code } }`. Through the Pi provider those show up only as
 * text (`errorMessage`: `503 {"error":{"code":"provider_auth_required",...}}` or an SDK sentence), so `classifyProxyMessage` reads that text;
 * `classifyProxyResponse` reads a real status, body and headers (the health and model-list probes). Nothing here echoes a response body
 * or message: the `message` of a failure is a fixed sentence, so it can never carry a key, a prompt or a reply.
 */

export type ProxyErrorKind =
  /** 503 `provider_auth_required` (Codex, Claude) or `auth_required` (Antigravity): the main user must log in. */
  | "auth_required"
  /** 401: the shared bearer key in `secrets.json` is wrong or missing. A setup problem, not a login. */
  | "bad_key"
  /** 503 `provider_busy` (with `Retry-After`, the Claude OAuth refresh lock). */
  | "busy"
  /** 429 `provider_queue_full`. */
  | "queue_full"
  /** 504 `request_timeout` (5 minutes including the proxy's queue wait). */
  | "timeout"
  /** 404 `model_not_found`. */
  | "model_not_found"
  /** 400 `model_not_capable` / `unsupported_parameter` and any other 4xx: a bug on our side, never a fallback. */
  | "bad_request"
  /** Connection refused or reset: the proxy is not running or the main user is logged off. Same handling as `auth_required`. */
  | "down"
  /** This host's own limiter refused the call (queue depth cap, P2 and P3 only). Not a proxy error. */
  | "limiter_busy"
  /** The caller aborted (`/stop`). Never retried, never a fallback. */
  | "aborted"
  /** Anything else (a 5xx with no known code, an unreadable message). */
  | "unknown";

export interface RetryPlan {
  /** How many more attempts after the first failure (0 = none). */
  attempts: number;
  /** Seconds to wait before a retry: the `Retry-After` value when the proxy sent one, else this default. */
  delaySec: number;
}

export interface ProxyFailure {
  kind: ProxyErrorKind;
  /** HTTP status when known. */
  status?: number;
  /** The proxy's own `error.code` when known. */
  code?: string;
  /** `Retry-After` in seconds when the proxy sent one (probes only; the provider text does not carry headers). */
  retryAfterSec?: number;
  /** I39: no retry, one backoff retry, or wait and retry up to twice. */
  retry: RetryPlan;
  /** After the retries are used up, a preset in `route.fallback` with `autoFallback: true` may take over. `never`: a bug or an abort. */
  fallback: "after_retries" | "never";
  /** Mark the preset "needs login" in `/status` and tell the user once (audited by the caller). */
  needsLogin: boolean;
  /** The shared key is wrong: tell the user to fix `secrets.json` (the key itself is never shown). */
  needsKeyFix: boolean;
  /** 404: refresh `GET /v1/models`; another model of the same provider is never substituted. */
  refreshModels: boolean;
  /** A fixed, content-free sentence for logs, `/status` and the one user notice. */
  message: string;
}

const NO_RETRY: RetryPlan = { attempts: 0, delaySec: 0 };

interface Row {
  retry: RetryPlan;
  fallback: ProxyFailure["fallback"];
  needsLogin?: boolean;
  needsKeyFix?: boolean;
  refreshModels?: boolean;
  message: string;
}

/** The I39 table. Delays: 503 busy waits the proxy's `Retry-After` (30 s in the proxy), else 30 s; the others back off 5 s once. */
const TABLE: Record<ProxyErrorKind, Row> = {
  auth_required: { retry: NO_RETRY, fallback: "after_retries", needsLogin: true, message: "the proxy needs a login for this provider (the main user must sign in)" },
  bad_key: { retry: NO_RETRY, fallback: "after_retries", needsKeyFix: true, message: "the proxy rejected the key in secrets.json (HTTP 401)" },
  busy: { retry: { attempts: 2, delaySec: 30 }, fallback: "after_retries", message: "the proxy provider is busy" },
  queue_full: { retry: { attempts: 1, delaySec: 5 }, fallback: "after_retries", message: "the proxy queue for this provider is full" },
  timeout: { retry: { attempts: 1, delaySec: 5 }, fallback: "after_retries", message: "the proxy request timed out" },
  model_not_found: { retry: NO_RETRY, fallback: "never", refreshModels: true, message: "the proxy does not know this model id (refresh the model list; no other model is substituted)" },
  bad_request: { retry: NO_RETRY, fallback: "never", message: "the proxy rejected the request (a client bug, not an outage)" },
  down: { retry: NO_RETRY, fallback: "after_retries", needsLogin: true, message: "the proxy is not reachable (not running, or the main user is logged off)" },
  limiter_busy: { retry: NO_RETRY, fallback: "never", message: "too many calls waiting for the proxy (this host's limiter)" },
  aborted: { retry: NO_RETRY, fallback: "never", message: "the request was stopped" },
  unknown: { retry: { attempts: 1, delaySec: 5 }, fallback: "after_retries", message: "the proxy returned an unexpected error" },
};

export function failureOf(kind: ProxyErrorKind, extra: { status?: number; code?: string; retryAfterSec?: number } = {}): ProxyFailure {
  const row = TABLE[kind];
  const retry: RetryPlan = kind === "busy" && extra.retryAfterSec !== undefined ? { attempts: row.retry.attempts, delaySec: clampDelay(extra.retryAfterSec) } : { ...row.retry };
  return {
    kind,
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.code !== undefined ? { code: extra.code } : {}),
    ...(extra.retryAfterSec !== undefined ? { retryAfterSec: extra.retryAfterSec } : {}),
    retry,
    fallback: row.fallback,
    needsLogin: row.needsLogin === true,
    needsKeyFix: row.needsKeyFix === true,
    refreshModels: row.refreshModels === true,
    message: row.message,
  };
}

function clampDelay(sec: number): number {
  if (!Number.isFinite(sec) || sec < 0) return 30;
  return Math.min(Math.max(Math.round(sec), 1), 120);
}

/** The error codes the proxy documents, by kind (README, notes-multibot section 4). */
const CODE_KIND: Record<string, ProxyErrorKind> = {
  provider_auth_required: "auth_required",
  auth_required: "auth_required",
  invalid_api_key: "bad_key",
  provider_busy: "busy",
  provider_queue_full: "queue_full",
  request_timeout: "timeout",
  model_not_found: "model_not_found",
  model_not_capable: "bad_request",
  unsupported_parameter: "bad_request",
};

/** The kind for a status plus an optional documented code. The code wins over the status (a 503 can be auth or busy). */
export function kindOf(status: number | undefined, code: string | undefined): ProxyErrorKind {
  if (code !== undefined && Object.prototype.hasOwnProperty.call(CODE_KIND, code)) return CODE_KIND[code] as ProxyErrorKind;
  switch (status) {
    case 401:
      return "bad_key";
    case 404:
      return "model_not_found";
    case 429:
      return "queue_full";
    case 504:
      return "timeout";
    case 400:
    case 403:
    case 405:
    case 413:
    case 415:
    case 422:
      return "bad_request";
    case 503:
      return "busy"; // a 503 with no documented code: treat as busy (wait, then fall back)
    default:
      return status !== undefined && status >= 400 && status < 500 ? "bad_request" : "unknown";
  }
}

/** The `error.code` (or `error.type`) of an OpenAI-style envelope, or undefined. */
export function codeFromBody(body: unknown): string | undefined {
  if (typeof body === "string") {
    try {
      return codeFromBody(JSON.parse(body));
    } catch {
      return findKnownCode(body);
    }
  }
  if (typeof body !== "object" || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err === "object" && err !== null) {
    const e = err as { code?: unknown; type?: unknown };
    if (typeof e.code === "string") return e.code;
    if (typeof e.type === "string") return e.type;
  }
  return undefined;
}

function findKnownCode(text: string): string | undefined {
  return Object.keys(CODE_KIND).find((c) => text.includes(c));
}

/** `Retry-After` as seconds (delta-seconds form; an HTTP date is not used by the proxy). */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Classify a real HTTP answer (status, body text or parsed JSON, `Retry-After`). */
export function classifyProxyResponse(input: { status: number; body?: unknown; retryAfter?: string | null }): ProxyFailure {
  const code = codeFromBody(input.body ?? undefined);
  const retryAfterSec = parseRetryAfter(input.retryAfter);
  return failureOf(kindOf(input.status, code), { status: input.status, ...(code !== undefined ? { code } : {}), ...(retryAfterSec !== undefined ? { retryAfterSec } : {}) });
}

const MARKER_PATTERN = /\[a7-proxy:([a-z_]+)\]/;

/**
 * The text the Models wrapper puts in `errorMessage` for a failure that must NOT be retried by the Harness (I39: no retry for a login, a
 * wrong key, a missing model, a bad request, a downed proxy). Pi's retry policy matches status numbers and words such as "503" or
 * "timeout" in the message, so the original text is replaced by this fixed sentence (it contains none of them). The marker lets the
 * S22.3 fallback engine and `/status` classify it again with `classifyProxyMessage`.
 */
export function markedMessage(failure: ProxyFailure): string {
  return `[a7-proxy:${failure.kind}] ${failure.message}`;
}

/**
 * The S22.3 input (`Failure.kind` of `src/models/fallback.ts`) for a classified proxy failure; undefined when nothing must reach the
 * fallback engine (a caller abort, this host's own limiter refusal). Typed structurally so this folder does not import `src/models`.
 * `bad_key` goes in as `auth_required` (no retry, then the route's `onAuthRequired` rule), which is the closest I39 row.
 */
export type FallbackFailureKind = "auth_required" | "provider_busy" | "queue_full" | "timeout" | "model_not_found" | "bad_request" | "connection_refused" | "other";

export function toFallbackFailure(f: ProxyFailure): { kind: FallbackFailureKind; retryAfterSec?: number } | undefined {
  const kinds: Record<ProxyErrorKind, FallbackFailureKind | undefined> = {
    auth_required: "auth_required",
    bad_key: "auth_required",
    busy: "provider_busy",
    queue_full: "queue_full",
    timeout: "timeout",
    model_not_found: "model_not_found",
    bad_request: "bad_request",
    down: "connection_refused",
    limiter_busy: undefined,
    aborted: undefined,
    unknown: "other",
  };
  const kind = kinds[f.kind];
  if (kind === undefined) return undefined;
  return { kind, ...(f.retryAfterSec !== undefined ? { retryAfterSec: f.retryAfterSec } : {}) };
}

/** True when the Harness should be left to retry the original text itself (busy, queue full, timeout, unknown: I39 allows a retry). */
export function harnessMayRetry(failure: ProxyFailure): boolean {
  return failure.retry.attempts > 0;
}

const CONNECTION_PATTERNS = [/ECONNREFUSED/i, /ECONNRESET/i, /EHOSTUNREACH/i, /ENETUNREACH/i, /connection error/i, /fetch failed/i, /socket hang up/i, /connect ECONN/i, /network error/i];
const TIMEOUT_PATTERNS = [/ETIMEDOUT/i, /timed out/i, /timeout/i, /UND_ERR_(HEADERS|BODY)_TIMEOUT/i];

/**
 * Classify the text the Pi provider puts in `errorMessage` (or a thrown `Error.message`): a leading or parenthesised HTTP status, a
 * documented code anywhere in it, or a connection failure. The text is only read, never copied into the result.
 */
export function classifyProxyMessage(text: string | undefined, opts: { aborted?: boolean } = {}): ProxyFailure {
  if (opts.aborted === true) return failureOf("aborted");
  const t = text ?? "";
  const marked = MARKER_PATTERN.exec(t)?.[1];
  if (marked !== undefined && Object.prototype.hasOwnProperty.call(TABLE, marked)) return failureOf(marked as ProxyErrorKind);
  const code = findKnownCode(t);
  const status = statusFromText(t);
  if (code !== undefined || status !== undefined) {
    // "stream timeout" from the Harness' own stream guard is not a proxy status; a leading status or a known code decides.
    const ra = retryAfterFromText(t);
    return failureOf(kindOf(status, code), { ...(status !== undefined ? { status } : {}), ...(code !== undefined ? { code } : {}), ...(ra !== undefined ? { retryAfterSec: ra } : {}) });
  }
  if (CONNECTION_PATTERNS.some((re) => re.test(t))) return failureOf("down");
  if (TIMEOUT_PATTERNS.some((re) => re.test(t))) return failureOf("timeout");
  return failureOf("unknown");
}

/** A `Retry-After` the SDK put into the text (`retry-after: 12`, `"retry_after": 12`); the header itself never reaches us. */
function retryAfterFromText(text: string): number | undefined {
  const m = /retry[-_ ]after["']?\s*[:=]\s*"?(\d{1,4})\b/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

function statusFromText(text: string): number | undefined {
  const m = /^\s*(?:HTTP\s*)?(\d{3})(?=[\s:]|$)/i.exec(text) ?? /\((\d{3})\)/.exec(text) ?? /\bstatus(?: code)?[:= ]+(\d{3})\b/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 400 && n <= 599 ? n : undefined;
}

/** Classify something thrown by `fetch` or a provider call. An `AbortError` caused by our own timeout is `timeout`; by the caller, `aborted`. */
export function classifyThrown(e: unknown, opts: { callerAborted?: boolean; timedOut?: boolean } = {}): ProxyFailure {
  if (opts.callerAborted === true) return failureOf("aborted");
  if (opts.timedOut === true) return failureOf("timeout");
  if (e instanceof ProxyError) return e.failure;
  const err = e as { name?: unknown; message?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  if (err && err.name === "AbortError") return failureOf("aborted");
  const bits = [err?.code, err?.cause?.code, err?.message, err?.cause?.message].filter((x): x is string => typeof x === "string").join(" ");
  return classifyProxyMessage(bits);
}

/** An error that carries its classification. The message is the fixed sentence, never a response body. */
export class ProxyError extends Error {
  readonly failure: ProxyFailure;
  constructor(failure: ProxyFailure) {
    super(failure.message);
    this.name = "ProxyError";
    this.failure = failure;
  }
}
