import {
  createAuthorizationRequest,
  exchangeCodeForTokens,
  parseAuthCode,
  refreshTokens,
} from "./oauth.js";
import { getClaudeTokens, readClaudeCredentials } from "./keychain.js";
import {
  BETA_FLAGS,
  CLI_VERSION,
  OAUTH_BETA_FLAG,
  ANTHROPIC_VERSION,
  STAINLESS_HEADERS,
  TOOL_PREFIX,
  USER_AGENT,
} from "./constants.js";

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
  "You are Claude Code, Anthropic's official CLI for Claude.";

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

  // Layer 1: Claude CLI keychain
  try {
    const kt = getClaudeTokens();
    if (kt && kt.expires > Date.now() + 60_000) fresh = kt;
  } catch {}

  // Layer 2: Stored refresh token
  if (!fresh && auth.refresh) {
    try { fresh = refreshTokens(auth.refresh); } catch {}
  }

  // Layer 3: CLI refresh token
  if (!fresh) {
    try {
      const creds = readClaudeCredentials();
      if (creds?.claudeAiOauth?.refreshToken)
        fresh = refreshTokens(creds.claudeAiOauth.refreshToken);
    } catch {}
  }

  if (fresh) {
    await storeAuth(client, fresh);
    auth.access = fresh.access;
    auth.refresh = fresh.refresh;
    auth.expires = fresh.expires;
    return fresh.access;
  }
  return null;
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
  const incoming = existing.split(",").map((b) => b.trim()).filter(Boolean);
  const required = BETA_FLAGS.split(",").map((b) => b.trim());
  return [...new Set([...required, OAUTH_BETA_FLAG, ...incoming])].join(",");
}

/** Deduplicate repeated Claude Code prefix in a text block. */
function deduplicatePrefix(text: string): string {
  const doubled = `${CLAUDE_PREFIX}\n\n${CLAUDE_PREFIX}`;
  while (text.includes(doubled)) {
    text = text.replace(doubled, CLAUDE_PREFIX);
  }
  return text;
}

// ── Plugin ─────────────────────────────────────────────────────────

