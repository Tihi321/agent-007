# Web UI redesign: Grok-Bot-style layout, MVP-ready

Status: APPROVED 2026-11-02 with the answers in §11 (WQ1 to WQ8 all answered: defaults accepted; WQ6 = live check on the redesigned UI). WR1, WR2, WR3, WR4 and WR6 done; WR5, WR7 and WR8 not started. Repo `C:\projects\Personal\agent-007`, base `master` 5f0be1c. Proposed branch: `agent-007-web-ui-redesign` (WQ8).
Research: `research.md` (this folder) has the sources and the design spec read off the Grok Bot screenshots.
Parent plans:
- `.claude/tickets/agent-007-milestone2/plan.md`: S35 UI, I47 to I58, §7 Web UI, §15 Live order.
- `.claude/tickets/agent-007-model-sources/plan.md`: MS5 Models page, I59 to I62.

New IDs use these prefixes: **WR** tasks, **WA** acceptance criteria, **WK** risks, **WU** user steps, **WQ** open questions, and **I63** for the one new invariant.

User request (2026-11-02, word for word): "add next before telegram and tailscale in agenta, after this in plan, check on internet how does https://www.vellum.ai/blog/official-grok-bot-breakdown gropbot looks like and copy over it0s design, so it is mvp ready as well".

## 0. Scope (one line)

**Full reading** (chosen): restyle and rebuild every screen of the web UI in `ui/web` and `ui/common` after the Grok Bot app layout, and close the MVP gaps (states, mobile, a11y, streaming, markdown). The layout is:
- a sidebar of bots, each with its last message and time;
- a centre chat with bubbles and a pill composer;
- a details pane for the selected bot;
- an avatar for each bot drawn as a shape and a colour with two eyes;
- a favourites row on mobile.

The narrow reading (a CSS re-skin only) was not chosen, because "MVP ready" needs behaviour changes such as stream resume, stop/regenerate placement, empty and error states, and the mobile flow.

This is the next step after the Models page (MS1 to MS6). It comes before L2 Tailscale and L3 Telegram; see M2 plan §15.

## 1. Decisions

### 1a. Fixed by the request or by existing invariants
- **D1** Copy the layout and patterns, not the brand. No xAI or Grok name, logo, mark, avatar artwork or image. Our name stays "agent-007" with our own `icon.svg`.
- **D2** I57 and I25a stay:
  - no framework and no dependency;
  - strict CSP and no `innerHTML`;
  - no inline style and no browser storage.
  
  Every new view is built with `h()` from `ui/common/dom.js`. This plan does **not** ask to relax I57.
- **D3** The CSP stays as it is: `default-src 'none'; style-src 'self'; img-src 'self'`, with no `font-src`. This means:
  - **no web font**, so we keep the system stack;
  - no `data:` images;
  - icons are **same-origin SVG files** used through CSS `mask-image: url("/i-*.svg")`, so they take `currentColor`;
  - avatars are pure CSS shapes (`border-radius` and `clip-path`, with `::before`/`::after` for the eyes).
- **D4** No backend API change is needed. Everything below uses existing routes (§4). Three optional backend additions are listed as open questions WQ2, WQ3 and WQ7. They are not in scope unless the user says yes.
- **D5** The theme follows the system (`prefers-color-scheme`). A manual toggle cannot be remembered, because browser storage is banned by the static test, and server prefs would be a backend change (WQ3).

### 1b. Defaults chosen by this plan (the user can override each; see §11)
- **D6** Sidebar rows are **bots**, as in Grok. Each row shows the time and preview of that bot's newest thread. A bot's threads (history, search, pin, rename, export, delete) live in its **details pane** (WQ1).
- **D7** Avatars: the 8 existing avatar ids map to 8 shape and colour pairs. The labels change to describe the look (for example "Violet circle"). The ids stay the same, so stored bots need no migration (WQ2).

  | id | shape | colour |
  |---|---|---|
  | robot | rounded square | indigo |
  | fox | droplet | orange |
  | owl | circle | violet |
  | cat | triangle | pink |
  | planet | circle | sky |
  | leaf | cloud/blob | green |
  | bolt | pill | red |
  | book | rounded square | teal |
- **D8** The palette is neutral. In light mode the primary action is an inverse pill (black on white), and in dark mode it is white on near-black. Blue is used only for links, focus, the selected state and badges (WQ4).
- **D9** The size budget rises from 130 KB to **160 KB** in total. The per-file limit stays at 30 KB (WQ5).

## 2. Out of scope
- **Backend:** no new or changed routes, schemas, stores or SSE events (see D4 for the optional exceptions).
- **Features Grok has and we do not:**
  - voice and dictation;
  - file attachments and uploads (the composer "+" is not shown);
  - `@`-mentions of other bots, and group chats;
  - a cloud computer screen;
  - plugins, the vault, routines and schedules;
  - share links and a keyboard-shortcut sheet beyond a small help popover.
- **UI work we are not doing:**
  - unread state, which needs per-thread read marks on the server;
  - a manual theme toggle (D5);
  - a web font;
  - syntax highlighting in code blocks (they stay monochrome, with a language label);
  - images in Markdown, which stay blocked as in S35.
