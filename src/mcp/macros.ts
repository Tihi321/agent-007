/**
 * S10.3: typed macros (deferred tools). A macro is a FIXED call sequence against one MCP server with typed parameters:
 *
 *   tts_line       {text, voice?, lang?}      vibetts           synthesize_to_file
 *   chiptune_loop  {mood, chip?, bars?}       chiptune-studio   compose_track, then render_audio
 *   comfy_image    {prompt, size?}            comfy-mcp         generate_image
 *
 * Rules (the done-check of S10.3):
 *  - model text reaches the server only through the typed fields named below (`text`, `mood`, `prompt`, and the narrow
 *    `voice`, `lang`, `chip`, `size`, `bars`); every field is validated again here, whatever the Harness validated;
 *  - the model never supplies a path: the output location is built here, from a generated name, and stays under the tool's
 *    own data folder (a bare file name for VibeTTS, which then uses its export folder; `<ChiptuneStudio data>\agent-007\...`
 *    for render_audio; ComfyUI's default output folder);
 *  - a macro is registered only if its server config lists it in `macros` and the server really lists the tools it needs;
 *  - the step tool names and argument names below were taken from the tools' own docs and are checked by the read-only
 *    `listTools` run of S10.1 (U37); they live in one table so a rename is a one-line change.
 *
 * Macro steps are curated code, so they do not need to be in the server's `allowTools` (that list is for the model's direct tools).
 */
import { randomBytes } from "node:crypto";
import { win32 } from "node:path";
import type { Logger } from "../contracts.js";
import { Type, defineTool } from "../pi/adapter.js";
import type { DeferredToolRegistration, ToolExecutionResult, TSchema } from "../pi/adapter.js";
import { describeMcpError } from "./client.js";
import type { HubClient } from "./client.js";
import { reduceMcpResult, toolError, toolText } from "./untrusted.js";

export class MacroArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MacroArgError";
  }
}

export interface MacroStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface MacroContext {
  /** Absolute folder for `render_audio` output (the Chiptune Studio data folder, plus `agent-007`). */
  chiptuneDir: string;
  /** A fresh short id for generated file names. */
  newId(): string;
}

export interface MacroDef {
  readonly id: string;
  readonly description: string;
  /** Tools the server must list for this macro to be registered. */
  readonly requires: readonly string[];
  readonly parameters: TSchema;
  /** Validates the typed arguments and returns the exact calls. Throws `MacroArgError`. */
  plan(args: unknown, ctx: MacroContext): MacroStep[];
}

// ---- argument validation ---------------------------------------------------------------------------

function record(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new MacroArgError("arguments must be an object");
  return args as Record<string, unknown>;
}

function noUnknown(o: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new MacroArgError(`unknown argument "${k}"`);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function freeText(o: Record<string, unknown>, key: string, max: number): string {
  const v = o[key];
  if (typeof v !== "string") throw new MacroArgError(`${key} must be text`);
  if (v.trim() === "") throw new MacroArgError(`${key} must not be empty`);
  if (v.length > max) throw new MacroArgError(`${key} is longer than ${max} characters`);
  if (CONTROL.test(v)) throw new MacroArgError(`${key} contains control characters`);
  return v;
}

function token(o: Record<string, unknown>, key: string, pattern: RegExp, what: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !pattern.test(v)) throw new MacroArgError(`${key} must be ${what}`);
  return v;
}

function oneOf<T extends string>(o: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new MacroArgError(`${key} must be one of ${values.join(", ")}`);
  return v as T;
}

function intIn(o: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new MacroArgError(`${key} must be a whole number from ${min} to ${max}`);
  return v;
}

// ---- the three macros ------------------------------------------------------------------------------

export const CHIPTUNE_CHIPS = ["nes", "gb", "genesis", "snes", "pce", "ps1", "dreamcast"] as const;
export const COMFY_SIZES = ["512x512", "768x768", "1024x1024", "1344x768", "768x1344"] as const;
const VOICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/;
const LANG_PATTERN = /^[a-z]{2,3}$/;
const MOOD_PATTERN = /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/;

export const TTS_LINE: MacroDef = {
  id: "tts_line",
  description:
    "Macro: speak one line of text to a WAV audio file with the local VibeTTS (text to speech, voice, language). One call, saved in VibeTTS's own export folder; returns the file path. Use for a single line of dialogue or narration.",
  requires: ["synthesize_to_file"],
  parameters: Type.Object({
    text: Type.String({ minLength: 1, maxLength: 2000, description: "The line to speak." }),
    voice: Type.Optional(Type.String({ maxLength: 64, description: "Voice id such as af_heart or supertonic:F1. Default: the configured voice for the language." })),
    lang: Type.Optional(Type.String({ maxLength: 3, description: "Language code, for example en, hr, de." })),
  }),
  plan(args, ctx) {
    const o = record(args);
    noUnknown(o, ["text", "voice", "lang"]);
    const text = freeText(o, "text", 2000);
    const voice = token(o, "voice", VOICE_PATTERN, "a voice id (letters, digits, : _ . -)");
    const lang = token(o, "lang", LANG_PATTERN, "a 2 or 3 letter language code");
    return [
      {
        tool: "synthesize_to_file",
        args: {
          text,
          ...(voice !== undefined ? { voice } : {}),
          ...(lang !== undefined ? { lang } : {}),
          format: "wav",
          // A bare file name: VibeTTS saves it in its own export folder. The model never chooses a path.
          output: `a7-tts-${ctx.newId()}.wav`,
          overwrite: false,
        },
      },
    ];
  },
};

