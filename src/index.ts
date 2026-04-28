import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import {
  createAuthorizationRequest,
  exchangeCodeForTokens,
  parseAuthCode,
  refreshTokens,
  startOAuthCallbackServer,
} from "./oauth.js";
import { getClaudeTokens, readClaudeCredentials } from "./keychain.js";
import {
  BETA_FLAGS,
  CLI_VERSION,
  OAUTH_BETA_FLAG,
  ANTHROPIC_VERSION,
  BILLING_CCH,
  STAINLESS_HEADERS,
  USER_AGENT,
  PROFILE_URL,
  CLI_BUILD_ID,
  ENTRYPOINT,
  DEFAULT_EFFORT,
  CLEAR_THINKING_TYPE,
  SESSION_ID,
} from "./constants.js";
import {
  getClaudeTools,
  translateArgsOpencodeToClaude,
  translateToolArgsJsonString,
  computeFingerprint,
  extractFirstUserMessageText,
  shouldUseClaudeToolSchemas,
} from "./claude-tools.js";
import { createSseProcessor } from "./stream.js";

// ── Types ──────────────────────────────────────────────────────────

type AuthType = {
  type: string;
  access?: string;
  refresh?: string;
  expires?: number;
};

type ProviderModel = {
  cost?: unknown;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  limit?: { context: number; output: number };
  modalities?: { input: string[]; output: string[] };
};

type OAuthProfile = {
  account?: { uuid?: string };
};

type ClaudeSystemPromptCache = {
  system?: Array<{ type?: string; text?: string; cache_control?: unknown }>;
  billing?: {
    ccVersion?: string;
    ccVersionSuffix?: string;
    ccEntrypoint?: string;
  };
};

const OUTBOUND_TOOL_NAME_MAP: Record<string, string> = {
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

const ANTHROPIC_MODELS: Record<string, ProviderModel> = {
  "claude-opus-4-6": {
    name: "Claude Opus 4.6",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 200000, output: 32000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  },
  "claude-opus-4-5": {
    name: "Claude Opus 4.5",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 200000, output: 32000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 200000, output: 64000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  "claude-sonnet-4-5": {
    name: "Claude Sonnet 4.5",
    attachment: true, reasoning: true, tool_call: true, temperature: false,
    limit: { context: 200000, output: 8192 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  },
  "claude-haiku-4-5-20251001": {
    name: "Claude Haiku 4.5",
    attachment: true, reasoning: false, tool_call: true, temperature: true,
    limit: { context: 200000, output: 8192 },
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 },
  },
};

type PluginClient = {
  auth: {
    set: (args: {
      path: { id: string };
      body: Record<string, unknown>;
    }) => Promise<void>;
  };
};

// ── Helpers ────────────────────────────────────────────────────────

const CLAUDE_PREFIX =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

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

const oauthProfileCache = new Map<string, Promise<OAuthProfile | null>>();
const SYSTEM_PROMPT_CACHE_PATH = process.env.ANTHROPIC_SYSTEM_PROMPT_PATH
  || join(process.env.HOME || "", ".cache", "opencode-claude-bridge", "claude-system-prompt.json");

function buildAuthFailureResponse(detail: string): Response {
  const message = [
    "Claude OAuth credentials are no longer valid.",
    detail,
    "Reconnect 'Claude Pro / Max (OAuth)' in OpenCode or run `claude login` again.",
  ].filter(Boolean).join(" ");

  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: "authentication_error",
      message,
    },
  }), {
    status: 401,
    headers: {
      "content-type": "application/json",
    },
  });
}

/** Persist fresh tokens to OpenCode's auth store. */
async function storeAuth(
  client: PluginClient,
  tokens: { access: string; refresh: string; expires: number },
) {
  await client.auth.set({
    path: { id: "anthropic" },
    body: {
      type: "oauth",
      refresh: tokens.refresh,
      access: tokens.access,
      expires: tokens.expires,
    },
  });
}