- **Other parts of the repo:**
  - the settings UI in `ui/settings/` (owner loopback). It has its own CSS and does not load `ui/common/tokens.css`;
  - Telegram, Tailscale and anything else under `deploy\`.

## 3. Design spec mapped to our screens

### 3.1 Tokens (`ui/common/tokens.css`)
Keep the existing token **names**, because every web view uses them, and change their values. `ui/settings` has its own `app.css` and does not load `tokens.css`, so it is unaffected. Add these new tokens:

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #ffffff | #0b0b0c | page, centre chat |
| `--panel` | #ffffff | #161617 | cards, panes |
| `--panel-2` | #f4f4f5 | #1f1f21 | bot bubble, search field, hovered row |
| `--sidebar` (new) | #f7f7f8 | #121213 | sidebar fill |
| `--selected` (new) | #ececee | #26262a | selected row |
| `--text` | #0d0d0d | #ececec | |
| `--muted` | #6b6b72 | #9a9aa2 | time, preview, meta (both pass 4.5:1 on their backgrounds; WR1 checks) |
| `--border` | #e6e6e8 | #2a2a2c | hairlines |
| `--accent` | #2563eb | #60a5fa | links, focus ring, badges |
| `--inverse` / `--inverse-text` (new) | #0d0d0d / #ffffff | #ececec / #0d0d0d | user bubble, primary pill, send button |
| `--warn` / `--warn-soft` | amber, kept | | status pill "Needs approval" |
| `--danger`, `--ok` | kept | | |
| `--radius` | 12px | | inputs, cards |
| `--radius-bubble` (new) | 18px | | bubbles |
| `--radius-pill` (new) | 999px | | buttons, composer, chips |
| `--shadow-float` (new) | 0 2px 12px rgb(0 0 0 / .08) | 0 2px 12px rgb(0 0 0 / .5) | composer, popovers |
| `--space-1..6` (new) | 4, 8, 12, 16, 24, 32 px | | |
| `--fs-xs/sm/md/lg/xl` (new) | 12, 13, 15, 17, 22 px | | meta, preview, body, header, h1 |
| `--dur` (new) | 160ms | | fades and the pane slide; 0 under reduced motion |
| `--avatar-*` (new) | indigo #6366f1, orange #f97316, violet #8b5cf6, pink #ec4899, sky #3b82f6, green #22c55e, red #ef4444, teal #14b8a6 | same | avatars (eyes are #fff at 90%) |

- Fonts: `--font` stays the system stack, with Inter- or SF-like metrics through `system-ui` (D3). Body text is 15 px with line-height 1.45.
- Touch targets stay at 44 px or more (S35 rule). The 40 px visible avatar sits inside a row that is 56 px or taller.

### 3.2 Layout (`ui/web/app.css`)
- **Desktop, 1100 px and wider**: a grid of `sidebar 280px | chat 1fr | details 320px`. The details pane is open by default and closes with its X or the header button; it then gives its width back to the chat.
- **Desktop, 900 to 1099 px**: `sidebar 260px | chat 1fr`. The details pane overlays from the right as a sheet.
- **Mobile, under 900 px**: one pane at a time, chosen by the route.
  - `#/bots` (home) shows the sidebar full width, with a favourites row on top. The favourites are the bots with a pinned thread, or else the most recent four.
  - `#/chat/...` shows the chat with a back button.
  - The details pane is a full-screen sheet.

  The shell gets a class `shell shell-list|shell-chat|shell-page` from the router; CSS hides the panes that do not apply.
- **Settings-type pages** (Account, Admin, Models, bot editor) render in the centre column with a max width of 760 px; the Models page keeps its own two-column grid. The sidebar stays visible on desktop.

### 3.3 Components (new or restyled CSS classes, each a plain `h()` structure)
- **Avatars**
  - `.avatar` with `.av-<id>` and a size class `.av-sm` (22 px), `.av-md` (40 px) or `.av-lg` (64 px).
  - It keeps `role="img"` and an `aria-label` with the look's name.
  - The eyes are two `::before`/`::after` dots. The shape comes from `border-radius` or `clip-path`.
  - The user avatar is `.av-user`: the initial of the display name on a `--panel-2` disc.
- **Bot list rows** (`.botrow`, inside `ul.botlist`)
  - Each row is a `<button>` (or an `<a href="#/chat/<id>">`) containing the avatar, `.botrow-name`, `.botrow-time` and `.botrow-preview`. The preview is one line with an ellipsis.
  - The selected row gets `.is-current` and `aria-current="page"`.
  - Rows are 60 px tall with a 10 px radius on the selected fill.
- **Search** (`.search`): a filled field with no border, a magnifier icon mask, and the label "Search" (aria-label).
  - While you type it filters the bot rows by name and tagline on the client.
  - At 2 or more characters it also lists matching **chats** below a "Chats" subheading, through `/api/chat/thread/search`, with debounce.
  - Ctrl+K (Cmd+K) focuses it.
- **Chat header** (`.chathead`)
  - On mobile, a back icon button.
  - The small avatar, the bot name as the screen's h1, and the model badge as a muted pill.
  - A details toggle (an icon button with the sr-only text "Details").
