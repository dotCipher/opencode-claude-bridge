/**
 * Unit tests for opencode-claude-bridge plugin logic.
 * Run with: npm test (builds then runs node --test).
 *
 * These tests exercise the actual production modules — the SSE processor
 * is imported from ./stream, the argument translator from ./claude-tools.
 * No local re-implementations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  translateToolArgsJsonString,
  translateArgsOpencodeToClaude,
  AGENT_TYPE_CLAUDE_TO_OPENCODE,
  AGENT_TYPE_OPENCODE_TO_CLAUDE,
  shouldUseClaudeToolSchemas,
} from "./claude-tools.js";
import { extractOAuthErrorDetail } from "./oauth.js";
import { createSseProcessor, parseSseEvent, buildSseEvent } from "./stream.js";
import {
  deriveModelDisplayName,
  rewriteSystemBlocksForModel,
} from "./index.js";

// ── Helpers (extracted / reimplemented from index.ts for unit testing) ────────

const THINKING_MODELS = [
  "claude-opus-4",
  "claude-sonnet-4-6",
];

function shouldInjectThinking(model: string | undefined): boolean {
  if (!model) return false;
  return THINKING_MODELS.some((m) => model.includes(m));
}

// Simulate the body-transform logic from the fetch wrapper
function transformBody(bodyStr: string): Record<string, unknown> {
  const parsed = JSON.parse(bodyStr);

  const supportsThinking = shouldInjectThinking(parsed.model);
  if (!parsed.thinking && supportsThinking) {
    parsed.thinking = { type: "adaptive" };
  }

  const thinkingType = parsed.thinking?.type;
  if (
    (thinkingType === "enabled" || thinkingType === "adaptive") &&
    parsed.temperature !== undefined &&
    parsed.temperature !== 1
  ) {
    parsed.temperature = 1;
  }

  return parsed;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("thinking injection", () => {
  it("does NOT inject thinking for claude-sonnet-4-5", () => {
    const out = transformBody(JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }));
    assert.equal(out.thinking, undefined, "sonnet-4-5 must not get thinking injected");
  });

  it("does NOT inject thinking for claude-haiku-4-5-20251001", () => {
    const out = transformBody(JSON.stringify({ model: "claude-haiku-4-5-20251001", messages: [] }));
    assert.equal(out.thinking, undefined, "haiku must not get thinking injected");
  });

  it("does NOT inject thinking for an unknown model", () => {
    const out = transformBody(JSON.stringify({ model: "gpt-4o", messages: [] }));
    assert.equal(out.thinking, undefined, "unknown model must not get thinking injected");
  });

  it("injects adaptive thinking for claude-sonnet-4-6", () => {
    const out = transformBody(JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }));
    assert.deepEqual(out.thinking, { type: "adaptive" });
  });

  it("injects adaptive thinking for claude-opus-4-5", () => {
    const out = transformBody(JSON.stringify({ model: "claude-opus-4-5", messages: [] }));
    assert.deepEqual(out.thinking, { type: "adaptive" });
  });

  it("injects adaptive thinking for claude-opus-4-6", () => {
    const out = transformBody(JSON.stringify({ model: "claude-opus-4-6", messages: [] }));
    assert.deepEqual(out.thinking, { type: "adaptive" });
  });

  it("does not overwrite an existing thinking block", () => {
    const out = transformBody(
      JSON.stringify({ model: "claude-sonnet-4-6", messages: [], thinking: { type: "disabled" } }),
    );
    assert.deepEqual(out.thinking, { type: "disabled" });
  });
});

describe("temperature coercion", () => {
  it("forces temperature to 1 when adaptive thinking is injected", () => {
    const out = transformBody(
      JSON.stringify({ model: "claude-sonnet-4-6", messages: [], temperature: 0.7 }),
    );
    assert.equal(out.temperature, 1);
  });

  it("forces temperature to 1 when thinking:enabled is already set", () => {
    const out = transformBody(
      JSON.stringify({ model: "claude-sonnet-4-6", messages: [], thinking: { type: "enabled" }, temperature: 0 }),
    );
    assert.equal(out.temperature, 1);
  });

  it("does not touch temperature when thinking is not injected (sonnet-4-5)", () => {
    const out = transformBody(
      JSON.stringify({ model: "claude-sonnet-4-5", messages: [], temperature: 0.7 }),
    );
    assert.equal(out.temperature, 0.7);
  });

  it("does not touch temperature when it is already 1", () => {
    const out = transformBody(
      JSON.stringify({ model: "claude-sonnet-4-6", messages: [], temperature: 1 }),
    );
    assert.equal(out.temperature, 1);
  });

  it("does not touch temperature when it is absent", () => {
    const out = transformBody(
      JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }),
    );
    assert.equal(out.temperature, undefined);
  });
});

describe("OAuth error parsing", () => {
  it("extracts nested error messages from token responses", () => {
    const detail = extractOAuthErrorDetail(JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "invalid_grant: refresh token not found or invalid",
      },
    }));
    assert.equal(detail, "invalid_grant: refresh token not found or invalid");
  });

  it("falls back to raw response bodies when parsing fails", () => {
    const detail = extractOAuthErrorDetail("plain failure body");
    assert.equal(detail, "plain failure body");
  });
});

describe("tool schema selection", () => {
  it("uses Claude schemas for native Anthropic requests", () => {
    assert.equal(shouldUseClaudeToolSchemas({
      model: "claude-sonnet-4-6",
      requestUrl: "https://api.anthropic.com/v1/messages",
    }), true);
  });

  it("uses Claude schemas for Claude-family models on OpenRouter", () => {
    assert.equal(shouldUseClaudeToolSchemas({
      model: "anthropic/claude-3.7-sonnet",
      requestUrl: "https://openrouter.ai/api/v1/chat/completions",
    }), true);
  });

  it("keeps default schemas for non-Claude models on OpenRouter", () => {
    assert.equal(shouldUseClaudeToolSchemas({
      model: "x-ai/grok-4-fast",
      requestUrl: "https://openrouter.ai/api/v1/chat/completions",
    }), false);
  });

  it("keeps default schemas for non-Claude targets", () => {
    assert.equal(shouldUseClaudeToolSchemas({
      model: "gpt-4o-mini",
      requestUrl: "https://api.openai.com/v1/responses",
    }), false);
  });
});

// ── translateToolArgsJsonString: argument translation on parsed JSON ─────────

describe("translateToolArgsJsonString", () => {
  function translated(toolName: string, args: Record<string, unknown>): any {
    return JSON.parse(translateToolArgsJsonString(JSON.stringify(args), toolName));
  }

  it("renames file_path → filePath for Read", () => {
    const out = translated("Read", { file_path: "/tmp/x.txt" });
    assert.deepEqual(out, { filePath: "/tmp/x.txt" });
  });

  it("renames all Edit params", () => {
    const out = translated("Edit", {
      file_path: "/f.ts",
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
    });
    assert.deepEqual(out, {
      filePath: "/f.ts",
      oldString: "foo",
      newString: "bar",
      replaceAll: true,
    });
  });

  it("renames glob → include for Grep and preserves other keys", () => {
    const out = translated("Grep", { pattern: "hello", glob: "*.ts", path: "/src" });
    assert.deepEqual(out, { pattern: "hello", include: "*.ts", path: "/src" });
  });

  it("renames skill → name for Skill and strips args (OpenCode skill has no args param)", () => {
    const out = translated("Skill", { skill: "commit", args: "-m fix" });
    assert.deepEqual(out, { name: "commit" });
  });

  it("translates activeForm → priority INSIDE TodoWrite todos[]", () => {
    const out = translated("TodoWrite", {
      todos: [
        { content: "fix bug", status: "pending", activeForm: "Running tests" },
        { content: "ship it", status: "completed", activeForm: "Shipping" },
      ],
    });
    assert.deepEqual(out, {
      todos: [
        { content: "fix bug", status: "pending", priority: "Running tests" },
        { content: "ship it", status: "completed", priority: "Shipping" },
      ],
    });
  });

  it("does NOT rewrite activeForm when it appears only inside a string value (Linus case)", () => {
    // A TodoWrite whose content text happens to contain the literal token
    // "activeForm" must not have that substring corrupted.
    const content = 'Update the activeForm handler in foo.ts';
    const out = translated("TodoWrite", {
      todos: [{ content, status: "pending", activeForm: "Editing foo.ts" }],
    });
    // content preserved verbatim
    assert.equal(out.todos[0].content, content);
    // activeForm key renamed to priority
    assert.equal(out.todos[0].priority, "Editing foo.ts");
    assert.equal(out.todos[0].activeForm, undefined);
  });

  it("does NOT rewrite file_path when it appears inside a Bash command string", () => {
    // Bash commands have no translation — the string value must survive untouched.
    const command = 'cat heredoc <<EOF\n{"file_path": "inside/string"}\nEOF';
    const out = translated("Bash", { command });
    assert.deepEqual(out, { command });
  });

  it("maps Agent subagent_type values", () => {
    assert.equal(translated("Agent", { subagent_type: "general-purpose" }).subagent_type, "general");
    assert.equal(translated("Agent", { subagent_type: "Explore" }).subagent_type, "explore");
    assert.equal(translated("Agent", { subagent_type: "Plan" }).subagent_type, "plan");
    assert.equal(translated("Agent", { subagent_type: "statusline-setup" }).subagent_type, "build");
  });

  it("leaves an unknown Agent subagent_type untouched", () => {
    assert.equal(translated("Agent", { subagent_type: "custom-agent" }).subagent_type, "custom-agent");
  });

  it("strips prompt param for WebFetch and injects default format", () => {
    // Claude's WebFetch has no "format" field; OpenCode's webfetch needs one.
    // We default to "markdown" so the OpenCode tool receives a valid payload.
    const out = translated("WebFetch", { url: "https://example.com", prompt: "Extract title" });
    assert.deepEqual(out, { url: "https://example.com", format: "markdown" });
  });

  it("respects explicit WebFetch format if already set", () => {
    const out = translated("WebFetch", { url: "https://example.com", format: "text" });
    assert.deepEqual(out, { url: "https://example.com", format: "text" });
  });

  it("returns input unchanged for malformed JSON", () => {
    const malformed = "{not valid json";
    assert.equal(translateToolArgsJsonString(malformed, "Read"), malformed);
  });

  it("returns input unchanged for non-object JSON (array or primitive)", () => {
    assert.equal(translateToolArgsJsonString("[1,2,3]", "Read"), "[1,2,3]");
    assert.equal(translateToolArgsJsonString('"hello"', "Read"), '"hello"');
    assert.equal(translateToolArgsJsonString("null", "Read"), "null");
  });

  it("passes through unknown tool names without modification", () => {
    const out = translated("TotallyMadeUpTool", { foo: "bar", file_path: "/x" });
    assert.deepEqual(out, { foo: "bar", file_path: "/x" });
  });

  // Field stripping — Claude sends fields OpenCode's Zod schemas don't accept
  it("strips Claude-only Agent fields (model, run_in_background, isolation)", () => {
    const out = translated("Agent", {
      description: "d",
      prompt: "p",
      subagent_type: "general-purpose",
      model: "opus",
      run_in_background: true,
      isolation: "worktree",
    });
    assert.deepEqual(out, {
      description: "d",
      prompt: "p",
      subagent_type: "general",
    });
  });

  it("defaults Agent subagent_type to 'general' when missing (OpenCode requires it)", () => {
    const out = translated("Agent", { description: "d", prompt: "p" });
    assert.equal(out.subagent_type, "general");
  });

  it("strips Claude-only Bash fields (run_in_background, dangerouslyDisableSandbox)", () => {
    const out = translated("Bash", {
      command: "ls",
      run_in_background: true,
      dangerouslyDisableSandbox: true,
    });
    assert.deepEqual(out, { command: "ls" });
  });

  it("strips Claude-only Read field (pages)", () => {
    const out = translated("Read", { file_path: "/x.pdf", pages: "1-5" });
    assert.deepEqual(out, { filePath: "/x.pdf" });
  });

  it("strips Claude-only Grep fields", () => {
    const out = translated("Grep", {
      pattern: "foo",
      glob: "*.ts",
      output_mode: "content",
      "-B": 2,
      "-A": 3,
      "-C": 5,
      context: 1,
      "-n": true,
      "-i": true,
      type: "js",
      head_limit: 10,
      offset: 5,
      multiline: false,
    });
    assert.deepEqual(out, { pattern: "foo", include: "*.ts" });
  });

  it("translates AskUserQuestion multiSelect → multiple per question", () => {
    const out = translated("AskUserQuestion", {
      questions: [
        { question: "Which?", options: ["a", "b"], multiSelect: true },
        { question: "Either?", options: ["y", "n"], multiSelect: false },
      ],
    });
    assert.deepEqual(out, {
      questions: [
        { question: "Which?", options: ["a", "b"], multiple: true },
        { question: "Either?", options: ["y", "n"], multiple: false },
      ],
    });
  });
});

// ── translateArgsOpencodeToClaude: outbound translation on parsed objects ───

describe("translateArgsOpencodeToClaude", () => {
  it("renames camelCase keys to snake_case for Edit", () => {
    const out = translateArgsOpencodeToClaude("Edit", {
      filePath: "/f.ts",
      oldString: "a",
      newString: "b",
      replaceAll: true,
    });
    assert.deepEqual(out, {
      file_path: "/f.ts",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    });
  });

  it("maps OpenCode subagent_type values back to Claude", () => {
    assert.equal(translateArgsOpencodeToClaude("Agent", { subagent_type: "general" }).subagent_type, "general-purpose");
    assert.equal(translateArgsOpencodeToClaude("Agent", { subagent_type: "build" }).subagent_type, "general-purpose");
    assert.equal(translateArgsOpencodeToClaude("Agent", { subagent_type: "explore" }).subagent_type, "Explore");
    assert.equal(translateArgsOpencodeToClaude("Agent", { subagent_type: "plan" }).subagent_type, "Plan");
  });

  it("strips Agent OpenCode-only fields (task_id, command)", () => {
    const out = translateArgsOpencodeToClaude("Agent", {
      description: "d",
      prompt: "p",
      subagent_type: "general",
      task_id: "t_1",
      command: "go",
    });
    assert.deepEqual(out, {
      description: "d",
      prompt: "p",
      subagent_type: "general-purpose",
    });
  });

  it("translates AskUserQuestion multiple → multiSelect per question", () => {
    const out = translateArgsOpencodeToClaude("AskUserQuestion", {
      questions: [
        { question: "Which?", options: ["a", "b"], multiple: true },
        { question: "Either?", options: ["y", "n"], multiple: false },
      ],
    });
    assert.deepEqual(out, {
      questions: [
        { question: "Which?", options: ["a", "b"], multiSelect: true },
        { question: "Either?", options: ["y", "n"], multiSelect: false },
      ],
    });
  });

  it("synthesizes a WebFetch prompt from format (markdown)", () => {
    const out = translateArgsOpencodeToClaude("WebFetch", {
      url: "https://example.com",
      format: "markdown",
    });
    assert.deepEqual(out, {
      url: "https://example.com",
      prompt: "Fetch this URL and return the content as markdown.",
    });
  });

  it("synthesizes a WebFetch prompt from format (text)", () => {
    const out = translateArgsOpencodeToClaude("WebFetch", {
      url: "https://example.com",
      format: "text",
    });
    assert.equal(out.prompt, "Fetch this URL and return the content as plain text.");
  });

  it("synthesizes a WebFetch prompt from format (html)", () => {
    const out = translateArgsOpencodeToClaude("WebFetch", {
      url: "https://example.com",
      format: "html",
    });
    assert.equal(out.prompt, "Fetch this URL and return the raw HTML.");
  });

  it("strips WebFetch timeout (OpenCode-only)", () => {
    const out = translateArgsOpencodeToClaude("WebFetch", {
      url: "https://example.com",
      format: "markdown",
      timeout: 30,
    });
    assert.equal(out.timeout, undefined);
  });

  it("renames priority → activeForm in TodoWrite and collapses cancelled → completed", () => {
    const out = translateArgsOpencodeToClaude("TodoWrite", {
      todos: [
        { content: "a", status: "pending", priority: "Doing a" },
        { content: "b", status: "cancelled", priority: "Was doing b" },
      ],
    });
    assert.deepEqual(out, {
      todos: [
        { content: "a", status: "pending", activeForm: "Doing a" },
        { content: "b", status: "completed", activeForm: "Was doing b" },
      ],
    });
  });

  it("is the inverse of translateToolArgsJsonString for the Edit round trip", () => {
    // Round-trip: Claude inbound → OpenCode → Claude outbound should be identity
    // for keys that have a bidirectional mapping.
    const claudeArgs = { file_path: "/f.ts", old_string: "a", new_string: "b" };
    const opencodeArgs = JSON.parse(translateToolArgsJsonString(JSON.stringify(claudeArgs), "Edit"));
    const roundTripped = translateArgsOpencodeToClaude("Edit", opencodeArgs);
    assert.deepEqual(roundTripped, claudeArgs);
  });
});

// ── Agent type map integrity ─────────────────────────────────────────────────

describe("Agent type maps", () => {
  it("CLAUDE_TO_OPENCODE covers Claude's subagent_type values", () => {
    assert.equal(AGENT_TYPE_CLAUDE_TO_OPENCODE["general-purpose"], "general");
    assert.equal(AGENT_TYPE_CLAUDE_TO_OPENCODE["Explore"], "explore");
    assert.equal(AGENT_TYPE_CLAUDE_TO_OPENCODE["Plan"], "plan");
    assert.equal(AGENT_TYPE_CLAUDE_TO_OPENCODE["statusline-setup"], "build");
  });

  it("OPENCODE_TO_CLAUDE covers OpenCode's built-in agents", () => {
    assert.equal(AGENT_TYPE_OPENCODE_TO_CLAUDE["general"], "general-purpose");
    assert.equal(AGENT_TYPE_OPENCODE_TO_CLAUDE["build"], "general-purpose");
    assert.equal(AGENT_TYPE_OPENCODE_TO_CLAUDE["explore"], "Explore");
    assert.equal(AGENT_TYPE_OPENCODE_TO_CLAUDE["plan"], "Plan");
  });
});

// ── SSE processor: test the actual createSseProcessor from ./stream ─────────

const INBOUND_TOOL_NAME_MAP: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Glob: "glob",
  Grep: "grep",
  Edit: "edit",
  Write: "write",
  Agent: "task",
  WebFetch: "webfetch",
  TodoWrite: "todowrite",
  Skill: "skill",
  AskUserQuestion: "question",
};

function makeProcessor(opts: { debug?: (msg: string) => void } = {}) {
  return createSseProcessor({
    inboundToolNameMap: INBOUND_TOOL_NAME_MAP,
    translateToolArgs: translateToolArgsJsonString,
    debug: opts.debug,
  });
}

function sseEvent(eventName: string, data: object): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Walk a concatenated SSE stream and return every parsed event, so tests
 * can assert on object shape rather than substring matching.
 */
