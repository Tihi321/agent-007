/** REQ-0014 browser backend interface (owner T3). Types only; the real one is `playwright.ts`, tests use a fake. */
import type { BrowserKey } from "../../../jobs/browserContracts.js";

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  value?: string;
  inForm: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: SnapshotElement[];
  truncated: boolean;
}

export interface ElementFacts {
  ref: string;
  tag: string;
  type: string;
  role: string;
  /** accessible name / text / value, <= 120 chars */
  name: string;
  autocomplete: string;
  nameAttr: string;
  idAttr: string;
  inForm: boolean;
  /** submit button, input[type=submit|image], or <button> without type in a form */
  isSubmit: boolean;
  formAction: string;
  formHasPassword: boolean;
  href: string;
  contentEditable: boolean;
  /** textarea, or role=textbox with aria-multiline=true */
  multiline: boolean;
  visible: boolean;
}

export interface LaunchOptions {
  profileDir: string;
  headless: boolean;
  browsersDir: string;
  proxy: { server: string; username: string; password: string };
  viewport: { width: 1280; height: 800 };
}

export interface BrowserSession {
  goto(url: string): Promise<{ url: string; title: string; status?: number }>;
  back(): Promise<{ url: string; title: string }>;
  /** tags interactive elements with data-a7-ref="eN"; password values never returned */
  snapshot(maxChars: number): Promise<PageSnapshot>;
  facts(ref: string): Promise<ElementFacts | undefined>;
  /** Facts of `document.activeElement` (tagged with a ref when it has none); undefined when nothing but the page has focus. Throws when unreadable. */
  activeFacts(): Promise<ElementFacts | undefined>;
  click(ref: string): Promise<void>;
  type(ref: string, text: string, clear: boolean): Promise<void>;
  /** select: option by label, then by value */
  fill(ref: string, value: string): Promise<void>;
  press(key: BrowserKey, ref?: string): Promise<void>;
  screenshot(file: string, fullPage: boolean): Promise<{ bytes: number }>;
  url(): string;
  /** the user closed the window, or Chromium crashed */
  onClose(cb: () => void): void;
  close(): Promise<void>;
}

export interface BrowserBackend {
  launch(o: LaunchOptions): Promise<BrowserSession>;
}
