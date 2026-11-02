# Research: Grok Bot app design, for the agent-007 web UI redesign

Date: 2026-11-02. Researched by fetching the article, its two product screenshots and one detailed third-party guide. Nothing was installed. Screenshots were downloaded to `.claude/temp/grokbot-img/` (scratch, not committed) only so they could be viewed.

## Sources

1. Vellum, "Official Grok Bot Breakdown (2026)": https://www.vellum.ai/blog/official-grok-bot-breakdown . This is the page the user named. Vellum sells a competing product. The text covers features, pricing and security, and says nothing about visual design. It holds two screenshots:
   - "Grok Bot Homepage" (dark theme, desktop app inside the x.ai product page): https://cdn.sanity.io/images/ghjnhoi4/production/97e04d2e9edef22e50b6aacaafc1eb228e985af9-3786x2118.png
   - "Grok Bot UI" (light theme, desktop window with three panes and an iPhone app): https://cdn.sanity.io/images/ghjnhoi4/production/89ee89905fdc0d324c0c51b5b30557fde90ed714-2048x1152.jpg
2. Flavio Copes, "A deep dive into Grok Bot": https://flaviocopes.com/grok-bot/ . This is the most detailed text source on the UI: sidebar, New chat (+) menu, Library, details pane, composer, settings sections, approval cards, onboarding and mobile.
3. Search results that confirm the product basics, with no layout detail: https://www.eesel.ai/blog/grok-bot , https://mem0.ai/blog/grok-bot-guide , https://www.igeeksblog.com/grok-bot-macos-ios-launch/ , https://www.windowsmode.com/grok-bot-for-windows/amp/ , https://cursor.com/docs/grok-bot/get-started.md . Fetching `docs.x.ai/grok-bot/get-started.md` returned 404.

Caveat: the article and the guide only describe the UI in words. The spec below is read off the two screenshots, and the colour and size values are estimates from those images. They are not taken from any published design system.

## What Grok Bot is (only what matters for design)

- An agent app built around **named Bots**. Each Bot has a name, a job (its role) and an avatar. The sidebar lists Bots, and every conversation centres on a Bot rather than on a separate task. Several Bots share one cloud computer.
- Desktop app (macOS and Windows) and a phone app. The phone app covers messaging, watching the computer and approvals. Admin work, such as editing schedules and full run history, is desktop only.
- **Onboarding**: Sign in, then "name the first Bot and choose its avatar shape and colour", then send the Bot its role as the first message.
- **Approvals**: an approval card in the chat with "Allow once", "Deny" and an "always allow" rule. Routine cards expire after 30 minutes. Chat cards wait for an answer.
- **Composer**: `@` mentions a Bot, `>` starts a quote, Cmd+/ opens a keyboard shortcut sheet, and a voice button appears when the field is empty.
- **Details pane** for a Bot: one column with a live screen preview ("Chief of Staff's screen") and Routines (a status icon, a name and a schedule line, for example "Every day at 8:00 AM" or "Paused"). Its header has Back, Share, Settings and Close.
- **Settings** sections: General, Vault, Computer, Connect apps, Permissions (Custom Rules: "Allow automatically" or "Ask first").

## Visual spec read off the screenshots

### Layout (desktop, light screenshot, window about 1080 px wide)
- **Three panes**:
  - Left sidebar: about 280 px, tinted background.
  - Centre chat: flexible width, white.
  - Right details pane: about 330 px, white, separated by a 1 px hairline. It can be closed.
- **Sidebar, top to bottom**:
  - The window traffic lights and a "+" (new) icon button at the top right.
  - A full-width **search field**: grey fill, no border, 8 to 10 px radius, a magnifier icon and the placeholder "Search".
  - The **Bot list**. Each row has:
    - an avatar of about 40 px;
    - the **name** (semibold, about 15 px);
    - a **time** at the right (muted, about 12 px; for example "7:34 PM", "Yesterday", "Tuesday");
    - a **one-line preview** of the last message (muted, about 13 px, cut off with an ellipsis);
    - an optional **blue unread dot** at the right.
  - The selected row has a rounded light grey fill with no border, and rows sit about 60 px apart.
  - Bottom of the sidebar: a "Plugins" row with an icon, then the **user row** (a small face avatar and "Alex Chen").