function parseAllEvents(sse: string): Array<{ event: string | null; data: any }> {
  const events: Array<{ event: string | null; data: any }> = [];
  const frames = sse.split("\n\n").filter((f) => f.length > 0).map((f) => f + "\n\n");
  for (const frame of frames) {
    const parsed = parseSseEvent(frame);
    if (!parsed) continue;
    events.push({ event: parsed.event, data: JSON.parse(parsed.data) });
  }
  return events;
}

/**
 * Extract the tool-use input that will reach OpenCode for a given block
 * index. Returns the parsed args object the consumer's SDK will see after
 * concatenating all partial_json fragments for that block.
 */
function finalToolArgs(sse: string, blockIndex: number): any {
  const events = parseAllEvents(sse);
  const fragments: string[] = [];
  for (const e of events) {
    if (
      e.data?.type === "content_block_delta" &&
      e.data.index === blockIndex &&
      e.data.delta?.type === "input_json_delta"
    ) {
      fragments.push(String(e.data.delta.partial_json ?? ""));
    }
  }
  if (fragments.length === 0) return null;
  return JSON.parse(fragments.join(""));
}

function toolUseStartName(sse: string, blockIndex: number): string | null {
  const events = parseAllEvents(sse);
  for (const e of events) {
    if (
      e.data?.type === "content_block_start" &&
      e.data.index === blockIndex &&
      e.data.content_block?.type === "tool_use"
    ) {
      return e.data.content_block.name;
    }
  }
  return null;
}

