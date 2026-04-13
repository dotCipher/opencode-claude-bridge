/**
 * Unit tests for opencode-claude-bridge plugin logic.
 * Run with: node --import tsx/esm src/index.test.ts
 * Or after build: node dist/index.test.js
 *
 * Uses node:test — no extra dependencies required.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { buildTokenCurlArgs } from "./oauth.js";

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

function normalizeOutboundToolUse(name: string, input: Record<string, unknown>) {
  const normalized = structuredClone(input);

  if (name === "Agent") {
    if (typeof normalized.subagent_type === "string") {
      const agentMap: Record<string, string> = {
        build: "general-purpose",
        general: "general-purpose",
        explore: "Explore",
        plan: "Plan",
      };
      normalized.subagent_type = agentMap[normalized.subagent_type as string] || normalized.subagent_type;
    }
    delete normalized.task_id;
    delete normalized.command;
  }

  if (name === "AskUserQuestion" && Array.isArray(normalized.questions)) {
    for (const item of normalized.questions as Array<Record<string, unknown>>) {
      if (typeof item.multiple === "boolean" && item.multiSelect === undefined) {
        item.multiSelect = item.multiple;
        delete item.multiple;
      }
    }
  }

  if (name === "Skill" && typeof normalized.name === "string" && normalized.skill === undefined) {
    normalized.skill = normalized.name;
    delete normalized.name;
  }

  if (name === "WebFetch") {
    if (typeof normalized.format === "string" && normalized.prompt === undefined) {
      const format = normalized.format;
      normalized.prompt = format === "text"
        ? "Fetch this URL and return the content as plain text."
        : format === "html"
        ? "Fetch this URL and return the raw HTML."
        : "Fetch this URL and return the content as markdown.";
      delete normalized.format;
    }
    delete normalized.timeout;
  }

  return normalized;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripScalarJsonField(text: string, field: string): string {
  const escapedField = escapeRegExp(field);
  const valuePattern = String.raw`(?:"(?:[^"\\]|\\.)*"|true|false|null|-?\d+(?:\.\d+)?)`;
  return text
    .replace(new RegExp(`"${escapedField}"\\s*:\\s*${valuePattern}\\s*,`, "g"), "")
    .replace(new RegExp(`,\\s*"${escapedField}"\\s*:\\s*${valuePattern}`, "g"), "");
}

function normalizeInboundStreamChunk(text: string, currentToolName: string): string {
  let normalized = text;

  if (currentToolName === "Agent" && normalized.includes('"content_block_start"')) {
    if (!normalized.includes('"subagent_type"')) {
      if (/"input"\s*:\s*\{\s*\}/.test(normalized)) {
        normalized = normalized.replace(
          /"input"\s*:\s*\{\s*\}/,
          '"input":{"subagent_type":"general"}',
        );
      } else {
        normalized = normalized.replace(
          /"input"\s*:\s*\{/,
          '"input":{"subagent_type":"general",',
        );
      }
    }
  }

  if (currentToolName === "WebFetch" && normalized.includes('"content_block_start"') && !normalized.includes('"format"')) {
    if (/"input"\s*:\s*\{\s*\}/.test(normalized)) {
      normalized = normalized.replace(
        /"input"\s*:\s*\{\s*\}/,
        '"input":{"format":"markdown"}',
      );
    } else {
      normalized = normalized.replace(
        /"input"\s*:\s*\{/,
        '"input":{"format":"markdown",',
      );
    }
  }

  if (currentToolName === "AskUserQuestion") {
    normalized = normalized.replace(/"multiSelect"\s*:/g, '"multiple":');
  }

  if (currentToolName === "Agent") {
    normalized = normalized.replace(
      /"subagent_type"\s*:\s*"(general-purpose|statusline-setup|Explore|Plan)"/g,
      (_m, val: string) => {
        const map: Record<string, string> = {
          "general-purpose": "general",
          "statusline-setup": "build",
          "Explore": "explore",
          "Plan": "plan",
        };
        return `"subagent_type": "${map[val] || val}"`;
      },
    );
    normalized = normalized
      .replace(/"model"\s*:\s*"(?:[^"\\]|\\.)*"\s*,/g, "")
      .replace(/,\s*"model"\s*:\s*"(?:[^"\\]|\\.)*"/g, "")
      .replace(/"run_in_background"\s*:\s*(?:true|false)\s*,/g, "")
      .replace(/,\s*"run_in_background"\s*:\s*(?:true|false)/g, "")
      .replace(/"isolation"\s*:\s*"(?:[^"\\]|\\.)*"\s*,/g, "")
      .replace(/,\s*"isolation"\s*:\s*"(?:[^"\\]|\\.)*"/g, "");
  }

  if (currentToolName === "Bash") {
    normalized = normalized
      .replace(/"run_in_background"\s*:\s*(?:true|false)\s*,/g, "")
      .replace(/,\s*"run_in_background"\s*:\s*(?:true|false)/g, "")
      .replace(/"dangerouslyDisableSandbox"\s*:\s*(?:true|false)\s*,/g, "")
      .replace(/,\s*"dangerouslyDisableSandbox"\s*:\s*(?:true|false)/g, "");
  }

  if (currentToolName === "Read") {
    normalized = normalized
      .replace(/"pages"\s*:\s*"(?:[^"\\]|\\.)*"\s*,/g, "")
      .replace(/,\s*"pages"\s*:\s*"(?:[^"\\]|\\.)*"/g, "");
  }

  if (currentToolName === "Grep") {
    for (const field of ["output_mode", "-B", "-A", "-C", "context", "-n", "-i", "type", "head_limit", "offset", "multiline"]) {
      normalized = stripScalarJsonField(normalized, field);
    }
  }

  if (currentToolName === "Skill") {
    normalized = normalized
      .replace(/"skill"\s*:/g, '"name":')
      .replace(/"args"\s*:\s*"(?:[^"\\]|\\.)*"\s*,/g, "")
      .replace(/,\s*"args"\s*:\s*"(?:[^"\\]|\\.)*"/g, "");
  }

  if (currentToolName === "WebFetch") {
    normalized = normalized
      .replace(/"prompt"\s*:\s*"(?:[^"\\]|\\.)*"\s*,/g, "")
      .replace(/,\s*"prompt"\s*:\s*"(?:[^"\\]|\\.)*"/g, "");
  }

  return normalized;
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

describe("windows compatibility regressions", () => {
  it("builds curl args without shell escaping requirements", () => {
    const payload = JSON.stringify({ note: "O'Reilly" });
    const args = buildTokenCurlArgs(payload);

    assert.equal(args[0], "-s");
    assert.equal(args[1], "-w");
    assert.equal(args[2], "\n__HTTP_STATUS__%{http_code}");
    assert.equal(args[args.length - 2], "-d");
    assert.equal(args[args.length - 1], payload);
  });
});

describe("tool mapping regressions", () => {
  it("maps OpenCode general agent type to Claude general-purpose", () => {
    const out = normalizeOutboundToolUse("Agent", { subagent_type: "general" });
    assert.equal(out.subagent_type, "general-purpose");
  });

  it("maps AskUserQuestion multiple to multiSelect", () => {
    const out = normalizeOutboundToolUse("AskUserQuestion", {
      questions: [{ question: "Q?", header: "Q", options: [], multiple: true }],
    });
    assert.deepEqual(out, {
      questions: [{ question: "Q?", header: "Q", options: [], multiSelect: true }],
    });
  });

  it("strips OpenCode-only agent history fields before sending to Claude", () => {
    const out = normalizeOutboundToolUse("Agent", {
      subagent_type: "general",
      task_id: "abc",
      command: "do thing",
    });
    assert.deepEqual(out, { subagent_type: "general-purpose" });
  });

  it("maps OpenCode skill name to Claude skill", () => {
    const out = normalizeOutboundToolUse("Skill", { name: "commit" });
    assert.deepEqual(out, { skill: "commit" });
  });

  it("maps OpenCode webfetch format to a best-effort Claude prompt", () => {
    const out = normalizeOutboundToolUse("WebFetch", {
      url: "https://example.com",
      format: "markdown",
      timeout: 5,
    });
    assert.deepEqual(out, {
      url: "https://example.com",
      prompt: "Fetch this URL and return the content as markdown.",
    });
  });

  it("seeds missing inbound agent subagent_type with general", () => {
    const out = normalizeInboundStreamChunk(
      '{"type":"content_block_start","content_block":{"type":"tool_use","id":"x","name":"task","input":{}}}',
      "Agent",
    );
    assert.match(out, /"subagent_type":"general"/);
  });

  it("seeds missing inbound agent subagent_type even when input has other fields", () => {
    const out = normalizeInboundStreamChunk(
      '{"type":"content_block_start","content_block":{"type":"tool_use","id":"x","name":"task","input":{"description":"d"}}}',
      "Agent",
    );
    assert.match(out, /"input":\{"subagent_type":"general","description":"d"\}/);
  });

  it("maps inbound general-purpose agent type to general", () => {
    const out = normalizeInboundStreamChunk(
      '{"subagent_type":"general-purpose"}',
      "Agent",
    );
    assert.equal(out, '{"subagent_type": "general"}');
  });

  it("maps inbound AskUserQuestion multiSelect to multiple", () => {
    const out = normalizeInboundStreamChunk(
      '{"multiSelect":true}',
      "AskUserQuestion",
    );
    assert.equal(out, '{"multiple":true}');
  });

  it("maps inbound Claude skill to OpenCode name and drops args", () => {
    const out = normalizeInboundStreamChunk(
      '{"skill":"commit","args":"-m hi"}',
      "Skill",
    );
    assert.equal(out, '{"name":"commit"}');
  });

  it("maps inbound Claude webfetch to OpenCode format and drops prompt", () => {
    const out = normalizeInboundStreamChunk(
      '{"type":"content_block_start","content_block":{"type":"tool_use","id":"x","name":"webfetch","input":{"url":"https://example.com","prompt":"Summarize"}}}',
      "WebFetch",
    );
    assert.match(out, /"format":"markdown"/);
    assert.doesNotMatch(out, /"prompt"/);
  });

  it("drops inbound Claude-only grep options unsupported by OpenCode", () => {
    const out = normalizeInboundStreamChunk(
      '{"glob":"*.ts","output_mode":"content","head_limit":10}',
      "Grep",
    );
    assert.equal(out, '{"glob":"*.ts"}');
  });
});
