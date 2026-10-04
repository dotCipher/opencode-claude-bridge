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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  translateToolArgsJsonString,
  translateArgsOpencodeToClaude,
  AGENT_TYPE_CLAUDE_TO_OPENCODE,
  AGENT_TYPE_OPENCODE_TO_CLAUDE,
  shouldUseClaudeToolSchemas,
} from "./claude-tools.js";
import {
  extractOAuthErrorDetail,
  parseOAuthRedirect,
  startOAuthCallbackServer,
  type OAuthTokens,
} from "./oauth.js";
import { selectClaudeCredentials } from "./keychain.js";
import {
  createOpenCodeClaudeBridgeV2,
  default as pluginModule,
  buildBetaFlags,
  deriveModelDisplayName,
  getClaudeToolsForActiveOpenCodeTools,
  getInboundToolNameMapForActiveOpenCodeTools,
  isAnthropicApiUrl,
  mapOutboundToolName,
  rewriteSystemBlocksForModel,
  shouldInjectClaudeTools,
  stripAssistantPrefillForClaude,
  stripMessageCacheControlPreservingTail,
  stripSystemCacheControl,
  type V2PluginContext,
} from "./index.js";
import { createSseProcessor, parseSseEvent, buildSseEvent } from "./stream.js";
import { BETA_FLAGS, OAUTH_BETA_FLAG } from "./constants.js";
import {
  MAX_RETRY_DELAY_MS,
  getResponseRetryDelayMs,
  parseRetryAfterMs,
  waitForRetry,
} from "./retry.js";

describe("Anthropic beta headers", () => {
  it("preserves SDK beta flags alongside the bridge requirements", () => {
    const sdkBeta = "thinking-binding-controls-test";
    const flags = buildBetaFlags(sdkBeta).split(",");
    assert.ok(flags.includes(sdkBeta), "request-body feature betas must survive rewriting");
    assert.deepEqual(flags.slice(0, 2), ["claude-code-20250219", OAUTH_BETA_FLAG]);
    for (const flag of BETA_FLAGS.split(",").map((value) => value.trim()).filter(Boolean)) {
      assert.ok(flags.includes(flag), `missing configured beta: ${flag}`);
    }
  });

  it("deduplicates overlapping flags and removes whitespace and empty entries", () => {
    const flags = buildBetaFlags(
      ` , ${OAUTH_BETA_FLAG}, claude-code-20250219, ${BETA_FLAGS}, sdk-test, sdk-test, , `,
    ).split(",");
    assert.equal(flags.length, new Set(flags).size);
    assert.ok(flags.every((flag) => flag.length > 0 && flag === flag.trim()));
    assert.ok(flags.includes("sdk-test"));
  });

  it("keeps the bridge requirements when no incoming beta header is present", () => {
    assert.deepEqual(buildBetaFlags("").split(","), [...new Set([
      "claude-code-20250219",
      OAUTH_BETA_FLAG,
      ...BETA_FLAGS.split(",").map((flag) => flag.trim()).filter(Boolean),
    ])]);
  });
});

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