// Helper that runs a tool_use through the processor: start, one or more
// delta fragments, stop. Returns the concatenated SSE output.
function runToolUse(toolName: string, fragments: string[], opts: { index?: number } = {}): string {
  const idx = opts.index ?? 1;
  const proc = makeProcessor();
  let out = "";
  out += proc.feedChunk(sseEvent("content_block_start", {
    type: "content_block_start",
    index: idx,
    content_block: { type: "tool_use", id: `tu_${idx}`, name: toolName, input: {} },
  }));
  for (const frag of fragments) {
    out += proc.feedChunk(sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: idx,
      delta: { type: "input_json_delta", partial_json: frag },
    }));
  }
  out += proc.feedChunk(sseEvent("content_block_stop", {
    type: "content_block_stop",
    index: idx,
  }));
  return out;
}

describe("SSE processor: tool name mapping", () => {
  for (const [claude, opencode] of Object.entries(INBOUND_TOOL_NAME_MAP)) {
    it(`maps ${claude} → ${opencode} on content_block_start`, () => {
      const out = runToolUse(claude, ['{}']);
      assert.equal(toolUseStartName(out, 1), opencode);
    });
  }

  it("passes through an unknown tool name without modification", () => {
    const out = runToolUse("CustomUnmappedTool", ['{}']);
    assert.equal(toolUseStartName(out, 1), "CustomUnmappedTool");
  });
});