- **Messages**
  - The log is `role="log"`, `aria-live="polite"`. Inside it, `.msg.msg-user` is a right-aligned inverse bubble and `.msg.msg-assistant` is a left-aligned `--panel-2` bubble. The maximum width is 72ch (100% on mobile).
  - A centred `.daysep` shows the time ("9:41 AM", "Yesterday 7:34 PM") when the gap between two messages is more than 30 minutes.
  - Notices are centred `.sysline` lines ("Stopped.", "Switched to the local fallback").
  - Hovering, or focusing within, the last bot message shows `.msg-actions`:
    - Copy, for every bot message;
    - Regenerate, on the last one only.
- **Streaming**
  - The live bubble shows a `.typing` indicator (three dots, CSS animation, static under reduced motion) until the first delta.
  - After that it shows the progressive Markdown render.
  - It has `aria-busy="true"` while running.
  - The status line above the composer gives "Waiting for the model…" and notices.
- **Tool chips**: a compact `.toolrow` under the bubble. It shows an icon plus "name: status", with colours by status, and uses the existing statuses.
- **Approval card**
  - `.card.actioncard` with the title "Approval needed" and a status pill `.pill-warn` that reads "Waiting for you".
  - It shows the summary, then the pill buttons **Approve** (primary inverse), **Deny** (secondary) and **Why** (ghost). The Why text expands below.
  - After a decision, the card collapses to a `.sysline` ("Approved.", "Denied.").
- **Composer** (`form.composer`; the class name stays exactly `composer` for the journey test)
  - A floating pill with `--shadow-float`.
  - The textarea grows from 1 to 8 rows: JS sets the `rows` attribute, not a style.
  - A round inverse button at the right:
    - "Send" (arrow icon, sr-only text "Send"), disabled while empty;
    - "Stop" (square icon) while running.

    These are **two** buttons, and one is hidden at a time, so the Stop button has the text content "Stop" as the test expects.
  - Enter sends and Shift+Enter adds a new line (existing). Escape while running stops (with a confirm on mobile).
  - The placeholder is "Message <bot name>".
- **Empty states** (`.empty`, with a large avatar or icon, one sentence and one action)
  - No bots: "Create your first bot" with a New bot button.
  - No chats with this bot: the bot's avatar, its tagline and the starter chips.
  - No search results: "No bots or chats match".
  - Signed out: the auth card.
- **Loading**: skeleton rows (`.skel`, a shimmer that is static under reduced motion) in the bot list and the log while the first call is pending. Nothing shows for under 150 ms (a timer), so fast loads do not flash.
- **Errors**
  - `.banner-error` with a **Retry** button that runs the failed load again.
  - When the server cannot be reached (status 0): a sticky top banner "Cannot reach agent-007. Retrying…", with retry every 3 s, 5 s and 10 s, and a manual Retry.
  - A turn error stays as now: a red line inside the bubble, plus a Retry that calls regenerate.
- **Details pane** (`aside.details`, aria-label "Bot details"), top to bottom:
  - the large avatar, name, tagline, model badge, egress note and paid lines (existing data);
  - **Usage**: the `<progress>` meter and its text (they move here from under the composer and keep the text format "N/M messages, …");
  - **Chats**: a "New chat" pill and a list of this bot's threads (title, time, pin mark). Each row has a "More" menu button that opens a small popover with Pin/Unpin, Rename, Export and Delete (existing calls);
  - **Starters**, as chips;
  - **Edit bot**, as a secondary pill.
  
  The header has a Close (X) icon button. The popover and sheet trap focus lightly: focus moves in, Escape closes, and focus goes back to the opener.
- **Bot gallery** (`#/bots` on desktop with no chat open, and the mobile home below the list)
  - The h1 "Your bots", then a grid of `.botcard` items: a large avatar, the name, the tagline, the model badge and paid lines, a primary pill **Chat** and a secondary **Edit**.
  - The first card is a dashed "New bot" tile, plus the "New bot" button in the header.
  - The "+" in the sidebar header also goes to `#/bot/new`.
- **Bot editor** (Grok onboarding: name, then look, then role)
  - One form in sections with h2 headings:
    - "Name and look": a name field, the tagline, an **avatar picker** of 8 radio buttons styled as avatars (`name="avatar"`, each inside its `<label>`, so I57 and the a11y check pass), and a live preview (avatar plus name);
    - "Role": the persona and the starters;
    - "Model": the preset, the cloud fallback, the local fallback and the egress or paid note;
    - "Tools and memory".
  - A sticky footer holds Save, Cancel and (on edit) Delete.
  - The field names do not change.
- **User menu** (sidebar bottom: the user avatar, the display name, a chevron)
  - It opens a popover with Account, Admin (owner and admin), Models (owner) and Sign out.
  - The top nav bar goes away. The nav links stay real `<a>` elements with the same text, so the "navigation hidden when signed out" check still holds. On mobile the menu is in the home header (the user avatar at the left, as in Grok).
- **Auth screens** (sign-in, claim, invite, recovery codes)
  - A centred 400 px card on `--bg`, with our icon, an h1, the fields and a full-width primary pill.
  - The texts stay the same.
- **Account, Admin, Models**
  - Restyled through the tokens and the shared classes (cards, pills, tables, banners), with section headings.
  - JS changes are limited to class names and wrappers. Strings stay the same.

