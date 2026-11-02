# Changelog: agent-007-web-ui-redesign

## 2026-11-02 — web UI redesign (WR1 to WR8)

Outcome: the web UI in `ui/web` and `ui/common` now has a three-pane layout: a sidebar of bots, the centre chat and a details pane. Bots have pure-CSS shape avatars, buttons are neutral black/white pills, and the theme follows the system. Markdown gains code blocks with a language label and Copy, tables and hr, and a dropped stream resumes. There is no backend change. Nothing has been checked in a browser yet.

### Repository `agent-007` — branch `agent-007-web-ui-redesign` (base master 5f0be1c)
- `ui/common/tokens.css`: new neutral light/dark values; existing token names kept; new tokens for sidebar, selected, inverse, radii, shadow, spacing, font sizes, `--dur` and the avatar colours. Reduced motion sets `--dur: 0`.
- `ui/common/dom.js`: new `icon(name, label)` helper (a CSS-mask span, plus sr-only text when given a label).
- `ui/web/i-*.svg` (12 new files): own-drawn stroke icons, used only as CSS masks.
- `ui/web/app.css`: rewritten. It covers base components (pills, search, banners, skeleton, empty states, popover, sheet, typing dots, sysline), the 8 avatar looks in 3 sizes, the shell grid with breakpoints at 1100 and 900 px and `100dvh`, the sidebar, chat, composer, details, gallery, editor, Markdown code/table/hr, and the auth card and page wrappers. 21 KB.
- `ui/web/app.js`: builds the shell (`aside.sidebar` "Bots", `main#main`, `aside.details`). The router sets the shell mode and the current bot. The user menu replaces the top nav. New `ctx.refreshBots`, `openDetails`, `closeDetails`, `detailsOpen` and `logout`. Ctrl/Cmd+K focuses search. An offline banner appears on a status-0 answer, with auto-retry and a Retry button. `onDocument` returns an unregister function.
- `ui/web/sidebar.js` (new): bot rows (avatar, name, time, last preview) with `aria-current`, client-side bot filtering and debounced chat search, a mobile favourites row, skeletons after 150 ms, empty states and `dispose()`.
- `ui/web/time.js` (new): `shortTime(ms, now)`.
- `ui/web/chat.js`: rebuilt.
  - The header has back, avatar, h1, model badge and a Details toggle.
  - The log has bubbles, day separators, syslines and tool chips, with Copy and Regenerate on bot messages.
  - While streaming, typing dots show until the first delta. After that the Markdown is re-rendered at most every 100 ms (plain text past 20k characters), with `aria-busy` on the live bubble and autoscroll only near the bottom.
  - The approval card collapses to a sysline once decided.
  - The pill composer has Send and Stop, and the textarea grows by its `rows` attribute.
  - A dropped stream resumes from the last event id (1/2/4 s), then shows "Connection lost" with Retry.
  - The thread list and the usage meter moved to the details pane.
- `ui/web/details.js` (new): the details pane with bot facts, usage meter, the bot's chats, a More menu (Pin/Unpin, Rename, Export, Delete), starters and Edit.
- `ui/web/bots.js`: gallery cards with a New bot tile and an empty state. The editor is in sections with an 8-radio avatar look picker and a live preview. Avatar labels are now look names ("Violet circle"). Avatar ids, field names and the save body are unchanged.
- `ui/web/markdown-parse.js` and `ui/web/markdown.js`:
  - Fence language is reduced to letters and digits.
  - Fences open only when the line has no further backtick, and an unclosed fence renders as code.
  - GFM tables have inline cells under the same link rules, plus `hr`.
  - Code blocks get a header with the language label and Copy, and tables sit in a scrolling wrap.
- `ui/web/auth.js`, `account.js`, `admin.js`, `models.js`: class and wrapper changes only, plus a decorative `/icon.svg` image on the auth card. No string or logic changes.
- `test/web/ui.test.ts`:
  - The static test now also requires that every CSS `url()` is same-origin (WA1).
  - The budget is raised to 160 KB (WA2).
  - The safe-Markdown test is extended (WA3).
  - The journey test picks an avatar radio and asserts the sidebar preview (WA4).
  - New stream-resume test (WA5) and new `shortTime` table test (WA6).

### Deviations
- WR4 was committed before WR3, because `chat.js` imports `details.js`.
- Light `--muted` is #64646b, not #6b6b72, for contrast on `--selected`. `--focus` is the accent blue.
- Escape stops a run at once, with no confirm on mobile.
- Thread rows in the details pane use `aria-current="true"`.
- The budget was raised in WR5, the first commit where the UI total passed 130 KB.
- The picker radios also have id/for pairs, as the a11y check requires.
- No README change: the README has no web UI layout section.
- Plan, research and changelog files are committed in the ticket folder, as for the earlier tickets.

### Verification
- `corepack yarn install --immutable`, then `corepack yarn build`: ok.
- `node --test "dist/test/**/*.test.js"`, final run on cde9047: 1597 pass, 0 fail, 1 skipped.
  - An earlier run of the same tree failed redteam T8 (the known flake) and the safe-Markdown test. Both pass alone, and the safe-Markdown failure was the 2 s timing check (see the limitations below).
- UI size: 136,515 bytes in total (budget 160 KB). The largest file is `models.js` at 22,536 bytes (limit 30 KB).
- Reviews:
  - `/code-review` (medium): 10 findings. 6 are fixed in WR8. 4 are kept as plan decisions and listed in plan.md Results.
  - `/security-review`: no findings.
- NOT RUN: any browser check. The WU1 to WU12 manual checklist is in plan.md §10. No gateway was started.

### Follow-ups and known limitations
- The safe-Markdown timing check (under 2 s) can fail under full-suite load. This is pre-existing: the emphasis/link pathological input `*[\`` × 20,000 takes about 0.7 to 0.85 s alone, both on master and here, and grows quadratically. The new table input is linear (about 11 ms).
- Kept by design: avatar labels are read next to the bot name; the Markdown is fully re-rendered every 100 ms while streaming; after "Connection lost", Send is enabled again; `api.stream` does not trigger the offline banner.

### Commit status
Committed on `agent-007-web-ui-redesign` (WR1 187ae41, WR2 a5ba440, WR6 fd9e6dc, WR4 711d1f2, WR3 9ba12d3, WR5 fa07cc8, WR7 23500a5, WR8 cde9047, plus this changelog). Not pushed and not merged.
