import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function detectClaudeVersion(): string {
  // Try to read version from installed Claude CLI
  try {
    const version = execSync("claude --version 2>/dev/null", {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    const match = version.match(/^(\d+\.\d+\.\d+)/);
    if (match) return match[1];
  } catch {}
  // Fallback to credentials file
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    const raw = readFileSync(credPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed.version && typeof parsed.version === "string") {
      return parsed.version;
    }
  } catch {}
  return "2.1.98";
}

export const CLIENT_ID =
  process.env.ANTHROPIC_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const PROFILE_URL =
  process.env.ANTHROPIC_PROFILE_URL ||
  "https://claude.ai/api/oauth/profile";

export const TOKEN_URL =
  process.env.ANTHROPIC_TOKEN_URL ||
  "https://platform.claude.com/v1/oauth/token";

export const AUTHORIZE_URL =
  process.env.ANTHROPIC_AUTHORIZE_URL ||
  "https://claude.ai/oauth/authorize";

// Manual redirect URL — used when the local server can't receive the callback
// (e.g., user copies the code from the browser). This matches Claude CLI's
// MANUAL_REDIRECT_URL from the production OAuth config.
export const MANUAL_REDIRECT_URL =
  process.env.ANTHROPIC_MANUAL_REDIRECT_URL ||
  "https://platform.claude.com/oauth/code/callback";

// All OAuth scopes — union of Console + Claude.ai scopes, matching Claude CLI's
// ALL_OAUTH_SCOPES. Includes org:create_api_key for Console -> Claude.ai redirect.
export const SCOPES =
  process.env.ANTHROPIC_SCOPES ||
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export const CLI_VERSION =
  process.env.ANTHROPIC_CLI_VERSION || detectClaudeVersion();

export const CLI_BUILD_ID =
  process.env.ANTHROPIC_CLI_BUILD_ID || "835";

export const ENTRYPOINT =
  process.env.ANTHROPIC_ENTRYPOINT ||
  process.env.CLAUDE_CODE_ENTRYPOINT ||
  "sdk-cli";

export const USER_AGENT =
  process.env.ANTHROPIC_USER_AGENT ||
  `claude-cli/${CLI_VERSION} (external, ${ENTRYPOINT})`;

// Exact beta flags from Claude Code 2.1.98 (confirmed via request interception)
// oauth-2025-04-20 is added separately only for OAuth auth.
export const BETA_FLAGS =
  process.env.ANTHROPIC_BETA_FLAGS ||
  "interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,claude-code-20250219,advisor-tool-2026-03-01,effort-2025-11-24";

export const OAUTH_BETA_FLAG = "oauth-2025-04-20";

// Exact anthropic-version header from Claude Code SDK
export const ANTHROPIC_VERSION = "2023-06-01";

// Stainless SDK headers (matches what Claude Code's bundled SDK sends)
export const STAINLESS_HEADERS: Record<string, string> = {
  "x-stainless-lang": "js",
  "x-stainless-package-version": process.env.ANTHROPIC_SDK_VERSION || "0.81.0",
  "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform === "linux" ? "Linux" : "Windows",
  "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": process.version,
};

export const DEFAULT_EFFORT =
  process.env.ANTHROPIC_DEFAULT_EFFORT || "medium";

export const CLEAR_THINKING_TYPE =
  process.env.ANTHROPIC_CLEAR_THINKING_TYPE || "clear_thinking_20251015";

export const BILLING_CCH =
  process.env.ANTHROPIC_BILLING_CCH || "";

export const SESSION_ID =
  process.env.ANTHROPIC_SESSION_ID || "";

export const TOOL_PREFIX = "mcp_";
