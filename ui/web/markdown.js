// Turns the safe Markdown tree into DOM nodes (S35). Text goes in as text nodes. Links open in a new tab with rel="noopener noreferrer".
import { h } from "./dom.js";
import { parseMarkdown } from "./markdown-parse.js";

function inline(nodes) {
  return nodes.map((n) => {
    if (n.t === "text") return n.v;
    if (n.t === "code") return h("code", {}, n.v);
    if (n.t === "strong") return h("strong", {}, inline(n.c));
    if (n.t === "em") return h("em", {}, inline(n.c));
    if (n.t === "link") return h("a", { href: n.href, target: "_blank", rel: "noopener noreferrer" }, inline(n.c));
    return "";
  });
}

export function renderMarkdown(src) {
  const root = h("div", { class: "md" });
  for (const b of parseMarkdown(src)) {
    if (b.t === "p") root.append(h("p", {}, inline(b.c)));
    else if (b.t === "h") root.append(h(`h${Math.min(6, b.level + 2)}`, {}, inline(b.c)));
    else if (b.t === "pre") root.append(h("pre", {}, h("code", {}, b.v)));
    else if (b.t === "ul" || b.t === "ol") root.append(h(b.t, {}, b.items.map((it) => h("li", {}, inline(it)))));
    else if (b.t === "quote") root.append(h("blockquote", {}, inline(b.c)));
  }
  return root;
}
