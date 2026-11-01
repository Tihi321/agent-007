/** A tiny DOM stand-in for the web UI tests (there is no browser or jsdom here). Only what ui/common/dom.js and the views use. Not a test file. */
export class FNode {
  childNodes: FNode[] = [];
  parent: FNode | null = null;
  append(...kids: (FNode | string)[]): void {
    for (const k of kids) {
      const n = typeof k === "string" ? new FText(k) : k;
      n.parent = this;
      this.childNodes.push(n);
    }
  }
  replaceChildren(...kids: (FNode | string)[]): void {
    for (const c of this.childNodes) c.parent = null;
    this.childNodes = [];
    this.append(...kids);
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.childNodes = [];
    if (v !== "") this.append(v);
  }
}

export class FText extends FNode {
  constructor(readonly data: string) {
    super();
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(_v: string) {}
}

export class FElement extends FNode {
  attrs = new Map<string, string>();
  listeners: Record<string, ((e: any) => unknown)[]> = {};
  className = "";
  hidden = false;
  disabled = false;
  checked = false;
  selected = false;
  value = "";
  scrollTop = 0;
  scrollHeight = 0;
  dispose?: () => void;
  constructor(readonly tagName: string) {
    super();
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
    if (k === "value") this.value = v;
    if (k === "checked") this.checked = true;
    if (k === "selected") this.selected = true;
    if (k === "hidden") this.hidden = true;
    if (k === "disabled") this.disabled = true;
    if (k === "class") this.className = v;
  }
  getAttribute(k: string): string | null {
    if (k === "class") return this.className || null;
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  addEventListener(t: string, fn: (e: any) => unknown): void {
    (this.listeners[t] ??= []).push(fn);
  }
  async fire(t: string, ev: Record<string, unknown> = {}): Promise<void> {
    const e = { preventDefault() {}, key: "", shiftKey: false, ...ev };
    for (const l of this.listeners[t] ?? []) await l(e);
  }
  focus(): void {}
  get options(): FElement[] {
    return all(this).filter((x) => x.tagName === "option");
  }
}

export const fakeDocument = {
  createElement: (t: string) => new FElement(t),
  createTextNode: (s: string) => new FText(s),
};

export function all(root: FNode): FElement[] {
  const out: FElement[] = [];
  const walk = (n: FNode): void => {
    for (const c of n.childNodes) {
      if (c instanceof FElement) out.push(c);
      walk(c);
    }
  };
  if (root instanceof FElement) out.push(root);
  walk(root);
  return out;
}

export const byTag = (root: FNode, tag: string): FElement[] => all(root).filter((e) => e.tagName === tag);
export const byName = (root: FNode, name: string): FElement => {
  const e = all(root).find((x) => x.getAttribute("name") === name);
  if (!e) throw new Error(`no field named ${name}`);
  return e;
};
export const buttonByText = (root: FNode, text: string): FElement => {
  const e = all(root).find((x) => x.tagName === "button" && x.textContent.trim() === text);
  if (!e) throw new Error(`no button "${text}" (have: ${byTag(root, "button").map((b) => b.textContent.trim()).join(" | ")})`);
  return e;
};