### 3.4 Markdown in chat (safe, no innerHTML)
Extend `markdown-parse.js` (a pure tree, as now) and `markdown.js` (the DOM builder, text nodes only):
- **Fenced code**:
  - a header row with the language label (from the fence info, letters and digits only, as text) and a **Copy** button that uses `navigator.clipboard.writeText` when present and is hidden otherwise;
  - `pre` scrolls on the x axis;
  - an **unclosed fence** while streaming renders as a code block that runs to the end.
- **GFM pipe tables** become `table`, `thead`, `tbody`, `th` and `td`. Cells are parsed inline, so links in cells follow the same rules. The table sits in `.table-wrap`, which scrolls.
- **`---`** becomes `hr`. Nested list items (two-space indent) render as one level. Tasks (`- [ ]`) render as plain text.
- **Unchanged:** no HTML pass-through; links only http, https and mailto, with `target=_blank rel="noopener noreferrer"`; images become `[image: alt]` text; parsing stays linear (the pathological-input check stays).
- **Streaming render**: the live bubble re-renders the Markdown tree from the full text at most every 100 ms (a timer), and once more at the end. The log's live region announces only finished messages. The live bubble is `aria-busy`, so screen readers do not read each delta.

## 4. API used (all existing; no change)
| Need | Route | Fields used |
|---|---|---|
| Session, user row | `GET /api/me` | `user.displayName`, `login`, `role` |
| Bots (sidebar, gallery) | `POST /api/bots/list` | `id, name, tagline, avatar, cloud, presetLabel, paid` |
| Last activity per bot | `POST /api/chat/threads` with **no** `bot` | `botId, updatedAt, preview, pinned, title, id` (all threads, sorted pinned and then newest). The sidebar takes the first thread per bot. |
| Bot's threads | `POST /api/chat/threads` with `{bot}` | the same |
| Search chats | `POST /api/chat/thread/search` | the same summary shape |
| Chat, stream, stop, regenerate, approval, usage | `/api/chat/thread/get`, `/api/chat/send`, `GET /api/chat/stream` (SSE, `Last-Event-ID`), `/api/chat/stop`, `/api/chat/regenerate`, `/api/chat/approval`, `/api/chat/usage` | as in `ui/web/chat.js` now |
| Thread actions | `/api/chat/thread/pin`, `rename`, `export`, `delete` | as now |
| Editor | `/api/bots/options`, `get`, `create`, `update`, `delete` | as now; `avatars` is the enum of 8 ids |
| Auth, account, admin, models | unchanged | unchanged |

- Sidebar refresh: after a send ends and after thread actions, the chat view calls `ctx.refreshBots()`, which runs the two list calls again. No polling.
- Stream resume: when `api.stream` returns `{ok:false}` while the thread is running, wait 1 s, 2 s and then 4 s (3 tries) and call `follow()` again with the last event id. It does not reset `last` to 0 on a failure; today's code always resets it. After 3 failures it shows "Connection lost" with Retry.

## 5. Files to touch
| File | Change |
|---|---|
| `ui/common/tokens.css` | new values and tokens (§3.1); base controls become pills |
| `ui/web/app.css` | rewritten: shell grid, sidebar, rows, chat, bubbles, composer, details, gallery, editor, avatars, states, skeleton, popover, sheet, mobile; split into `app.css` + `chat.css` if it goes over 30 KB, and add the link in `index.html` |
| `ui/web/index.html` | the extra stylesheet link, if split |
| `ui/web/i-*.svg` (new, flat; about 12 files of 200 to 400 bytes) | the icons: plus, search, send, stop, back, close, details, more, copy, retry, pin, chevron. Own simple strokes, `fill`/`stroke` black (they are used as masks) |
| `ui/web/icon.svg` | keep, or redraw as our own mark in the new style (an agent-007 shape with eyes) |
| `ui/web/app.js` | the shell (sidebar, centre, details slots), the route to a shell class, the user menu instead of the top nav, `ctx.refreshBots`, Ctrl+K, the offline banner |
| `ui/web/sidebar.js` (new) | bot list rows, search (bots and chats), favourites row, skeleton and empty states |
| `ui/web/chat.js` | header, log with separators and syslines, bubble actions, typing indicator, throttled live Markdown, composer pill with Send/Stop, stream resume, approval card restyle; the thread list moves out |
| `ui/web/details.js` (new) | the details pane (facts, usage, chats list with the More popover, starters, Edit) |
| `ui/web/bots.js` | gallery cards, editor sections, avatar picker radios with preview, avatar look labels (D7) |
| `ui/web/time.js` (new, pure) | `shortTime(ms, now)`: "7:34 PM", "Yesterday", "Tuesday" (within 6 days), "Aug 23" (this year), "Aug 23, 2025" |
| `ui/web/markdown-parse.js`, `ui/web/markdown.js` | §3.4 |
| `ui/web/auth.js`, `account.js`, `admin.js`, `models.js` | class names and wrappers only; no logic or string changes |
| `ui/common/dom.js` | maybe `icon(name, label)` → `h("span", {class: "icon i-<name>", "aria-hidden": "true"})` plus sr-only text; no other change |
| `test/web/fakeDom.ts` | only if a view needs something it lacks. Prefer `className` and `setAttribute` in views (the fake has no `classList` or `dataset`) |
| `test/web/ui.test.ts` | §8 |
| `src/web/runtime/userBots.ts` | **no change** (the avatar ids stay) |
| README or docs | one paragraph on the new web UI layout, only if a web UI section exists |

