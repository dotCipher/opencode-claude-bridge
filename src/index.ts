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

type ProviderModel = { cost: unknown };

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
        let auth = await getAuth();

        // Auto-bootstrap from Claude CLI keychain if no OAuth tokens stored
        if (auth.type !== "oauth") {
          try {
            const tokens = getClaudeTokens();
            if (tokens) {
              console.error("[opencode-oauth] Auto-synced credentials from Claude CLI");
              await storeAuth(client, tokens);
              auth = { type: "oauth", ...tokens };
            }
          } catch {}
        }

        if (auth.type !== "oauth") {
          // Not OAuth — restore API key for non-OAuth providers
          if (savedApiKey) process.env.ANTHROPIC_API_KEY = savedApiKey;
          return {};
        }

        // OAuth active — set a placeholder so the SDK doesn't error on missing key.
        // Our fetch wrapper sets the real Authorization: Bearer header and removes x-api-key.
        process.env.ANTHROPIC_API_KEY = "oauth-placeholder";

        // Zero out cost for Pro/Max subscription
        if (provider?.models) {
          for (const model of Object.values(provider.models)) {
            model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
          }
        }

        return {
          ...(auth.access ? { authToken: auth.access } : {}),

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

                // Required for interleaved-thinking beta (not supported on haiku)
                if (!parsed.thinking && !parsed.model?.includes("haiku")) {
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

            // ── Request ──
            const outHeaders: Record<string, string> = {};
            headers.forEach((v, k) => { outHeaders[k] = v; });

            const response = await globalThis.fetch(finalUrl, {
              method: init?.method || "POST",
              body,
              headers: outHeaders,
              signal: init?.signal,
            });

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
              return { type: "success" as const, ...tokens };
            }

            const { url, verifier } = createAuthorizationRequest();
            return {
              url,
              instructions: "A browser window will open — log in to Claude, then paste the authorization code below:",
              method: "code" as const,
              callback: async (code: string) => {
                try {
                  const tokens = exchangeCodeForTokens(parseAuthCode(code), verifier);
                  return { type: "success" as const, ...tokens };
                } catch {
                  return { type: "failed" as const };
                }
              },
            };
          },
        },
        {
          provider: "anthropic",
          label: "API Key",
          type: "api" as const,
        },
      ],
    },
  };
};

export default OpenCodeClaudeBridge;
