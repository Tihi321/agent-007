/**
 * S23.1: the setup check as a command the USER runs: `node dist/src/proxy/setupCheck.js --port <n> --secrets <path> [--model <id> ...]`.
 *
 * It calls only `GET /healthz` and `GET /v1/models`, reads `proxyApiKey` from the agent's own `secrets.json` (never the proxy's
 * `settings.json`), and prints ids, counts and fixed sentences: never the key. A bad secrets file is reported without echoing its content.
 * `--model` ids are compared with the proxy's list (as presets of the codex vendor unless written `<vendor>/<id>` with claude or antigravity).
 * The port comes from the user: `scripts/proxy/check-port.ps1` prints it.
 */
import { readFileSync } from "node:fs";
import { parseSecrets } from "../config/secrets.js";
import { createRedactor } from "../logging/redact.js";
import { checkProxy, formatSetupReport } from "./discover.js";
import { EndpointError } from "./health.js";
import type { FetchLike } from "./health.js";

export interface SetupCheckIo {
  out: (line: string) => void;
  fetch?: FetchLike;
  readFile?: (path: string) => string;
}

export function parseArgs(argv: readonly string[]): { port?: number; baseUrl?: string; secrets?: string; models: string[]; error?: string } {
  const out: { port?: number; baseUrl?: string; secrets?: string; models: string[]; error?: string } = { models: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--port" && v !== undefined) {
      out.port = Number(v);
      i++;
    } else if (a === "--url" && v !== undefined) {
      out.baseUrl = v;
      i++;
    } else if (a === "--secrets" && v !== undefined) {
      out.secrets = v;
      i++;
    } else if (a === "--model" && v !== undefined) {
      out.models.push(v);
      i++;
    } else {
      out.error = `unknown or incomplete argument: ${String(a)}`;
      return out;
    }
  }
  return out;
}

/** Returns the process exit code: 0 when the check is OK, 1 when not, 2 for a usage error. */
export async function runSetupCheck(argv: readonly string[], io: SetupCheckIo): Promise<number> {
  const args = parseArgs(argv);
  if (args.error) {
    io.out(args.error);
    io.out("usage: setupCheck --port <n> | --url http://127.0.0.1:<n>/v1  [--secrets <secrets.json>]  [--model <id> ...]");
    return 2;
  }
  let apiKey: string | undefined;
  if (args.secrets !== undefined) {
    try {
      apiKey = parseSecrets((io.readFile ?? ((p: string) => readFileSync(p, "utf8")))(args.secrets)).proxyApiKey;
    } catch (e) {
      // parseSecrets messages never echo file content; a read error names only the path and the OS reason
      io.out(`cannot use the secrets file: ${e instanceof Error ? e.message.split("\n")[0] : "unreadable"}`);
      return 2;
    }
  }
  const presets = args.models.map((id, n) => {
    const m = /^(claude|antigravity)\//.exec(id);
    return { id: `check-${n + 1}`, kind: "acp" as const, modelId: id, providerId: (m?.[1] ?? "codex") as "codex" | "claude" | "antigravity" };
  });
  try {
    const report = await checkProxy({
      ...(args.port !== undefined ? { port: args.port } : {}),
      ...(args.baseUrl !== undefined ? { baseUrl: args.baseUrl } : {}),
      apiKey,
      presets,
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
    const redact = createRedactor([apiKey]);
    for (const line of formatSetupReport(report, redact)) io.out(line);
    return report.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof EndpointError) {
      io.out(e.message);
      return 2;
    }
    throw e;
  }
}

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runSetupCheck(process.argv.slice(2), { out: (l) => console.log(l) }).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.log("setup check failed unexpectedly");
      process.exitCode = 1;
    },
  );
}
