// The views that are not generated from one schema: overview, audit tail, preferences, job templates and personas.
// All text from the server is set with textContent (through h()).
import { checklist, h, humanize } from "./forms.js";

function when(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function short(rev) {
  return rev ? String(rev).slice(0, 8) : "none";
}

export function issuesBanner(title, issues) {
  const list = h("ul", {}, (issues || []).map((i) => h("li", {}, i)));
  return h("div", { class: "banner banner-error", role: "alert" }, h("strong", {}, title), list);
}

export async function renderStatus(api) {
  const [status, prefs] = await Promise.all([api.get("/api/status"), api.get("/api/prefs")]);
  const root = h("div", {});
  if (!status.ok) {
    root.append(h("p", { class: "banner banner-error" }, status.body.message || "Could not load the status."));
    return root;
  }
  const s = status.body;
  if (s.restartRequired) {
    root.append(h("p", { class: "banner banner-warn", role: "status" }, "The agent is still running the older security settings. Send /applysettings in Telegram to restart it with the new ones."));
  } else if (s.runningRevision) {
    root.append(h("p", { class: "banner banner-ok" }, "The agent is running the current security settings."));
  } else {
    root.append(h("p", { class: "banner banner-info" }, "The agent has not reported which revision it runs yet (it does when it starts)."));
  }
  root.append(
    h("div", { class: "card" }, h("h2", {}, "Security settings"), h("dl", { class: "kv" },
      h("dt", {}, "File revision"), h("dd", { class: "mono" }, short(s.fileRevision)),
      h("dt", {}, "Running revision"), h("dd", { class: "mono" }, short(s.runningRevision)),
      h("dt", {}, "Last audited"), h("dd", { class: "mono" }, short(s.lastAudited)))),
  );
  if (s.invalidPersonas.length > 0) {
    root.append(h("div", { class: "banner banner-warn" }, h("strong", {}, "Personas that cannot be used right now"), h("ul", {}, s.invalidPersonas.map((p) => h("li", {}, `${p.id}: ${p.reasons.join("; ")}`)))));
  }
  root.append(h("div", { class: "card" }, h("h2", {}, "Kill switch"), h("p", {}, s.killSwitchNote)));
  if (prefs.ok) {
    const st = prefs.body.prefs.style;
    root.append(
      h("div", { class: "card" }, h("h2", {}, "Preferences"), h("p", { class: "muted" }, prefs.body.note),
        h("dl", { class: "kv" }, ...["tone", "verbosity", "language"].flatMap((k) => [h("dt", {}, humanize(k)), h("dd", {}, st[k])]), h("dt", {}, "Default persona"), h("dd", {}, prefs.body.prefs.defaultPersona))),
    );
  }
  return root;
}

export async function renderAudit(api) {
  const root = h("div", {});
  const select = h("select", { id: "audit-limit", "aria-label": "How many lines" }, ...[50, 100, 200].map((n) => h("option", { value: String(n) }, `Last ${n}`)));
  const holder = h("div", {});
  const load = async () => {
    const r = await api.get(`/api/audit?limit=${select.value}`);
    holder.replaceChildren();
    if (!r.ok) {
      holder.append(h("p", { class: "banner banner-error" }, r.body.message || "Could not load the audit log."));
      return;
    }
    const lines = [...r.body.lines].reverse();
    if (lines.length === 0) {
      holder.append(h("p", { class: "muted" }, "Nothing has been audited yet."));
      return;
    }
    const tbody = h("tbody", {});
    for (const l of lines) {
      const who = l.approver ? (l.approver.kind === "tg" ? `Telegram ${l.approver.userId ?? ""}` : `UI ${l.approver.sessionHash ?? ""}`) : l.writer;
      const detail = h("details", {}, h("summary", {}, "Details"), h("pre", {}, JSON.stringify({ diff: l.diff, base: short(l.baseRevision), after: short(l.afterRevision), note: l.note, proposal: l.proposalId, wseq: l.wseq }, null, 2)));
      tbody.append(h("tr", {}, h("td", {}, when(l.ts)), h("td", {}, l.source), h("td", {}, l.kind), h("td", {}, h("span", { class: `badge ${["rejected", "invalid", "apply_failed", "expired"].includes(l.decision) ? "badge-bad" : "badge-ok"}` }, l.decision)), h("td", { class: "mono" }, `${l.target.file} ${l.target.path}`), h("td", {}, who), h("td", {}, detail)));
    }
    holder.append(h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, ...["When", "Source", "Kind", "Decision", "Target", "By", ""].map((c) => h("th", { scope: "col" }, c)))), tbody)));
  };
  select.addEventListener("change", load);
  const refresh = h("button", { type: "button", class: "btn" }, "Refresh");
  refresh.addEventListener("click", load);
  root.append(h("div", { class: "actions" }, h("label", { for: "audit-limit", class: "sr-only" }, "How many lines"), select, refresh), holder);
  await load();
  return root;
}