- **Chat header**: a small avatar (about 22 px), the Bot name in semibold, and one icon button at the right ("show screen" or "details").
- **Messages**:
  - A centred muted **timestamp** at the top of a group ("9:41 AM").
  - **User** bubbles sit on the right: black fill (#0d0d0d) with white text.
  - **Bot** bubbles sit on the left: light grey fill (about #f1f1f2) with dark text.
  - Bubble radius is about 18 px, padding about 12 by 16 px, and the maximum width is about 70% of the column.
  - Consecutive bot bubbles stack with a gap of about 4 px.
  - Links inside bubbles are blue.
  - **File card** inside the stream: an icon tile, the file name in semibold, "12 pages · 1.2 MB" in muted text, and a download icon at the right. It has a white fill, a hairline border and a 12 px radius.
- **Composer**: a single pill (fully rounded, white, soft shadow and hairline) floating at the bottom of the centre column. It has a "+" (attach) at the left, the placeholder "Message Chief of Staff", and a black circular **mic or send** button at the right.
- **System lines** in the dark screenshot: a centred muted sentence such as "Renamed to Sales Outbound".
- **Agent action card** in the dark screenshot:
  - The title "Computer".
  - A **status pill** at the right ("You're in control", with an amber dot on a soft amber fill).
  - One body sentence, an embedded preview image, and two **pill buttons**: the primary one is inverse (white on dark), the secondary one is a dark grey pill. The labels are "Take over" and "I'm done".

### Dark theme (homepage screenshot)
- The page background is near black (about #0b0b0c).
- The app window is about #161617, and the sidebar is the same tone with a hairline (#2a2a2c) at its right.
- Bot bubbles are about #2a2a2c with light text.
- User bubbles invert to a light fill (about #ececec) with dark text, which mirrors the black user bubble in light mode.
- The search field is about #232325.
- Primary buttons are white pills with black text. Secondary buttons are #222 pills with light text and a large radius (999 px).
- The type is a neutral grotesque, similar to SF Pro or Inter. The hero headline is set tight and large. App text runs from 13 to 15 px.

### Avatars (the most distinctive element)
- Each Bot is a **flat coloured shape with two small eye marks**. The shapes are circle, droplet, cloud or blob, rounded square, triangle, pill and a two-shape group for group chats.
- The colours are saturated mid-tones: violet #8b5cf6, sky #3b82f6, green #22c55e, teal #14b8a6, brown #8b5a3c, orange #f97316, red #ef4444, pink #ec4899, indigo #6366f1.
- The user's own avatar is a small face illustration. Ours will be an initial on a neutral disc.
- On the phone, the home screen puts a **row of large avatars (about 64 px) with captions** at the top (the favourite Bots) above the same conversation list.

### Mobile (iPhone screenshot)
- Header: the user avatar at the left, and Search and "+" icon buttons at the right. There is no title bar text.
- A favourites row of large avatars, then the list rows as on desktop (avatar, name, time, preview).
- Opening a Bot shows the chat full screen. The details pane is its own screen.

### Motion (inferred, the screenshots are static)
- The UI is calm and flat, with no gradients inside the app. Shadows appear only on the composer pill and floating cards. Expect only short fades and a slide for the pane.

## What we take and what we do not

Take:
- The three-pane layout and the sidebar of Bots with a time and a preview.
- The pill composer with an inline send/stop button.
- Inverse user bubbles and grey bot bubbles, centred timestamps and system lines.
- Action cards with a status pill and pill buttons, used for our approval cards.
- A details pane for the Bot.
- Avatars drawn as shape plus colour plus two eyes.
- A favourites row on mobile.
- The neutral near-black and white palette, a single saturated accent, and large radii.

Do not take:
- The xAI or Grok names, logos or brand marks, the "Meet Grok Bot" hero, or any image asset.
- The exact avatar artwork. Ours are our own CSS shapes.
- Features we do not have: the cloud computer screen, voice, Plugins, Vault, Routines, file uploads and Share. Where Grok shows the computer screen in the details pane, we show the Bot's facts, its chats and its usage.
