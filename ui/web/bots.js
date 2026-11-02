// Bots: the list of cards and the editor (S35). The model badge and the one-line egress note come from the server, so the editor never
// guesses what leaves the PC. A user can only pick presets and tools their account allows (the options call), and the form has no field
// for folders, peers or tokens: those are fixed by the system.
import { clear, field, h, icon } from "./dom.js";

// The ids are stored on bots and never change; the labels name the look (shape and colour, WR5/D7).
const AVATAR_LABEL = { robot: "Indigo square", fox: "Orange droplet", owl: "Violet circle", cat: "Pink triangle", planet: "Sky circle", leaf: "Green blob", bolt: "Red pill", book: "Teal square" };

export function avatarEl(name, size = "md") {
  return h("span", { class: `avatar av-${size} av-${name} avatar-${name}`, role: "img", "aria-label": AVATAR_LABEL[name] || "Avatar" });
}

export function badgeEl(bot) {
  return h("span", { class: bot.cloud ? "badge badge-cloud" : "badge" }, bot.cloud ? `${bot.presetLabel} (cloud)` : bot.presetLabel);
}

/** M2: one line per paid model of a bot: off until the owner enables it, else the usage against the day and month caps. */
export function paidLines(paid) {
  return (paid || []).map((p) =>
    h("p", { class: "muted small" }, p.enabled ? `${p.label} (paid): ${p.dayTokens}/${p.perDay} tokens today, ${p.monthTokens}/${p.perMonth} this month${p.headroom === 0 ? ", cap reached" : ""}` : `${p.label} (paid): off until the owner enables it with a spending cap`),
  );
}

const presetText = (p) => `${p.label}${p.paid ? " (paid)" : p.cloud ? " (cloud)" : ""}`;

export async function renderBots(ctx) {
  const r = await ctx.api.call("/api/bots/list", {});
  const bots = r.ok ? r.data.bots : [];
  const newBot = () => ctx.go("#/bot/new");
  return h(
    "section",
    { class: "gallery", "aria-labelledby": "bots-title" },
    h("div", { class: "row" }, h("h1", { id: "bots-title" }, "Your bots"), h("button", { class: "btn btn-primary", type: "button", onclick: newBot }, icon("plus"), "New bot")),
    bots.length === 0
      ? h("div", { class: "empty" }, h("strong", {}, "Create your first bot"), h("p", {}, "No bots yet. Create one to start chatting."), h("button", { class: "btn btn-primary", type: "button", onclick: newBot }, "New bot"))
      : h(
          "ul",
          { class: "cards botgrid", role: "list" },
          h("li", {}, h("button", { class: "botcard botcard-new", type: "button", onclick: newBot }, icon("plus"), h("span", {}, "New bot"))),
          bots.map((b) =>
            h(
              "li",
              { class: "card botcard" },
              avatarEl(b.avatar, "lg"),
              h("strong", { class: "botcard-name" }, b.name),
              h("div", { class: "muted small" }, b.tagline || ""),
              h("div", {}, badgeEl(b)),
              paidLines(b.paid),
              h("div", { class: "botcard-actions" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => ctx.go(`#/chat/${b.id}`) }, "Chat"), h("button", { class: "btn", type: "button", onclick: () => ctx.go(`#/bot/${b.id}`) }, "Edit")),
            ),
          ),
        ),
  );
}