const OpenCodeClaudeBridge = async ({ client }: { client: PluginClient }) => {
  // Save and clear ANTHROPIC_API_KEY so SDK doesn't bypass our fetch.
  // Restored if OAuth isn't active (API key providers still work).
  const savedApiKey = process.env.ANTHROPIC_API_KEY;

  // Bootstrap auth from Claude CLI keychain at plugin init time — before
  // OpenCode builds its provider state. This ensures the loader runs on
  // startup so models appear immediately without requiring a restart.
  try {
    const tokens = getClaudeTokens();
    if (tokens) await storeAuth(client, tokens);
  } catch {}

  return {
    "experimental.chat.system.transform": async (
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
        // Pass apiKey (not authToken): @ai-sdk/anthropic@3.x throws when both are present,
        // which happens when ANTHROPIC_API_KEY is set in the desktop env before plugin init.
        process.env.ANTHROPIC_API_KEY = "oauth-placeholder";

        return {
          apiKey: "oauth-placeholder",

          async fetch(input: string | URL | Request, init?: RequestInit) {
            const auth = await getAuth();
            if (auth.type !== "oauth") return fetch(input, init);

            if (!auth.access || !auth.expires || auth.expires < Date.now()) {
              await refreshAuth(auth, client);
            }

            // ── Headers ──
            const headers = new Headers();
            if (input instanceof Request) mergeHeaders(headers, input.headers);
            if (init?.headers) mergeHeaders(headers, init.headers);

            headers.set("authorization", `Bearer ${auth.access}`);
            headers.delete("x-api-key");
            headers.set("user-agent", USER_AGENT);
            headers.set("x-app", "cli");
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

                // Inject billing header as first system block (required for OAuth)
                if (!parsed.system) parsed.system = [];
                const hasBilling = parsed.system.some(
                  (s: { text?: string }) =>
                    s.text?.startsWith("x-anthropic-billing-header:"),
                );
                if (!hasBilling) {
                  // Generate content hash matching Claude CLI's format
                  const sysContent = parsed.system
                    .map((s: { text?: string }) => s.text || "")
                    .join("");
                  const { createHash } = await import("node:crypto");
                  const hash = createHash("sha256")
                    .update(sysContent)
                    .digest("hex");
                  parsed.system.unshift({
                    type: "text",
                    text: `x-anthropic-billing-header: cc_version=${CLI_VERSION}.${hash.slice(0, 3)}; cc_entrypoint=cli; cch=${hash.slice(0, 5)};`,
                  });
                }

                // Sanitize system prompt
                if (parsed.system && Array.isArray(parsed.system)) {
                  parsed.system = parsed.system.map(
                    (item: { type?: string; text?: string }) => {
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
                    },
                  );
                }

                // Prefix tool names with mcp_
                if (parsed.tools && Array.isArray(parsed.tools)) {
                  parsed.tools = parsed.tools.map(
                    (tool: { name?: string }) => ({
                      ...tool,
                      name: tool.name && !tool.name.startsWith(TOOL_PREFIX)
                        ? `${TOOL_PREFIX}${tool.name}` : tool.name,
                    }),
                  );
                }

                // Prefix tool_use blocks in messages
                if (parsed.messages && Array.isArray(parsed.messages)) {
                  for (const msg of parsed.messages) {
                    if (!Array.isArray(msg.content)) continue;
                    for (const block of msg.content) {
                      if (
                        block.type === "tool_use" &&
                        block.name &&
                        !block.name.startsWith(TOOL_PREFIX)
                      ) {
                        block.name = `${TOOL_PREFIX}${block.name}`;
                      }
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
                const freshToken = await refreshAuth(auth, client);
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

            // ── Strip mcp_ prefix from streaming response ──
            if (!response.body) return response;

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const encoder = new TextEncoder();

            return new Response(
              new ReadableStream({
                async pull(controller) {
                  const { done, value } = await reader.read();
                  if (done) { controller.close(); return; }
                  let text = decoder.decode(value, { stream: true });
                  text = text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"');
                  controller.enqueue(encoder.encode(text));
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
            const tokens = getClaudeTokens();
            if (tokens) {
              await storeAuth(client, tokens);
              return {
                instructions: "✓ Connected via Claude CLI — press Esc, then restart OpenCode if Anthropic models aren't visible",
                method: "code" as const,
                callback: async () => ({ type: "success" as const, ...tokens }),
              };
            }

            const { url, verifier } = createAuthorizationRequest();

            // Best-effort browser open — try launchctl asuser (escapes sidecar sandbox),
            // plain open, and osascript in order. Also write a .command file to Desktop.
            (async () => {
              const { execFileSync } = await import("node:child_process");
              const { writeFileSync, chmodSync } = await import("node:fs");
              const { homedir } = await import("node:os");
              const { join } = await import("node:path");

              if (process.platform === "darwin") {
                // Write .command file to Desktop as a guaranteed fallback
                try {
                  const safe = url.replace(/'/g, "'\\''");
                  const script = `#!/bin/bash\n/usr/bin/open '${safe}'\nrm -f "$0"\n`;
                  const scriptPath = join(homedir(), "Desktop", "opencode-oauth.command");
                  writeFileSync(scriptPath, script);
                  chmodSync(scriptPath, 0o755);
                } catch {}

                // Try to open browser directly
                const uid = String(process.getuid?.() ?? "");
                const attempts: Array<() => void> = [
                  () => execFileSync("/bin/launchctl", ["asuser", uid, "/usr/bin/open", url], { timeout: 5000 }),
                  () => execFileSync("/usr/bin/open", [url], { timeout: 3000 }),
                  () => execFileSync("/usr/bin/osascript", ["-e", `open location "${url}"`], { timeout: 3000 }),
                ];
                for (const attempt of attempts) {
                  try { attempt(); break; } catch {}
                }
              } else if (process.platform === "win32") {
                try { execFileSync("cmd", ["/c", "start", url], { timeout: 3000 }); } catch {}
              } else {
                const attempts: Array<() => void> = [
                  () => execFileSync("/usr/bin/xdg-open", [url], { timeout: 3000 }),
                  () => execFileSync("/usr/bin/open", [url], { timeout: 3000 }),
                ];
                for (const attempt of attempts) {
                  try { attempt(); break; } catch {}
                }
              }
            })().catch(() => {});

            return {
              url,
              instructions: `Opening browser… If nothing opens, double-click 'opencode-oauth.command' on your Desktop, then paste the authorization code below:\n\n${url}`,
              method: "code" as const,
              callback: async (code: string) => {
                try {
                  const tokens = exchangeCodeForTokens(parseAuthCode(code), verifier);
                  await storeAuth(client, tokens);
                  return { type: "success" as const, ...tokens };
                } catch {
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
