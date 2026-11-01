# Claude Sonnet comparison eval (MA4)

Status: HARNESS READY, REAL RUN NOT DONE (UNTESTED live). No gate depends on this file. The pass bar stays defined on Strata.

Offline evidence (`test/proxy-eval.test.ts`, fake proxy, no model call): `--proxy-port` target resolution, the proxy pre-check (refuses an `api_key` login, a missing key, an unlisted model), the multi-bot live path with the proxy as target, and the routing eval through the real Harness.

Real run (user steps U67 to U70 first: proxy logged in with the Claude subscription, terms acknowledged, key in the dev `secrets.json` as `proxyApiKey`). Each is a paid-subscription call, so run only on the user's go:

```
node dist/scripts/routing-eval/run.js --proxy-port <port> --model claude/sonnet --label claude-sonnet --results .claude/tickets/agent-007-milestone2/claude-sonnet-routing-results.md
node dist/scripts/multibot-eval/run.js --mode live --confirm-live --proxy-port <port> --model claude/sonnet --label claude-sonnet --results .claude/tickets/agent-007-milestone2/claude-sonnet-multibot-results.md
node dist/scripts/settings-eval/run.js --proxy-port <port> --model claude/sonnet --label claude-sonnet
```

The runner checks `/healthz` and `/v1/models` first and stops if `auth_method` is `api_key`.
