/**
 * Pure request/response transforms shared by the plugin.
 *
 * These live outside `index.ts` on purpose. `index.ts` is the file named in
 * opencode's `plugin` array, and opencode's plugin loader treats EVERY named
 * export of that file as a plugin factory: it enumerates `Object.values(mod)`,
 * requires each to be a function, calls each one, and uses the return value as
 * a hook object. So a named export there is loader surface, not API.
 *
 * Keeping them here means they stay importable and unit-testable while
 * `index.ts` exports only its default plugin.
 */
import { getClaudeTools, shouldUseClaudeToolSchemas } from "./claude-tools.js";

export const OUTBOUND_TOOL_NAME_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  edit: "Edit",
  write: "Write",
  task: "Agent",
  webfetch: "WebFetch",
  todowrite: "TodoWrite",
  skill: "Skill",
  mcp_bash: "Bash",
  mcp_read: "Read",
  mcp_glob: "Glob",
  mcp_grep: "Grep",
  mcp_edit: "Edit",
  mcp_write: "Write",
  mcp_task: "Agent",
  mcp_webfetch: "WebFetch",
  mcp_todowrite: "TodoWrite",
  mcp_skill: "Skill",
  question: "AskUserQuestion",
  mcp_question: "AskUserQuestion",
  plan_enter: "EnterPlanMode",
  plan_exit: "ExitPlanMode",
};

/**
 * Derive a human-readable display name from a Claude model ID.
 *
 * Matches `claude-{family}-{major}-{minor}[-{date}]` (the convention used
 * for every Claude model family to date) and renders e.g.
 *   claude-opus-4-7            -> "Opus 4.7"
 *   claude-haiku-4-5-20251001  -> "Haiku 4.5"
 *   claude-sonnet-4-6          -> "Sonnet 4.6"
 *
 * Falls back to the raw model ID if the convention doesn't match, so future
 * naming changes are surfaced truthfully instead of silently wrong.
 */
export function deriveModelDisplayName(modelId: string): string {
  const m = modelId.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d+)?$/i);
  if (!m) return modelId;
  const [, family, major, minor] = m;
  const capitalized = family.charAt(0).toUpperCase() + family.slice(1).toLowerCase();
  return `${capitalized} ${major}.${minor}`;
}

/**
 * Rewrite model-identity lines inside the cached Claude Code system prompt
 * so they reflect the model actually being requested. Without this, every
 * request (regardless of selected model) gets a system prompt claiming
 * "You are powered by the model named Sonnet 4.6", which can bias behavior.
 */
export function rewriteSystemBlocksForModel(
  blocks: Array<{ type?: string; text?: string }>,
  modelId: string | undefined,
): Array<{ type?: string; text?: string }> {
  if (!modelId) return blocks;
  const display = deriveModelDisplayName(modelId);

  return blocks.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    let text = block.text;

    text = text.replace(
      /You are powered by the model named [^\n]+? The exact model ID is [a-z0-9.-]+\./g,
      `You are powered by the model named ${display}. The exact model ID is ${modelId}.`,
    );

    return { ...block, text };
  });
}

export function stripSystemCacheControl(
  system: Array<{ type?: string; text?: string; cache_control?: unknown }>,
): Array<{ type?: string; text?: string }> {
  return system.map((block) => {
    if (!("cache_control" in block)) return block;
    const { cache_control, ...rest } = block;
    return rest;
  });
}

export function shouldInjectClaudeTools(input: {
  model?: string;
  requestUrl?: string;
  tools?: unknown;
}): boolean {
  if (!shouldUseClaudeToolSchemas({ model: input.model, requestUrl: input.requestUrl })) {
    return false;
  }
  return Array.isArray(input.tools) && input.tools.length > 0;
}

export function getClaudeToolsForActiveOpenCodeTools(
  tools: unknown,
): ReturnType<typeof getClaudeTools> {
  if (!Array.isArray(tools)) return [];
  const activeClaudeNames = new Set(
    tools
      .map((tool) => {
        if (!tool || typeof tool !== "object") return undefined;
        const name = (tool as { name?: unknown }).name;
        if (typeof name !== "string") return undefined;
        return OUTBOUND_TOOL_NAME_MAP[name] || name;
      })
      .filter((name): name is string => typeof name === "string"),
  );
  return getClaudeTools().filter((tool) => activeClaudeNames.has(tool.name));
}

export function stripAssistantPrefillForClaude(
  messages: Array<{ role?: string; content?: unknown }>,
): Array<{ role?: string; content?: unknown }> {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return messages;
  if (typeof last.content !== "string") return messages;
  if (last.content.trim() !== "Continue with your tasks.") return messages;
  return messages.slice(0, -1);
}