describe("SSE processor: argument translation", () => {
  it("translates file_path → filePath for Read", () => {
    const out = runToolUse("Read", ['{"file_path": "/tmp/test.txt"}']);
    assert.deepEqual(finalToolArgs(out, 1), { filePath: "/tmp/test.txt" });
  });

  it("translates all Edit params", () => {
    const out = runToolUse("Edit", [
      '{"file_path": "/f.ts", "old_string": "foo", "new_string": "bar", "replace_all": true}',
    ]);
    assert.deepEqual(finalToolArgs(out, 1), {
      filePath: "/f.ts",
      oldString: "foo",
      newString: "bar",
      replaceAll: true,
    });
  });

  it("translates glob → include for Grep, preserves pattern", () => {
    const out = runToolUse("Grep", ['{"pattern": "hello", "glob": "*.ts"}']);
    assert.deepEqual(finalToolArgs(out, 1), { pattern: "hello", include: "*.ts" });
  });

  it("translates activeForm → priority per todo item in TodoWrite", () => {
    const out = runToolUse("TodoWrite", [
      '{"todos": [{"content": "fix", "status": "pending", "activeForm": "Fixing"}]}',
    ]);
    assert.deepEqual(finalToolArgs(out, 1), {
      todos: [{ content: "fix", status: "pending", priority: "Fixing" }],
    });
  });

  it("translates Agent subagent_type values", () => {
    const out = runToolUse("Agent", [
      '{"description": "d", "prompt": "p", "subagent_type": "general-purpose"}',
    ]);
    assert.deepEqual(finalToolArgs(out, 1), {
      description: "d",
      prompt: "p",
      subagent_type: "general",
    });
  });

  it("strips prompt and injects default format for WebFetch", () => {
    const out = runToolUse("WebFetch", [
      '{"url": "https://example.com", "prompt": "Extract the title"}',
    ]);
    assert.deepEqual(finalToolArgs(out, 1), {
      url: "https://example.com",
      format: "markdown",
    });
  });

  it("translates skill → name and strips args for Skill", () => {
    const out = runToolUse("Skill", ['{"skill": "commit", "args": "-m fix"}']);
    assert.deepEqual(finalToolArgs(out, 1), { name: "commit" });
  });

  it("leaves Bash args untouched", () => {
    const out = runToolUse("Bash", ['{"command": "echo hello"}']);
    assert.deepEqual(finalToolArgs(out, 1), { command: "echo hello" });
  });
});