/** Layered token refresh: keychain → stored refresh → CLI refresh token. */
async function refreshAuth(
  auth: AuthType,
  client: PluginClient,
): Promise<string | null> {
  type Tokens = { access: string; refresh: string; expires: number };
  let fresh: Tokens | null = null;
  const errors: string[] = [];

  // Layer 1: Claude CLI keychain
  try {
    const kt = getClaudeTokens();
    if (kt && kt.expires > Date.now() + 60_000) fresh = kt;
  } catch (err) {
    errors.push(String(err));
  }

  // Layer 2: Stored refresh token
  if (!fresh && auth.refresh) {
    try { fresh = refreshTokens(auth.refresh); }
    catch (err) { errors.push(String(err)); }
  }

  // Layer 3: CLI refresh token
  if (!fresh) {
    try {
      const creds = readClaudeCredentials();
      if (creds?.claudeAiOauth?.refreshToken)
        fresh = refreshTokens(creds.claudeAiOauth.refreshToken);
    } catch (err) {
      errors.push(String(err));
    }
  }

  if (fresh) {
    await storeAuth(client, fresh);
    auth.access = fresh.access;
    auth.refresh = fresh.refresh;
    auth.expires = fresh.expires;
    return fresh.access;
  }

  if (errors.length > 0) {
    throw new Error(errors[errors.length - 1]);
  }

  return null;
}

/** Best-effort browser open — tries multiple methods on each platform. */
function openBrowser(url: string): void {
  (async () => {
    const { execFileSync } = await import("node:child_process");

    if (process.platform === "darwin") {
      const uid = String(process.getuid?.() ?? "");
      const attempts: Array<[string, () => void]> = [
        ["launchctl asuser", () => execFileSync("/bin/launchctl", ["asuser", uid, "/usr/bin/open", url], { timeout: 5000 })],
        ["open", () => execFileSync("/usr/bin/open", [url], { timeout: 3000 })],
        ["osascript", () => execFileSync("/usr/bin/osascript", ["-e", `open location "${url}"`], { timeout: 3000 })],
      ];
      for (const [name, attempt] of attempts) {
        try { attempt(); break; }
        catch {}
      }
    } else if (process.platform === "win32") {
      try { execFileSync("cmd", ["/c", "start", "", url], { timeout: 3000 }); }
      catch {}
    } else {
      const attempts: Array<[string, () => void]> = [
        ["xdg-open", () => execFileSync("/usr/bin/xdg-open", [url], { timeout: 3000 })],
        ["open", () => execFileSync("/usr/bin/open", [url], { timeout: 3000 })],
      ];
      for (const [name, attempt] of attempts) {
        try { attempt(); break; }
        catch {}
      }
    }
  })().catch(() => {});
}

/** Merge HeadersInit (Headers | string[][] | Record) onto a Headers object. */
function mergeHeaders(target: Headers, source: HeadersInit) {
  if (source instanceof Headers) {
    source.forEach((v, k) => target.set(k, v));
  } else if (Array.isArray(source)) {
    for (const [k, v] of source) {
      if (v !== undefined) target.set(k, String(v));
    }
  } else {
    for (const [k, v] of Object.entries(source)) {
      if (v !== undefined) target.set(k, String(v));
    }
  }
}

/** Build deduplicated beta flags string. */
function buildBetaFlags(existing: string): string {
  const required = BETA_FLAGS.split(",").map((b) => b.trim()).filter(Boolean);
  const withoutSpecials = required.filter(
    (beta) => beta !== "claude-code-20250219" && beta !== OAUTH_BETA_FLAG,
  );
  return ["claude-code-20250219", OAUTH_BETA_FLAG, ...withoutSpecials].join(",");
}

/** Deduplicate repeated Claude Code prefix in a text block. */
function deduplicatePrefix(text: string): string {
  const doubled = `${CLAUDE_PREFIX}\n\n${CLAUDE_PREFIX}`;
  while (text.includes(doubled)) {
    text = text.replace(doubled, CLAUDE_PREFIX);
  }
  return text;
}

function mapOutboundToolName(name: string | undefined): string | undefined {
  if (!name) return name;
  return OUTBOUND_TOOL_NAME_MAP[name] || name;
}

function maybeUnquoteText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("\"")) return text;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed;
  } catch {
    // Expected for non-JSON text — don't log.
  }
  return text;
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

