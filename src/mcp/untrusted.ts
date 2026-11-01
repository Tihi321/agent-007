/**
 * S10.5: every MCP result is untrusted data. Before the model sees it, it is wrapped
 *
 *     <untrusted_content source="mcp:<server>/<tool>"> ... </untrusted_content>
 *
 * Text over 20 KB is trimmed with a marker; binary and resource results are reduced to their path (or uri) and type, so no
 * base64 payload and no server-chosen file content reaches the model. A closing (or opening) marker inside the body is
 * defused, so a result cannot close the wrapper early and speak with the agent's voice.
 */
import type { McpCallToolResult, McpContentBlock, ToolExecutionResult } from "../pi/adapter.js";

/** The trim limit for the text of one result (plan S10.5: "text over 20 KB"). */
export const MCP_TEXT_LIMIT_BYTES = 20 * 1024;
const MAX_REF_CHARS = 300;

/** `mcp:<server>/<tool>`, the `source` attribute of the wrapper. */
export function mcpSource(server: string, tool: string): string {
  return `mcp:${server}/${tool}`;
}

function singleLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Wraps `body` as untrusted content. The source is made attribute-safe; `<untrusted_content` / `</untrusted_content` in the body are defused. */
export function wrapUntrustedContent(source: string, body: string): string {
  const safeSource = source.replace(/["\r\n<>]/g, "'").slice(0, 300);
  const safeBody = body.replace(/<(\s*\/?\s*untrusted_content)/gi, "<\\$1");
  return `<untrusted_content source="${safeSource}">\n${safeBody}\n</untrusted_content>`;
}

export interface TrimmedText {
  text: string;
  trimmed: boolean;
  totalBytes: number;
  shownBytes: number;
}

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character; the marker says how much was dropped. */
export function trimToBytes(text: string, maxBytes: number = MCP_TEXT_LIMIT_BYTES): TrimmedText {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) return { text, trimmed: false, totalBytes: total, shownBytes: total };
  let cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  // A split multi-byte character decodes to U+FFFD at the end; drop it.
  while (cut.endsWith("�")) cut = cut.slice(0, -1);
  const shown = Buffer.byteLength(cut, "utf8");
  return {
    text: `${cut}\n[trimmed: showing ${shown} of ${total} bytes]`,
    trimmed: true,
    totalBytes: total,
    shownBytes: shown,
  };
}

function describeBinary(kind: string, mimeType: string | undefined, base64: string | undefined): string {
  const type = singleLine(mimeType ?? "unknown type", 100);
  const bytes = base64 === undefined ? undefined : Math.floor((base64.length * 3) / 4);
  return `[${kind}: ${type}${bytes === undefined ? "" : `, ${bytes} bytes`}; content not shown]`;
}

/** One non-text block reduced to its path or uri and its type. */
function reduceBlock(block: McpContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return describeBinary("image", block.mimeType, block.data);
    case "audio":
      return describeBinary("audio", block.mimeType, block.data);
    case "resource_link":
      return `[resource: ${singleLine(block.uri, MAX_REF_CHARS)} (${singleLine(block.mimeType ?? "unknown type", 100)}); content not shown]`;
    case "resource": {
      const r = block.resource;
      const size = "blob" in r ? `, ${Math.floor((r.blob.length * 3) / 4)} bytes` : "";
      return `[resource: ${singleLine(r.uri, MAX_REF_CHARS)} (${singleLine(r.mimeType ?? "unknown type", 100)}${size}); content not shown]`;
    }
    default:
      return "[unsupported content block; not shown]";
  }
}

export interface ReducedMcpResult {
  /** The wrapped text the model gets. */
  text: string;
  isError: boolean;
  trimmed: boolean;
}

/**
 * The model-visible form of one tool result: text blocks as they are (trimmed), everything else reduced to path and type,
 * `structuredContent` as JSON only when the result has no text block (servers usually mirror it as text), all inside one wrapper.
 */
export function reduceMcpResult(server: string, tool: string, result: McpCallToolResult, limitBytes: number = MCP_TEXT_LIMIT_BYTES): ReducedMcpResult {
  const parts: string[] = [];
  let hasText = false;
  for (const block of result.content ?? []) {
    if (block.type === "text") hasText = true;
    parts.push(reduceBlock(block));
  }
  if (!hasText && result.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent));
    } catch {
      parts.push("[structured content could not be shown]");
    }
  }
  let body = parts.join("\n");
  if (body === "") body = result.isError === true ? "(the tool reported an error with no message)" : "(no output)";
  const t = trimToBytes(body, limitBytes);
  return { text: wrapUntrustedContent(mcpSource(server, tool), t.text), isError: result.isError === true, trimmed: t.trimmed };
}

// ---- small result helpers shared by the S10 tools ----------------------------------------------------

export function toolText(text: string): ToolExecutionResult {
  return { output: [{ type: "text", text }] };
}

export function toolError(text: string): ToolExecutionResult {
  return { isError: true, output: [{ type: "text", text }] };
}
