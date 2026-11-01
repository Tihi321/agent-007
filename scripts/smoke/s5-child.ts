/**
 * S5b child: runs (or resumes) the gated turn and is killed by the parent. Not run on its own.
 * Usage: node s5-child.js --storage <path> --log <file> --hook-wait-ms <n> --tool-sleep-ms <n> [--runner ..]
 */
import { isMain, loadSmokeRunner, parseArgs } from "./config.js";
import { ctx, openRig } from "./common.js";
import { buildS5Extension, S5_PROMPT } from "./s5-shared.js";

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const storage = String(args.flags["storage"] ?? "");
  const log = String(args.flags["log"] ?? "");
  if (!storage || !log) {
    console.error("usage: s5-child --storage <path> --log <file> --hook-wait-ms <n> --tool-sleep-ms <n>");
    process.exit(2);
  }
  const cfg = loadSmokeRunner(args);
  const ext = buildS5Extension({ hookWaitMs: Number(args.flags["hook-wait-ms"] ?? 60_000), toolSleepMs: Number(args.flags["tool-sleep-ms"] ?? 60_000), memo: true, logFile: log });
  const rig = await openRig({ storagePath: storage, cfg, extensions: [ext], settings: { stream: { timeoutMs: 600_000 } }, resume: true });
  await rig.root.submit({ type: "input", content: S5_PROMPT, requestId: "s5b" }, ctx);
  console.log("SUBMITTED");
  setInterval(() => undefined, 60_000);
}
