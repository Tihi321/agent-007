// Bots: the list of cards and the editor (S35). The model badge and the one-line egress note come from the server, so the editor never
// guesses what leaves the PC. A user can only pick presets and tools their account allows (the options call), and the form has no field
// for folders, peers or tokens: those are fixed by the system.
import { clear, field, h } from "./dom.js";

const AVATAR_LABEL = { robot: "Robot", fox: "Fox", owl: "Owl", cat: "Cat", planet: "Planet", leaf: "Leaf", bolt: "Bolt", book: "Book" };

export function avatarEl(name) {
  return h("span", { class: `avatar avatar-${name}`, role: "img", "aria-label": AVATAR_LABEL[name] || "Avatar" }, (AVATAR_LABEL[name] || "?").slice(0, 1));
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
  return h(
    "section",
    { "aria-labelledby": "bots-title" },
    h("div", { class: "row" }, h("h1", { id: "bots-title" }, "Your bots"), h("button", { class: "btn btn-primary", type: "button", onclick: () => ctx.go("#/bot/new") }, "New bot")),
    bots.length === 0 ? h("p", { class: "muted" }, "No bots yet. Create one to start chatting.") : null,
    h(
      "ul",
      { class: "cards", role: "list" },
      bots.map((b) =>
        h(
          "li",
          { class: "card bot-card" },
          h("div", { class: "row" }, avatarEl(b.avatar), h("div", {}, h("strong", {}, b.name), h("div", { class: "muted small" }, b.tagline || ""))),
          h("div", {}, badgeEl(b)),
          paidLines(b.paid),
          h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => ctx.go(`#/chat/${b.id}`) }, "Chat"), h("button", { class: "btn", type: "button", onclick: () => ctx.go(`#/bot/${b.id}`) }, "Edit")),
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
  const tagline = h("input", { type: "text", name: "tagline", maxlength: "80", value: bot.tagline });
  const avatar = h("select", { name: "avatar" }, o.avatars.map((a) => h("option", { value: a, selected: a === bot.avatar }, AVATAR_LABEL[a] || a)));
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
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: async (ev) => {
        ev.preventDefault();
        clear(e);
        const body = {
          name: name.value,
          tagline: tagline.value,
          avatar: avatar.value,
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
        ctx.go("#/bots");
      },
    },
    h("h1", {}, botId ? "Edit bot" : "New bot"),
    field("Name", name),
    field("Tagline", tagline),
    field("Avatar", avatar),
    field("Persona", persona, "Written by you. It shapes tone and style only; it cannot give the bot new powers."),
    field("Model", preset),
    note,
    field("Cloud fallback", cloudFallback, "Tried after the main model, before the local fallback. A paid route here also needs the owner's cap."),
    botId ? paidLines(bot.paid) : null,
    field("Local fallback", fallback, "Used once if the main model is not available. A fallback is always a local model."),
    h("fieldset", {}, h("legend", {}, "Tools"), toolBoxes.map((x) => x.el)),
    h("label", { class: "check" }, memory, h("span", {}, "Remember durable notes about me (this bot's own memory)")),
    field("Starter prompts (one per line)", starters),
    e,
    h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "submit" }, "Save"), h("button", { class: "btn", type: "button", onclick: () => ctx.go("#/bots") }, "Cancel")),
  );
  if (botId) {
    form.append(
      h(
        "button",
        {
          class: "btn btn-danger",
          type: "button",
          onclick: async () => {
            if (!ctx.confirm(`Delete ${bot.name} and its chats?`)) return;
            const r = await ctx.api.call("/api/bots/delete", { id: botId });
            if (r.ok) ctx.go("#/bots");
          },
        },
        "Delete this bot",
      ),
    );
  }
  return form;
}