Nothing under `src/web` changes, except an optional item the user approves (WQ2, WQ3, WQ7).

## 6. Tasks
Order: WR1, then WR2 and WR6 in parallel, then WR3, WR4 and WR5 in parallel, then WR7, then WR8. Each task leaves `yarn build` and `yarn test` green. Commit one task per commit (subject `WRn: …`).

### WR1 Tokens, base components, icons, avatars
- **Status: DONE.** Evidence: `yarn build` ok; full run 1594 pass, 1 fail (redteam T8 flake; passes alone, with ui.test.js 22/22), 1 skipped. WA1 static test extended with the `url(` assertion. Contrast ratios are in the commit message.
- **Deviations:** (1) light `--muted` is #64646b, not #6b6b72, because #6b6b72 on `--selected` was 4.48:1; (2) `--focus` is now the accent blue (was amber); (3) added `icon(name,label)` to dom.js, and `avatarEl` in bots.js now adds `av-md av-<id>` so the current views show the new looks until WR5; (4) the old `.avatar` rule is gone, so letters inside avatars are hidden; (5) the 160 KB budget edit stays in WR8 as planned.
- **Inputs:** §3.1, §3.3 (avatars, pills, search, banners, skeleton, empty states, popover and sheet styles), `research.md`.
- **Outputs:**
  - `tokens.css` and the parts of `app.css` for base components;
  - `i-*.svg`;
  - the `.avatar .av-<id>` classes for the 8 ids in 3 sizes, plus `.av-user`;
  - `dom.js` `icon()`, if used.
- **Contracts:**
  - The existing token names still exist, because the views use them.
  - No `url()` other than `/i-*.svg`.
  - Contrast: `--text` and `--muted` against `--bg`, `--panel`, `--panel-2` and `--sidebar` is at least 4.5:1, and the inverse pair is at least 7:1. Write the computed ratios into the WR1 commit message.
  - `prefers-reduced-motion` sets `--dur: 0` and stops the shimmer and typing animations.
- **Done:** the static test passes.

### WR2 App shell, router, sidebar, user menu
- **Status: DONE.** Evidence: `yarn build` ok; full run 1597 tests, 1596 pass, 0 fail, 1 skipped (new: the WA6 `shortTime` table test; the journey test now asserts the sidebar row text has the name, "Hello **world**" and a time, and exactly one `aria-current=page`). UI total 114.8 KB, so the budget stays at 130 KB (WR8 still raises it). Not run in a browser: all CSS and layout are UNTESTED (WU checks).
- **Deviations:** (1) the chat view's own `aside.sidebar` was renamed `chat-side` (class clash with the shell sidebar); chat.js calls `ctx.refreshBots()` when a stream ends and bots.js after save and delete. (2) The sidebar row is an `<a href>` to the bot's newest thread (by `updatedAt`, not "first in the list", because pinned threads sort first). (3) The user-menu panel is hidden, not removed, so the Account/Admin/Models links and the Sign out button always exist in the DOM (the journey test finds them unchanged). (4) Added `env.onDocument(type, fn)` (browser entry: `document.addEventListener`) for Ctrl/Cmd+K and click-outside; tests omit it. (5) Offline banner: `api.call/get` are wrapped in app.js; auto-retry probes `/api/me` at 3 s, 5 s, then every 10 s, and the manual Retry also re-runs the route. (6) Added a mobile-only "Bots" back link above page-type screens; on mobile the user menu moves to the top of the home list. (7) `ctx.logout()` and `ctx.user` added.
- **Inputs:** §3.2, §3.3 (rows, search, user menu, favourites, offline banner), §4.
- **Outputs:**
  - `app.js` builds `div.shell` with `aside.sidebar` (aria-label "Bots"), `main#main` and `aside.details` slots;
  - `sidebar.js` exports `renderSidebar(ctx)`, which returns an element with an `update({currentBot})` method;
  - the router sets the shell class and the current bot;
  - `ctx.refreshBots()`;
  - `ctx.openDetails(el)` and `ctx.closeDetails()`.
- **Contracts:**
  - Signed out: no sidebar and no nav links, only the centred auth card.
  - The links "Account", "Admin" and "Models" are `<a>` with exactly those texts.
  - "Sign out" is a `<button>` with exactly that text.
  - At most one `h1` on the screen (the a11y check): the sidebar has none, and the centre view owns the h1.
  - Ctrl+K and Cmd+K focus the search.
  - The offline banner appears only on a status-0 answer, and clears on the next success.
- **Done:**
  - The journey test passes with the shell.
  - The sidebar shows the bot with its last preview and time after a chat.

