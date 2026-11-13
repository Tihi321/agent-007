# Discoveries: REQ-0016

Source: director-researcher, 2026-11-11. Not acted on; awaiting the user.

- 2026-11-11 director-researcher: TIMER_TOOLS are not in TAINT_BLOCKED_TOOLS (src/botbus/capabilities.ts:23) - suggested: add them to the blocked list as part of AC3 (planner to cover)
- 2026-11-11 director-researcher: taint tracking is wired only for multi-bot installs, a one-bot install has no taint tracking (src/agent/multibot.ts:410) - suggested: decide whether one-bot installs need it before AC3 holds
- 2026-11-11 director-researcher: unverified whether the Pi adapter exposes now/setTimer/onWake/sleepUntil types (src/pi/adapter.ts) - suggested: check the adapter before the plan relies on them
- 2026-11-11 planner: watchOwnerNotices is started only in src/agent/multibot.ts:592, so web lockout notices may never reach Telegram on one-bot installs; not checked whether this is intended.