function normalizeSystemBlocks(
  system: Array<{ type?: string; text?: string }>,
): Array<{ type?: string; text?: string }> {
  const normalized = system.map((item) => {
    if (item.type === "text" && item.text) {
      return {
        ...item,
        text: deduplicatePrefix(
          item.text
            .replace(/OpenCode/g, "Claude Code")
            .replace(/opencode/gi, "Claude"),
        ),
      };
    }
    return item;
  });

  const billing = normalized[0];
  const prompt = normalized[1];
  if (
    billing?.type === "text"
    && billing.text?.startsWith("x-anthropic-billing-header:")
    && prompt?.type === "text"
    && prompt.text?.startsWith(`${CLAUDE_PREFIX}\n\n`)
  ) {
    const rest = prompt.text.slice(`${CLAUDE_PREFIX}\n\n`.length);
    return [
      billing,
      { ...prompt, text: CLAUDE_PREFIX },
      { ...prompt, text: rest },
      ...normalized.slice(2),
    ];
  }

  return normalized;
}

function readCachedClaudePromptCache(): ClaudeSystemPromptCache | null {
  try {
    const raw = readFileSync(SYSTEM_PROMPT_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as ClaudeSystemPromptCache;
    if (!Array.isArray(parsed.system) || parsed.system.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function getStableDeviceId(): string {
  let who = "unknown";
  try {
    who = `${userInfo().username}@${hostname()}`;
  } catch {
    try {
      who = `${process.env.USER || process.env.USERNAME || "unknown"}@${hostname()}`;
    } catch {}
  }
  return createHash("sha256").update(who).digest("hex");
}

function buildBillingHeader(
  sessionId: string,
  cachedClaudePromptCache: ClaudeSystemPromptCache | null,
  dynamicFingerprint?: string,
): string {
  const cch = BILLING_CCH
    || createHash("sha256").update(sessionId).digest("hex").slice(0, 5);
  // Prefer dynamic fingerprint (computed per-request from first user message)
  // over static cached value, matching Claude Code's actual behavior.
  const suffix = dynamicFingerprint
    || cachedClaudePromptCache?.billing?.ccVersionSuffix
    || CLI_BUILD_ID;
  const ccVersion = cachedClaudePromptCache?.billing?.ccVersion
    || `${CLI_VERSION}.${suffix}`;
  const ccEntrypoint = cachedClaudePromptCache?.billing?.ccEntrypoint || ENTRYPOINT;
  return `x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=${ccEntrypoint}; cch=${cch};`;
}

async function fetchOAuthProfile(accessToken: string): Promise<OAuthProfile | null> {
  const cached = oauthProfileCache.get(accessToken);
  if (cached) return cached;

  const pending = (async () => {
    try {
      const response = await globalThis.fetch(PROFILE_URL, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "user-agent": USER_AGENT,
          "anthropic-beta": OAUTH_BETA_FLAG,
        },
      });
      if (!response.ok) return null;
      return await response.json() as OAuthProfile;
    } catch {
      return null;
    }
  })();

  oauthProfileCache.set(accessToken, pending);
  return pending;
}

// ── Plugin ─────────────────────────────────────────────────────────

const OpenCodeClaudeBridge = async ({ client }: { client: PluginClient }) => {
  // Save and clear ANTHROPIC_API_KEY so SDK doesn't bypass our fetch.
  // Restored if OAuth isn't active (API key providers still work).
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  const sessionId = SESSION_ID || randomUUID();
  const deviceId = getStableDeviceId();
  const cachedClaudePromptCache = readCachedClaudePromptCache();
  const cachedClaudeSystem = cachedClaudePromptCache?.system || null;

  // Bootstrap auth from Claude CLI keychain at plugin init time — before
  // OpenCode builds its provider state. This ensures the loader runs on
  // startup so models appear immediately without requiring a restart.
  try {
    const tokens = getClaudeTokens();
    if (tokens) await storeAuth(client, tokens);
  } catch {}

  return {
    "experimental.chat.system.transform": (
      input: { model?: { providerID: string } },
      output: { system: string[] },
    ) => {
      if (input.model?.providerID !== "anthropic") return;
      if (output.system.some((s) => s.includes(CLAUDE_PREFIX))) return;
      if (output.system.length > 0) {
        output.system[0] = `${CLAUDE_PREFIX}\n\n${output.system[0]}`;
      } else {
        output.system.push(CLAUDE_PREFIX);
      }
    },

    auth: {
      provider: "anthropic",

      async loader(
        getAuth: () => Promise<AuthType>,
        provider: { models: Record<string, ProviderModel> },
      ) {
        // Always inject Claude models — runs before any auth check so models
        // appear in the selector even on a fresh install with no auth configured
        if (provider?.models !== undefined) {
          for (const [id, def] of Object.entries(ANTHROPIC_MODELS)) {
            if (!provider.models[id]) provider.models[id] = { ...def };
          }
        }

        let auth = await getAuth();

        // Auto-bootstrap from Claude CLI keychain if no OAuth tokens stored
        if (auth.type !== "oauth") {
          try {
            const tokens = getClaudeTokens();
            if (tokens) {
              await storeAuth(client, tokens);
              auth = { type: "oauth", ...tokens };
            }
          } catch {}
        }

        // API key mode — set the key in env and let the SDK handle everything
        if (auth.type === "apikey" && auth.access) {
          process.env.ANTHROPIC_API_KEY = auth.access;
          return {};
        }

        if (auth.type !== "oauth") {
          // Not configured — restore env API key if present so SDK can use it
          if (savedApiKey) process.env.ANTHROPIC_API_KEY = savedApiKey;
          return {};
        }

        // OAuth active — set a placeholder so the SDK doesn't error on missing key.
        // Our fetch wrapper sets the real Authorization: Bearer header and removes x-api-key.
        process.env.ANTHROPIC_API_KEY = "oauth-placeholder";

        return {
          // OpenCode 1.4.0 now rejects Anthropic provider config when both an
          // apiKey and authToken are present. Keep the placeholder apiKey for
          // provider init, and let the fetch wrapper supply the real bearer token.
          async fetch(input: string | URL | Request, init?: RequestInit) {
            const auth = await getAuth();
            if (auth.type !== "oauth") return fetch(input, init);

            let accessToken = auth.access || null;
            if (!accessToken || !auth.expires || auth.expires < Date.now()) {
              try {
                accessToken = await refreshAuth(auth, client);
              } catch (err) {
                const detail = err instanceof Error ? err.message : String(err);
                console.error(`[opencode-claude-bridge] OAuth refresh failed: ${detail}`);
                return buildAuthFailureResponse(detail);
              }
            }

            if (!accessToken) {
              return buildAuthFailureResponse("No usable OAuth access token is available.");
            }

            // ── Headers ──
            const headers = new Headers();
            if (input instanceof Request) mergeHeaders(headers, input.headers);
            if (init?.headers) mergeHeaders(headers, init.headers);

            headers.set("authorization", `Bearer ${accessToken}`);
            headers.delete("x-api-key");
            headers.delete("x-session-affinity");
            if (!headers.has("accept")) headers.set("accept", "application/json");
            headers.set("user-agent", USER_AGENT);
            headers.set("x-app", "cli");
            headers.set("x-claude-code-session-id", sessionId);
            headers.set("anthropic-version", ANTHROPIC_VERSION);
            headers.set("anthropic-dangerous-direct-browser-access", "true");
            for (const [k, v] of Object.entries(STAINLESS_HEADERS)) headers.set(k, v);
            if (!headers.has("x-stainless-retry-count")) headers.set("x-stainless-retry-count", "0");
            if (!headers.has("x-stainless-timeout")) headers.set("x-stainless-timeout", "600");
            headers.set("anthropic-beta", buildBetaFlags(headers.get("anthropic-beta") || ""));

            // ── Body ──
            let body = init?.body;
            if (body && typeof body === "string") {
              try {
                const parsed = JSON.parse(body);
                let requestUrl = "";
                try {
                  requestUrl = String(
                    new URL(
                      typeof input === "string" ? input
                      : input instanceof URL ? input.toString()
                      : input.url,
                    ),
                  );
                } catch {}

                // Only inject adaptive thinking for models that support it.
                // Use an explicit allowlist — haiku and older sonnet variants
                // (e.g. claude-sonnet-4-5) reject the field entirely.
                // claude-sonnet-4-6 and claude-opus-4-x are confirmed to support
                // interleaved-thinking-2025-05-14.
                const THINKING_MODELS = [
                  "claude-opus-4",
                  "claude-sonnet-4-6",
                ];
                const supportsThinking = parsed.model &&
                  THINKING_MODELS.some((m: string) => parsed.model.includes(m));
                if (!parsed.thinking && supportsThinking) {
                  parsed.thinking = { type: "adaptive" };
                }

                // Anthropic requires temperature=1 when thinking is enabled/adaptive
                const thinkingType = parsed.thinking?.type;
                if (
                  (thinkingType === "enabled" || thinkingType === "adaptive") &&
                  parsed.temperature !== undefined &&
                  parsed.temperature !== 1
                ) {
                  parsed.temperature = 1;
                }

                if (!parsed.system) parsed.system = [];
                if (Array.isArray(parsed.messages)) {
                  parsed.messages = stripAssistantPrefillForClaude(parsed.messages);
                }
                // context_management and output_config.effort are only
                // supported by thinking-capable models. Sending them to
                // haiku (used for title generation) produces a 400.
                if (supportsThinking) {
                  if (!parsed.context_management) {
                    parsed.context_management = {
                      edits: [{ type: CLEAR_THINKING_TYPE, keep: "all" }],
                    };
                  }
                  if (!parsed.output_config) {
                    parsed.output_config = { effort: DEFAULT_EFFORT };
                  }
                }

                const profile = auth.access
                  ? await fetchOAuthProfile(auth.access)
                  : null;
                if (!parsed.metadata) parsed.metadata = {};
                if (!parsed.metadata.user_id && profile?.account?.uuid) {
                  parsed.metadata.user_id = JSON.stringify({
                    device_id: deviceId,
                    account_uuid: profile.account.uuid,
                    session_id: sessionId,
                  });
                }

                // Compute dynamic fingerprint from the first user message
                // (matches Claude Code's per-request fingerprint behavior).
                let dynamicFingerprint: string | undefined;
                if (parsed.messages && Array.isArray(parsed.messages)) {
                  const firstText = extractFirstUserMessageText(parsed.messages);
                  if (firstText) {
                    dynamicFingerprint = computeFingerprint(firstText);
                  }
                }

                // Inject billing header as first system block (required for OAuth).
                const hasBilling = parsed.system.some(
                  (s: { text?: string }) =>
                    s.text?.startsWith("x-anthropic-billing-header:"),
                );
                let billingHeader = buildBillingHeader(sessionId, cachedClaudePromptCache, dynamicFingerprint);
                if (!hasBilling) {
                  parsed.system.unshift({
                    type: "text",
                    text: billingHeader,
                  });
                } else {
                  billingHeader = parsed.system[0]?.text || billingHeader;
                }

                // If we have a locally captured Claude Code system prompt, prefer it.
                if (cachedClaudeSystem) {
                  const rewritten = rewriteSystemBlocksForModel(
                    cachedClaudeSystem,
                    typeof parsed.model === "string" ? parsed.model : undefined,
                  );
                  parsed.system = [
                    { type: "text", text: billingHeader },
                    ...rewritten,
                  ];
                } else if (parsed.system && Array.isArray(parsed.system)) {
                  // Otherwise keep the existing prompt but shape it closer to Claude Code.
                  parsed.system = normalizeSystemBlocks(parsed.system);
                }

                // Keep OpenCode's default tool schemas for non-Claude targets.
                // Claude wire schemas are only useful for Anthropic-native
                // requests or Claude-family models on Anthropic-compatible
                // routers such as OpenRouter.
                if (shouldInjectClaudeTools({ model: parsed.model, requestUrl, tools: parsed.tools })) {
                  parsed.tools = getClaudeTools();
                }
                delete parsed.tool_choice;

                // Normalize message content blocks:
                // - Translate tool names (OpenCode → Claude Code)
                // - Translate tool_use input arguments (camelCase → snake_case)
                // - Clean up text blocks
                if (parsed.messages && Array.isArray(parsed.messages)) {
                  for (const msg of parsed.messages) {
                    if (!Array.isArray(msg.content)) continue;
                    for (const block of msg.content) {
                      if (block.type === "text" && typeof block.text === "string") {
                        block.text = maybeUnquoteText(block.text);
                        delete block.cache_control;
                      }
                      if (block.type === "tool_use" && block.name) {
                        block.name = mapOutboundToolName(block.name);
                        // Consolidated OpenCode → Claude argument translation:
                        // key renames, Agent/AskUserQuestion/Skill/WebFetch/TodoWrite
                        // field bridging. Mirrors translateToolArgsJsonString
                        // (inbound) so round-trips preserve meaning. See
                        // translateArgsOpencodeToClaude in claude-tools.ts.
                        if (block.input && typeof block.input === "object") {
                          block.input = translateArgsOpencodeToClaude(
                            block.name,
                            block.input as Record<string, unknown>,
                          );
                        }
                      }
                      // tool_result blocks reference tool names via tool_use_id,
                      // no name translation needed here.
                    }
                  }
                }

                body = JSON.stringify(parsed);
              } catch {}
            }

            // ── URL: add ?beta=true ──
            let requestUrl: URL | null = null;
            try {
              requestUrl = new URL(
                typeof input === "string" ? input
                  : input instanceof URL ? input.toString()
                  : input.url,
              );
            } catch {}

            if (requestUrl?.pathname === "/messages") {
              requestUrl.pathname = "/v1/messages";
            }
            if (requestUrl?.pathname === "/v1/messages" && !requestUrl.searchParams.has("beta")) {
              requestUrl.searchParams.set("beta", "true");
            }
            const finalUrl = requestUrl?.toString()
              ?? (input instanceof Request ? input.url : String(input));

            // ── Request (with 429 auto-refresh retry) ──
            const outHeaders: Record<string, string> = {};
            headers.forEach((v, k) => { outHeaders[k] = v; });

            const doFetch = () => globalThis.fetch(finalUrl, {
              method: init?.method || "POST",
              body,
              headers: outHeaders,
              signal: init?.signal,
            });

            let response = await doFetch();

            // 429 auto-refresh: rate limits are per-access-token, so refreshing
            // the token gives us a fresh rate limit bucket. Try up to 2 retries.
            if (response.status === 429) {
              for (let retry = 0; retry < 2; retry++) {
                console.error(`[opencode-claude-bridge] 429 rate limited (attempt ${retry + 1}/2), refreshing token...`);
                let freshToken: string | null = null;
                try {
                  freshToken = await refreshAuth(auth, client);
                } catch (err) {
                  const detail = err instanceof Error ? err.message : String(err);
                  console.error(`[opencode-claude-bridge] OAuth refresh failed after 429: ${detail}`);
                  return buildAuthFailureResponse(detail);
                }
                if (!freshToken) {
                  console.error("[opencode-claude-bridge] Token refresh failed, returning 429");
                  break;
                }
                outHeaders["authorization"] = `Bearer ${freshToken}`;
                // Back off briefly: 1s first retry, 2s second
                await new Promise((r) => setTimeout(r, 1000 * (retry + 1)));
                response = await doFetch();
                if (response.status !== 429) break;
              }
            }

            // ── Map Claude-style tool names and arguments back to OpenCode ──
            if (!response.body) return response;

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const encoder = new TextEncoder();

            // Parse SSE events on \n\n boundaries, buffer tool_use
            // input_json_delta fragments per content-block index, and
            // translate the assembled JSON once at content_block_stop.
            // This avoids chunk-boundary corruption (e.g. "file_" + "path"
            // split across TCP chunks) that regex-on-raw-bytes can't
            // handle. See src/stream.ts for the processor implementation.
            const processor = createSseProcessor({
              inboundToolNameMap: INBOUND_TOOL_NAME_MAP,
              translateToolArgs: translateToolArgsJsonString,
            });

            return new Response(
              new ReadableStream({
                start(controller) {
                  // Use start() with an async loop rather than pull():
                  // Bun's ReadableStream doesn't reliably re-invoke pull()
                  // when the handler resolves without enqueuing (which
                  // happens while we're buffering input_json_delta
                  // fragments), so pull() can stall the stream.
                  (async () => {
                    try {
                      while (true) {
                        const { done, value } = await reader.read();
                        if (done) {
                          const tail = processor.flush();
                          if (tail) controller.enqueue(encoder.encode(tail));
                          controller.close();
                          return;
                        }
                        const out = processor.feedChunk(decoder.decode(value, { stream: true }));
                        if (out) controller.enqueue(encoder.encode(out));
                      }
                    } catch (e) {
                      controller.error(e);
                    }
                  })();
                },
              }),
              { status: response.status, statusText: response.statusText, headers: response.headers },
            );
          },
        };
      },

      methods: [
        {
          label: "Claude Pro / Max (OAuth)",
          type: "oauth" as const,
          authorize: async () => {
            // First try: auto-bootstrap from Claude CLI keychain
            const tokens = getClaudeTokens();
            if (tokens) {
              await storeAuth(client, tokens);
              return {
                instructions: "Connected via Claude CLI — press Esc, then restart OpenCode if Anthropic models aren't visible",
                method: "code" as const,
                callback: async () => ({ type: "success" as const, ...tokens }),
              };
            }

            // Start a local HTTP server to capture the OAuth redirect.
            // This gives us an ephemeral port so the redirect_uri is
            // http://localhost:{port}/callback — matching Claude Code's flow.
            let callbackServer: Awaited<ReturnType<typeof startOAuthCallbackServer>> | null = null;
            try {
              callbackServer = await startOAuthCallbackServer();
            } catch (err) {
              console.error(`[opencode-oauth] Failed to start callback server: ${err}`);
            }

            if (callbackServer) {
              const { url, manualUrl, verifier, port } = callbackServer;
              const redirectUri = `http://localhost:${port}/callback`;

              // Best-effort browser open
              openBrowser(url);

              // Race: localhost callback vs manual code paste.
              // If the browser redirects to localhost, the callback server
              // captures the code automatically. Otherwise, the user can
              // paste the code from the manual-flow URL.
              //
              // We set up the automatic flow listener in the background.
              // If the user pastes a code first, that wins.
              let autoCode: string | null = null;
              callbackServer.waitForCode().then((code) => {
                autoCode = code;
              }).catch(() => {});

              return {
                url,
                instructions: `Opening browser for OAuth...\n\nIf the browser redirected back successfully, just press Enter.\nOtherwise, open this URL and paste the code:\n${manualUrl}`,
                method: "code" as const,
                callback: async (manualInput: string) => {
                  try {
                    // Brief pause to let the auto-flow resolve if it just arrived
                    if (!autoCode && !manualInput?.trim()) {
                      await new Promise((r) => setTimeout(r, 500));
                    }

                    if (autoCode) {
                      // Auto-flow captured the code via localhost redirect
                      const tokens = exchangeCodeForTokens(autoCode, verifier, redirectUri);
                      await storeAuth(client, tokens);
                      callbackServer?.close();
                      return { type: "success" as const, ...tokens };
                    }

                    const code = parseAuthCode(manualInput);
                    if (!code) {
                      console.error("[opencode-oauth] No authorization code received");
                      callbackServer?.close();
                      return { type: "failed" as const };
                    }

                    // Manual flow — redirect_uri defaults to MANUAL_REDIRECT_URL
                    const tokens = exchangeCodeForTokens(code, verifier);
                    await storeAuth(client, tokens);
                    callbackServer?.close();
                    return { type: "success" as const, ...tokens };
                  } catch (err) {
                    console.error(`[opencode-oauth] Token exchange failed: ${err}`);
                    callbackServer?.close();
                    return { type: "failed" as const };
                  }
                },
              };
            }

            // Fallback: no callback server — use manual redirect URL flow only.
            // This is the path for environments where we can't bind localhost.
            const { url, verifier } = createAuthorizationRequest();

            openBrowser(url);

            return {
              url,
              instructions: `Opening browser for OAuth...\n\nAfter authorizing, you'll see a code — paste it below:\n${url}`,
              method: "code" as const,
              callback: async (code: string) => {
                try {
                  // redirect_uri defaults to MANUAL_REDIRECT_URL in exchangeCodeForTokens
                  const tokens = exchangeCodeForTokens(parseAuthCode(code), verifier);
                  await storeAuth(client, tokens);
                  return { type: "success" as const, ...tokens };
                } catch (err) {
                  console.error(`[opencode-oauth] Token exchange failed: ${err}`);
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
        {
          label: "Claude API Key",
          type: "oauth" as const,
          authorize: async () => {
            // Auto-detect from environment
            const envKey = process.env.ANTHROPIC_API_KEY || savedApiKey;
            if (envKey) {
              await client.auth.set({
                path: { id: "anthropic" },
                body: { type: "apikey", access: envKey, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 },
              });
              return {
                instructions: "✓ API key found in environment — press Esc, then restart OpenCode if Anthropic models aren't visible",
                method: "code" as const,
                callback: async () => ({ type: "success" as const, access: envKey, refresh: "", expires: Date.now() + 365 * 24 * 60 * 60 * 1000 }),
              };
            }
            // Prompt user to paste key
            return {
              instructions: "Paste your Anthropic API key (sk-ant-...):",
              method: "code" as const,
              callback: async (key: string) => {
                const k = key.trim();
                if (!k) return { type: "failed" as const };
                await client.auth.set({
                  path: { id: "anthropic" },
                  body: { type: "apikey", access: k, expires: Date.now() + 365 * 24 * 60 * 60 * 1000 },
                });
                return { type: "success" as const, access: k, refresh: "", expires: Date.now() + 365 * 24 * 60 * 60 * 1000 };
              },
            };
          },
        },
      ],
    },
  };
};

export default OpenCodeClaudeBridge;