export const CHIPTUNE_LOOP: MacroDef = {
  id: "chiptune_loop",
  description:
    "Macro: compose a looping chiptune track for a mood and render it to an OGG file with Chiptune Studio (compose_track then render_audio). Game music loop, chip such as nes, snes, gb, genesis. Returns the file path.",
  requires: ["compose_track", "render_audio"],
  parameters: Type.Object({
    mood: Type.String({ minLength: 1, maxLength: 40, description: "Mood, for example ambient, battle, synthwave, mysterious-calm." }),
    chip: Type.Optional(Type.Enum([...CHIPTUNE_CHIPS], { description: "Sound chip. Default: the mood's own default." })),
    bars: Type.Optional(Type.Integer({ minimum: 1, maximum: 64, description: "Loop length in bars (default 16)." })),
  }),
  plan(args, ctx) {
    const o = record(args);
    noUnknown(o, ["mood", "chip", "bars"]);
    const mood = freeText(o, "mood", 40);
    if (!MOOD_PATTERN.test(mood)) throw new MacroArgError("mood must be a short word or phrase (letters, digits, space, - and _)");
    const chip = oneOf(o, "chip", CHIPTUNE_CHIPS);
    const bars = intIn(o, "bars", 1, 64);
    const path = win32.join(ctx.chiptuneDir, `a7-chiptune-${ctx.newId()}.ogg`);
    return [
      { tool: "compose_track", args: { mood, ...(chip !== undefined ? { chip } : {}), bars: bars ?? 16, loop: true } },
      { tool: "render_audio", args: { path, format: "ogg" } },
    ];
  },
};

export const COMFY_IMAGE: MacroDef = {
  id: "comfy_image",
  description:
    "Macro: generate one image from a text prompt with the local ComfyUI (text to image, picture, illustration). One call; returns the PNG path in ComfyUI's output folder.",
  requires: ["generate_image"],
  parameters: Type.Object({
    prompt: Type.String({ minLength: 1, maxLength: 2000, description: "What to draw: subject, style, lighting, background." }),
    size: Type.Optional(Type.Enum([...COMFY_SIZES], { description: "Image size, width x height. Default 1024x1024." })),
  }),
  plan(args) {
    const o = record(args);
    noUnknown(o, ["prompt", "size"]);
    const prompt = freeText(o, "prompt", 2000);
    const size = oneOf(o, "size", COMFY_SIZES) ?? "1024x1024";
    const [w, h] = size.split("x").map(Number) as [number, number];
    return [{ tool: "generate_image", args: { prompt, width: w, height: h, count: 1 } }];
  },
};

export const MACROS: Readonly<Record<string, MacroDef>> = { [TTS_LINE.id]: TTS_LINE, [CHIPTUNE_LOOP.id]: CHIPTUNE_LOOP, [COMFY_IMAGE.id]: COMFY_IMAGE };
export const MACRO_IDS: readonly string[] = Object.keys(MACROS);

// ---- tool registration -----------------------------------------------------------------------------

export interface MacroToolDeps {
  serverId: string;
  client: Pick<HubClient, "callTool">;
  ctx: MacroContext;
  /** Per-step timeout. */
  timeoutMs: number;
  logger?: Logger | undefined;
}

export function defaultMacroContext(chiptuneDir: string): MacroContext {
  return { chiptuneDir, newId: () => `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}` };
}

/** The deferred tool for one macro. `replay: "unsafe"`: an interrupted macro is never rerun (it may have written a file). */
export function buildMacroTool(def: MacroDef, deps: MacroToolDeps): DeferredToolRegistration {
  const tool = defineTool({
    name: def.id,
    description: `${def.description} [creative-hub macro on server ${deps.serverId}]`,
    parameters: def.parameters,
    deferred: true,
    replay: "unsafe",
    async execute(args, api, context): Promise<ToolExecutionResult> {
      let steps: MacroStep[];
      try {
        steps = def.plan(args, deps.ctx);
      } catch (e) {
        if (e instanceof MacroArgError) return toolError(`${def.id}: ${e.message}`);
        throw e;
      }
      const outputs: string[] = [];
      for (const [i, step] of steps.entries()) {
        try {
          const result = await deps.client.callTool(step.tool, step.args, {
            signal: context.abortSignal,
            timeoutMs: deps.timeoutMs,
            onProgress: (p) => api.output(`[${def.id} ${i + 1}/${steps.length}] ${p.progress}${p.total !== undefined ? `/${p.total}` : ""}\n`),
          });
          const reduced = reduceMcpResult(deps.serverId, step.tool, result);
          outputs.push(reduced.text);
          if (reduced.isError) return { isError: true, output: [{ type: "text", text: outputs.join("\n") }] };
        } catch (e) {
          const d = describeMcpError(e, deps.serverId);
          deps.logger?.warn("mcp.macro_failed", { macro: def.id, step: step.tool, kind: d.kind });
          const done = outputs.length > 0 ? `\n(steps already done: ${outputs.length} of ${steps.length})` : "";
          return { isError: true, output: [{ type: "text", text: `${[...outputs, `${def.id}: step ${step.tool} failed. ${d.message}`].join("\n")}${done}` }] };
        }
      }
      return toolText(outputs.join("\n"));
    },
  });
  return tool as unknown as DeferredToolRegistration;
}