const TEMPLATE_SKELETON = {
  id: "",
  title: "",
  description: "",
  engine: "claude",
  cwd: "C:\\projects\\Personal\\creative-hub",
  prompt: "Describe the job here.\n<brief>{{brief}}</brief>",
  params: { type: "object", properties: {} },
  permissionMode: "default",
  allowedTools: ["Read", "Glob", "Grep"],
  disallowedTools: ["Bash", "PowerShell"],
  mcpServers: [],
  flow: { enabled: false },
  paidModels: false,
  autostart: [],
  timeoutMin: 30,
};

export async function renderTemplates(api, toast) {
  const root = h("div", {});
  const r = await api.get("/api/templates");
  if (!r.ok) {
    root.append(h("p", { class: "banner banner-error" }, r.body.message || "Could not load the templates."));
    return root;
  }
  root.append(h("p", { class: "banner banner-info" }, "A template is checked by the same rules the job runner uses: a template that skips the permission prompts, or keeps a shell tool, is refused."));
  const editor = (item) => {
    const text = h("textarea", { class: "mono", "aria-label": `Template ${item ? item.file : "new"} (JSON)`, spellcheck: "false" });
    text.value = JSON.stringify(item ? item.doc : TEMPLATE_SKELETON, null, 2);
    const out = h("div", {});
    const save = h("button", { type: "button", class: "btn btn-primary" }, "Save template");
    save.addEventListener("click", async () => {
      out.replaceChildren();
      let doc;
      try {
        doc = JSON.parse(text.value);
      } catch (e) {
        out.append(issuesBanner("Not valid JSON", [String(e.message)]));
        return;
      }
      const res = await api.post("/api/templates/save", { doc, baseRevision: item ? item.revision : api.absent });
      if (res.ok) {
        toast("Template saved.", "ok");
        if (item) item.revision = res.body.revision;
        else window.location.reload();
      } else out.append(issuesBanner(res.body.message || "The template was not saved.", res.body.issues || []));
    });
    return h("div", {}, text, h("div", { class: "actions" }, save), out);
  };
  for (const item of r.body.items) {
    const t = item.doc || {};
    root.append(
      h("div", { class: "card" }, h("h2", {}, t.title || item.file), h("p", { class: "muted" }, `${item.file} - engine ${t.engine || "?"} `, h("span", { class: `badge ${item.errors.length === 0 ? "badge-ok" : "badge-bad"}` }, item.errors.length === 0 ? "valid" : "has problems")),
        item.errors.length > 0 ? issuesBanner("Problems", item.errors) : null,
        h("details", {}, h("summary", {}, "Edit"), editor(item))),
    );
  }
  root.append(h("div", { class: "card" }, h("h2", {}, "New template"), h("details", {}, h("summary", {}, "Start from a skeleton"), editor(null))));
  return root;
}

const WRITE_CHOICES = [["none", "Never write memory"], ["scope", "Write to its own memory file"], ["shared", "Write to the shared memory"]];