### WR3 Chat view
- **Status: DONE.** Evidence: `yarn build` ok; full run 1598 tests, 1597 pass, 0 fail, 1 skipped (new: WA5 resume test; the journey test passes unchanged). UI total 127.8 KB, so the 130 KB budget stays (WR8 still raises it). UNTESTED (no browser): all CSS and layout, typing dots, the 100 ms live render timing in a real browser, Copy click, the approval card, Escape to stop, textarea growth, and the details toggle at the three breakpoints.
- **Deviations:** (1) Committed after WR4 (WR4 first) because chat.js imports details.js. (2) Escape while running stops at once, with no confirm on mobile. (3) Copy is created only when `navigator.clipboard.writeText` exists (same rule as the code blocks). (4) After a failed stream the view asks `/api/chat/thread/get`: if the run is over it shows the result, else it retries after 1 s, 2 s, 4 s (`ctx.resumeDelays` overrides the delays, for the test). (5) Regenerate also re-reads the thread, so the old answer is not shown beside the new one. (6) Details open by default only at 1100 px and wider (and when `matchMedia` is absent, as in tests). (7) New-chat empty state reads "Start a chat with <name>." plus tagline and starter chips. (8) Old chat CSS rules were removed from app.css and the new ones added there (no chat.css; app.css is 18 KB).
- **Inputs:** §3.3 (header, messages, streaming, tool chips, approval card, composer, empty, errors), §3.4 (streaming render), §4 (stream resume).
- **Outputs:** `chat.js` rebuilt. It uses `details.js` for the right pane (through `ctx.openDetails`).
- **Contracts:**
  - `form.composer` (the exact class name), `textarea[name=message]` and `role=log` with `aria-live=polite` keep the names the test uses.
  - Send and Stop are two buttons with those texts.
  - Finished bot messages render Markdown (`strong` for `**x**`).
  - The `<progress>` usage meter and its text exist in the DOM (in the details pane).
  - The stream resumes with the last event id and does not duplicate text, because the live text is rebuilt from deltas after `last`.
  - Leaving the view aborts the stream (the existing `dispose`).
- **Done:** the journey test passes, and one new resume test passes (§8).

### WR4 Details pane
- **Status: DONE** (committed before WR3, because chat.js imports details.js). Evidence: `yarn build` ok; full run 1598 tests, 1597 pass, 0 fail, 1 skipped. Pin, rename, export and delete from the pane, the More popover focus/Escape behaviour and the layout are UNTESTED (WU8, WU9).
- **Deviations:** (1) Thread rows are `<a href>` with `aria-current="true"` (not "page"), so the shell keeps exactly one `aria-current=page` (the sidebar row). (2) `renderDetails(ctx, bot, {botId, thread, onClose, onStarter})` returns `div.detailsbody` with `refresh()`, `setThread(id)`, `focusClose()`; the aside and its label are the shell's. (3) Escape anywhere in the pane (no menu open) closes the pane. (4) The click-outside close of the More menu listens on the pane only (no document listener, which would leak per chat). (5) The pane has no thread search (the sidebar searches chats). (6) app.js: `ctx.detailsOpen()` and an `el.afterMount()` hook in `ctx.mount` (mount closes the details, so a view opens its pane after it is mounted).
- **Inputs:** §3.3 (details pane), the existing thread calls.
- **Outputs:** `details.js` `renderDetails(ctx, bot, {thread})`.
- **Contracts:**
  - Every thread action keeps its current call and its confirm or prompt (`ctx.confirm`, `ctx.prompt`).
  - The More menu is a button with `aria-haspopup="menu"` and `aria-expanded`, and its items are buttons.
  - Escape closes it and focus goes back to the button.
- **Done:** pin, rename, export and delete work from the pane in a manual check (WU).

### WR5 Bot gallery and editor
- **Status: DONE.** Evidence: `yarn build` ok; full run 1598 tests, 1597 pass, 0 fail, 1 skipped; ui.test.js 9/9. The journey test now picks the "owl" radio (fires `change`), checks the radio sits in a label "Violet circle", and checks the saved bot shows the "Violet circle" avatar. UI total is now 134.6 KB, so the budget test was raised to 160 KB in this commit (D9; per-file stays 30 KB). UNTESTED (no browser): all layout and CSS, arrow-key movement in the radio group, the live preview, the sticky footer, the dashed tile.
- **Deviations:** (1) `avatarEl(name, size = "md")` no longer renders a letter inside the avatar (the CSS hid it anyway); aria-labels are the look names. (2) The picker radios have ids and `for` labels as well as sitting inside the label (the a11y check needs it); the saved avatar comes from a `look` variable set on `change`, not from a select. (3) The empty state keeps the sentence "No bots yet. Create one to start chatting." under the heading "Create your first bot", because the journey test asserts it. (4) Labels: robot Indigo square, fox Orange droplet, owl Violet circle, cat Pink triangle, planet Sky circle, leaf Green blob, bolt Red pill, book Teal square.
- **Inputs:** §3.3 (gallery, editor, avatars D7).
- **Outputs:** `bots.js` `renderBots` (gallery) and `renderBotEditor` (sections, radio picker, preview).
- **Contracts:**
  - The texts "Your bots", "New bot", "Chat" and "Edit" stay.
  - Each avatar radio sits inside its `label`, and the label's text is the look name.
  - The picker also works with the arrow keys (native radio group).
  - The save body is unchanged.
