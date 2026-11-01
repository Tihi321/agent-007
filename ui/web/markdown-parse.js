// A small, safe Markdown parser (S35). It returns a tree of plain objects and NEVER passes HTML through: every piece of text stays text,
// links are kept only for http, https and mailto, and images are not rendered at all (an image link becomes its alt text as a plain link).
// The DOM builder (markdown.js) turns the tree into elements with textContent, so nothing here can inject markup. No imports, so it runs in Node tests.

const LINK_OK = /^(https?:\/\/|mailto:)/i;

/** Inline spans: `code`, **bold**, *italic*, [text](url). */
export function parseInline(src) {
  const out = [];
  let i = 0;
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush();
      out.push({ t: "code", v: m[1] });
      i += m[0].length;
    } else if ((m = /^\*\*([^*\n]+)\*\*/.exec(rest))) {
      flush();
      out.push({ t: "strong", c: parseInline(m[1]) });
      i += m[0].length;
    } else if ((m = /^\*([^*\n]+)\*/.exec(rest)) || (m = /^_([^_\n]+)_/.exec(rest))) {
      flush();
      out.push({ t: "em", c: parseInline(m[1]) });
      i += m[0].length;
    } else if ((m = /^!?\[([^\]\n]*)\]\(([^)\s]*)\)/.exec(rest))) {
      flush();
      const isImage = rest.startsWith("!");
      const label = m[1] || m[2];
      if (!isImage && LINK_OK.test(m[2])) out.push({ t: "link", href: m[2], c: [{ t: "text", v: label }] });
      else out.push({ t: "text", v: isImage ? `[image: ${m[1]}]` : m[0] });
      i += m[0].length;
    } else {
      text += src[i];
      i++;
    }
  }
  flush();
  return out;
}

/** Blocks: paragraphs, headings, fenced code, lists, quotes. */
export function parseMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^```(\w*)\s*$/.exec(line))) {
      endPara();
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      blocks.push({ t: "pre", v: code.join("\n"), lang: m[1] });
    } else if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      endPara();
      blocks.push({ t: "h", level: m[1].length, c: parseInline(m[2]) });
    } else if ((m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line))) {
      endPara();
      const ordered = /\d/.test(m[1]);
      const items = [parseInline(m[2])];
      while (i + 1 < lines.length && (m = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i + 1])) && /\d/.test(m[1]) === ordered) {
        items.push(parseInline(m[2]));
        i++;
      }
      blocks.push({ t: ordered ? "ol" : "ul", items });
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      endPara();
      const q = [m[1]];
      while (i + 1 < lines.length && (m = /^>\s?(.*)$/.exec(lines[i + 1]))) {
        q.push(m[1]);
        i++;
      }
      blocks.push({ t: "quote", c: parseInline(q.join(" ")) });
    } else if (line.trim() === "") endPara();
    else para.push(line.trim());
  }
  endPara();
  return blocks;
}
