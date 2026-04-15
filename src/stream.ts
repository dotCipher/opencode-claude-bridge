/**
 * SSE stream processor for the Anthropic Messages API response.
 *
 * Anthropic streams tool_use arguments as many tiny input_json_delta
 * events whose partial_json fragments can split mid-key (e.g. "file_" +
 * "path"). Doing regex substitution on each chunk as it arrives silently
 * fails at those splits. This module instead:
 *
 *   1. Frames on `\n\n` SSE event boundaries (chunks may contain partial
 *      or multiple events).
 *   2. Buffers input_json_delta fragments per tool_use block (keyed by
 *      content-block index, so interleaved blocks don't corrupt each
 *      other).
 *   3. On content_block_stop, translates the fully-assembled JSON once
 *      via the injected translateToolArgs callback and emits a single
 *      synthetic input_json_delta containing the translated payload,
 *      followed by the stop event.
 *
 * The translateToolArgs callback is injected rather than hard-coded so
 * the same processor can be exercised in isolation from unit tests.
 */

export function parseSseEvent(
  block: string,
): { event: string | null; data: string } | null {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join("\n") };
}

export function buildSseEvent(event: string | null, data: string): string {
  return (event ? `event: ${event}\n` : "") + `data: ${data}\n\n`;
}

/**
 * Cheap extraction of the `type` field from an SSE data JSON string
 * without parsing the whole payload. Used to decide whether an event is
 * interesting enough to round-trip through JSON.parse + JSON.stringify.
 * Returns null if the type can't be determined from the first few
 * properties — caller should fall back to a full parse in that case.
 */
function peekType(data: string): string | null {
  // Match the first top-level "type": "..." occurrence. Doesn't handle
  // escaped quotes in the value, but Anthropic type names are plain
  // identifiers so that's fine. If anything weird happens, return null
  // and force a full parse.
  const m = data.match(/^\s*\{\s*"type"\s*:\s*"([a-z_]+)"/);
  return m ? m[1] : null;
}

export type StreamProcessorDeps = {
  /**
   * Map from Claude's tool name (e.g. "Read") to OpenCode's tool name
   * (e.g. "read"). Applied to content_block_start events with type
   * "tool_use".
   */
  inboundToolNameMap: Record<string, string>;

  /**
   * Translate an assembled tool_use argument JSON string from Claude's
   * schema to OpenCode's schema. Receives the raw JSON string and the
   * original (Claude) tool name.
   */
  translateToolArgs: (json: string, toolName: string) => string;

  /**
   * Optional debug sink for swallowed errors. Called with a short
   * message describing what was swallowed and why. Typically wired to
   * a console.error behind an env flag.
   */
  debug?: (msg: string) => void;
};

/**
 * Create a stateful SSE processor.
 *
 * `feedChunk(text)` accumulates a raw response chunk into the SSE frame
 * buffer, processes every complete event in that buffer, and returns the
 * concatenated transformed bytes to emit downstream. Incomplete trailing
 * frames stay buffered for the next call.
 *
 * `flush()` returns any trailing buffered bytes — used at end-of-stream
 * to avoid dropping data if the upstream closed mid-frame (Anthropic
 * normally ends on a blank line, so this is typically empty).
 */
export function createSseProcessor(deps: StreamProcessorDeps) {
  type ToolBlockState = { toolName: string; partialJson: string };
  const toolBlocks = new Map<number, ToolBlockState>();
  let sseBuffer = "";

  // Event types that require peeking into the JSON to decide whether/how to
  // mutate. Every other event type is a pure pass-through — no need to
  // re-serialize, just forward the original bytes.
  const INTERESTING_TYPES = new Set([
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
  ]);

  function processEvent(block: string): string {
    const parsed = parseSseEvent(block);
    if (!parsed) return block; // comment/keepalive line — pass through
    const { event, data } = parsed;

    // Cheap sniff: if the event isn't one we care about, forward the raw
    // frame. Saves a JSON.parse + JSON.stringify round trip on every
    // message_start, ping, message_delta, and text_delta.
    const cheapType = peekType(data);
    if (cheapType !== null && !INTERESTING_TYPES.has(cheapType)) {
      return block;
    }

    let obj: unknown;
    try {
      obj = JSON.parse(data);
    } catch (e) {
      deps.debug?.(`processEvent: JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`);
      return block;
    }

    if (obj === null || typeof obj !== "object") {
      return block;
    }
    const rec = obj as Record<string, any>;
    const type = rec.type as string | undefined;

    // content_block_start with tool_use: translate name, register per-index state
    if (
      type === "content_block_start" &&
      rec.content_block &&
      typeof rec.content_block === "object" &&
      rec.content_block.type === "tool_use"
    ) {
      const idx = rec.index as number;
      const claudeName: string = rec.content_block.name || "";
      const mapped = deps.inboundToolNameMap[claudeName] || claudeName;
      rec.content_block.name = mapped;
      if (rec.content_block.input === undefined) rec.content_block.input = {};
      toolBlocks.set(idx, { toolName: claudeName, partialJson: "" });
      return buildSseEvent(event, JSON.stringify(rec));
    }

    // input_json_delta: buffer the fragment, emit nothing yet
    if (
      type === "content_block_delta" &&
      rec.delta &&
      typeof rec.delta === "object" &&
      rec.delta.type === "input_json_delta"
    ) {
      const idx = rec.index as number;
      const state = toolBlocks.get(idx);
      if (state) {
        state.partialJson += String(rec.delta.partial_json ?? "");
        return "";
      }
      return block;
    }

    // content_block_stop: if this closed a tool_use block, flush a synthetic
    // input_json_delta containing the fully translated JSON, then emit the stop.
    if (type === "content_block_stop") {
      const idx = rec.index as number;
      const state = toolBlocks.get(idx);
      if (state) {
        toolBlocks.delete(idx);
        let translated: string;
        try {
          translated = deps.translateToolArgs(state.partialJson, state.toolName);
        } catch (e) {
          deps.debug?.(`translateToolArgs threw for ${state.toolName}: ${e instanceof Error ? e.message : String(e)}`);
          translated = state.partialJson;
        }
        const synthDelta = {
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: translated },
        };
        return (
          buildSseEvent("content_block_delta", JSON.stringify(synthDelta)) +
          block
        );
      }
      return block;
    }

    // Interesting type we didn't end up mutating (e.g. a non-tool_use
    // content_block_start, or a text_delta inside a content_block_delta).
    return block;
  }

  function feedChunk(text: string): string {
    sseBuffer += text;
    let out = "";
    while (true) {
      const boundary = sseBuffer.indexOf("\n\n");
      if (boundary === -1) break;
      const block = sseBuffer.slice(0, boundary + 2);
      sseBuffer = sseBuffer.slice(boundary + 2);
      out += processEvent(block);
    }
    return out;
  }

  function flush(): string {
    const remaining = sseBuffer;
    sseBuffer = "";
    if (toolBlocks.size > 0) {
      // The upstream disconnected mid-tool_use without sending
      // content_block_stop, so we never emitted a synthetic translated
      // delta for these blocks. The consumer will see the start but no
      // completed args. Surface it so the operator isn't debugging a
      // ghost.
      const orphaned = Array.from(toolBlocks.entries()).map(
        ([idx, s]) => `index=${idx} tool=${s.toolName} bufferedBytes=${s.partialJson.length}`,
      );
      deps.debug?.(`flush: ${toolBlocks.size} tool_use block(s) abandoned mid-stream: ${orphaned.join("; ")}`);
      toolBlocks.clear();
    }
    return remaining;
  }

  return { feedChunk, flush };
}
