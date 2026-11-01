// Models page (MS5, owner only): fetch a source's model list on demand, tick the models that become presets of the web gateway, add one by its id,
// edit and remove presets, add OpenAI-compatible providers. Every value from the server is set as text (I57); fetched strings are untrusted.
// A key typed here is sent once and the input is cleared; the page never keeps it and the server never returns it.
import { withStepUp } from "./account.js";
import { clear, field, h } from "./dom.js";

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const privacyBadge = (p) => h("span", { class: p === "cloud" ? "badge badge-cloud" : "badge" }, p === "cloud" ? "cloud" : "local");

export async function renderModels(ctx) {
  const out = h("div", { "aria-live": "polite" });
  const bannersEl = h("div", {});
  const listEl = h("div", { class: "models-list" });
  const mainEl = h("div", { class: "models-main" });
  const st = { sources: [], presets: [], banners: [], sel: "", adding: false, fetched: {}, busy: false, replacingKey: false, copied: null };
  let tableHost = null;

  const note = (ok, msg) => clear(out, h("p", { class: ok ? "banner banner-ok" : "banner banner-error", role: ok ? null : "alert" }, msg));
  const write = (path, body) => withStepUp(ctx, () => ctx.api.call(path, body), out);
  const source = () => st.sources.find((s) => s.id === st.sel);
  const fetchedOf = () => st.fetched[st.sel];

  async function reload() {
    const r = await ctx.api.call("/api/admin/models/list", {});
    if (!r.ok) {
      note(false, r.data.message || "Could not load the models.");
      return false;
    }
    st.sources = r.data.sources || [];
    st.presets = r.data.presets || [];
    st.banners = r.data.banners || [];
    if (!st.adding && !source()) st.sel = st.sources[0]?.id || "";
    draw();
    return true;
  }

  function draw() {
    clear(bannersEl, st.banners.map((b) => h("p", { class: "banner banner-warn", role: "status" }, b)));
    drawList();
    drawMain();
  }

  function drawList() {
    clear(
      listEl,
      h(
        "ul",
        { class: "plainlist", role: "list" },
        st.sources.map((s) => {
          const f = st.fetched[s.id];
          return h(
            "li",
            {},
            h(
              "button",
              { class: s.id === st.sel && !st.adding ? "btn models-source current" : "btn models-source", type: "button", "aria-current": s.id === st.sel && !st.adding ? "true" : null, onclick: () => {
                st.sel = s.id;
                st.adding = false;
                st.replacingKey = false;
                draw();
              } },
              h("strong", {}, s.label), " ", privacyBadge(s.privacy),
              !s.setUp ? h("span", { class: "chip" }, "not set up") : null,
              s.setUp && s.kind === "custom" && s.privacy === "cloud" && !s.hasKey ? h("span", { class: "chip" }, "no key") : null,
              f && f.error ? h("span", { class: "chip chip-error" }, "fetch failed") : null,
            ),
          );
        }),
      ),
      h("button", { class: "btn btn-primary", type: "button", onclick: () => {
        st.adding = true;
        draw();
      } }, "Add provider"),
    );
  }

  function drawMain() {
    if (st.adding) return clear(mainEl, addProviderForm());
    const s = source();
    if (!s) return clear(mainEl, h("p", { class: "muted" }, "No sources."));
    const f = fetchedOf();
    const claudeKey = s.proxyAuth && s.proxyAuth.claude === "api_key";
    tableHost = h("div", { class: "table-wrap" });
    const filter = h("input", { type: "search", name: "filter", autocomplete: "off", value: f?.filter || "", oninput: (ev) => {
      if (st.fetched[st.sel]) st.fetched[st.sel].filter = ev.target.value;
      drawTable();
    } });
    const notAdded = h("input", { type: "checkbox", name: "notAdded", checked: !!f?.notAdded, onchange: (ev) => {
      if (st.fetched[st.sel]) st.fetched[st.sel].notAdded = ev.target.checked;
      drawTable();
    } });
    const byId = h("input", { type: "text", name: "modelId", autocomplete: "off", spellcheck: "false", maxlength: "128" });
    clear(
      mainEl,
      h(
        "div",
        { class: "card" },
        h("h2", {}, s.label), " ", privacyBadge(s.privacy),
        s.billing ? h("span", { class: s.billing === "paid" ? "badge badge-cloud" : "badge" }, s.billing === "paid" ? "paid per use" : "free or subscription") : null,
        s.kind === "acp-proxy" ? h("span", { class: "chip" }, "Claude and Antigravity need terms acknowledgment in the settings UI") : null,
        h("p", { class: "muted small" }, s.baseUrl || "Not set up in the configuration."),
        claudeKey ? h("p", { class: "banner banner-warn" }, "The proxy's Claude login is an API key: Claude models are refused unless marked paid.") : null,
        s.privacy === "cloud" ? h("p", { class: "help" }, `Cloud: your bots' messages and tool results go to ${hostOf(s.baseUrl) || "this provider"}; check that provider's terms.`) : null,
        s.kind === "lmstudio" ? h("p", { class: "help" }, "Context for a model that is not loaded is a guess: set it to the context LM Studio loads the model with.") : null,
        s.kind === "custom" ? sourceSettings(s) : null,
        h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !s.setUp || st.busy, onclick: () => doFetch(s) }, st.busy ? "Fetching..." : "Fetch models")),
        f && f.error ? h("p", { class: "banner banner-error", role: "alert" }, f.error) : null,
        f && !f.error ? [
          f.note ? h("p", { class: "banner banner-warn" }, f.note) : null,
          f.ignored ? h("p", { class: "muted small" }, `${f.ignored} entries from the provider were ignored (bad id or over the limit).`) : null,
          field("Filter", filter),
          h("label", { class: "check" }, notAdded, "Show not added only"),
          tableHost,
          h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "button", onclick: () => addSelected(s) }, "Add selected")),
        ] : null,
        s.setUp ? h("form", { class: "row", onsubmit: async (ev) => {
          ev.preventDefault();
          const id = byId.value.trim();
          if (!id) return;
          if (await addModels(s, [{ modelId: id }])) byId.value = "";
        } }, field("Add a model by its id", byId), h("button", { class: "btn", type: "submit" }, "Add")) : null,
      ),
      h("h3", {}, "Presets from this source"),
      presetList(s),
      h("p", { class: "muted small" }, "These presets are for the web app. Telegram bots use only the presets of the settings UI (port 47007): use \"Copy for settings UI\" on a preset and paste it there."),
    );
    if (f && !f.error) drawTable();
  }

  async function doFetch(s) {
    st.busy = true;
    drawMain();
    const r = await write("/api/admin/models/fetch", { sourceId: s.id });
    st.busy = false;
    const prev = st.fetched[s.id];
    st.fetched[s.id] = r.ok
      ? { rows: r.data.rows || [], ignored: r.data.ignored || 0, note: r.data.note || "", ticks: new Set(), filter: prev?.filter || "", notAdded: !!prev?.notAdded }
      : { error: r.data.message || "The fetch failed.", ticks: new Set() };
    if (r.ok) await reload(); // the list now knows the proxy's login methods (Claude API-key note); reload also redraws
    else draw();
  }

  function drawTable() {
    const f = fetchedOf();
    if (!tableHost || !f || !f.rows) return;
    const q = (f.filter || "").trim().toLowerCase();
    const rows = f.rows.filter((r) => (!q || r.modelId.toLowerCase().includes(q)) && (!f.notAdded || !r.presetId));
    const lm = source()?.kind === "lmstudio";
    clear(
      tableHost,
      rows.length === 0
        ? h("p", { class: "muted" }, f.rows.length === 0 ? "The provider listed no models." : "No model matches.")
        : h(
            "table",
            { class: "models-table" },
            h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Add"), h("th", { scope: "col" }, "Model"), lm ? h("th", { scope: "col" }, "State") : null, h("th", { scope: "col" }, "Context"), h("th", { scope: "col" }, "Badges"), h("th", { scope: "col" }, "Preset"))),
            h(
              "tbody",
              {},
              rows.map((r) => {
                const locked = !!r.blocked || !!r.presetId;
                const cb = h("input", { type: "checkbox", value: r.modelId, checked: f.ticks.has(r.modelId), disabled: locked, "aria-label": `Add ${r.modelId}`, onchange: (ev) => {
                  if (ev.target.checked) f.ticks.add(r.modelId);
                  else f.ticks.delete(r.modelId);
                } });
                const c = r.classified || {};
                return h(
                  "tr",
                  {},
                  h("td", {}, cb),
                  h("td", { class: "mono" }, r.modelId),
                  lm ? h("td", {}, r.loaded === true ? "loaded" : r.loaded === false ? "not loaded" : "unknown") : null,
                  h("td", {}, r.contextHint ? String(r.contextHint) : c.defaults ? `${c.defaults.contextWindow} (default)` : ""),
                  h(
                    "td",
                    {},
                    h("span", { class: "chip" }, r.group),
                    c.privacy ? privacyBadge(c.privacy) : null,
                    c.needsTerms ? h("span", { class: r.termsOk ? "chip chip-ok" : "chip chip-error" }, r.termsOk ? "terms accepted" : "needs terms") : null,
                    c.paidAllowed ? h("span", { class: "chip" }, "can be paid") : null,
                  ),
                  h("td", {}, r.blocked ? h("span", { class: "chip chip-error" }, `Blocked: ${r.blocked}`) : r.presetId ? h("span", {}, h("code", {}, r.presetId), " added") : h("span", { class: "muted" }, `new: ${r.proposedId}`)),
                );
              }),
            ),
          ),
    );
  }

  async function addModels(s, models) {
    const r = await write("/api/admin/models/presets/add", { sourceId: s.id, models });
    if (!r.ok) {
      note(false, r.data.message || "Could not add the models.");
      return false;
    }
    const added = r.data.added || [];
    const skipped = r.data.skipped || [];
    const f = fetchedOf();
    if (f && f.rows) {
      for (const a of added) {
        const row = f.rows.find((x) => x.modelId === a.modelId);
        if (row) row.presetId = a.presetId;
        f.ticks.delete(a.modelId);
      }
    }
    note(skipped.length === 0, `Added ${added.length}${skipped.length ? `; skipped ${skipped.map((x) => `${x.modelId} (${x.reason})`).join(", ")}` : ""}.`);
    await reload();
    return added.length > 0;
  }

  async function addSelected(s) {
    const f = fetchedOf();
    const ids = f ? [...f.ticks] : [];
    if (ids.length === 0) return note(false, "Tick at least one model.");
    await addModels(s, ids.map((modelId) => ({ modelId })));
  }

  function presetList(s) {
    const mine = st.presets.filter((p) => p.sourceId === s.id);
    if (mine.length === 0) return h("p", { class: "muted" }, "No presets yet.");
    return h(
      "ul",
      { class: "cards", role: "list" },
      mine.map((p) => {
        const head = h("p", {}, h("code", {}, p.id), " ", privacyBadge(p.privacy), p.billing === "paid" ? h("span", { class: "badge badge-cloud" }, "paid") : null, p.needsTerms ? h("span", { class: p.termsOk ? "chip chip-ok" : "chip chip-error" }, p.termsOk ? "terms accepted" : "needs terms") : null, h("span", { class: "chip" }, `used by ${p.usedBy} ${p.usedBy === 1 ? "bot" : "bots"}`));
        if (p.origin === "settings") {
          return h("li", { class: "card" }, head, h("p", {}, p.label), h("p", { class: "muted small" }, `${p.modelId} · context ${p.contextWindow}, max tokens ${p.maxTokens} · from the settings UI, read-only here`));
        }
        const label = h("input", { type: "text", name: "label", maxlength: "60", value: p.label });
        const ctxIn = h("input", { type: "number", name: "contextWindow", min: "1024", max: "2000000", step: "1", value: String(p.contextWindow) });
        const maxIn = h("input", { type: "number", name: "maxTokens", min: "256", max: "200000", step: "1", value: String(p.maxTokens) });
        const paid = p.privacy === "cloud"
          ? h("label", { class: "check" }, h("input", { type: "checkbox", name: "paid", checked: p.billing === "paid", onchange: async (ev) => {
              const r = await write("/api/admin/models/presets/update", { presetId: p.id, billing: ev.target.checked ? "paid" : "subscription" });
              note(r.ok, r.ok ? "Billing changed." : r.data.message || "That did not work.");
              await reload();
            } }), "Paid per use (needs an owner grant with caps before a bot can use it)")
          : null;
        return h(
          "li",
          { class: "card" },
          head,
          p.modelId ? h("p", { class: "muted small" }, p.modelId) : null,
          field("Label", label),
          field("Context window", ctxIn),
          field("Max tokens", maxIn),
          paid,
          h(
            "div",
            { class: "row" },
            h("button", { class: "btn btn-small", type: "button", onclick: async () => {
              const r = await write("/api/admin/models/presets/update", { presetId: p.id, label: label.value, contextWindow: Number(ctxIn.value), maxTokens: Number(maxIn.value) });
              note(r.ok, r.ok ? "Saved." : r.data.message || "That did not work.");
              if (r.ok) await reload();
            } }, "Save"),
            p.copyJson ? h("button", { class: "btn btn-small", type: "button", onclick: () => copy(p) }, "Copy for settings UI") : null,
            h("button", { class: "btn btn-small btn-danger", type: "button", onclick: () => removeOne("/api/admin/models/presets/remove", { presetId: p.id }, p.id) }, "Remove"),
          ),
          st.copied === p.id ? h("pre", { class: "codes" }, p.copyJson) : null,
        );
      }),
    );
  }

  async function copy(p) {
    try {
      await globalThis.navigator.clipboard.writeText(p.copyJson);
      note(true, "Copied. Paste it into the Models form of the settings UI (port 47007), then apply the settings.");
    } catch {
      st.copied = p.id; // no clipboard access: show the text to copy by hand
      note(false, "Could not use the clipboard. Copy the text shown under the preset.");
      drawMain();
    }
  }

  // Remove without force first; a 409 lists the bots using it and asks to type the id before the forced second call.
  async function removeOne(path, body, typed) {
    let r = await write(path, body);
    if (r.status === 409 && r.data.error === "in_use") {
      const bots = (r.data.bots || []).map((b) => `${b.user}/${b.bot}`).join(", ");
      const c = ctx.prompt(`Used by: ${bots || "some bots"}. Their chats on it will fall back or be refused. Type ${typed} to remove it anyway`, "");
      if (c !== typed) return note(false, "Not removed.");
      r = await write(path, { ...body, force: true });
    }
    note(r.ok, r.ok ? "Removed." : r.data.message || "That did not work.");
    if (r.ok) {
      if (path.includes("/sources/")) st.sel = "";
      await reload();
    }
  }

  function sourceSettings(s) {
    const keyIn = h("input", { type: "password", name: "apiKey", autocomplete: "new-password", maxlength: "512" });
    const keyForm = h("form", { class: "row", onsubmit: async (ev) => {
      ev.preventDefault();
      const apiKey = keyIn.value;
      keyIn.value = "";
      if (!apiKey) return;
      const r = await write("/api/admin/models/sources/update", { sourceId: s.id, apiKey });
      st.replacingKey = false;
      note(r.ok, r.ok ? "Key saved." : r.data.message || "That did not work.");
      await reload();
    } }, field(s.hasKey ? "New API key" : "API key", keyIn), h("button", { class: "btn btn-small", type: "submit" }, "Save key"));
    let billing = null;
    if (s.privacy === "cloud") {
      const sel = h("select", { name: "billing" }, h("option", { value: "subscription" }, "Free or subscription"), h("option", { value: "paid" }, "Paid per use"));
      sel.value = s.billing === "paid" ? "paid" : "subscription";
      billing = h("div", { class: "row" }, field("Billing", sel), h("button", { class: "btn btn-small", type: "button", onclick: async () => {
        const r = await write("/api/admin/models/sources/update", { sourceId: s.id, billing: sel.value });
        note(r.ok, r.ok ? "Billing changed." : r.data.message || "That did not work.");
        await reload();
      } }, "Save billing"));
    }
    return h(
      "div",
      {},
      s.hasKey && !st.replacingKey ? h("p", {}, "Key saved ", h("button", { class: "btn btn-small", type: "button", onclick: () => {
        st.replacingKey = true;
        drawMain();
      } }, "Replace key")) : keyForm,
      billing,
      h("button", { class: "btn btn-small btn-danger", type: "button", onclick: () => removeOne("/api/admin/models/sources/remove", { sourceId: s.id }, s.id) }, "Remove provider"),
    );
  }

  function addProviderForm() {
    const name = h("input", { type: "text", name: "label", maxlength: "40", autocomplete: "off" });
    const url = h("input", { type: "text", name: "baseUrl", autocomplete: "off", spellcheck: "false", placeholder: "https://openrouter.ai/api/v1" });
    const key = h("input", { type: "password", name: "apiKey", autocomplete: "new-password", maxlength: "512" });
    const asCloud = h("input", { type: "checkbox", name: "treatAsCloud", onchange: sync });
    const mkRadio = (value, text) => h("label", { class: "check" }, h("input", { type: "radio", name: "billing", value, onchange: sync }), text);
    const rSub = mkRadio("subscription", "Free or subscription");
    const rPaid = mkRadio("paid", "Paid per use");
    const asCloudBox = h("label", { class: "check" }, asCloud, "Treat as cloud (for a local URL that relays to a vendor)");
    const billingBox = h("fieldset", {}, h("legend", {}, "Billing (required for a cloud provider)"), rSub, rPaid);
    const egress = h("p", { class: "banner banner-warn" });
    const err = h("p", { class: "banner banner-error", role: "alert" });
    const isLoopback = () => LOOPBACK.has(hostOf(url.value.trim()));
    const isCloud = () => !!url.value.trim() && (!isLoopback() || asCloud.checked);
    function sync() {
      const cloud = isCloud();
      asCloudBox.hidden = !(url.value.trim() && isLoopback());
      billingBox.hidden = !cloud;
      egress.hidden = !cloud;
      err.hidden = true;
      egress.textContent = `Cloud: your bots' messages and tool results go to ${hostOf(url.value.trim()) || "this host"}; check that provider's terms.`;
    }
    const form = h(
      "form",
      { class: "card", onsubmit: async (ev) => {
        ev.preventDefault();
        const apiKey = key.value;
        key.value = ""; // the key is never kept after submit
        const cloud = isCloud();
        const billing = rPaid.querySelector("input").checked ? "paid" : rSub.querySelector("input").checked ? "subscription" : "";
        if (cloud && !billing) {
          err.textContent = "Choose how this provider is billed.";
          err.hidden = false;
          return;
        }
        const body = { label: name.value.trim(), baseUrl: url.value.trim() };
        if (apiKey) body.apiKey = apiKey;
        if (cloud) body.billing = billing;
        if (isLoopback() && asCloud.checked) body.treatAsCloud = true;
        const r = await write("/api/admin/models/sources/add", body);
        if (!r.ok) {
          err.textContent = `${r.data.message || "Could not add the provider."} Type the key again if you use one.`;
          err.hidden = false;
          return;
        }
        st.adding = false;
        st.sel = r.data.sourceId || "";
        note(true, "Provider added. Press Fetch models.");
        await reload();
      } },
      h("h2", {}, "Add provider"),
      h("p", { class: "muted small" }, "Any OpenAI-compatible service. A cloud URL must be https. The base URL cannot be changed later: remove the provider and add it again."),
      field("Name", name),
      field("Base URL", url, "Ends in /v1, for example http://127.0.0.1:1234/v1 or https://openrouter.ai/api/v1."),
      field("API key (optional)", key, "Stored sealed on the server. It is never shown again."),
      asCloudBox,
      billingBox,
      egress,
      err,
      h("div", { class: "row" }, h("button", { class: "btn btn-primary", type: "submit" }, "Add provider"), h("button", { class: "btn", type: "button", onclick: () => {
        st.adding = false;
        draw();
      } }, "Cancel")),
    );
    url.addEventListener("input", sync);
    sync();
    return form;
  }

  await reload();
  return h("section", { "aria-labelledby": "models-title" }, h("h1", { id: "models-title" }, "Models"), h("p", { class: "muted" }, "Fetch a provider's model list, tick the models to add, and they are usable by your web bots at once. Other people get a model only through their limits in Admin. Telegram bots use only the presets of the settings UI."), out, bannersEl, h("div", { class: "models" }, listEl, mainEl));
}

