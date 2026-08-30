import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { OAuthTokens } from "./oauth.js";
import { refreshTokens } from "./oauth.js";

interface KeychainCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

interface GetClaudeTokensOptions {
  refreshExpired?: boolean;
  logRefreshFailures?: boolean;
}

const KEYCHAIN_SERVICE = "Claude Code-credentials";

/**
 * Pick the first candidate that actually carries `claudeAiOauth`.
 *
 * More than one Keychain item can share the service name, and a match is not
 * the same thing as the right item: attaching an MCP server writes a second
 * item under this service holding only `mcpOAuth`. Selecting on content rather
 * than on "the first thing `security` returned" is what keeps that item from
 * shadowing the real credential.
 *
 * Exported for tests; the selection is pure so it can be exercised without a
 * Keychain.
 */
export function selectClaudeCredentials(
  candidates: Array<KeychainCredentials | null>,
): KeychainCredentials | null {
  for (const candidate of candidates) {
    if (candidate?.claudeAiOauth) return candidate;
  }
  return null;
}

/** Read one Keychain item, optionally scoped to an account. */
function readKeychainItem(account?: string): KeychainCredentials | null {
  const args = ["find-generic-password", "-s", KEYCHAIN_SERVICE];
  if (account) args.push("-a", account);
  args.push("-w");
  try {
    // execFileSync, not a shell string: the account name is user-controlled
    // and must not be interpolated into a command line.
    const raw = execFileSync("security", args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!raw) return null;
    return JSON.parse(raw) as KeychainCredentials;
  } catch {
    // Item missing, Keychain unavailable, or unparseable contents.
    return null;
  }
}

/**
 * Read Claude CLI credentials from macOS Keychain.
 * Falls back to ~/.claude/.credentials.json on other platforms.
 */
export function readClaudeCredentials(): KeychainCredentials | null {
  if (process.platform === "darwin") {
    let account: string | undefined;
    try {
      account = userInfo().username;
    } catch {
      // userInfo() throws when there is no passwd entry for the uid.
      account = undefined;
    }

    // Scoped lookup first (Claude Code stores under the current account), then
    // the historical unscoped lookup so anyone whose item lives under a
    // different account name keeps working exactly as before.
    const found = selectClaudeCredentials([
      account ? readKeychainItem(account) : null,
      readKeychainItem(),
    ]);
    if (found) return found;
    // Deliberately fall through when the Keychain had matches but none carried
    // claudeAiOauth. Returning such an item made the credentials-file fallback
    // below unreachable.
  }

  // Fallback: credentials file
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json");
    const raw = readFileSync(credPath, "utf8");
    return JSON.parse(raw) as KeychainCredentials;
  } catch {
    return null;
  }
}

/**
 * Get valid OAuth tokens from Claude CLI.
 * If expired, attempts to refresh via curl.
 */
export function getClaudeTokens(options: GetClaudeTokensOptions = {}): OAuthTokens | null {
  const refreshExpired = options.refreshExpired ?? true;
  const logRefreshFailures = options.logRefreshFailures ?? true;
  const creds = readClaudeCredentials();
  if (!creds?.claudeAiOauth) return null;

  const { accessToken, refreshToken, expiresAt } = creds.claudeAiOauth;

  // Token still valid (60s buffer)
  if (expiresAt > Date.now() + 60_000) {
    return {
      access: accessToken,
      refresh: refreshToken,
      expires: expiresAt,
    };
  }

  // Expired — try refresh only when the caller explicitly wants side effects.
  // Login/bootstrap paths use this in read-only mode so stale Claude CLI
  // keychain refresh tokens do not produce invalid_grant noise before a fresh
  // OAuth login starts.
  if (!refreshExpired) return null;

  if (refreshToken) {
    try {
      console.error("[opencode-oauth] Claude CLI token expired, refreshing...");
      return refreshTokens(refreshToken);
    } catch (err) {
      if (logRefreshFailures) console.error(`[opencode-oauth] Keychain refresh failed: ${err}`);
    }
  }

  return null;
}