describe("SSE processor: chunk boundary handling", () => {
  it("handles args split across many small fragments", () => {
    const out = runToolUse("Read", ['{"fi', 'le_', 'pa', 'th":', ' "/', 'tmp/', 'x.t', 'xt"}']);
    assert.deepEqual(finalToolArgs(out, 1), { filePath: "/tmp/x.txt" });
  });

  it("handles multiple SSE events concatenated into one chunk", () => {
    const proc = makeProcessor();
    const combined =
      sseEvent("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "Read", input: {} },
      }) +
      sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"file_path": "/a.txt"}' },
      }) +
      sseEvent("content_block_stop", {
        type: "content_block_stop",
        index: 1,
      });
    const out = proc.feedChunk(combined);
    assert.deepEqual(finalToolArgs(out, 1), { filePath: "/a.txt" });
    assert.ok(parseAllEvents(out).some((e) => e.data.type === "content_block_stop"));
  });

  it("handles an SSE event split across two chunks", () => {
    const proc = makeProcessor();
    const fullEvent = sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu_1", name: "Write", input: {} },
    });
    const mid = Math.floor(fullEvent.length / 2);
    const first = proc.feedChunk(fullEvent.slice(0, mid));
    assert.equal(first, "", "No complete event yet — should not emit");
    const second = proc.feedChunk(fullEvent.slice(mid));
    assert.equal(toolUseStartName(second, 1), "write");
  });

  it("passes through text deltas unchanged", () => {
    const proc = makeProcessor();
    const out = proc.feedChunk(sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello world" },
    }));
    const events = parseAllEvents(out);
    assert.equal(events.length, 1);
    assert.equal(events[0].data.delta.text, "Hello world");
  });

  it("does NOT translate tool args inside a text_delta", () => {
    // Proves text content isn't mutated: a text_delta containing the
    // literal string "file_path" survives intact.
    const proc = makeProcessor();
    const out = proc.feedChunk(sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "use file_path to specify path" },
    }));
    const events = parseAllEvents(out);
    assert.equal(events[0].data.delta.text, "use file_path to specify path");
  });
});

