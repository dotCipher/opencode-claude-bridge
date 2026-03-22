import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * Read Claude CLI credentials from macOS Keychain.
 * Falls back to ~/.claude/.credentials.json on other platforms.
 */
export function readClaudeCredentials(): KeychainCredentials | null {
  if (process.platform === "darwin") {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      if (raw && raw !== "") {
        return JSON.parse(raw) as KeychainCredentials;
      }
    } catch {
      // Keychain not available or entry missing
    }
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
export function getClaudeTokens(): OAuthTokens | null {
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

  // Expired — try refresh
  if (refreshToken) {
    try {
      console.error("[opencode-oauth] Claude CLI token expired, refreshing...");
      return refreshTokens(refreshToken);
    } catch (err) {
      console.error(`[opencode-oauth] Keychain refresh failed: ${err}`);
    }
  }

  return null;
}