- **Done:** the journey test creates a bot by picking an avatar radio.

### WR6 Markdown
- **Status: DONE.** Evidence: `yarn build` ok; full run 1595 pass, 1 fail (redteam T8 flake; passes alone 15/15), 1 skipped; ui.test.js 8/8 with the extended safe-Markdown test (lang, unclosed fence, table, hr, javascript: in a cell, 20,000 `|` linear). CSS added to app.css (no new file); UI total 117.8 KB, budget unchanged. Copy button is only created when `navigator.clipboard.writeText` exists. Copy click and the rendered DOM are UNTESTED (parser only is tested).
- **Inputs:** §3.4.
- **Outputs:** the parser and builder changes.
- **Contracts:**
  - The tree stays plain data. The new node types are `table` (`head: inline[][]`, `rows: inline[][][]`), `hr` and `pre.lang`.
  - Nothing in the tree carries HTML.
  - The linear-time check still passes, including 20,000 `|` characters.
- **Done:** the extended safe-Markdown test passes.

### WR7 Auth, Account, Admin, Models restyle
- **Inputs:** §3.3 (auth screens, settings-type pages).
- **Outputs:** class and wrapper changes in `auth.js`, `account.js`, `admin.js` and `models.js`.
- **Contracts:**
  - No string changes. The journey, L4 step-up and models tests pass unchanged.
  - Every Models page invariant (I59 to I62) is untouched: no key kept, every fetched value set as text.
- **Done:** all web tests pass, and a manual look in light and dark (WU).

### WR8 Tests, budget, docs, review
- **Inputs:** §8.
- **Outputs:**
  - the test edits;
  - the budget raised to 160 KB (D9);
  - a results section added to this plan;
  - `/code-review` at medium on the branch diff. `/security-review` is needed because the Markdown and DOM paths change.
- **Done:** `yarn build && yarn test` is green, and the review findings are fixed or listed.

## 7. MVP-ready checklist (each item maps to a task; WU checks it in a browser)
- [ ] Empty states: no bots, no chats, no search results, a new chat with starters (WR2, WR3, WR5)
- [ ] Loading: sidebar and log skeletons, no flash under 150 ms (WR1, WR2, WR3)
- [ ] Errors: a load error with Retry, offline banner with auto-retry, a turn error with Retry, a stream drop that resumes (WR2, WR3)
- [ ] Mobile and responsive: three breakpoints, back navigation, details sheet, favourites row, no horizontal scroll at 360 px, the composer stays above the on-screen keyboard (`100dvh`) (WR1, WR2)
- [ ] Keyboard: everything is reachable in a logical tab order; Enter sends; Shift+Enter adds a new line; Escape stops a run or closes a popover or sheet; Ctrl+K searches; the visible focus ring is kept (WR2 to WR5)
- [ ] A11y basics: one h1 per view, labelled controls, `aria-current` on the selected bot, `role=log` plus `aria-busy` while streaming, icon buttons with sr-only text, contrast of 4.5:1 or more, reduced motion respected, usable at 200% zoom (all)
- [ ] Dark mode: follows the system; both themes checked on every screen (WR1, WR7)
- [ ] Markdown and code rendered safely without innerHTML: code blocks with a language label and Copy, tables, hr, links with `noopener`, no images (WR6)
- [ ] Avatars: 8 looks, shown in the sidebar, header, details, gallery and picker (WR1, WR5)
- [ ] Bot gallery with cards and a New bot tile (WR5)
- [ ] Streaming indicator: typing dots, then live Markdown; the status line (WR3)
- [ ] Stop and regenerate: Stop in the composer while running, Regenerate on the last bot message, Copy on bot messages (WR3)
- [ ] History and search: per-bot chat list with pin, rename, export and delete; global search over bots and chats (WR2, WR4)

## 8. Acceptance criteria and tests (few; test-discipline)
| ID | Criterion | Proof |
|---|---|---|
| WA1 | I57 still holds: no innerHTML, eval, inline style, external fetch, external CSS or browser storage. The only CSS `url()` values are same-origin `/i-*.svg` | **existing** static test, extended by one assertion: every CSS `url(` value starts with `"/` |
| WA2 | The UI stays small | **existing** budget test, with the total raised to 160 KB (D9); the per-file limit stays at 30 KB |
| WA3 | Markdown stays safe and gains code language, tables and hr; an unclosed fence renders as code; a `javascript:` link inside a table cell is not a link | **existing** safe-Markdown test, extended (one more input block and assertions); not a new test |
| WA4 | The whole journey works in the new layout: claim, create a bot through the avatar radio picker, chat with streaming, the sidebar row shows the bot's last preview, reload keeps history, account, sign out; the a11y check passes on every screen | **existing** journey test, updated: the avatar is picked by firing the radio; it asserts the sidebar row text contains the preview; the h1 and label checks stay as they are |
| WA5 | A dropped stream resumes from the last event id with no duplicated or lost text | **new** test: the chat view against a fake `api.stream` that fails once mid-answer and then replays from `last-event-id`; it asserts the final bubble text and that the second call carried the id |
| WA6 | `shortTime` formats today, yesterday, the past week, this year and older | **new** table-driven test of 5 rows (pure function) |

