// A small, safe Markdown parser (S35). It returns a tree of plain objects and NEVER passes HTML through: every piece of text stays text,
// links are kept only for http, https and mailto, and images are not rendered at all (an image link becomes its alt text as a plain link).
// The DOM builder (markdown.js) turns the tree into elements with textContent, so nothing here can inject markup. No imports, so it runs in Node tests.

const LINK_OK = /^(https?:\/\/|mailto:)/i;

/** For each position, the index of the next character passing `test` at or after it (src.length when there is none); one backward pass. */
function nextOf(src, test) {
  const next = new Int32Array(src.length + 2).fill(src.length);
  for (let k = src.length - 1; k >= 0; k--) next[k] = test(src[k]) ? k : next[k + 1];
  return next;
}
const WS = /\s/;

/**
 * Inline spans: `code`, **bold**, *italic*, [text](url). Linear time: every closing delimiter is found with a precomputed next-index table, never
 * by rescanning the rest of the line, so pathological input such as `*[` repeated 20,000 times stays fast. The output is the same as the
 * anchored-regex version it replaced: code, bold, italic content is one or more characters other than its delimiter and a newline; a link is
 * [label](url) with no newline or "]" in the label and no ")" or whitespace in the url.
 */
export function parseInline(src) {
  const n = src.length;
  const nl = nextOf(src, (c) => c === "\n");
  const tick = nextOf(src, (c) => c === "`");
  const star = nextOf(src, (c) => c === "*");
  const under = nextOf(src, (c) => c === "_");
  const close = nextOf(src, (c) => c === "]");
  const paren = nextOf(src, (c) => c === ")");
  const ws = nextOf(src, (c) => WS.test(c));
  // The end of a run of at least one character that is not `delim` or a newline, closed by `delim`; -1 when there is none.
  const closer = (from, table) => {
    const j = table[from];
    return j > from && j < n && j < nl[from] ? j : -1;
  };
  const out = [];
  let i = 0;
  let text = "";
  const flush = () => {
    if (text) out.push({ t: "text", v: text });
    text = "";
  };
  while (i < n) {
    const c = src[i];
    let j;
    if (c === "`" && (j = closer(i + 1, tick)) >= 0) {
      flush();
      out.push({ t: "code", v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (c === "*" && src[i + 1] === "*" && (j = closer(i + 2, star)) >= 0 && src[j + 1] === "*") {
      flush();
      out.push({ t: "strong", c: parseInline(src.slice(i + 2, j)) });
      i = j + 2;
      continue;
    }
    if ((c === "*" && (j = closer(i + 1, star)) >= 0) || (c === "_" && (j = closer(i + 1, under)) >= 0)) {
      flush();
      out.push({ t: "em", c: parseInline(src.slice(i + 1, j)) });
      i = j + 1;
      continue;
    }
    const isImage = c === "!";
    const b = isImage ? i + 1 : i;
    if (src[b] === "[") {
      const e = close[b + 1];
      if (e < n && e < nl[b + 1] && src[e + 1] === "(") {
        const p = paren[e + 2];
        if (p < n && p < ws[e + 2]) {
          const label = src.slice(b + 1, e);
          const url = src.slice(e + 2, p);
          flush();
          if (!isImage && LINK_OK.test(url)) out.push({ t: "link", href: url, c: [{ t: "text", v: label || url }] });
          else out.push({ t: "text", v: isImage ? `[image: ${label}]` : src.slice(i, p + 1) });
          i = p + 1;
          continue;
        }
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

const cells = (line) => {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
};
const isSep = (line) => line.includes("-") && cells(line).every((c) => /^:?-+:?$/.test(c));

/** Blocks: paragraphs, headings, fenced code, tables, rules, lists, quotes. */
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
    if ((m = /^```([^`]*)$/.exec(line))) {
      endPara();
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      blocks.push({ t: "pre", v: code.join("\n"), lang: (m[1].trim().split(/\s+/)[0] ?? "").replace(/[^A-Za-z0-9]/g, "") });
    } else if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && isSep(lines[i + 1]) && cells(line).length === cells(lines[i + 1]).length) {
      endPara();
      const head = cells(line).map(parseInline);
      const rows = [];
      i++;
      while (i + 1 < lines.length && lines[i + 1].trim() !== "" && lines[i + 1].includes("|")) {
        const r = cells(lines[++i]);
        rows.push(head.map((_, k) => parseInline(r[k] ?? "")));
      }
      blocks.push({ t: "table", head, rows });
    } else if (/^\s*---+\s*$/.test(line)) {
      endPara();
      blocks.push({ t: "hr" });
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

/**
 * Follows a growing Markdown text (the live answer) and returns where its finished blocks end: just after the last blank line outside a
 * fenced code block. A blank line outside a fence closes every block, so parseMarkdown(text) equals the blocks of text.slice(0, cut) followed
 * by those of text.slice(cut). Only new complete lines are scanned, so following a whole answer is linear. A fence line with a "|" could be
 * a table row instead of a fence, so after one the cutter stops cutting (the rest renders as one open block, which is always exact).
 */
export function blockCutter() {
  let scanned = 0;
  let inFence = false;
  let stuck = false;
  let cut = 0;
  return (text) => {
    let nl;
    while ((nl = text.indexOf("\n", scanned)) >= 0) {
      let blank = false;
      // parseMarkdown also splits at a lone "\r".
      for (const line of text.slice(scanned, nl).replace(/\r$/, "").split("\r")) {
        blank = false;
        if (inFence) inFence = !/^```\s*$/.test(line);
        else if (/^```([^`]*)$/.test(line)) {
          inFence = true;
          if (line.includes("|")) stuck = true;
        } else blank = line.trim() === "";
      }
      scanned = nl + 1;
      if (blank && !stuck) cut = scanned;
    }
    return cut;
  };
}