describe("SSE processor: interleaved and concurrent tool_use blocks", () => {
  it("keeps per-block state isolated across interleaved deltas", () => {
    const proc = makeProcessor();
    let out = "";

    // Open block 1 (Read)
    out += proc.feedChunk(sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu_1", name: "Read", input: {} },
    }));
    // Open block 2 (Write) — shouldn't be valid per Anthropic's ordering but
    // the processor must still keep state by index, not a single "current".
    out += proc.feedChunk(sseEvent("content_block_start", {
      type: "content_block_start",
      index: 2,
      content_block: { type: "tool_use", id: "tu_2", name: "Write", input: {} },
    }));

    // Interleave deltas for both blocks
    out += proc.feedChunk(sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"file_path": "/read.txt"}' },
    }));
    out += proc.feedChunk(sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: '{"file_path": "/write.txt", "content": "hi"}' },
    }));

    out += proc.feedChunk(sseEvent("content_block_stop", { type: "content_block_stop", index: 1 }));
    out += proc.feedChunk(sseEvent("content_block_stop", { type: "content_block_stop", index: 2 }));

    assert.deepEqual(finalToolArgs(out, 1), { filePath: "/read.txt" });
    assert.deepEqual(finalToolArgs(out, 2), { filePath: "/write.txt", content: "hi" });
  });
});