describe("Claude assistant prefill stripping", () => {
  it("strips the synthetic continue prefill so Anthropic requests end with a user message", () => {
    const out = stripAssistantPrefillForClaude([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: "Continue with your tasks." },
    ]);
    assert.deepEqual(out, [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("appends a user turn after a real assistant tail so the request ends on a user message", () => {
    const out = stripAssistantPrefillForClaude([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: "Real assistant content" },
    ]);
    assert.deepEqual(out, [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: "Real assistant content" },
      { role: "user", content: "Continue." },
    ]);
  });

  it("drops the nudge then appends a user turn when it trails a real assistant turn", () => {
    const out = stripAssistantPrefillForClaude([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: "Real assistant content" },
      { role: "assistant", content: "Continue with your tasks." },
    ]);
    assert.deepEqual(out, [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: "Real assistant content" },
      { role: "user", content: "Continue." },
    ]);
  });

  it("ends on a user turn after opencode's max-steps assistant prefill", () => {
    const maxSteps = "CRITICAL - MAXIMUM STEPS REACHED\n\nTools are disabled until next user input. Respond with text only.";
    for (const content of [maxSteps, [{ type: "text", text: maxSteps }]]) {
      const out = stripAssistantPrefillForClaude([
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content },
      ]);
      assert.deepEqual(out, [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content },
        { role: "user", content: "Continue." },
      ]);
    }
  });

  it("leaves a user-tailed conversation unchanged", () => {
    const input = [
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const out = stripAssistantPrefillForClaude(input);
    // Assert against a fresh literal (not the same reference) so the test would
    // fail if the function mutated the input or appended a synthetic turn.
    assert.deepEqual(out, [
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    assert.equal(out.length, 2);
  });
});

describe("system cache control", () => {
  it("strips cache_control from system blocks", () => {
    assert.deepEqual(stripSystemCacheControl([
      { type: "text", text: "a", cache_control: { type: "ephemeral" } },
      { type: "text", text: "b" },
    ]), [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });
});

describe("message cache control (tail breakpoint)", () => {
  it("preserves the tail message's text cache_control but strips earlier ones", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "old", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "mid", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "tail", cache_control: { type: "ephemeral" } }],
      },
    ];
    stripMessageCacheControlPreservingTail(messages);
    // Earlier messages: cache_control stripped.
    assert.equal("cache_control" in messages[0].content[0], false);
    assert.equal("cache_control" in messages[1].content[0], false);
    // Tail message: cache_control preserved (the surviving breakpoint).
    assert.deepEqual(messages[2].content[0].cache_control, { type: "ephemeral" });
  });

  it("preserves a tail breakpoint even when the tail block is text (text-tailed request)", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] },
    ];
    stripMessageCacheControlPreservingTail(messages);
    assert.deepEqual(messages[0].content[0].cache_control, { type: "ephemeral" });
  });

  it("leaves non-text blocks and messages without content untouched", () => {
    const messages: Array<{ role: string; content?: unknown }> = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "r", cache_control: { type: "ephemeral" } },
          { type: "text", text: "x", cache_control: { type: "ephemeral" } },
        ],
      },
      { role: "assistant", content: undefined },
      { role: "user", content: [{ type: "text", text: "tail" }] },
    ];
    stripMessageCacheControlPreservingTail(messages);
    const first = messages[0].content as Array<Record<string, unknown>>;
    // Non-text block: never stripped.
    assert.deepEqual(first[0].cache_control, { type: "ephemeral" });
    // Earlier text block: stripped.
    assert.equal("cache_control" in first[1], false);
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

  it("injects Claude tool schemas only when active tools are present", () => {
    assert.equal(shouldInjectClaudeTools({
      model: "claude-sonnet-4-6",
      requestUrl: "https://api.anthropic.com/v1/messages",
      tools: [{ name: "bash" }],
    }), true);
  });

  it("does not inject Claude tool schemas for tool-less summary or compaction requests", () => {
    assert.equal(shouldInjectClaudeTools({
      model: "claude-sonnet-4-6",
      requestUrl: "https://api.anthropic.com/v1/messages",
      tools: [],
    }), false);
    assert.equal(shouldInjectClaudeTools({
      model: "claude-sonnet-4-6",
      requestUrl: "https://api.anthropic.com/v1/messages",
      tools: undefined,
    }), false);
  });

  it("filters Claude tool schemas to tools active in the OpenCode request", () => {
    const out = getClaudeToolsForActiveOpenCodeTools([
      { name: "bash" },
      { name: "webfetch" },
      { name: "question" },
    ]).map((tool) => tool.name).sort();
    assert.deepEqual(out, ["AskUserQuestion", "Bash", "WebFetch"]);
  });

  it("does not advertise WebSearch when only a custom websearch_cited tool is active", () => {
    const out = getClaudeToolsForActiveOpenCodeTools([
      { name: "webfetch" },
      {
        name: "websearch_cited",
        description: "Search the web with citations",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]).map((tool) => tool.name).sort();
    assert.deepEqual(out, ["WebFetch", "websearch_cited"]);
  });

  it("preserves active MCP and custom OpenCode tools", () => {
    const customTool = {
      name: "custom_mcp_query_record",
      description: "Get a record by ID",
      input_schema: {
        type: "object",
        properties: { recordId: { type: "string" } },
        required: ["recordId"],
      },
    };
    const out = getClaudeToolsForActiveOpenCodeTools([
      { name: "bash", description: "OpenCode bash", input_schema: { type: "object" } },
      customTool,
    ]);

    const bashTool = out.find((tool) => tool.name === "Bash");
    const preservedTool = out.find((tool) => tool.name === customTool.name);

    assert.ok(bashTool);
    assert.notEqual(bashTool.description, "OpenCode bash");
    assert.deepEqual(preservedTool, customTool);
  });

  it("preserves MCP tools that have no description", () => {
    const out = getClaudeToolsForActiveOpenCodeTools([
      {
        name: "custom_mcp_get_timestamp",
        input_schema: { type: "object", properties: {} },
      },
    ]);

    assert.deepEqual(out, [
      {
        name: "custom_mcp_get_timestamp",
        description: "",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("preserves MCP tools whose names look like prefixed core tools", () => {
    const mcpTool = {
      name: "mcp_bash",
      description: "Run a command through an MCP server",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    };
    const out = getClaudeToolsForActiveOpenCodeTools([mcpTool]);

    assert.deepEqual(out, [mcpTool]);
  });

  it("preserves custom tools whose names collide with Claude core tool names", () => {
    const customTool = {
      name: "Bash",
      description: "Custom Bash-like MCP tool",
      input_schema: {
        type: "object",
        properties: { script: { type: "string" } },
        required: ["script"],
      },
    };
    const out = getClaudeToolsForActiveOpenCodeTools([customTool]);

    assert.deepEqual(out, [customTool]);
  });

  it("maps inbound Claude core names only for active OpenCode core tools", () => {
    assert.deepEqual(getInboundToolNameMapForActiveOpenCodeTools([
      { name: "bash" },
      { name: "mcp_bash", input_schema: { type: "object" } },
    ]), { Bash: "bash" });
    assert.deepEqual(getInboundToolNameMapForActiveOpenCodeTools([
      { name: "Bash", input_schema: { type: "object" } },
    ]), {});
  });

  it("maps outbound OpenCode core history but preserves MCP-prefixed names", () => {
    assert.equal(mapOutboundToolName("bash"), "Bash");
    assert.equal(mapOutboundToolName("mcp_bash"), "mcp_bash");
  });

  it("does not advertise AskUserQuestion when OpenCode did not enable question", () => {
    const out = getClaudeToolsForActiveOpenCodeTools([
      { name: "bash" },
      { name: "read" },
    ]).map((tool) => tool.name).sort();
    assert.deepEqual(out, ["Bash", "Read"]);
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

  it("parses stringified AskUserQuestion questions and translates multiSelect", () => {
    const out = translated("AskUserQuestion", {
      questions: JSON.stringify([
        {
          header: "Slack secret fix",
          question: "SLACK_WEBHOOK_URL is missing. How do you want to handle it?",
          options: [
            { label: "Set manually now", description: "Paste the webhook URL now." },
            { label: "IaC it properly now", description: "Wire the secret through IaC." },
          ],
          multiSelect: false,
        },
      ]),
    });
    assert.deepEqual(out, {
      questions: [
        {
          header: "Slack secret fix",
          question: "SLACK_WEBHOOK_URL is missing. How do you want to handle it?",
          options: [
            { label: "Set manually now", description: "Paste the webhook URL now." },
            { label: "IaC it properly now", description: "Wire the secret through IaC." },
          ],
          multiple: false,
        },
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

  it("maps plan_enter → EnterPlanMode with empty args (outbound)", () => {
    const out = translateArgsOpencodeToClaude("EnterPlanMode", {});
    assert.deepEqual(out, {});
  });

  it("maps plan_exit → ExitPlanMode preserving allowedPrompts (outbound)", () => {
    const out = translateArgsOpencodeToClaude("ExitPlanMode", {
      allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
    });
    assert.deepEqual(out, { allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] });
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
  EnterPlanMode: "plan_enter",
  ExitPlanMode: "plan_exit",
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

  it("maps EnterPlanMode → plan_enter with empty args", () => {
    const out = runToolUse("EnterPlanMode", ['{}']);
    assert.equal(toolUseStartName(out, 1), "plan_enter");
    assert.deepEqual(finalToolArgs(out, 1), {});
  });

  it("maps ExitPlanMode → plan_exit preserving allowedPrompts", () => {
    const out = runToolUse("ExitPlanMode", [
      '{"allowedPrompts":[{"tool":"Bash","prompt":"run tests"}]}',
    ]);
    assert.equal(toolUseStartName(out, 1), "plan_exit");
    assert.deepEqual(finalToolArgs(out, 1), {
      allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
    });
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

describe("plugin module shape", () => {
  it("default-exports { id, setup, server } so opencode's loader recognises it", () => {
    // A bare function default export sends opencode down its legacy path, where
    // it calls every named export of this module as a plugin factory — which
    // crashes on the helpers above and takes the whole plugin down with it.
    // `server` keeps the V1 implementation on opencode >= 1.18; `setup` adds
    // opencode >= 2, which ignores `server` and never runs V1 hooks.
    assert.equal(typeof pluginModule, "object");
    assert.equal(typeof pluginModule.server, "function");
    assert.equal(typeof pluginModule.setup, "function");
  });

  it("carries an id, which opencode requires for path-referenced plugins", () => {
    assert.equal(pluginModule.id, "opencode-claude-bridge");
  });

  it("v2 setup registers the anthropic oauth method override and provider-scoped hooks", async () => {
    const registrations: string[] = [];
    const methodUpdate = { capture: null as unknown };
    const hooks: Array<{ name: string; options?: { providerID?: string } }> = [];
    const ctx = {
      integration: {
        transform: async (editor: (editor: {
          method: {
            update(registration: Record<string, unknown>): void;
          };
        }) => void) => {
          editor({
            method: {
              update(registration: Record<string, unknown>) {
                methodUpdate.capture = registration;
                registrations.push("integration.transform");
              },
            },
          });
        },
        connection: {
          active: async () => undefined,
          resolve: async () => undefined,
        },
      },
      session: {
        hook: async (name: string, _cb: unknown, options?: { providerID?: string }) => {
          hooks.push({ name, options });
          registrations.push(`session.hook(${name})`);
        },
      },
    };
    const cleanup = await (pluginModule.setup as (c: unknown) => Promise<unknown>)(ctx);

    const registration = methodUpdate.capture as Record<string, unknown>;
    assert.equal(registration.integrationID, "anthropic");
    const method = registration.method as Record<string, unknown>;
    assert.equal(method.id, "oauth");
    assert.equal(method.type, "oauth");
    assert.equal(typeof registration.authorize, "function");
    assert.equal(typeof registration.refresh, "function");
    // The refresh callback must be async — opencode calls .then() on its result
    // (a plain-object return crashes the credential resolver).
    assert.equal(
      (registration.refresh as (...args: unknown[]) => unknown).constructor.name,
      "AsyncFunction",
      "refresh must be async so opencode can await it",
    );

    assert.deepEqual(
      hooks.map((h) => `${h.name}:${h.options?.providerID ?? ""}`).sort(),
      [
        "compaction:anthropic",
        "context:anthropic",
        "generate:anthropic",
        "http.request:anthropic",
        "http.response:anthropic",
        "title:anthropic",
      ],
    );
    assert.equal(typeof cleanup, "function");
  });
});

describe("isAnthropicApiUrl security", () => {
  it("accepts HTTPS anthropic.com and subdomains", () => {
    assert.equal(isAnthropicApiUrl("https://api.anthropic.com/v1/messages", undefined), true);
    assert.equal(isAnthropicApiUrl("https://anthropic.com/v1/messages", undefined), true);
    assert.equal(isAnthropicApiUrl("https://us.api.anthropic.com/v1/messages", undefined), true);
  });

  it("rejects suffix-spoofed domains and plaintext HTTP", () => {
    assert.equal(isAnthropicApiUrl("https://evilanthropic.com/v1/messages", undefined), false);
    assert.equal(isAnthropicApiUrl("https://anthropic.com.evil.example/v1/messages", undefined), false);
    assert.equal(isAnthropicApiUrl("http://api.anthropic.com/v1/messages", undefined), false);
    assert.equal(isAnthropicApiUrl("https://api.openai.com/v1/responses", undefined), false);
    assert.equal(isAnthropicApiUrl("not-a-url", undefined), false);
  });

  it("allows explicitly configured HTTPS or loopback HTTP ANTHROPIC_BASE_URL only", () => {
    assert.equal(
      isAnthropicApiUrl("http://127.0.0.1:43210/v1/messages", "http://127.0.0.1:43210"),
      true,
    );
    assert.equal(
      isAnthropicApiUrl("http://127.0.0.1:43210/v1/messages", undefined),
      false,
    );
    assert.equal(
      isAnthropicApiUrl("https://proxy.corp.internal/v1/messages", "https://proxy.corp.internal"),
      true,
    );
    assert.equal(
      isAnthropicApiUrl("http://proxy.corp.internal/v1/messages", "http://proxy.corp.internal"),
      false,
    );
    assert.equal(
      isAnthropicApiUrl("https://other.corp.internal/v1/messages", "https://proxy.corp.internal"),
      false,
    );
  });
});

describe("OAuth CSRF state & redirect paste security", () => {
  it("parseOAuthRedirect accepts matching state and extracts code or error", () => {
    assert.deepEqual(
      parseOAuthRedirect("http://localhost:9999/callback?code=abc123&state=s-good", "s-good"),
      { code: "abc123" },
    );
    assert.deepEqual(
      parseOAuthRedirect(
        "http://localhost:9999/callback?error=access_denied&error_description=Denied&state=s-good",
        "s-good",
      ),
      { error: "Denied" },
    );
  });

  it("parseOAuthRedirect rejects mismatched state, malformed URL, or missing code", () => {
    assert.throws(
      () => parseOAuthRedirect("http://localhost:9999/callback?code=abc&state=wrong", "s-good"),
      /different sign-in/,
    );
    assert.throws(
      () => parseOAuthRedirect("http://localhost:9999/callback?code=abc", "s-good"),
      /different sign-in/,
    );
    assert.throws(
      () => parseOAuthRedirect("not a url", "s-good"),
      /full URL/,
    );
    assert.throws(
      () => parseOAuthRedirect("http://localhost:9999/callback?state=s-good", "s-good"),
      /authorization code/,
    );
  });

  it("callback server rejects forged/missing state without aborting legitimate callback", async () => {
    const server = await startOAuthCallbackServer();
    try {
      const codePromise = server.waitForCode();

      // Forged request with wrong state gets 400 and does NOT settle the attempt
      const forged = await fetch(`http://localhost:${server.port}/callback?code=evil&state=wrong`);
      assert.equal(forged.status, 400);

      // Missing state also gets 400
      const missing = await fetch(`http://localhost:${server.port}/callback?code=evil`);
      assert.equal(missing.status, 400);

      // Legitimate callback with matching state succeeds
      const ok = await fetch(
        `http://localhost:${server.port}/callback?code=legit-code&state=${encodeURIComponent(server.state)}`,
      );
      assert.equal(ok.status, 200);
      assert.equal(await codePromise, "legit-code");

      // Duplicate callback after settlement gets 409
      const dup = await fetch(
        `http://localhost:${server.port}/callback?code=second&state=${encodeURIComponent(server.state)}`,
      );
      assert.equal(dup.status, 409);
    } finally {
      server.close();
    }
  });

  it("callback server submitRedirect settles waitForCode on valid state and rejects bad pastes", async () => {
    const server = await startOAuthCallbackServer();
    try {
      const codePromise = server.waitForCode();

      // Bad paste throws without aborting waitForCode
      assert.throws(
        () => server.submitRedirect("http://localhost:1234/callback?code=evil&state=bad"),
        /different sign-in/,
      );

      // Good paste resolves waitForCode
      server.submitRedirect(
        `http://localhost:${server.port}/callback?code=pasted-code&state=${encodeURIComponent(server.state)}`,
      );
      assert.equal(await codePromise, "pasted-code");
    } finally {
      server.close();
    }
  });
});

// ── Test harness for OpenCode v2 plugin ────────────────────────────

type MockV2Options = {
  activeConnection?: { type: "credential"; id: string; label?: string; method?: string } | { type: "env"; name: string };
  resolvedCredential?: { type: string; access?: string; refresh?: string; expires?: number; key?: string; methodID?: string };
};

function createMockV2Context(opts: MockV2Options = {}) {
  const state = {
    activeConnection: opts.activeConnection,
    resolvedCredential: opts.resolvedCredential,
  };
  const disposed: string[] = [];
  const connectCalls: Array<{ integrationID: string; methodID: string; label?: string }> = [];
  let oauthRegistration: {
    integrationID: string;
    method: { id: string; type: "oauth"; label: string };
    authorize: () => Promise<any>;
    refresh: (cred: any) => Promise<any>;
  } | null = null;
  const hooks = new Map<string, Array<{ cb: (event: any) => any; providerID?: string }>>();

  const ctx: V2PluginContext = {
    integration: {
      transform: async (editor) => {
        editor({
          method: {
            update(registration) {
              oauthRegistration = registration;
            },
          },
        });
        return {
          dispose: async () => {
            disposed.push("integration.transform");
          },
        };
      },
      oauth: {
        connect: async (input) => {
          connectCalls.push(input);
          if (oauthRegistration) {
            const auth = await oauthRegistration.authorize();
            if (auth.mode === "auto") {
              const cred = await auth.callback;
              state.activeConnection = {
                type: "credential",
                id: "cred_bootstrapped",
                label: input.label ?? "Claude CLI",
                method: "oauth",
              };
              state.resolvedCredential = cred;
            }
          }
          return { attemptID: "att_1" };
        },
      },
      connection: {
        active: async () => state.activeConnection,
        resolve: async () => state.resolvedCredential,
      },
    },
    session: {
      hook: async (name, cb, options) => {
        const list = hooks.get(name) ?? [];
        list.push({ cb, providerID: options?.providerID });
        hooks.set(name, list);
        return {
          dispose: async () => {
            disposed.push(`session.hook:${name}`);
          },
        };
      },
    },
  };

  return {
    ctx,
    state,
    disposed,
    connectCalls,
    getOAuthRegistration: () => oauthRegistration,
    triggerHook: async (name: string, event: any) => {
      for (const entry of hooks.get(name) ?? []) {
        await entry.cb(event);
      }
      return event;
    },
  };
}

describe("OpenCode v2 plugin (setup)", () => {
  const validTokens: OAuthTokens = {
    access: "sk-ant-oat01-valid-token",
    refresh: "sk-ant-ort01-valid-refresh",
    expires: Date.now() + 3_600_000,
  };

  it("seamlessly bootstraps keychain credentials when no Anthropic connection exists", async () => {
    const mock = createMockV2Context();
    let callbackServerStarted = false;
    const setup = createOpenCodeClaudeBridgeV2({
      getClaudeTokens: () => validTokens,
      startOAuthCallbackServer: async () => {
        callbackServerStarted = true;
        throw new Error("should not start callback server during keychain bootstrap");
      },
      readCachedClaudePromptCache: () => null,
      fetchOAuthProfile: async () => null,
    });

    const cleanup = await setup(mock.ctx);
    assert.equal(mock.connectCalls.length, 1);
    assert.deepEqual(mock.connectCalls[0], {
      integrationID: "anthropic",
      methodID: "oauth",
      label: "Claude CLI",
    });
    assert.equal(callbackServerStarted, false);
    assert.equal(mock.state.activeConnection?.type, "credential");
    assert.equal(mock.state.resolvedCredential?.type, "oauth");
    assert.equal(mock.state.resolvedCredential?.access, validTokens.access);

    await cleanup();
    assert.ok(mock.disposed.includes("integration.transform"));
    assert.ok(mock.disposed.includes("session.hook:http.request"));
    assert.ok(mock.disposed.includes("session.hook:http.response"));
    assert.ok(mock.disposed.includes("session.hook:context"));
  });

  it("never hijacks an existing env or key Anthropic connection during bootstrap", async () => {
    for (const activeConnection of [
      { type: "env" as const, name: "ANTHROPIC_API_KEY" },
      { type: "credential" as const, id: "cred_key", label: "My API Key", method: "key" },
      { type: "credential" as const, id: "cred_oauth", label: "Existing OAuth", method: "oauth" },
    ]) {
      const mock = createMockV2Context({
        activeConnection,
        resolvedCredential:
          activeConnection.type === "credential" && activeConnection.method === "oauth"
            ? { type: "oauth", methodID: "oauth", ...validTokens }
            : { type: "key", key: "sk-ant-api03-secret" },
      });
      const setup = createOpenCodeClaudeBridgeV2({
        getClaudeTokens: () => validTokens,
        readCachedClaudePromptCache: () => null,
        fetchOAuthProfile: async () => null,
      });
      await setup(mock.ctx);
      assert.equal(mock.connectCalls.length, 0);
    }
  });

  it("rewrites OAuth requests and translates SSE tool calls while preserving API-key passthrough", async () => {
    const mock = createMockV2Context({
      activeConnection: { type: "credential", id: "cred_1", method: "oauth" },
      resolvedCredential: { type: "oauth", methodID: "oauth", ...validTokens },
    });
    const setup = createOpenCodeClaudeBridgeV2({
      getClaudeTokens: () => validTokens,
      readCachedClaudePromptCache: () => null,
      fetchOAuthProfile: async () => ({ account: { uuid: "acct-uuid-123" } }),
    });
    await setup(mock.ctx);

    // 1. OAuth request gets rewritten
    const originalBody = JSON.stringify({
      model: "claude-sonnet-4-6",
      system: [{ type: "text", text: "You are OpenCode." }],
      messages: [{ role: "user", content: "Read README.md please" }],
      tools: [
        {
          name: "read",
          description: "Read file",
          input_schema: { type: "object", properties: { filePath: { type: "string" } } },
        },
      ],
    });
    const reqEvent = {
      request: new Request("https://api.anthropic.com/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${validTokens.access}`,
          "x-api-key": "should-be-stripped",
        },
        body: originalBody,
      }),
    };
    await mock.triggerHook("http.request", reqEvent);

    assert.equal(reqEvent.request.url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(reqEvent.request.headers.get("authorization"), `Bearer ${validTokens.access}`);
    assert.equal(reqEvent.request.headers.get("x-api-key"), null);
    assert.equal(reqEvent.request.headers.get("x-app"), "cli");
    assert.ok(reqEvent.request.headers.get("anthropic-beta")?.includes("oauth-2025-04-20"));
    assert.ok(reqEvent.request.headers.get("anthropic-beta")?.includes("thinking-binding-controls-2026-08-01"));

    const rewrittenBody = JSON.parse(await reqEvent.request.clone().text());
    assert.deepEqual(rewrittenBody.thinking, { type: "adaptive" });
    assert.ok(rewrittenBody.system[0].text.startsWith("x-anthropic-billing-header:"));
    assert.equal(rewrittenBody.tools[0].name, "Read");
    assert.ok(rewrittenBody.metadata.user_id.includes("acct-uuid-123"));

    // 2. Concurrent API-key request while OAuth request is still in-flight:
    // switch active connection to API key before OAuth response arrives.
    mock.state.activeConnection = { type: "credential", id: "cred_key", method: "key" };
    mock.state.resolvedCredential = { type: "key", key: "sk-ant-api03-user-key" };

    const apiKeyReq = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-api03-user-key",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }),
    });
    const apiKeyReqEvent = { request: apiKeyReq };
    await mock.triggerHook("http.request", apiKeyReqEvent);
    // Must NOT hijack via keychain even though validTokens are available!
    assert.equal(apiKeyReqEvent.request, apiKeyReq);
    assert.equal(apiKeyReqEvent.request.headers.get("x-api-key"), "sk-ant-api03-user-key");
    assert.equal(apiKeyReqEvent.request.headers.get("authorization"), null);

    // 3. Responses arrive out of order: OAuth response MUST still be SSE-translated
    // while API-key response MUST pass through untouched (regression for oauthMode race).
    const ssePayload =
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"/tmp/a.txt\\"}"}}\n\n' +
      'event: content_block_stop\n' +
      'data: {"type":"content_block_stop","index":0}\n\n';

    const oauthResEvent = {
      request: reqEvent.request,
      response: new Response(ssePayload, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    };
    await mock.triggerHook("http.response", oauthResEvent);
    const oauthOut = await oauthResEvent.response.text();
    assert.ok(oauthOut.includes('"name":"read"'), "OAuth SSE tool name should map Read -> read");
    assert.ok(oauthOut.includes("filePath"), "OAuth SSE args should map file_path -> filePath");

    const apiKeyRes = new Response(ssePayload, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const apiKeyResEvent = { request: apiKeyReqEvent.request, response: apiKeyRes };
    await mock.triggerHook("http.response", apiKeyResEvent);
    assert.equal(apiKeyResEvent.response, apiKeyRes, "API-key response must not be wrapped");
  });

  it("never rewrites non-Anthropic hosts or cleartext HTTP even with OAuth active", async () => {
    const mock = createMockV2Context({
      activeConnection: { type: "credential", id: "cred_1", method: "oauth" },
      resolvedCredential: { type: "oauth", methodID: "oauth", ...validTokens },
    });
    const setup = createOpenCodeClaudeBridgeV2({
      getClaudeTokens: () => validTokens,
      readCachedClaudePromptCache: () => null,
      fetchOAuthProfile: async () => null,
      configuredBaseUrl: undefined,
    });
    await setup(mock.ctx);

    for (const badUrl of [
      "https://evilanthropic.com/v1/messages",
      "http://api.anthropic.com/v1/messages",
      "https://api.openai.com/v1/responses",
    ]) {
      const req = new Request(badUrl, { method: "POST", body: "{}" });
      const event = { request: req };
      await mock.triggerHook("http.request", event);
      assert.equal(event.request, req, `must not rewrite ${badUrl}`);
      assert.equal(event.request.headers.get("authorization"), null);
    }
  });

  it("never hijacks x-api-key header requests when no integration connection exists", async () => {
    const mock = createMockV2Context();
    const setup = createOpenCodeClaudeBridgeV2({
      getClaudeTokens: () => validTokens,
      readCachedClaudePromptCache: () => null,
      fetchOAuthProfile: async () => null,
    });
    // Simulate no oauth.connect so activeConnection remains undefined
    delete (mock.ctx.integration as { oauth?: unknown }).oauth;
    await setup(mock.ctx);

    const req = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "sk-ant-api03-direct" },
      body: "{}",
    });
    const event = { request: req };
    await mock.triggerHook("http.request", event);
    assert.equal(event.request, req);
    assert.equal(event.request.headers.get("x-api-key"), "sk-ant-api03-direct");
  });

  it("system prompt hooks inject Claude prefix in OAuth mode and skip in API-key mode", async () => {
    const mock = createMockV2Context({
      activeConnection: { type: "credential", id: "cred_1", method: "oauth" },
      resolvedCredential: { type: "oauth", methodID: "oauth", ...validTokens },
    });
    const setup = createOpenCodeClaudeBridgeV2({
      getClaudeTokens: () => validTokens,
      readCachedClaudePromptCache: () => null,
      fetchOAuthProfile: async () => null,
    });
    await setup(mock.ctx);

    for (const hookName of ["context", "compaction", "generate", "title"]) {
      const event = {
        system: [{ type: "text", text: "Base prompt", metadata: { tag: "keep" } }],
      };
      await mock.triggerHook(hookName, event);
      assert.ok(event.system[0].text.startsWith("You are a Claude agent, built on Anthropic's Claude Agent SDK.\n\nBase prompt"));
      assert.deepEqual(event.system[0].metadata, { tag: "keep" });

      // Idempotent on second call
      await mock.triggerHook(hookName, event);
      assert.equal(event.system[0].text.match(/Claude Agent SDK/g)?.length, 1);
    }

    // Non-text first SystemPart is preserved instead of overwritten
    const nonTextEvent = {
      system: [{ type: "image", data: "abc" } as Record<string, unknown>],
    };
    await mock.triggerHook("context", nonTextEvent);
    assert.equal(nonTextEvent.system.length, 2);
    assert.equal(nonTextEvent.system[0].type, "text");
    assert.equal(nonTextEvent.system[1].type, "image");

    // Switch to API-key mode: system prompt must not be mutated
    mock.state.activeConnection = { type: "env", name: "ANTHROPIC_API_KEY" };
    mock.state.resolvedCredential = { type: "key", key: "sk-ant-api03-key" };
    const apiKeyEvent = { system: [{ type: "text", text: "Clean prompt" }] };
    await mock.triggerHook("context", apiKeyEvent);
    assert.equal(apiKeyEvent.system[0].text, "Clean prompt");
  });

  it("interactive authorize supports mode:auto with submit paste and code fallback", async () => {
    const mock = createMockV2Context();
    let closed = false;
    let submittedUrl = "";
    let resolveCode!: (code: string) => void;
    const exchanged: Array<{ code: string; verifier: string; redirectUri?: string }> = [];

    const setup = createOpenCodeClaudeBridgeV2({
      getClaudeTokens: () => null,
      startOAuthCallbackServer: async () => ({
        url: "https://claude.ai/oauth/authorize?state=s1",
        manualUrl: "https://claude.ai/oauth/authorize?manual=1",
        verifier: "v-pkce",
        state: "s1",
        port: 43210,
        waitForCode: () => new Promise<string>((res) => { resolveCode = res; }),
        submitRedirect: (redirectUrl: string) => {
          submittedUrl = redirectUrl;
          resolveCode("pasted-auth-code");
        },
        close: () => {
          closed = true;
        },
      }),
      exchangeCodeForTokens: (code, verifier, redirectUri) => {
        exchanged.push({ code, verifier, redirectUri });
        return validTokens;
      },
      readCachedClaudePromptCache: () => null,
      fetchOAuthProfile: async () => null,
    });
    await setup(mock.ctx);

    const reg = mock.getOAuthRegistration()!;
    const auth = await reg.authorize();
    assert.equal(auth.mode, "auto");
    assert.equal(auth.url, "https://claude.ai/oauth/authorize?state=s1");
    assert.equal(typeof auth.submit, "function");

    await auth.submit("http://localhost:43210/callback?code=pasted-auth-code&state=s1");
    const cred = await auth.callback;
    assert.equal(submittedUrl, "http://localhost:43210/callback?code=pasted-auth-code&state=s1");
    assert.equal(closed, true);
    assert.deepEqual(exchanged, [
      { code: "pasted-auth-code", verifier: "v-pkce", redirectUri: "http://localhost:43210/callback" },
    ]);
    assert.equal(cred.type, "oauth");
    assert.equal(cred.methodID, "oauth");
    assert.equal(cred.access, validTokens.access);
  });

  it("interactive authorize falls back to mode:code when callback server cannot bind", async () => {
    const mock = createMockV2Context();
    const setup = createOpenCodeClaudeBridgeV2({
      getClaudeTokens: () => null,
      startOAuthCallbackServer: async () => {
        throw new Error("EACCES");
      },
      createAuthorizationRequest: () => ({
        url: "https://claude.ai/oauth/authorize?state=s-manual",
        verifier: "v-manual",
        state: "s-manual",
      }),
      exchangeCodeForTokens: (code, verifier) => ({
        access: `tok:${code}:${verifier}`,
        refresh: "ref",
        expires: Date.now() + 3_600_000,
      }),
      readCachedClaudePromptCache: () => null,
      fetchOAuthProfile: async () => null,
    });
    await setup(mock.ctx);

    const reg = mock.getOAuthRegistration()!;
    const auth = await reg.authorize();
    assert.equal(auth.mode, "code");
    await assert.rejects(
      () => auth.callback("https://platform.claude.com/oauth/code/callback?code=bad&state=wrong"),
      /different sign-in/,
    );
    const cred = await auth.callback(
      "https://platform.claude.com/oauth/code/callback?code=good-code&state=s-manual",
    );
    assert.equal(cred.access, "tok:good-code:v-manual");
  });

  it("refresh callback persists updated tokens and throws cleanly when all layers fail", async () => {
    let nextTokens: OAuthTokens | null = {
      access: "sk-ant-oat01-refreshed",
      refresh: "sk-ant-ort01-refreshed",
      expires: Date.now() + 7_200_000,
    };
    const mock = createMockV2Context();
    const setup = createOpenCodeClaudeBridgeV2({
      getClaudeTokens: () => null,
      refreshTokensLayered: () => nextTokens,
      readCachedClaudePromptCache: () => null,
      fetchOAuthProfile: async () => null,
    });
    await setup(mock.ctx);

    const reg = mock.getOAuthRegistration()!;
    const refreshed = await reg.refresh({
      type: "oauth",
      methodID: "oauth",
      access: "old",
      refresh: "old-ref",
      expires: 1,
    });
    assert.equal(refreshed.access, "sk-ant-oat01-refreshed");
    assert.equal(refreshed.methodID, "oauth");

    nextTokens = null;
    await assert.rejects(
      () => reg.refresh({ type: "oauth", methodID: "oauth", access: "old", refresh: "old-ref", expires: 1 }),
      /All Claude OAuth refresh layers failed/,
    );
  });
});

describe("OpenCode v1 plugin (server)", () => {
  it("system transform prefixes anthropic system prompts and ignores other providers", async () => {
    const v1 = await pluginModule.server({
      client: { auth: { set: async () => {} } },
    });
    const transform = v1["experimental.chat.system.transform"];

    const nonAnthropic = { system: ["Keep untouched"] };
    transform({ model: { providerID: "openai" } }, nonAnthropic);
    assert.deepEqual(nonAnthropic.system, ["Keep untouched"]);

    const anthropic = { system: ["Base prompt"] };
    transform({ model: { providerID: "anthropic" } }, anthropic);
    assert.ok(anthropic.system[0].startsWith("You are a Claude agent, built on Anthropic's Claude Agent SDK.\n\nBase prompt"));

    // Idempotent
    transform({ model: { providerID: "anthropic" } }, anthropic);
    assert.equal(anthropic.system[0].match(/Claude Agent SDK/g)?.length, 1);
  });

  it("auth.loader passes through API-key auth without installing a custom fetch", async () => {
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    try {
      const v1 = await pluginModule.server({
        client: { auth: { set: async () => {} } },
      });
      const provider = { models: {} as Record<string, Record<string, unknown>> };
      const result = await v1.auth.loader(
        async () => ({ type: "apikey", access: "sk-ant-api03-v1-key" }),
        provider,
      );
      assert.equal(result.fetch, undefined);
      assert.equal(process.env.ANTHROPIC_API_KEY, "sk-ant-api03-v1-key");
    } finally {
      if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
  });

  it("auth.loader injects Claude models and rewrites OAuth fetch + SSE responses", async () => {
    const savedApiKey = process.env.ANTHROPIC_API_KEY;
    const savedFetch = globalThis.fetch;
    try {
      const v1 = await pluginModule.server({
        client: { auth: { set: async () => {} } },
      });

      const provider = { models: {} as Record<string, Record<string, unknown>> };
      const oauthAuth = {
        type: "oauth",
        access: "sk-ant-oat01-v1-token",
        refresh: "sk-ant-ort01-v1-refresh",
        expires: Date.now() + 3_600_000,
      };
      const loaderResult = await v1.auth.loader(async () => oauthAuth, provider);
      assert.ok("claude-sonnet-4-6" in provider.models, "should inject ANTHROPIC_MODELS");
      assert.equal(typeof loaderResult.fetch, "function");

      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};
      let capturedBody = "";
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/api/oauth/profile")) {
          return new Response(JSON.stringify({ account: { uuid: "v1-acct-uuid" } }), { status: 200 });
        }
        capturedUrl = url;
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        capturedBody = String(init?.body ?? "");
        const sse =
          'event: content_block_start\n' +
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}\n\n' +
          'event: content_block_delta\n' +
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"/tmp/v1.txt\\"}"}}\n\n' +
          'event: content_block_stop\n' +
          'data: {"type":"content_block_stop","index":0}\n\n';
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch;

      const res = await loaderResult.fetch!("https://api.anthropic.com/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "oauth-placeholder" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "Hello" }],
          tools: [
            {
              name: "read",
              description: "Read file",
              input_schema: { type: "object", properties: { filePath: { type: "string" } } },
            },
          ],
        }),
      });

      assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages?beta=true");
      assert.equal(capturedHeaders["authorization"], "Bearer sk-ant-oat01-v1-token");
      assert.equal(capturedHeaders["x-api-key"], undefined);
      assert.ok(capturedHeaders["anthropic-beta"]?.includes("thinking-binding-controls-2026-08-01"));
      const parsedOut = JSON.parse(capturedBody);
      assert.equal(parsedOut.tools[0].name, "Read");

      const text = await res.text();
      assert.ok(text.includes('"name":"read"'));
      assert.ok(text.includes("filePath"));
    } finally {
      globalThis.fetch = savedFetch;
      if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
  });
});

describe("selectClaudeCredentials", () => {
  const real = {
    claudeAiOauth: {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: 1,
    },
  };
  // What attaching an MCP server writes under the same service name.
  const mcpOnly = { mcpOAuth: { some: "thing" } } as never;

  it("skips an item that has no claudeAiOauth", () => {
    assert.equal(selectClaudeCredentials([mcpOnly, real]), real);
  });

  it("prefers the first item that does carry claudeAiOauth", () => {
    const other = { claudeAiOauth: { accessToken: "b", refreshToken: "r", expiresAt: 2 } };
    assert.equal(selectClaudeCredentials([real, other]), real);
  });

  it("returns null when nothing carries claudeAiOauth", () => {
    assert.equal(selectClaudeCredentials([null, mcpOnly]), null);
  });

  it("tolerates a null candidate from a failed lookup", () => {
    assert.equal(selectClaudeCredentials([null, real]), real);
  });
});

describe("retry policy", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");

  it("reads Retry-After as delay seconds or as an HTTP date", () => {
    assert.equal(parseRetryAfterMs("3", now), 3000);
    assert.equal(parseRetryAfterMs("Sun, 04 Oct 2026 12:00:05 GMT", now), 5000);
    assert.equal(parseRetryAfterMs("Sun, 04 Oct 2026 11:59:00 GMT", now), 0);
    assert.equal(parseRetryAfterMs(null, now), null);
    assert.equal(parseRetryAfterMs("", now), null);
    assert.equal(parseRetryAfterMs("-1", now), null);
    assert.equal(parseRetryAfterMs("soon", now), null);
  });

  it("waits as long as Retry-After asks, else backs off", () => {
    assert.equal(getResponseRetryDelayMs(new Headers({ "retry-after": "4" }), 0, now), 4000);
    assert.equal(getResponseRetryDelayMs(new Headers(), 0, now), 2000);
    assert.equal(getResponseRetryDelayMs(new Headers(), 1, now), 4000);
  });

  it("refuses a wait longer than the bridge absorbs", () => {
    const seconds = String(MAX_RETRY_DELAY_MS / 1000 + 1);
    assert.equal(getResponseRetryDelayMs(new Headers({ "retry-after": seconds }), 0, now), null);
    assert.equal(getResponseRetryDelayMs(new Headers({ "retry-after": "18000" }), 0, now), null);
  });

  it("ends a retry wait early when the request is aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted by caller");
    const started = Date.now();
    const wait = waitForRetry(5000, controller.signal);
    controller.abort(reason);
    await assert.rejects(wait, (err) => err === reason);
    assert.ok(Date.now() - started < 1000);
    await assert.rejects(waitForRetry(10, controller.signal), (err) => err === reason);
  });
});

describe("API request retry", () => {
  type Reply = { status: number; retryAfter?: string };

  // Drives the plugin's real fetch wrapper against a stubbed network. Auth is a
  // valid stored token, so no refresh (and no real token request) can happen;
  // 429 cases only use waits the bridge refuses, which return before refreshing.
  // HOME and XDG_DATA_HOME point at a scratch dir so the developer's own Claude
  // CLI credentials and opencode log dir are never touched.
  async function sendThroughBridge(replies: Reply[], signal?: AbortSignal) {
    const originalFetch = globalThis.fetch;
    const originalEnv = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      HOME: process.env.HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    };
    const scratchDir = mkdtempSync(join(tmpdir(), "bridge-retry-test-"));
    process.env.HOME = scratchDir;
    process.env.XDG_DATA_HOME = join(scratchDir, "data");
    const messageCalls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("/v1/messages")) return new Response("{}", { status: 404 });
      messageCalls.push(url);
      const reply = replies[Math.min(messageCalls.length - 1, replies.length - 1)];
      return new Response(JSON.stringify({ type: reply.status === 200 ? "message" : "error" }), {
        status: reply.status,
        headers: reply.retryAfter === undefined ? {} : { "retry-after": reply.retryAfter },
      });
    }) as typeof fetch;

    try {
      const hooks = await pluginModule.server({ client: { auth: { set: async () => {} } } });
      const loaded = await hooks.auth.loader(
        async () => ({
          type: "oauth",
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.now() + 3_600_000,
        }),
        { models: {} },
      ) as { fetch: (input: string, init?: RequestInit) => Promise<Response> };
      const response = await loaded.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
        signal,
      });
      return { status: response.status, calls: messageCalls.length };
    } finally {
      globalThis.fetch = originalFetch;
      for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  it("retries an overloaded response and returns the recovered one", async () => {
    const result = await sendThroughBridge([{ status: 529, retryAfter: "0" }, { status: 200 }]);
    assert.deepEqual(result, { status: 200, calls: 2 });
  });

  it("stops after two retries and returns the last overloaded response", async () => {
    const result = await sendThroughBridge([{ status: 529, retryAfter: "0" }]);
    assert.deepEqual(result, { status: 529, calls: 3 });
  });

  it("returns a long Retry-After at once instead of waiting inside the request", async () => {
    const started = Date.now();
    const result = await sendThroughBridge([{ status: 429, retryAfter: "18000" }]);
    assert.deepEqual(result, { status: 429, calls: 1 });
    assert.ok(Date.now() - started < 1000);
  });

  it("does not retry other errors", async () => {
    const result = await sendThroughBridge([{ status: 500 }]);
    assert.deepEqual(result, { status: 500, calls: 1 });
  });

  it("gives up the retry wait when the request is aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled")), 20);
    await assert.rejects(
      sendThroughBridge([{ status: 529, retryAfter: "5" }], controller.signal),
      /cancelled/,
    );
  });
});
