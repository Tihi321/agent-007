/**
 * Chain records (S21.2, I32, U59): what survives a restart. A chain keeps STAMPS only (id, origin, taint, counters, the hashes
 * and edges loop detection needs), never a body. A conversation record binds a Pi conversation of a bot to a chain, so that
 * `contextOf` after a restart returns the same `chain_id`, hop, path and taint.
 *
 * `MemoryChainStore` for tests; `FileChainStore` writes one small JSON file (temp file + rename), bounded in size.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BotId, Origin } from "./contracts.js";

export interface ChainRecord {
  chainId: string;
  origin: Origin;
  rootBot: BotId;
  startedAt: number;
  messages: number;
  tokens: number;
  taint: boolean;
  hashes: string[];
  edges: string[];
}

/** The stamp of one conversation inside a chain. `path` ends with the bot that owns the conversation. */
export interface ConvRecord {
  chainId: string;
  origin: Origin;
  hop: number;
  path: BotId[];
  taint: boolean;
  at: number;
}

export interface ChainStore {
  getChain(chainId: string): ChainRecord | undefined;
  putChain(rec: ChainRecord): void;
  getConv(bot: BotId, conversationId: string): ConvRecord | undefined;
  putConv(bot: BotId, conversationId: string, rec: ConvRecord): void;
}

export const MAX_CHAINS = 500;
export const MAX_CONVS = 2000;
const MAX_MEMORY = 40;

const convKey = (bot: string, conv: string): string => `${bot}|${conv}`;

export class MemoryChainStore implements ChainStore {
  protected chains = new Map<string, ChainRecord>();
  protected convs = new Map<string, ConvRecord>();
  getChain(chainId: string): ChainRecord | undefined {
    const c = this.chains.get(chainId);
    return c ? { ...c, hashes: [...c.hashes], edges: [...c.edges] } : undefined;
  }
  putChain(rec: ChainRecord): void {
    const copy = { ...rec, hashes: rec.hashes.slice(-MAX_MEMORY), edges: rec.edges.slice(-MAX_MEMORY) };
    this.chains.delete(rec.chainId);
    this.chains.set(rec.chainId, copy);
    while (this.chains.size > MAX_CHAINS) this.chains.delete(this.chains.keys().next().value as string);
    this.changed();
  }
  getConv(bot: BotId, conversationId: string): ConvRecord | undefined {
    const c = this.convs.get(convKey(bot, conversationId));
    return c ? { ...c, path: [...c.path] } : undefined;
  }
  putConv(bot: BotId, conversationId: string, rec: ConvRecord): void {
    const k = convKey(bot, conversationId);
    this.convs.delete(k);
    this.convs.set(k, { ...rec, path: [...rec.path] });
    while (this.convs.size > MAX_CONVS) this.convs.delete(this.convs.keys().next().value as string);
    this.changed();
  }
  protected changed(): void {
    /* the file store persists here */
  }
}

interface FileShape {
  v: 1;
  chains: ChainRecord[];
  convs: { k: string; rec: ConvRecord }[];
}

/** Persists after every change; a missing or unreadable file starts empty (a restart then treats unknown conversations as tainted peers). */
export class FileChainStore extends MemoryChainStore {
  constructor(private readonly path: string) {
    super();
    try {
      const doc = JSON.parse(readFileSync(path, "utf8")) as FileShape;
      if (doc.v === 1) {
        for (const c of doc.chains) this.chains.set(c.chainId, c);
        for (const c of doc.convs) this.convs.set(c.k, c.rec);
      }
    } catch {
      /* first start or a damaged file */
    }
  }
  protected override changed(): void {
    const doc: FileShape = { v: 1, chains: [...this.chains.values()], convs: [...this.convs].map(([k, rec]) => ({ k, rec })) };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc), "utf8");
    renameSync(tmp, this.path);
  }
}