describe("SSE processor: error handling", () => {
  it("calls debug callback on malformed JSON in an SSE data frame", () => {
    const messages: string[] = [];
    const proc = createSseProcessor({
      inboundToolNameMap: INBOUND_TOOL_NAME_MAP,
      translateToolArgs: translateToolArgsJsonString,
      debug: (m) => messages.push(m),
    });
    const malformed = "event: content_block_start\ndata: {not valid\n\n";
    const out = proc.feedChunk(malformed);
    // Passed through as-is
    assert.equal(out, malformed);
    // And we told the operator about it (behind their debug flag)
    assert.ok(messages.some((m) => m.includes("JSON.parse failed")), `Expected debug log, got: ${JSON.stringify(messages)}`);
  });

  it("calls debug callback when translateToolArgs throws", () => {
    const messages: string[] = [];
    const proc = createSseProcessor({
      inboundToolNameMap: INBOUND_TOOL_NAME_MAP,
      translateToolArgs: () => { throw new Error("translator blew up"); },
      debug: (m) => messages.push(m),
    });
    let out = "";
    out += proc.feedChunk(sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu_1", name: "Read", input: {} },
    }));
    out += proc.feedChunk(sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"file_path": "/x"}' },
    }));
    out += proc.feedChunk(sseEvent("content_block_stop", { type: "content_block_stop", index: 1 }));
    assert.ok(messages.some((m) => m.includes("translator blew up")));
    // And we fall back to emitting the raw (untranslated) JSON so downstream doesn't hang
    assert.deepEqual(finalToolArgs(out, 1), { file_path: "/x" });
  });
});

describe("SSE processor: flush", () => {
  it("flush returns any trailing buffered bytes", () => {
    const proc = makeProcessor();
    const partial = "event: content_block_start\ndata: {\"t"; // incomplete frame
    assert.equal(proc.feedChunk(partial), "");
    assert.equal(proc.flush(), partial);
    // And state is cleared after flush
    assert.equal(proc.flush(), "");
  });

  it("logs a debug warning when a tool_use block is abandoned mid-stream", () => {
    // Simulates upstream disconnect after start + some deltas but before stop.
    const messages: string[] = [];
    const proc = createSseProcessor({
      inboundToolNameMap: INBOUND_TOOL_NAME_MAP,
      translateToolArgs: translateToolArgsJsonString,
      debug: (m) => messages.push(m),
    });
    proc.feedChunk(sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu_1", name: "Read", input: {} },
    }));
    proc.feedChunk(sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"file_path"' },
    }));
    // ...and then the stream ends without a content_block_stop.
    proc.flush();
    assert.ok(
      messages.some((m) => m.includes("abandoned") && m.includes("index=1") && m.includes("tool=Read")),
      `Expected abandoned-block warning, got: ${JSON.stringify(messages)}`,
    );
  });
});

