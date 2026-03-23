# opencode-claude-bridge

Use your Claude Pro/Max subscription in [OpenCode](https://opencode.ai). If you're logged into the Claude CLI, it just works — no extra setup.

## Install

```bash
npm install -g opencode-claude-bridge
```

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-claude-bridge"]
}
```

Select an Anthropic model, choose **Claude Pro/Max** when prompted, and you're in.

**From source:**

```bash
git clone https://github.com/dotCipher/opencode-claude-bridge.git ~/opencode-claude-bridge
cd ~/opencode-claude-bridge && npm install && npm run build
```

```json
{
  "plugin": ["~/opencode-claude-bridge/dist/index.js"]
}
```

## How the bridge works

The plugin sits between OpenCode and the Anthropic API:

> **OpenCode** → **opencode-claude-bridge** → **Anthropic API**

**Authentication** — Supports both OAuth and API key auth:

- **OAuth (Pro/Max)** — Auto-reads your Claude CLI's OAuth tokens from macOS Keychain (or `~/.claude/.credentials.json` on Linux). No browser flow needed. If Claude CLI isn't available, falls back to browser-based OAuth PKCE.
- **API key** — Works alongside a standard `provider` entry in your OpenCode config with an `apiKey`. The plugin only activates its OAuth handling for the built-in `anthropic` provider; custom API key providers pass through unchanged.

**Token refresh** — When tokens expire, three layers are tried in order: re-read from Keychain, refresh via stored token, refresh via CLI's token. On 429 rate limits, the token is refreshed and the request retried (up to 3 attempts).

**Request transformation** — Every outbound request is rewritten to match what Claude Code 2.1.81 actually sends: correct `user-agent`, `anthropic-beta` flags, `anthropic-version`, Stainless SDK headers, `?beta=true` URL parameter, `mcp_` tool name prefixing, and system prompt sanitization.

## Requirements

- [OpenCode](https://opencode.ai) v1.2+
- For OAuth: [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`claude login`)
- macOS (Keychain) or Linux (`~/.claude/.credentials.json` fallback)
- For API key: just configure a `provider` with `apiKey` in your OpenCode config as usual

## Environment overrides

| Variable | Default |
|----------|---------|
| `ANTHROPIC_CLIENT_ID` | `9d1c250a-...` (Anthropic's public OAuth client) |
| `ANTHROPIC_TOKEN_URL` | `https://console.anthropic.com/v1/oauth/token` |
| `ANTHROPIC_AUTHORIZE_URL` | `https://claude.ai/oauth/authorize` |
| `ANTHROPIC_CLI_VERSION` | Auto-detected from `claude --version` |
| `ANTHROPIC_BETA_FLAGS` | Matches Claude Code 2.1.81 |

## Updating for new Claude CLI versions

When Claude Code updates, the required headers or body fields may change. To capture exactly what the latest Claude CLI sends:

```bash
./scripts/intercept-claude.sh claude-sonnet-4-6
```

This starts a local proxy, runs Claude CLI through it with OAuth, and saves the full request headers and body to `/tmp/claude-intercept-*`. Compare against the plugin's constants and fetch wrapper to spot differences.

Key things that have changed across versions:
- `anthropic-beta` flags (required set changes)
- Body fields (`thinking`, `metadata`, `context_management`)
- `user-agent` version string
- `x-stainless-package-version`

## Credits

Combines approaches from [shahidshabbir-se/opencode-anthropic-oauth](https://github.com/shahidshabbir-se/opencode-anthropic-oauth), [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth), [vinzabe/PERMANENT-opencode-anthropic-oauth-fix](https://github.com/vinzabe/PERMANENT-opencode-anthropic-oauth-fix), and [lehdqlsl/opencode-claude-auth-sync](https://github.com/lehdqlsl/opencode-claude-auth-sync).

## License

MIT
