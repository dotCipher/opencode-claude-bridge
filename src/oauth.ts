import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import {
  CLIENT_ID,
  TOKEN_URL,
  AUTHORIZE_URL,
  MANUAL_REDIRECT_URL,
  SCOPES,
  USER_AGENT,
} from "./constants.js";

export interface OAuthTokens {
  access: string;
  refresh: string;
  expires: number;
}

export interface OAuthCallbackServer {
  /** The URL the user should open to authorize. */
  url: string;
  /** A manual-flow URL the user can paste a code from if localhost redirect doesn't work. */
  manualUrl: string;
  /** The PKCE code verifier (needed for token exchange). */
  verifier: string;
  /** The state parameter (used for CSRF validation). */
  state: string;
  /** The port the local server is listening on. */
  port: number;
  /** Wait for the authorization code to arrive via localhost redirect. Resolves with the code. */
  waitForCode: () => Promise<string>;
  /** Stop the callback server. */
  close: () => void;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url").replace(/=+$/, "");
}

function sleep(ms: number): void {
  execSync(`sleep ${(ms / 1000).toFixed(3)}`, { timeout: 60000 });
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
    } catch (err) {
      if (attempt === retries - 1) throw err;
    }
    sleep(1000 * Math.pow(2, attempt) + Math.random() * 1000);
  }

  return {
    status: 429,
    body: '{"error":{"type":"rate_limit_error","message":"Rate limited"}}',
  };
}

function parseTokenResponse(status: number, body: string, label: string): OAuthTokens {
  if (status !== 200) {
    throw new Error(`${label} failed (${status}): ${body}`);
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

/**
 * Build PKCE challenge and state, then construct both automatic (localhost
 * redirect) and manual (platform.claude.com redirect) authorization URLs.
 */
function buildAuthUrls(
  port: number,
): { automaticUrl: string; manualUrl: string; verifier: string; state: string } {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));

  const automaticRedirectUri = `http://localhost:${port}/callback`;

  const buildUrl = (redirectUri: string): string => {
    const params = new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    return `${AUTHORIZE_URL}?${params}`;
  };

  return {
    automaticUrl: buildUrl(automaticRedirectUri),
    manualUrl: buildUrl(MANUAL_REDIRECT_URL),
    verifier,
    state,
  };
}

/**
 * Start a local HTTP server to receive the OAuth callback redirect.
 * Returns a server handle with the authorization URLs, a promise that
 * resolves when the auth code arrives, and a close() method.
 *
 * This matches Claude Code's approach: an ephemeral port on localhost
 * captures the redirect. The redirect_uri includes the real port.
 */
export function startOAuthCallbackServer(): Promise<OAuthCallbackServer> {
  return new Promise((resolve, reject) => {
    let codeResolve: ((code: string) => void) | null = null;
    let codeReject: ((err: Error) => void) | null = null;
    const codePromise = new Promise<string>((res, rej) => {
      codeResolve = res;
      codeReject = rej;
    });

    const escapeHtml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          const desc = url.searchParams.get("error_description") || error;
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body><h2>Authorization failed</h2><p>${escapeHtml(desc)}</p><p>You can close this window.</p></body></html>`);
          codeReject?.(new Error(`OAuth error: ${desc}`));
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<html><body><h2>Authorization successful</h2><p>You can close this window and return to OpenCode.</p></body></html>`);
          codeResolve?.(code);
          return;
        }

        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Missing authorization code");
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    // Timeout: close the server after 5 minutes if no code arrives
    const timeout = setTimeout(() => {
      codeReject?.(new Error("OAuth callback timed out after 5 minutes"));
      server.close();
    }, 5 * 60 * 1000);

    // Listen on port 0 = OS assigns an ephemeral port
    server.listen(0, "localhost", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }

      const port = addr.port;
      const { automaticUrl, manualUrl, verifier, state } = buildAuthUrls(port);

      resolve({
        url: automaticUrl,
        manualUrl,
        verifier,
        state,
        port,
        waitForCode: () => codePromise,
        close: () => {
          clearTimeout(timeout);
          server.close();
        },
      });
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Legacy createAuthorizationRequest for backward compatibility.
 * Uses MANUAL_REDIRECT_URL since there's no local server.
 */
export function createAuthorizationRequest(
  redirectUri?: string,
): { url: string; verifier: string; state: string } {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(32));

  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri || MANUAL_REDIRECT_URL,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  return { url: `${AUTHORIZE_URL}?${params}`, verifier, state };
}

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
    redirect_uri: redirectUri || MANUAL_REDIRECT_URL,
  });
  return parseTokenResponse(status, body, "Token exchange");
}

export function refreshTokens(refreshToken: string): OAuthTokens {
  const { status, body } = curlPost({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  return parseTokenResponse(status, body, "Token refresh");
}