There are no tests for CSS, layout, colours or icons: those are checked by hand (§10).

Tests removed: none. If the journey test's chat-thread button assertions become redundant once the thread list moves into the pane, update them in place rather than adding new ones.

## 9. Invariant
- **I63** The redesigned web UI keeps I57 and I25a:
  - icons are same-origin SVG files used only as CSS masks;
  - avatars are pure CSS;
  - no font or image comes from outside the origin;
  - the theme follows the system with no client storage;
  - chat Markdown is built from a plain tree with text nodes only.

  Proved by WA1 and WA3.

## 10. Manual browser checklist for the user (WU; nothing here is run by an agent)
Run on the PC over loopback (`http://127.0.0.1:47009`), after `yarn build` and the usual `start:local`/`web:local`. Use Edge or Chrome.
- **WU1** Light and dark: switch the Windows theme. Every screen (sign-in, gallery, editor, chat, details, account, admin, models) is legible, and no element has a wrong colour.
- **WU2** Desktop at 1280 px: three panes. Close details, and the chat widens. At about 1000 px: two panes, and details overlays.
- **WU3** Phone size: DevTools device mode at 375 by 812, and at 360 px wide.
  - The home shows the favourites row and the list.
  - A bot opens the chat; Back returns.
  - Details is a full-screen sheet.
  - There is no sideways scroll.
  - The composer is visible with the keyboard open (a real phone only after L2).
- **WU4** Create a bot: pick each avatar look and see the preview; save; it appears in the sidebar and the gallery.
- **WU5** Chat:
  - typing dots, then streaming Markdown;
  - send a long code answer ("write a 60-line Python script"), which shows the language label, Copy and horizontal scroll;
  - ask for a table;
  - Stop in the middle of an answer;
  - Regenerate;
  - Copy a message.
- **WU6** Reload during a streaming answer. The answer continues, without double text.
- **WU7** Approval: ask a bot something that needs an ask-first tool. The card shows; Why expands; Approve or Deny collapses it to a line.
- **WU8** History: in details, pin, rename, export and delete a chat. Search a word from an old chat in the sidebar and open the result.
- **WU9** Keyboard only: reach everything with Tab. Enter and Shift+Enter in the composer; Escape stops a run and closes the menu and the sheet; Ctrl+K focuses search. The focus ring is always visible.
- **WU10** Errors: stop the gateway while the page is open. The offline banner appears; start it again and the banner clears. Open a deleted chat's URL and see a clear message with a way back.
- **WU11** Narrator (Win+Ctrl+Enter), a quick pass: the bot list, the selected state, a new answer read once when done, buttons with names.
- **WU12** Turn on reduced motion (Windows: Settings > Accessibility > Visual effects > Animation effects off). No animation plays. Zoom to 200%: still usable.

## 11. Open questions for the user
**All answered 2026-11-02 (WQ1 to WQ8): the user accepted every default. WQ1 sidebar lists bots; WQ2 map the 8 ids; WQ3 system theme only; WQ4 inverse primary buttons; WQ5 budget 160 KB; WQ6 live check on the redesigned UI; WQ7 no busy dot; WQ8 this branch, one commit per task.**

- **WQ1** Sidebar rows: **bots**, with their chats in the details pane (Grok-faithful, default), or **chats** (threads) grouped under bots?
- **WQ2** Avatars: map the 8 existing avatar ids to 8 shape and colour looks (default, no backend change), or let users pick shape and colour separately? The second needs a new `avatarColor` field in the bot schema and store: a small backend change.
- **WQ3** Theme: follow the system only (default), or add a light/dark/system toggle? A toggle would be saved server-side per user, because browser storage is banned by I57: a small backend change.
- **WQ4** Primary buttons: neutral black/white pills (Grok look, default), or keep blue primary buttons?
- **WQ5** Raise the UI size budget from 130 KB to 160 KB total (default yes)? The current size is 88.6 KB, and the redesign adds an estimated 30 to 40 KB.
- **WQ6** Placement: should the L1 live check (the web UI on loopback) run on the **redesigned** UI? The default is yes, so the redesign lands first and L1 is not done twice. Or should L1 run now on the current UI?
- **WQ7** Sidebar activity: add a "working" dot for a bot whose turn is running? This needs a `running` flag in `/api/chat/threads` summaries (a small backend change). The default is no for the MVP.
- **WQ8** Branch name `agent-007-web-ui-redesign` from master (default), one commit per WR task?

## 12. Risks
- **WK1** Journey-test churn: the layout change touches the strings and structure the test uses. Mitigation: keep the listed texts and class names (§6 contracts), and update the test only where the design truly changes (the avatar picker, the sidebar row).
- **WK2** The size budget is exceeded. Mitigation: D9, splitting CSS into two files, and no icon is inlined into JS.
- **WK3** Re-rendering Markdown during streaming costs CPU on long answers. Mitigation: a 100 ms throttle; the parser is linear; past 20,000 characters, render plain text until the end.
- **WK4** Screen readers re-reading streaming text. Mitigation: `aria-busy` on the live bubble, and announce only the finished message.
- **WK5** Copying another product's look too closely. Mitigation: D1. Our own avatar drawings, icons and name; patterns only.