export async function renderBotEditor(ctx, botId) {
  const opts = await ctx.api.call("/api/bots/options", {});
  const o = opts.ok ? opts.data : { presets: [], avatars: [], tools: [], maxBots: 0, count: 0 };
  let bot = { name: "", tagline: "", avatar: o.avatars[0] || "robot", persona: "", preset: o.presets[0]?.id || "", cloudFallback: null, fallback: null, tools: ["tool_search"], memory: false, starters: [] };
  if (botId) {
    const g = await ctx.api.call("/api/bots/get", { id: botId });
    if (!g.ok) return h("p", { class: "banner banner-error", role: "alert" }, g.data.message || "No such bot.");
    bot = g.data.bot;
  }
  const e = h("div", { role: "alert" });
  const name = h("input", { type: "text", name: "name", maxlength: "40", value: bot.name, required: true });
  name.addEventListener("input", () => (previewName.textContent = name.value.trim() || "Your bot"));
  const tagline = h("input", { type: "text", name: "tagline", maxlength: "80", value: bot.tagline });
  // A native radio group (arrow keys work). Each radio sits in its label; the label text is the look name. The face is decorative.
  let look = bot.avatar;
  const preview = h("span", { class: `avatar av-lg av-${look}`, "aria-hidden": "true" });
  const previewName = h("strong", {}, bot.name || "Your bot");
  const picks = o.avatars.map((a, i) => {
    const id = `look-${i}`;
    const radio = h("input", { type: "radio", name: "avatar", value: a, id, checked: a === look });
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      look = a;
      preview.className = `avatar av-lg av-${a}`;
    });
    return h("label", { class: "look", for: id }, radio, h("span", { class: `avatar av-md av-${a}`, "aria-hidden": "true" }), h("span", { class: "look-name" }, AVATAR_LABEL[a] || a));
  });
  const persona = h("textarea", { name: "persona", maxlength: "4000" });
  persona.value = bot.persona || "";
  const preset = h("select", { name: "preset" }, o.presets.map((p) => h("option", { value: p.id, selected: p.id === bot.preset }, presetText(p))));
  const cloudFallback = h("select", { name: "cloudFallback" }, h("option", { value: "" }, "No cloud fallback"), o.presets.filter((p) => p.cloud).map((p) => h("option", { value: p.id, selected: p.id === bot.cloudFallback }, presetText(p))));
  const fallback = h("select", { name: "fallback" }, h("option", { value: "" }, "No local fallback"), o.presets.filter((p) => !p.cloud).map((p) => h("option", { value: p.id, selected: p.id === bot.fallback }, p.label)));
  const note = h("p", { class: "help", "aria-live": "polite" });
  const refreshNote = () => {
    const p = o.presets.find((x) => x.id === preset.value);
    const paid = [preset.value, cloudFallback.value].map((id) => o.presets.find((x) => x.id === id)).filter((x) => x && x.paid);
    note.textContent = (p ? p.note : "") + (paid.length ? ` Paid route (${paid.map((x) => x.label).join(", ")}): off until the owner enables it for this bot with a daily and a monthly cap; it stops at the cap.` : "");
  };
  preset.addEventListener("change", refreshNote);
  cloudFallback.addEventListener("change", refreshNote);
  refreshNote();
  const toolBoxes = o.tools.map((t) => {
    const cb = h("input", { type: "checkbox", value: t, checked: bot.tools.includes(t) });
    return { t, cb, el: h("label", { class: "check" }, cb, h("span", {}, t)) };
  });
  const memory = h("input", { type: "checkbox", name: "memory", checked: !!bot.memory });
  const starters = h("textarea", { name: "starters", maxlength: "700" });
  starters.value = (bot.starters || []).join("\n");
  const footer = h("div", { class: "stickyfoot" }, h("button", { class: "btn btn-primary", type: "submit" }, "Save"), h("button", { class: "btn", type: "button", onclick: () => ctx.go("#/bots") }, "Cancel"));
  const form = h(
    "form",
    {
      class: "editor",
      onsubmit: async (ev) => {
        ev.preventDefault();
        clear(e);
        const body = {
          name: name.value,
          tagline: tagline.value,
          avatar: look,
          persona: persona.value,
          preset: preset.value,
          cloudFallback: cloudFallback.value,
          fallback: fallback.value,
          tools: toolBoxes.filter((x) => x.cb.checked).map((x) => x.t),
          memory: memory.checked,
          starters: starters.value.split("\n").map((s) => s.trim()).filter(Boolean),
        };
        const r = botId ? await ctx.api.call("/api/bots/update", { id: botId, ...body }) : await ctx.api.call("/api/bots/create", body);
        if (!r.ok) {
          const issues = r.data.issues || [r.data.message || "Could not save."];
          return clear(e, h("div", { class: "banner banner-error" }, h("ul", {}, issues.map((i) => h("li", {}, i)))));
        }
        ctx.refreshBots();
        ctx.go("#/bots");
      },
    },
    h("h1", {}, botId ? "Edit bot" : "New bot"),
    h("section", { class: "fsec" }, h("h2", {}, "Name and look"), h("div", { class: "preview" }, preview, previewName), field("Name", name), field("Tagline", tagline), h("fieldset", { class: "looks" }, h("legend", {}, "Avatar"), h("div", { class: "lookgrid" }, picks))),
    h("section", { class: "fsec" }, h("h2", {}, "Role"), field("Persona", persona, "Written by you. It shapes tone and style only; it cannot give the bot new powers."), field("Starter prompts (one per line)", starters)),
    h(
      "section",
      { class: "fsec" },
      h("h2", {}, "Model"),
      field("Model", preset),
      note,
      field("Cloud fallback", cloudFallback, "Tried after the main model, before the local fallback. A paid route here also needs the owner's cap."),
      botId ? paidLines(bot.paid) : null,
      field("Local fallback", fallback, "Used once if the main model is not available. A fallback is always a local model."),
    ),
    h("section", { class: "fsec" }, h("h2", {}, "Tools and memory"), h("fieldset", {}, h("legend", {}, "Tools"), toolBoxes.map((x) => x.el)), h("label", { class: "check" }, memory, h("span", {}, "Remember durable notes about me (this bot's own memory)"))),
    e,
    footer,
  );
  if (botId) {
    footer.append(
      h(
        "button",
        {
          class: "btn btn-danger",
          type: "button",
          onclick: async () => {
            if (!ctx.confirm(`Delete ${bot.name} and its chats?`)) return;
            const r = await ctx.api.call("/api/bots/delete", { id: botId });
            if (r.ok) {
              ctx.refreshBots();
              ctx.go("#/bots");
            }
          },
        },
        "Delete this bot",
      ),
    );
  }
  return form;
}
