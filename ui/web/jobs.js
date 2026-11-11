// Browser sessions (REQ-0014, owner only): the jobs the agent ran in its browser and the screenshots of each. Images come from the
// authenticated same-origin route /api/owner/artifact (the CSP allows img-src 'self' only). Every value is set as text (I57).
import { clear, h, when } from "./dom.js";

const shotUrl = (path) => `/api/owner/artifact?path=${encodeURIComponent(path)}`;

export async function renderJobs(ctx) {
  const root = h("section", { class: "jobs", "aria-labelledby": "jobs-h" });
  const list = h("div", { class: "jobs-list" });
  const view = h("div", { class: "jobs-view" });
  const st = { jobs: [], sel: "", shot: "" };

  function drawShot(job) {
    const s = job.shots.find((x) => x.path === st.shot);
    if (!s) return null;
    return h(
      "figure",
      { class: "jobs-full" },
      h("img", { src: shotUrl(s.path), alt: s.caption || "Screenshot" }),
      h("figcaption", {}, s.caption || "", " ", h("button", { class: "btn btn-small", type: "button", onclick: () => ((st.shot = ""), draw()) }, "Close")),
    );
  }

  function draw() {
    clear(
      list,
      st.jobs.length === 0
        ? h("div", { class: "empty" }, h("p", {}, "No browser sessions yet"))
        : h(
            "ul",
            { class: "plainlist", role: "list" },
            st.jobs.map((j) =>
              h(
                "li",
                {},
                h(
                  "button",
                  { class: j.jobId === st.sel ? "btn jobs-row current" : "btn jobs-row", type: "button", "aria-pressed": j.jobId === st.sel ? "true" : "false", onclick: () => ((st.sel = j.jobId), (st.shot = ""), draw()) },
                  h("span", { class: "jobs-when" }, when(j.startedAt)),
                  h("span", { class: j.state === "succeeded" ? "chip chip-ok" : j.state === "running" ? "chip chip-running" : "chip chip-error" }, j.state),
                  h("span", { class: "jobs-count" }, `${j.shots.length} screenshot${j.shots.length === 1 ? "" : "s"}`),
                ),
              ),
            ),
          ),
    );
    const job = st.jobs.find((j) => j.jobId === st.sel);
    clear(
      view,
      job
        ? [
            h("h2", {}, job.templateId),
            h("p", { class: "help mono" }, job.jobId),
            drawShot(job),
            h(
              "ul",
              { class: "jobs-shots", role: "list" },
              job.shots.map((s) =>
                h(
                  "li",
                  {},
                  h("button", { class: "jobs-thumb", type: "button", "aria-label": `Open: ${s.caption || "screenshot"}`, onclick: () => ((st.shot = s.path), draw()) }, h("img", { src: shotUrl(s.path), alt: "", loading: "lazy" })),
                  h("span", { class: "jobs-cap" }, s.caption || ""),
                ),
              ),
            ),
          ]
        : null,
    );
  }

  clear(root, h("h1", { id: "jobs-h" }, "Browser sessions"), h("div", { class: "jobs-grid" }, list, view));
  const r = await ctx.api.get("/api/owner/jobs");
  if (r.ok) {
    st.jobs = (r.data.jobs || []).filter((j) => j && typeof j.jobId === "string" && Array.isArray(j.shots));
    st.sel = st.jobs[0]?.jobId || "";
  } else clear(root, h("h1", { id: "jobs-h" }, "Browser sessions"), h("p", { class: "banner banner-error", role: "alert" }, r.status === 404 ? "Screenshots are not set up on this gateway (paths.jobArtifactsDir)." : (r.data && r.data.message) || "Could not load the browser sessions."));
  if (r.ok) draw();
  return root;
}
