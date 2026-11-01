# Milestone 2 security review (S36)

Scope: everything under `src/web/`, `ui/web/`, `ui/common/`, `deploy/web/`, the ACL script rows, and the proxy changes in `src/proxy/`. Method: a read-through of each module against the threat table T1 to T14 and invariants I47 to I57, then the red-team suite (`test/web/redteam.test.ts`) against a fake tailnet. Reviewer: the implementing agent (self-review; the plan asks for a pass over the diff, not an independent audit). An independent look at the items marked REVIEW is recommended before the tailnet step (L2).

Severity key: HIGH = remote access to another user's data or host power; MEDIUM = needs another weakness or a local foothold; LOW = hardening.

## Findings, all fixed in this milestone

| # | Severity | Finding | Fix | Test |
|---|---|---|---|---|
| F1 | HIGH | A session was not bound to the Tailscale identity: a stolen cookie replayed from another tailnet device (or from the PC itself, by a non-owner) would have been accepted. Plan section 6 layer 3 requires the binding. | The gateway rejects a session whose login differs from the verified identity, and a non-owner session on a local identity; audited as `identity_rejected`. | T4 |
| F2 | MEDIUM | A reloaded page could not recover its CSRF token (the cookie is HttpOnly) except through a POST that itself needed the token. | `GET /api/me` (read-only, same-origin, no CORS) returns the token for the cookie's session. A state change still needs the header. | auth, ui |
| F3 | MEDIUM | The Telegram kill switch did not reach the web sessions (separate process). | `watchKillSwitch` ends all sessions when the flag file appears and the API answers 503 while it exists; `web-lockdown` CLI and an owner route do the same. | gateway, redteam |
| F4 | MEDIUM | `server.requestTimeout` is off (SSE needs long responses), so a slow-dripping POST body could hold a connection. | Per-body deadline of 15 s (408). Headers timeout 15 s stays. | gateway |
| F5 | LOW | The UI used `append(null)` in one place, which a real browser renders as the text "null". | Fixed; the fake DOM now throws on a null child so it cannot come back. | ui |
| F6 | LOW | Static fallback served `index.html` for any extension-less path. | Intended for client routes (`/claim`, `/invite`); no file is ever read from a request path (fixed asset map). | ui |

## Residual risks (accepted, written down)

| # | Severity | Risk | Why accepted | Follow-up |
|---|---|---|---|---|
| R1 | MEDIUM (REVIEW) | The WebAuthn verifier is hand-written (`webauthn.ts`, ES256, attestation none, user verification required, single-use challenges, counter check) instead of `@simplewebauthn/server`. It is the most security-sensitive new code. | UI-34 asked for a dependency; I57 and the "no installs" rule favour none. It is covered by a software-authenticator suite (rpId, origin, flags, counter, replay, wrong ceremony, wrong algorithm, forged signature) and passkeys are optional: password + TOTP is the baseline. | The owner decides: keep, or swap in the library. Do not rely on passkeys alone until someone has read `webauthn.ts`. |
| R2 | MEDIUM | T13: the gateway runs as the agent Windows user. A bug in it has that user's rights. | UI-36 (one Windows user). Mitigated: user bots have no host tools by construction, files are confined by `UserFs`, secrets are never loaded into user contexts, the stores are ACL-checked. | A separate Windows user is possible later. |
| R3 | LOW | T3: another process on the PC can imitate the whole serve header shape. | Same as any local malware; the app login is still required. | none |
| R4 | LOW | Lockout keys for the PC are shared (`client:local`), so a local process can lock the owner's local login (a denial, not an access). | Local foothold needed. | none |
| R5 | LOW | There is no global cap on open SSE streams, only 3 per user. | Tailnet users are invited people. | add a global cap if the user count grows |
| R6 | LOW | The web chat engine is not the Pi Harness, so a web turn is not durable across a gateway restart. | The thread is stored; the client re-asks. | none |
| R8 | MEDIUM | I51 across processes: the gateway is its own process and calls the model endpoints directly, so the local gate (`src/gate`, owner P0 over everything) does not see web turns. The web scheduler gives web turns ONE model slot and orders owner, peer, web and background inside the web process only. Worst case an owner Telegram turn waits behind one running web turn (non-preemptive) plus the runner's own FIFO. | Keeping the gateway out of the owner's runtime was the isolation goal. G6 item (9) measures it live. | If it matters: have the gateway take a gate lease from the agent over the IPC, or run the web chat inside the agent process. |
| R7 | LOW | Clock skew is read from the HTTP `Date` of Tailscale's control server (one HEAD request, tailnet mode only). | A failed request refuses the start (fail closed). | none |

## Checked and fine

- Invariants: I47 (user from the session only; ids from the client are looked up in the session user's own folders), I48 (loopback bind, serve status check), I49 (identity matrix), I50 (registry enumeration; the module imports no host code), I51 (scheduler), I52 (everything under `users\<id>\`, delete removes the tree), I53 (hashes, scrypt, AES-GCM; nothing readable in the stores), I54 (audit refuses body-like fields; a disk test), I55 (corrupt store or missing input stops the start), I56 (step-up on invite, caps, disable, delete, passkey add, recovery, export, lockdown), I57 (no framework, no innerHTML; the only new dependency is none).
- Injection into paths: user and bot ids are fixed patterns; thread ids are 24 hex; `UserFs` refuses `..`, drives, UNC, ADS, reserved names, trailing dots, wildcards, and resolves the deepest existing ancestor with `realpath` (junction test).
- No route returns a credential, a session id hash, a TOTP secret or an invite hash after creation; secrets appear once (invite code, recovery codes, TOTP key at enrolment).
- Error answers are fixed sentences; a 500 carries no stack or path.
- The proxy side: a Claude preset is refused when the proxy reports an API-key login (no request is made); a missing `auth_method` is only a warning.