function personaEditor(api, schemaInfo, existing, onSaved, toast) {
  const c = schemaInfo.ceiling;
  const p = existing ? existing.doc : { id: "", name: "", prompt: "", toolAllow: [], mcpAllow: {}, jobTemplates: [], modelPreset: c.defaultPreset, memory: { write: "none", sharedRead: true }, budgets: {} };
  const id = h("input", { type: "text", spellcheck: "false", autocomplete: "off", maxlength: 24 });
  id.value = p.id || "";
  if (existing) id.disabled = true;
  const name = h("input", { type: "text", maxlength: 60 });
  name.value = p.name || "";
  const description = h("input", { type: "text", maxlength: 200 });
  description.value = p.description || "";
  const prompt = h("textarea", { rows: 8, maxlength: 4000 });
  prompt.value = p.prompt || "";
  const tools = checklist(c.tools, p.toolAllow, "Tools this persona may use", "Only tools the security settings allow are listed. A persona can narrow, never widen.");
  const mcp = Object.entries(c.mcp).map(([server, list]) => [server, checklist(list, (p.mcpAllow || {})[server], `MCP tools on ${server}`)]);
  const templates = checklist(c.jobTemplates, p.jobTemplates, "Job templates this persona may dispatch");
  const preset = h("select", {}, c.presets.map((x) => h("option", { value: x }, x)));
  preset.value = c.presets.includes(p.modelPreset) ? p.modelPreset : c.defaultPreset;
  const write = h("select", {}, WRITE_CHOICES.map(([v, t]) => h("option", { value: v }, t)));
  write.value = p.memory.write;
  const scope = h("input", { type: "text", maxlength: 24, placeholder: "defaults to the persona id", spellcheck: "false" });
  scope.value = p.memory.scope || "";
  const sharedRead = h("input", { type: "checkbox" });
  sharedRead.checked = p.memory.sharedRead !== false;
  const jobs = h("input", { type: "number", min: 0, max: 10000, step: 1, placeholder: c.maxJobsPerDay === null ? "no cap" : `at most ${c.maxJobsPerDay}` });
  jobs.value = p.budgets && p.budgets.maxJobsPerDay !== undefined ? String(p.budgets.maxJobsPerDay) : "";
  const out = h("div", {});
  const field = (label, control, help) => {
    const fid = control.id || `pe-${Math.random().toString(36).slice(2, 8)}`;
    control.id = fid;
    return h("div", { class: "field" }, h("label", { for: fid }, label), control, help ? h("p", { class: "help" }, help) : null);
  };
  const collect = () => ({
    id: id.value.trim(),
    name: name.value.trim(),
    ...(description.value.trim() ? { description: description.value.trim() } : {}),
    prompt: prompt.value,
    toolAllow: tools.get(),
    mcpAllow: Object.fromEntries(mcp.map(([s, cl]) => [s, cl.get()]).filter(([, l]) => l.length > 0)),
    jobTemplates: templates.get(),
    modelPreset: preset.value,
    memory: { write: write.value, sharedRead: sharedRead.checked, ...(write.value === "scope" && scope.value.trim() ? { scope: scope.value.trim() } : {}) },
    budgets: jobs.value === "" ? {} : { maxJobsPerDay: Number(jobs.value) },
  });
  const fill = (d) => {
    id.value = existing ? id.value : d.id || "";
    name.value = d.name || "";
    description.value = d.description || "";
    prompt.value = d.prompt || "";
    for (const box of tools.el.querySelectorAll("input[type=checkbox]")) box.checked = (d.toolAllow || []).includes(box.nextSibling.textContent);
    for (const [s, cl] of mcp) for (const box of cl.el.querySelectorAll("input[type=checkbox]")) box.checked = ((d.mcpAllow || {})[s] || []).includes(box.nextSibling.textContent);
    for (const box of templates.el.querySelectorAll("input[type=checkbox]")) box.checked = (d.jobTemplates || []).includes(box.nextSibling.textContent);
    if (d.modelPreset && c.presets.includes(d.modelPreset)) preset.value = d.modelPreset;
    write.value = d.memory && ["none", "scope", "shared"].includes(d.memory.write) ? d.memory.write : "none";
    scope.value = (d.memory && d.memory.scope) || "";
    sharedRead.checked = !d.memory || d.memory.sharedRead !== false;
    jobs.value = d.budgets && d.budgets.maxJobsPerDay !== undefined ? String(d.budgets.maxJobsPerDay) : "";
  };
  const paste = h("textarea", { class: "mono", "aria-label": "A persona draft as JSON", spellcheck: "false", rows: 8 });
  const fillBtn = h("button", { type: "button", class: "btn btn-small" }, "Fill the form from this draft");
  fillBtn.addEventListener("click", () => {
    try {
      fill(JSON.parse(paste.value));
      out.replaceChildren();
    } catch (e) {
      out.replaceChildren(issuesBanner("Not valid JSON", [String(e.message)]));
    }
  });
  const save = h("button", { type: "button", class: "btn btn-primary" }, existing ? "Save persona" : "Create persona");
  save.addEventListener("click", async () => {
    out.replaceChildren();
    const res = await api.post("/api/personas/save", { persona: collect(), baseRevision: existing ? existing.revision : api.absent });
    if (res.ok) {
      toast(res.body.message || "Saved.", "ok");
      onSaved();
    } else out.append(issuesBanner(res.body.message || "The persona was not saved.", res.body.issues || []));
  });
  const del = existing ? h("button", { type: "button", class: "btn btn-danger" }, "Delete persona") : null;
  if (del) {
    del.addEventListener("click", async () => {
      if (!window.confirm(`Delete the persona ${existing.id}?`)) return;
      const res = await api.post("/api/personas/delete", { id: existing.id, baseRevision: existing.revision });
      if (res.ok) {
        toast("Persona deleted.", "ok");
        onSaved();
      } else out.append(issuesBanner(res.body.message || "Not deleted.", []));
    });
  }
  return h("div", {},
    field("Id", id, existing ? "The id cannot be changed." : "Lowercase letters, digits and dashes, starting with a letter."),
    field("Name", name), field("Description", description), field("Prompt", prompt, "Plain text. It is added to the system prompt and cannot grant any permission."),
    tools.el, ...mcp.map(([, cl]) => cl.el), templates.el,
    field("Model preset", preset, "One of the security presets."),
    h("fieldset", {}, h("legend", {}, "Memory"), field("Writes", write), field("Memory scope", scope, "Only used when it writes to its own file."), h("div", { class: "field" }, h("label", { class: "check" }, sharedRead, h("span", {}, "Read the shared memory notes")))),
    field("Jobs per day", jobs, "Leave empty for the ceiling."),
    h("details", {}, h("summary", {}, "Paste a draft (JSON)"), paste, h("div", { class: "actions" }, fillBtn)),
    h("div", { class: "actions" }, save, del), out);
}

