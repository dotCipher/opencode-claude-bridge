import {
  createAuthorizationRequest,
  exchangeCodeForTokens,
  parseAuthCode,
  refreshTokens,
} from "./oauth.js";
import { getClaudeTokens, readClaudeCredentials } from "./keychain.js";
import {
  BETA_FLAGS,
  OAUTH_BETA_FLAG,
  ANTHROPIC_VERSION,
  STAINLESS_HEADERS,
  TOOL_PREFIX,
  USER_AGENT,
} from "./constants.js";

type AuthType = {
  type: string;
  access?: string;
  refresh?: string;
  expires?: number;
};

type ProviderModel = {
  cost: unknown;
};

type PluginClient = {
  auth: {
    set: (args: {
      path: { id: string };
      body: Record<string, unknown>;
    }) => Promise<void>;
  };
};

type PluginInput = {
  model?: { providerID?: string };
};

type PluginOutput = {
  system: string[];
};

const AnthropicOAuthCombined = async ({ client }: { client: PluginClient }) => {
  return {
    "experimental.chat.system.transform": (
      input: PluginInput,
      output: PluginOutput,
    ) => {
      if (input.model?.providerID === "anthropic") {
        const prefix =
          "You are Claude Code, Anthropic's official CLI for Claude.";
        if (output.system.length > 0) {
          output.system[0] = `${prefix}\n\n${output.system[0]}`;
        } else {
          output.system.push(prefix);
        }
      }
    },

    auth: {
      provider: "anthropic",

      async loader(
        getAuth: () => Promise<AuthType>,
        provider: { models: Record<string, ProviderModel> },
      ) {
        let auth = await getAuth();

        // Auto-bootstrap: if no OAuth tokens stored yet, try Claude CLI keychain
        if (auth.type !== "oauth") {
          try {
            const keychainTokens = getClaudeTokens();
            if (keychainTokens) {
              console.error(
                "[opencode-oauth] Auto-synced credentials from Claude CLI",
              );
              await client.auth.set({
                path: { id: "anthropic" },
                body: {
                  type: "oauth",
                  refresh: keychainTokens.refresh,
                  access: keychainTokens.access,
                  expires: keychainTokens.expires,
                },
              });
              auth = {
                type: "oauth",
                access: keychainTokens.access,
                refresh: keychainTokens.refresh,
                expires: keychainTokens.expires,
              };
            }
          } catch {
            // Keychain unavailable — user will need to auth manually
          }
        }

        if (auth.type === "oauth") {
          // Zero out cost for Pro/Max subscription
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: { read: 0, write: 0 },
            };
          }

          return {
            apiKey: "",

            async fetch(input: string | URL | Request, init?: RequestInit) {
              const auth = await getAuth();
              if (auth.type !== "oauth") return fetch(input, init);

              // --- Layered token refresh ---
              if (
                !auth.access ||
                !auth.expires ||
                auth.expires < Date.now()
              ) {
                let fresh: {
                  access: string;
                  refresh: string;
                  expires: number;
                } | null = null;

                // Layer 1: Fresh tokens from Claude CLI keychain
                try {
                  const keychainTokens = getClaudeTokens();
                  if (
                    keychainTokens &&
                    keychainTokens.expires > Date.now() + 60_000
                  ) {
                    console.error(
                      "[opencode-oauth] Synced fresh token from Claude CLI",
                    );
                    fresh = keychainTokens;
                  }
                } catch {
                  // Keychain unavailable
                }

                // Layer 2: OAuth refresh with our stored refresh token
                if (!fresh && auth.refresh) {
                  try {
                    console.error(
                      "[opencode-oauth] Refreshing via stored refresh token...",
                    );
                    fresh = refreshTokens(auth.refresh);
                  } catch (err) {
                    console.error(
                      `[opencode-oauth] Stored refresh failed: ${err}`,
                    );
                  }
                }

                // Layer 3: OAuth refresh with Claude CLI's refresh token
                if (!fresh) {
                  try {
                    const creds = readClaudeCredentials();
                    if (creds?.claudeAiOauth?.refreshToken) {
                      console.error(
                        "[opencode-oauth] Trying Claude CLI refresh token...",
                      );
                      fresh = refreshTokens(creds.claudeAiOauth.refreshToken);
                    }
                  } catch (err) {
                    console.error(
                      `[opencode-oauth] CLI refresh also failed: ${err}`,
                    );
                  }
                }

                if (fresh) {
                  await client.auth.set({
                    path: { id: "anthropic" },
                    body: {
                      type: "oauth",
                      refresh: fresh.refresh,
                      access: fresh.access,
                      expires: fresh.expires,
                    },
                  });
                  auth.access = fresh.access;
                }
              }

              // --- Build headers ---
              const headers = new Headers();

              if (input instanceof Request) {
                input.headers.forEach((v, k) => headers.set(k, v));
              }

              if (init?.headers) {
                const h = init.headers;
                if (h instanceof Headers) {
                  h.forEach((v, k) => headers.set(k, v));
                } else if (Array.isArray(h)) {
                  for (const [k, v] of h) {
                    if (v !== undefined) headers.set(k, String(v));
                  }
                } else {
                  for (const [k, v] of Object.entries(h)) {
                    if (v !== undefined) headers.set(k, String(v));
                  }
                }
              }

              // --- Exact Claude Code 2.1.81 headers ---

              // Auth: OAuth Bearer token, remove API key
              headers.set("authorization", `Bearer ${auth.access}`);
              headers.delete("x-api-key");

              // Remove headers injected by Node/Bun fetch that Claude Code doesn't send
              headers.delete("sec-fetch-mode");
              headers.delete("sec-fetch-site");
              headers.delete("sec-fetch-dest");
              headers.delete("accept-language");

              // Ensure accept matches Claude Code
              if (!headers.has("accept") || headers.get("accept") === "*/*") {
                headers.set("accept", "application/json");
              }

              // Core identity headers
              headers.set("user-agent", USER_AGENT);
              headers.set("x-app", "cli");
              headers.set("anthropic-version", ANTHROPIC_VERSION);
              headers.set(
                "anthropic-dangerous-direct-browser-access",
                "true",
              );

              // Stainless SDK platform headers
              for (const [k, v] of Object.entries(STAINLESS_HEADERS)) {
                headers.set(k, v);
              }
              if (!headers.has("x-stainless-retry-count")) {
                headers.set("x-stainless-retry-count", "0");
              }
              if (!headers.has("x-stainless-timeout")) {
                headers.set("x-stainless-timeout", "600");
              }

              // Beta flags: merge required + oauth + any incoming
              const incoming = (headers.get("anthropic-beta") || "")
                .split(",")
                .map((b) => b.trim())
                .filter(Boolean);
              const required = BETA_FLAGS.split(",").map((b) => b.trim());
              const merged = [
                ...new Set([
                  ...required,
                  OAUTH_BETA_FLAG,
                  ...incoming,
                ]),
              ].join(",");
              headers.set("anthropic-beta", merged);

              // --- Transform request body ---
              let body = init?.body;
              if (body && typeof body === "string") {
                try {
                  const parsed = JSON.parse(body);

                  // Sanitize system prompt
                  if (parsed.system && Array.isArray(parsed.system)) {
                    parsed.system = parsed.system.map(
                      (item: { type?: string; text?: string }) => {
                        if (item.type === "text" && item.text) {
                          return {
                            ...item,
                            text: item.text
                              .replace(/OpenCode/g, "Claude Code")
                              .replace(/opencode/gi, "Claude"),
                          };
                        }
                        return item;
                      },
                    );
                  }

                  // Prefix tool definitions (avoid double-prefixing)
                  if (parsed.tools && Array.isArray(parsed.tools)) {
                    parsed.tools = parsed.tools.map(
                      (tool: { name?: string }) => ({
                        ...tool,
                        name:
                          tool.name && !tool.name.startsWith(TOOL_PREFIX)
                            ? `${TOOL_PREFIX}${tool.name}`
                            : tool.name,
                      }),
                    );
                  }

                  // Prefix tool_use blocks in messages (avoid double-prefixing)
                  if (parsed.messages && Array.isArray(parsed.messages)) {
                    parsed.messages = parsed.messages.map(
                      (msg: {
                        content?: Array<{ type?: string; name?: string }>;
                      }) => {
                        if (msg.content && Array.isArray(msg.content)) {
                          msg.content = msg.content.map(
                            (block: { type?: string; name?: string }) => {
                              if (
                                block.type === "tool_use" &&
                                block.name &&
                                !block.name.startsWith(TOOL_PREFIX)
                              ) {
                                return {
                                  ...block,
                                  name: `${TOOL_PREFIX}${block.name}`,
                                };
                              }
                              return block;
                            },
                          );
                        }
                        return msg;
                      },
                    );
                  }

                  body = JSON.stringify(parsed);
                } catch {
                  // ignore parse errors
                }
              }

              // --- URL rewrite ---
              let requestUrl: URL | null = null;
              try {
                if (typeof input === "string" || input instanceof URL) {
                  requestUrl = new URL(input.toString());
                } else if (input instanceof Request) {
                  requestUrl = new URL(input.url);
                }
              } catch {
                requestUrl = null;
              }

              if (
                requestUrl &&
                requestUrl.pathname === "/v1/messages" &&
                !requestUrl.searchParams.has("beta")
              ) {
                requestUrl.searchParams.set("beta", "true");
              }

              const finalUrl = requestUrl
                ? requestUrl.toString()
                : input instanceof Request
                  ? input.url
                  : String(input);

              // --- Request with 429 auto-refresh retry ---
              const MAX_RETRIES = 3;
              let response: Response;

              for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                const req = new Request(finalUrl, {
                  method: init?.method || "POST",
                  body,
                  headers,
                });

                response = await fetch(req);

                if (response.status !== 429 || attempt === MAX_RETRIES - 1) {
                  break;
                }

                console.error(
                  `[opencode-oauth] 429 (attempt ${attempt + 1}/${MAX_RETRIES}), refreshing...`,
                );

                try {
                  let fresh: {
                    access: string;
                    refresh: string;
                    expires: number;
                  } | null = null;

                  // Try keychain for a different token first
                  const keychainTokens = getClaudeTokens();
                  if (
                    keychainTokens &&
                    keychainTokens.access !== auth.access
                  ) {
                    fresh = keychainTokens;
                    console.error(
                      "[opencode-oauth] Got different token from keychain",
                    );
                  }

                  // Fall back to OAuth refresh
                  if (!fresh) {
                    fresh = refreshTokens(auth.refresh!);
                  }

                  await client.auth.set({
                    path: { id: "anthropic" },
                    body: {
                      type: "oauth",
                      refresh: fresh.refresh,
                      access: fresh.access,
                      expires: fresh.expires,
                    },
                  });
                  auth.access = fresh.access;
                  headers.set("authorization", `Bearer ${fresh.access}`);
                } catch (refreshErr) {
                  console.error(
                    `[opencode-oauth] 429 retry refresh failed: ${refreshErr}`,
                  );
                }

                const retryAfter =
                  parseInt(
                    response.headers.get("retry-after") || "0",
                    10,
                  ) * 1000;
                const delay =
                  retryAfter ||
                  1000 * Math.pow(2, attempt) + Math.random() * 1000;
                await new Promise((r) => setTimeout(r, delay));
              }

              // --- Strip mcp_ prefix from streaming response ---
              if (response!.body) {
                const reader = response!.body.getReader();
                const decoder = new TextDecoder();
                const encoder = new TextEncoder();

                const stream = new ReadableStream({
                  async pull(controller) {
                    const { done, value } = await reader.read();
                    if (done) {
                      controller.close();
                      return;
                    }

                    let text = decoder.decode(value, { stream: true });
                    text = text.replace(
                      /"name"\s*:\s*"mcp_([^"]+)"/g,
                      '"name": "$1"',
                    );
                    controller.enqueue(encoder.encode(text));
                  },
                });

                return new Response(stream, {
                  status: response!.status,
                  statusText: response!.statusText,
                  headers: response!.headers,
                });
              }

              return response!;
            },
          };
        }

        return {};
      },

      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            // First try: auto-sync from Claude CLI (zero interaction)
            const tokens = getClaudeTokens();
            if (tokens) {
              console.error(
                "[opencode-oauth] Auto-authenticated via Claude CLI",
              );
              return {
                type: "success",
                access: tokens.access,
                refresh: tokens.refresh,
                expires: tokens.expires,
              };
            }

            // Fallback: browser-based OAuth PKCE flow
            console.error(
              "[opencode-oauth] No Claude CLI found, starting browser OAuth...",
            );
            const { url, verifier } = createAuthorizationRequest();
            return {
              url,
              instructions: "Paste the authorization code here: ",
              method: "code",
              callback: async (code: string) => {
                try {
                  const cleanCode = parseAuthCode(code);
                  const exchanged = exchangeCodeForTokens(
                    cleanCode,
                    verifier,
                  );
                  return {
                    type: "success",
                    access: exchanged.access,
                    refresh: exchanged.refresh,
                    expires: exchanged.expires,
                  };
                } catch (err) {
                  console.error(
                    `[opencode-oauth] Token exchange failed: ${err}`,
                  );
                  return { type: "failed" };
                }
              },
            };
          },
        },
      ],
    },
  };
};

export default AnthropicOAuthCombined;
