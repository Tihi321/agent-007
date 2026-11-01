# Phase 0 report (partial, paused by user)

Date 2026-10-31. Runner: Strata 127.0.0.1:8080, model qwen3.8-flash-next-iq3_s (n_ctx 131072), keyless.
Command: `npm run smoke:all -- --runner strata --model qwen3.8-flash-next-iq3_s`. Log: `.claude/temp/gate-smoke.txt`; health: `.claude/temp/gate-p03b.txt`.

## P0.3b
GET /health 200 (status ok, loaded true, max_context 131072); GET /v1/models 200 (model loaded). PASS.

## P0.4 smoke (7 of 7 PASS after the S4 harness fix)
- S1 PASS: sqlite reopen, -wal/-shm appeared.
- S2 PASS: PONG in 8239 ms.
- S3 PASS: tool ran once {a:1234,b:4321}, answer 5555 (12492 ms).
- S4 first run FAIL (harness only): fixed 180 s ceiling cut off a resumed run that was still streaming. Resume worked (no duplicate submit, fresh request).
- S4 re-run PASS (2026-11-01, stall-based wait 120 s / hard cap 30 min, Strata `qwen3.8-flash-next-iq3_s`): (a) one final answer, msFromKillToDone 61116 ms, longest stall 1029 ms, 60 progress steps; (b) slow_unsafe ran once with an interrupted result, slow_safe reran (longest stall 29284 ms = the tool's 30 s sleep). Log `.claude/temp/gate-smoke-s4.txt`, JSON `.claude/temp/smoke/S4.strata.json`.
- S5 PASS: hook waited 300 s, tool ran, turn completed.
- S6 PASS: 60K prompt answered (TTFT 111 ms); recommended stream.timeoutMs >= 120000.
- S7 PASS: completed 33409 ms after the in-script TCP forwarder (port 1299) came up.

## Not run (paused)
P0.5 bakeoff, S16.1 routing eval, G3 settings-eval. No contextWindow/maxTokens proposal yet.