export async function renderPersonas(api, toast, reload) {
  const root = h("div", {});
  const r = await api.get("/api/personas");
  if (!r.ok) {
    root.append(h("p", { class: "banner banner-error" }, r.body.message || "Could not load the personas."));
    return root;
  }
  const info = r.body;
  if (!info.ceiling) {
    root.append(h("p", { class: "banner banner-error" }, "There are no security settings yet, so personas cannot be checked."));
    return root;
  }
  root.append(h("p", { class: "banner banner-info" }, `A persona can only narrow what the security settings allow. Built in: ${info.builtin.join(", ")}. Up to ${info.max} personas. A persona that asks for more than is allowed is refused, never trimmed.`));
  for (const p of info.personas) {
    const d = p.doc || {};
    root.append(
      h("div", { class: "card" }, h("h2", {}, d.name || p.id), h("p", { class: "muted" }, `${p.id} `, h("span", { class: `badge ${p.valid ? "badge-ok" : "badge-bad"}` }, p.valid ? "valid" : "not usable right now")),
        p.valid ? null : issuesBanner("Why it cannot be used", p.reasons),
        h("details", {}, h("summary", {}, "Edit"), personaEditor(api, info, { id: p.id, doc: d, revision: p.revision }, reload, toast))),
    );
  }
  root.append(h("div", { class: "card" }, h("h2", {}, "New persona"), h("details", {}, h("summary", {}, "Create a persona"), personaEditor(api, info, null, reload, toast))));
  return root;
}
