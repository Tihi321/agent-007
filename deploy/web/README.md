# agent-007 web gateway (Milestone 2): what you run, in order

Nothing here is run for you. Every step marked [GO] changes your machine and is yours to run. The gateway has two modes:

- **local (L1)**: loopback only, no Tailscale. You use it in a browser on this PC. Start here.
- **tailnet (L2)**: other people on your tailnet reach it through `tailscale serve` (HTTPS, tailnet only, never Funnel).

Port 47009 is the gateway. The settings UI (47008) and the job runner (47007) are never exposed.

## 0. Before anything (once)

1. Build: `npm run build` (the UI is copied to `dist\ui\web`).
2. [GO] ACL for the new folders. As an administrator, run `deploy\grant-folder-acls.ps1` (it now also gives `<data>\web-audit` the create-files + append-only grant), then `deploy\check-acl.ps1` (it lists `web-audit` and the `web\` files and fails if a broad group can read them).
3. For the Claude brain (U67 to U70): in the proxy app log in with the **Claude subscription** (not Console, no API key), then tick the Claude acknowledgment in the settings UI (Terms form) and add the `claude-sonnet` and `claude-opus` presets from the templates shown in the Models form.

## L1: the local web UI (loopback only)

1. [GO] Start the gateway as the agent user: `npm run web -- --mode local` (or `node dist\src\web\main.js --mode local`). It prints the port and says whether an owner exists.
2. On this PC, in a terminal: `npm run web-owner-code -- --data-dir <agent data folder>`. It prints a one-time code valid for 10 minutes.
3. In a browser on this PC open `http://localhost:47009/claim`, enter the code, give your Tailscale login (an email address), a display name and a password (12+ characters), add the key it shows to an authenticator app, type the 6-digit code. **Save the 10 recovery codes** shown once.
4. Create a bot: pick **Claude Sonnet** (default) or **Opus** and a **local fallback** (Strata). Chat. Reload: the history is still there.
5. Stop the proxy and send a message: the bot answers from Strata once and says so.
6. Lost the authenticator or passkey? On the PC: `npm run web-owner-code -- --data-dir <dir> --reset`, then claim again (this replaces the owner's sign-in methods and ends every session).

Passkeys: they work at `http://localhost:47009` (not at `127.0.0.1`, an IP address cannot be a passkey site) and later at the ts.net name. A passkey made at one address does not work at the other; password + authenticator works at both.

## L2: Tailscale (only after L1 passes)

1. Install Tailscale (1.60 or newer) and sign in; in the admin console turn on **MagicDNS** and **HTTPS certificates**.
2. Run `powershell deploy\web\tailscale-serve.ps1` (a dry run: it only prints the ACL snippet and the exact command). Paste the ACL snippet into the admin console (Access controls), edit the member list, tag this PC `tag:agent007-host`. Keep node sharing to other tailnets off.
3. [GO] Start the gateway in tailnet mode: `npm run web -- --mode tailnet --public-host <name>.<tailnet>.ts.net`. It refuses to start if the serve status shows a Funnel entry or a target other than 47009, if the Tailscale CLI is missing or too old, or if the clock is off.
4. [GO] `powershell deploy\web\tailscale-serve.ps1 -Apply` publishes the gateway. `... -Remove -Apply` takes it down. Check with `tailscale serve status`: it must list only port 47009 and no Funnel.
5. Sign in at `https://<name>.<tailnet>.ts.net` from your phone (add a passkey in Account if you like).
6. Invite someone: Admin, "Invite someone", enter their Tailscale login. Send the one-time code yourself (it is shown once, works once, 24 hours). They open the address from their own tailnet device, enter it, and set up a password + authenticator or a passkey.
7. Revoke: Admin, "Disable" ends their sessions at once and keeps their data for 30 days, then deletes it. "Delete" (typed confirmation) removes it now.

## What a user can and cannot do

Users get their own bots, chats and files under `<data>\users\<id>\`. Their bots have only: `tool_search`, `ask_user`, `read_file`, `list_dir`, `search_files`, `write_file` (own workspace, asks first), `remember` (own memory). There is no shell, no jobs, no Flow, no other bots, no MCP, no web access, no way to reach another user's or your files. The default for a new user is local models only (Strata); a Claude model is only available to a user whose cap you set.

You cannot read anyone's chats. The audit (Admin, owner only) holds ids, lengths and hashes.

## Kill switch and lockdown

- The Telegram `/killswitch` flag also ends every web session and makes the API answer 503 while the flag file exists (delete it locally to re-enable).
- `npm run web-lockdown -- --data-dir <dir>` ends every web session without the flag.
- Stopping the gateway or running `tailscale-serve.ps1 -Remove -Apply` takes the web access away.

## Files this adds

`<data>\web\` (users.json, invites.json, credentials.json, sessions.json, claim.json, lockout.json, web.key), `<data>\web-audit\` (append-only), `<data>\users\<id>\` (per user). `check-acl.ps1` verifies them. Back up `web\` and `users\` with the rest of the data folder; `web.key` is needed to read the stored authenticator secrets.

## Known limits

- The gateway runs as the agent Windows user (a bug in it has that user's rights, not yours). The review (security-review.md) lists what was done about it.
- Another process on this PC can imitate the serve headers; it still needs a password + code or a passkey (accepted, T3).
- Passkeys use a small verifier written for this project (ES256, no attestation). Review it before relying on passkeys alone.
- The web chat uses the model endpoints directly instead of the Telegram agent's Harness, so a web turn is not durable across a gateway restart: the thread is kept, the unfinished answer is not.
