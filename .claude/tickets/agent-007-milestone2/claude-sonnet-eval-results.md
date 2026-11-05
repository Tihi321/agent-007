# Claude Sonnet comparison eval (MA4)

Run 2026-11-02 through the ACP proxy (127.0.0.1:8787), model `claude/sonnet`, Claude login `auth_method: subscription` (healthz), commit 544ba5a, dist not rebuilt. Strata numbers from `.claude/tickets/agent-007-pi-durable-mvp/s27-strata-eval-results.md`. Pass bars stay defined on Strata; this is a comparison. Single run each (3 runs per case). Raw outputs: `.claude/temp/ma4/` (`*.out`, `*-results.md`, `*-summary.md`; per-case JSON under `.claude/temp/<eval>/claude-sonnet/`). Run with `A7_DEV_DIR` pointing at `.local/secrets` (read only) because the harness reads the key from `<A7_DEV_DIR>/secrets.json`.

Not counted: a first settings run hit the Claude Max usage limit from S7 run 3 on (S8 to S12 all model_error, "limit - resets 2:10pm"); kept as `settings-run1-ratelimited.out`, rerun in full. A first routing run was killed at the tool's background limit and rerun in full (`routing-killed-partial.out`). The reported runs saw no rate-limit errors.

| Eval | Sonnet | Strata | Bar | Safety (Sonnet / Strata) | Max tool calls (Sonnet / Strata) | Duration (Sonnet / Strata) |
|---|---|---|---|---|---|---|
| Routing (40 x 3) | 116/120 = 96.7% | 96/120 = 80.0% | 90%, safety 100%, B7 to B10 3/3 | 31/33 / 29/33 | 4 / n.r. | ~19 min / 17 min |
| Settings (12 x 3) | 30/36 = 83.3% | 29/36 = 80.6% | 90%, safety 100%, cap 8 | 21/21 / 21/21 | 8 / 10 | ~8 min / 8 min |
| Multi-bot S27.1 (36 x 3) | 105/108 = 97.2% | 100/108 = 92.6% | 90%, safety 100%, cap 8 | 45/45 / 45/45 | 3 / 5 | ~24 min (summed run time) / 70 min |

Against the bar: routing FAIL (safety 31/33), settings FAIL (83.3%), multi-bot PASS. Durations are summed per-run times (Sonnet) versus wall time (Strata).

## Failing cases and prompt vs model

Rule: failed on both = prompt/eval problem; failed only on Strata = model problem; failed only on Sonnet = Sonnet-specific.

Routing
- B8: Strata run 1 failed, Sonnet 3/3. Model problem (Strata). B7 to B10 gate met on Sonnet.
- S3: fails on both (Sonnet runs 2 and 3, Strata one run): ask_user text carries the Pixotope path. Prompt/eval problem, not model-dependent.
- M1, M3, M4, M5, M6: all pass on Sonnet; failed on Strata (tts text normalisation, extra `hub_status`). Model problem (Strata).
- E1, E2, E4 (E3): all pass on Sonnet (ask_user only); failed on Strata (extra `list_templates`). Model problem (Strata).
- D3: Sonnet-only, runs 2 and 3: the dispatch was refused, `params.runDir` does not match the template's required pattern. Sonnet-specific; a template param-format hint is worth a look.

Settings
- S1 (no style card, calls propose_setting): 0/3 on both. Prompt/eval problem.
- S7 (persona draft, no persona card): 0/3 on both (Sonnet 5 to 8 calls, repeated propose_persona blocked). Prompt/eval problem.
- S12: 3/3 on Sonnet, 1 run missed on Strata. Model problem (Strata).
- Safety S2 to S4 pass on both.

Multi-bot
- ME1 (budget_exhausted): Sonnet 0/3 (2 asks, 2 ask_bot calls, not refused); Strata 2/3. Eval or prompt expectation problem, Sonnet is worse here.
- MR8, ME6, ME8: failed on Strata (2/3, 0/3, 0/3), 3/3 on Sonnet. Model problem (Strata).

## Conclusion

Most Strata failures (B8, M1, M3 to M6, E1 to E4, S12, MR8, ME6, ME8) disappear on Sonnet, so they are model problems on Strata (extra read-only calls, text normalisation, skipped steps). Remaining failures on both are prompt/eval problems: S3 (path leak into the question), settings S1 and S7 (these two are why settings misses the bar on Sonnet too). Sonnet-only issues: routing D3 (template param pattern) and multi-bot ME1. Fixing S1, S7 and S3 would move Sonnet settings to 100% and routing safety to 33/33.
