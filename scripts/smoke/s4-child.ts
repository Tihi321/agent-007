/**
 * S4 child process: starts a turn and is then killed by the parent. Not run on its own.
 * Usage: node s4-child.js --case a|b --storage <path> --counters <dir> --sleep-ms <n> [--runner ..] [--model ..] [--base-url ..]
 */
import { isMain, loadSmokeRunner, parseArgs } from "./config.js";
import { ctx, openRig } from "./common.js";
import { buildS4Extension, S4_PROMPTS } from "./s4-shared.js";

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const which = args.flags["case"] === "b" ? "b" : "a";
  const storage = String(args.flags["storage"] ?? "");
  const counters = String(args.flags["counters"] ?? "");
  const sleepMs = Number(args.flags["sleep-ms"] ?? 30_000);
  if (!storage || !counters) {
    console.error("usage: s4-child --case a|b --storage <path> --counters <dir> --sleep-ms <n>");
    process.exit(2);
  }
  const cfg = loadSmokeRunner(args);
  const rig = await openRig({ storagePath: storage, cfg, extensions: [buildS4Extension(counters, sleepMs)], settings: { stream: { timeoutMs: 600_000 } }, resume: true });
  await rig.root.submit({ type: "input", content: S4_PROMPTS[which], requestId: `s4-${which}` }, ctx);
  console.log("SUBMITTED");
  // wait to be killed
  setInterval(() => undefined, 60_000);
}
