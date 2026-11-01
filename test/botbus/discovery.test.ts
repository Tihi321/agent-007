/**
 * Eval fix 1 (deviation 180): the BM25 `tool_search` finds `ask_bot` for the natural queries a model writes when the user says
 * "ask a bot". The deferred set here is the real bus tools plus plausible distractors (the other deferred tools of a bot).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolSearchTool } from "../../src/pi/adapter.js";
import { createBotBusTools } from "../../src/botbus/tools.js";
import { chainRig } from "./helpers.js";

const distractors = [
  ["search_files", "Search the text of files in the folders the user has allowed."],
  ["write_file", "Write a file inside your own workspace."],
  ["remember", "Save one durable fact about the user to memory."],
  ["shell", "Run one Windows PowerShell command after the user allows it."],
  ["hub_start", "Ask the user to start a creative-hub server that is down."],
  ["tts_speak", "Text to speech: turn a text into spoken audio with a chosen voice."],
  ["image_generate", "Generate an image from a prompt."],
].map(([name, description]) => ({ name, description: description as string, parameters: { type: "object", properties: { query: { type: "string", description: "input" } } } }));

test("tool_search loads ask_bot (top 2) for natural queries about asking another bot", async () => {
  const { bus } = chainRig();
  const bots = createBotBusTools({ bus, self: "a" }).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const deferred = [...distractors, ...bots];
  const search = createToolSearchTool() as any;
  const queries = ["ask another bot", "ask bot", "ask_bot", "delegate to research", "ask research", "ask the ops bot", "send a request to another bot", "delegate a question to a peer bot"];
  for (const query of queries) {
    const r = await search.execute({ query }, { agent: async () => ({ deferred }) }, {});
    const loaded: string[] = r.details.loaded;
    assert.ok(loaded.includes("ask_bot"), `"${query}" did not load ask_bot: ${loaded.join(",") || "nothing"}`);
    assert.ok(loaded.indexOf("ask_bot") <= 1, `"${query}" ranked ${loaded.join(",")}`);
  }
});
