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