// The per-user checklist on the Admin page: the catalogue presets, ticked from the user's caps. Returns the element; `save(ids)` posts the caps.
export async function renderPresetChecklist(ctx, user, save) {
  const r = await ctx.api.call("/api/admin/models/list", {});
  if (!r.ok) return h("p", { class: "banner banner-error", role: "alert" }, r.data.message || "Could not load the models.");
  const have = new Set(Array.isArray(user.caps.presets) ? user.caps.presets : []);
  const boxes = r.data.presets.map((p) => ({ p, cb: h("input", { type: "checkbox", value: p.id, checked: have.has(p.id) }) }));
  return h(
    "div",
    { class: "card" },
    h("p", { class: "muted small" }, `Models ${user.displayName} may use:`),
    h("ul", { class: "plainlist", role: "list" }, boxes.map(({ p, cb }) => h("li", {}, h("label", { class: "check" }, cb, h("span", {}, p.label, " ", privacyBadge(p.privacy), p.billing === "paid" ? h("span", { class: "badge badge-cloud" }, "paid") : null, " ", h("code", {}, p.id)))))),
    boxes.length === 0 ? h("p", { class: "muted" }, "No model presets yet. Add some on the Models page.") : null,
    h("button", { class: "btn btn-small btn-primary", type: "button", onclick: () => save(boxes.filter((x) => x.cb.checked).map((x) => x.p.id)) }, "Save models"),
  );
}
