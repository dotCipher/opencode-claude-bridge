import { randomBytes, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import {
  CLIENT_ID,
  TOKEN_URL,
  AUTHORIZE_URL,
  REDIRECT_URI,
  SCOPES,
  USER_AGENT,
} from "./constants.js";

export interface OAuthTokens {
  access: string;
  refresh: string;
  expires: number;
}

/**
 * RFC 7636-compliant base64url encoding — unpadded.
 */
function base64url(buf: Buffer): string {
  return buf.toString("base64url").replace(/=+$/, "");
}

function generateVerifier(): string {
  return base64url(randomBytes(64));
}

function generateChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/**
 * curl-based token exchange to avoid Bun/runtime fetch injecting
 * forbidden headers (Origin, Referer, Sec-Fetch-*) that trigger 429s.
 */
function curlPost(
  body: Record<string, string>,
  retries = 3,
): { status: number; body: string } {
  const payload = JSON.stringify(body);
  const escaped = payload.replace(/'/g, "'\\''");

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = execSync(
        `curl -s -w '\\n__HTTP_STATUS__%{http_code}' ` +
          `-X POST '${TOKEN_URL}' ` +
          `-H 'Content-Type: application/json' ` +
          `-H 'User-Agent: ${USER_AGENT}' ` +
          `-d '${escaped}'`,
        { timeout: 30000, encoding: "utf8" },
      );

      const parts = result.split("\n__HTTP_STATUS__");
      const status = parseInt(parts[parts.length - 1], 10);
      const responseBody = parts.slice(0, -1).join("\n__HTTP_STATUS__");

      if (status !== 429 || attempt === retries - 1) {
        return { status, body: responseBody };
      }

      console.error(
        `[opencode-oauth] Token endpoint 429 (attempt ${attempt + 1}/${retries}), retrying...`,
      );
      const delay = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
      execSync(`sleep ${(delay / 1000).toFixed(3)}`, { timeout: 60000 });
    } catch (err) {
      if (attempt === retries - 1) throw err;
      const delay = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
      execSync(`sleep ${(delay / 1000).toFixed(3)}`, { timeout: 60000 });
    }
  }

  return {
    status: 429,
    body: '{"error":{"type":"rate_limit_error","message":"Rate limited"}}',
  };
}

export function createAuthorizationRequest(
  redirectUri?: string,
): { url: string; verifier: string } {
  const verifier = generateVerifier();
  const challenge = generateChallenge(verifier);

  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri || REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });

  return {
    url: `${AUTHORIZE_URL}?${params}`,
    verifier,
  };
}

/**
 * Parse auth code from various input formats (vinzabe's robust parsing).
 */
export function parseAuthCode(raw: string): string {
  let code = raw.trim();

  if (code.includes("#")) {
    code = code.split("#")[0];
  }

  if (code.includes("?")) {
    try {
      const url = new URL(code);
      code = url.searchParams.get("code") || code;
    } catch {
      const match = code.match(/[?&]code=([^&#]+)/);
      if (match) code = match[1];
    }
  }

  return code.trim();
}

export function exchangeCodeForTokens(
  code: string,
  verifier: string,
  redirectUri?: string,
): OAuthTokens {
  const { status, body } = curlPost({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: redirectUri || REDIRECT_URI,
    state: verifier,
  });

  if (status !== 200) {
    throw new Error(`Token exchange failed (${status}): ${body}`);
  }

  const data = JSON.parse(body) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

export function refreshTokens(refreshToken: string): OAuthTokens {
  const { status, body } = curlPost({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  if (status !== 200) {
    throw new Error(`Token refresh failed (${status}): ${body}`);
  }

  const data = JSON.parse(body) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}