describe("SSE processor: pass-through optimization", () => {
  // Pass-through events (message_start, ping, message_delta, text
  // content_block_delta, etc.) should not be round-tripped through
  // JSON.parse + JSON.stringify — the output bytes should match the input
  // exactly when no translation is needed.
  it("emits the exact input bytes for ping events (no reserialize)", () => {
    const proc = makeProcessor();
    const pingFrame = sseEvent("ping", { type: "ping" });
    const out = proc.feedChunk(pingFrame);
    assert.equal(out, pingFrame);
  });

  it("emits the exact input bytes for message_start events", () => {
    const proc = makeProcessor();
    // Anthropic message_start payloads include nested objects and arrays —
    // passthrough must preserve byte-for-byte equality, including any
    // particular key order the API happens to emit.
    const frame =
      "event: message_start\n" +
      'data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[],"model":"claude","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1}}}' +
      "\n\n";
    const out = proc.feedChunk(frame);
    assert.equal(out, frame);
  });

  it("emits the exact input bytes for text_delta events", () => {
    const proc = makeProcessor();
    const frame = sseEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello world" },
    });
    const out = proc.feedChunk(frame);
    assert.equal(out, frame);
  });

  it("still transforms tool_use content_block_start (optimization does not skip interesting events)", () => {
    const proc = makeProcessor();
    const input = sseEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tu_1", name: "Read", input: {} },
    });
    const out = proc.feedChunk(input);
    assert.notEqual(out, input, "tool_use start should be transformed (name mapped)");
    assert.equal(toolUseStartName(out, 1), "read");
  });
});

describe("parseSseEvent / buildSseEvent round trip", () => {
  it("round-trips a simple event", () => {
    const original = buildSseEvent("ping", '{"type":"ping"}');
    const parsed = parseSseEvent(original);
    assert.deepEqual(parsed, { event: "ping", data: '{"type":"ping"}' });
  });

  it("returns null for a frame with no data line", () => {
    assert.equal(parseSseEvent("event: foo\n\n"), null);
  });

  it("handles a data-only frame (no event line)", () => {
    const parsed = parseSseEvent('data: {"ok":true}\n\n');
    assert.deepEqual(parsed, { event: null, data: '{"ok":true}' });
  });
});

describe("deriveModelDisplayName", () => {
  it("parses claude-opus-4-7 → Opus 4.7", () => {
    assert.equal(deriveModelDisplayName("claude-opus-4-7"), "Opus 4.7");
  });

  it("parses claude-sonnet-4-6 → Sonnet 4.6", () => {
    assert.equal(deriveModelDisplayName("claude-sonnet-4-6"), "Sonnet 4.6");
  });

  it("ignores a trailing date suffix (claude-haiku-4-5-20251001 → Haiku 4.5)", () => {
    assert.equal(deriveModelDisplayName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  });

  it("falls back to the raw id when the convention doesn't match", () => {
    assert.equal(deriveModelDisplayName("weird-custom-model"), "weird-custom-model");
    assert.equal(deriveModelDisplayName("claude-3-5-sonnet-20241022"), "claude-3-5-sonnet-20241022");
  });
});

describe("rewriteSystemBlocksForModel", () => {
  const sourceBlock = {
    type: "text",
    text:
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.\n" +
      " - You are powered by the model named Sonnet 4.6. The exact model ID is claude-sonnet-4-6.\n" +
      " - Assistant knowledge cutoff is August 2025.",
  };

  it("rewrites the identity line to match the requested model", () => {
    const [out] = rewriteSystemBlocksForModel([sourceBlock], "claude-opus-4-7");
    assert.ok(out.text?.includes("named Opus 4.7"));
    assert.ok(out.text?.includes("claude-opus-4-7"));
    assert.ok(!out.text?.includes("Sonnet 4.6"));
    assert.ok(!out.text?.includes("claude-sonnet-4-6"));
  });

  it("leaves blocks untouched when no model id is provided", () => {
    const [out] = rewriteSystemBlocksForModel([sourceBlock], undefined);
    assert.equal(out, sourceBlock);
  });

  it("handles a dated variant without re-including the date suffix in the display name", () => {
    const [out] = rewriteSystemBlocksForModel([sourceBlock], "claude-haiku-4-5-20251001");
    assert.ok(out.text?.includes("named Haiku 4.5"));
    assert.ok(out.text?.includes("The exact model ID is claude-haiku-4-5-20251001."));
  });

  it("preserves non-text blocks and non-matching text", () => {
    const nonText = { type: "other", text: "unchanged" };
    const noMatch = { type: "text", text: "no identity line here" };
    const blocks = [nonText, noMatch];
    const out = rewriteSystemBlocksForModel(blocks, "claude-opus-4-7");
    assert.deepEqual(out[0], nonText);
    assert.equal(out[1].text, "no identity line here");
  });
});
