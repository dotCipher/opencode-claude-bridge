# opencode-claude-bridge

Use your Claude Pro/Max subscription in [OpenCode](https://opencode.ai). If you're logged into the Claude CLI, it just works — no extra setup.

## Install

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-claude-bridge"]
}
```

OpenCode auto-installs the plugin from npm on next launch.

If you're logged into the Claude CLI (`claude login`), the plugin auto-syncs your credentials — just select an Anthropic model and start chatting. If not, you'll be prompted to authenticate via browser OAuth or enter an API key.

**Upgrade:**

OpenCode pins the installed version. To upgrade to the latest:

```bash
cd ~/.cache/opencode && npm install opencode-claude-bridge@latest
```

Then restart OpenCode.

<details>
<summary>Install from source</summary>

```bash
git clone https://github.com/dotCipher/opencode-claude-bridge.git ~/opencode-claude-bridge
cd ~/opencode-claude-bridge && npm install && npm run build
```

Then reference the full path in your config:

```json
{
  "plugin": ["/Users/YOU/opencode-claude-bridge/dist/index.js"]
}
```
</details>

## How the bridge works

The plugin sits between OpenCode and the Anthropic API:

> **OpenCode** -> **opencode-claude-bridge** -> **Anthropic API**

### Authentication

Supports both OAuth and API key auth:

- **OAuth (Pro/Max)** — Auto-reads your Claude CLI's OAuth tokens from macOS Keychain (or `~/.claude/.credentials.json` on Linux). No browser flow needed. If Claude CLI isn't available, falls back to browser-based OAuth PKCE.
- **API key** — Works alongside a standard `provider` entry in your OpenCode config with an `apiKey`. The plugin only activates its OAuth handling for the built-in `anthropic` provider; custom API key providers pass through unchanged.
- **Token refresh** — When tokens expire, three layers are tried: re-read from Keychain, refresh via stored token, refresh via CLI's token.

### Wire-level request matching

Every outbound OAuth request is rewritten to match what Claude Code sends on the wire:

- **Headers** — `user-agent`, `anthropic-beta`, `anthropic-version`, `x-stainless-*`, `x-claude-code-version`, `x-claude-code-session-id`, and all billing metadata (`cc_version`, `cc_entrypoint`, `cch`).
- **Body fields** — `thinking` (with effort and `clear_thinking`), `context_management`, `output_config`, `metadata` (session ID, billing info), and `?beta=true` URL parameter.
- **System prompt** — Claude Code's real system prompt is captured via the validator and cached at `~/.cache/opencode-claude-bridge/claude-system-prompt.json`. The bridge injects this as the system prompt for all requests. OpenCode's default system prompt is sanitized out.
- **MCP tool prefixing** — OpenCode's MCP tools are prefixed with `mcp_` to match Claude Code's convention.

### Tool wire-matching (v1.9.0)

Claude Code sends 24 core tools (plus user-specific MCP tools). OpenCode has 10. These differ in names, descriptions, schemas, parameter names, required fields, and sort order.

The bridge resolves this by:

1. **Replacing all 10 OpenCode tool definitions** with Claude Code's exact wire-captured definitions — matching descriptions, JSON schemas, parameter names, and required fields.
2. **Adding 14 Claude-only stub tools**: `AskUserQuestion`, `CronCreate`, `CronDelete`, `CronList`, `EnterPlanMode`, `EnterWorktree`, `ExitPlanMode`, `ExitWorktree`, `Monitor`, `NotebookEdit`, `RemoteTrigger`, `TaskOutput`, `TaskStop`, `WebSearch`.
3. **Sorting all 24 tools alphabetically** to match Claude Code's ordering.

If the model calls a stub tool, OpenCode's built-in error handling catches it, tells the model the tool is unavailable, and the model adapts on the next turn.

### Bidirectional parameter translation

Claude Code and OpenCode use different parameter naming conventions. The bridge translates in both directions on the fly:

**Inbound (API response -> OpenCode)** — translated via regex on the SSE stream:

| Claude Code sends | OpenCode expects |
|---|---|
| `file_path` | `filePath` |
| `old_string` | `oldString` |
| `new_string` | `newString` |
| `replace_all` | `replaceAll` |
| `glob` (in Grep) | `include` |
| `activeForm` (in TodoWrite) | `priority` |

**Outbound (OpenCode -> API request)** — translated in historical `tool_use` message blocks:

| OpenCode sends | Bridge converts to |
|---|---|
| `filePath` | `file_path` |
| `oldString` | `old_string` |
| `newString` | `new_string` |
| `replaceAll` | `replace_all` |
| `include` (in Grep) | `glob` |
| `priority` (in TodoWrite) | `activeForm` |

Additional shared-tool bridging handled by the bridge:

- `Agent` / `task` — defaults missing `subagent_type` to `general`, strips unsupported Claude-only fields inbound, and strips OpenCode-only history fields outbound
- `AskUserQuestion` / `question` — maps `multiSelect` <-> `multiple`
- `Skill` — maps `skill` <-> `name`
- `WebFetch` — best-effort bridge between Claude's `prompt` and OpenCode's `format` by using `markdown` inbound and synthesizing a Claude prompt outbound

### Agent type translation

Claude Code uses different agent/subagent types than OpenCode:

| Claude Code | OpenCode |
|---|---|
| `general-purpose` | `general` |
| `Explore` | `explore` |
| `Plan` | `plan` |
| `statusline-setup` | `build` |

These are mapped in both directions — inbound responses and outbound historical messages.

### TodoWrite status mapping

Claude Code has 3 todo statuses; OpenCode has 4. The outbound direction maps `cancelled` -> `completed` since Claude Code doesn't have a cancelled state.

### Dynamic fingerprint computation

The `cc_version` billing metadata suffix (a 3-character hex string like `df0` or `e0a`) is computed dynamically per request using the same algorithm as Claude Code:

```
SHA256(salt + message[4] + message[7] + message[20] + CLI_VERSION).slice(0, 3)
```

The salt is hardcoded in Claude Code's source. This changes per conversation because the user's message text changes.

## Requirements

- [OpenCode](https://opencode.ai) v1.2+
- For OAuth: [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and logged in (`claude login`)
- macOS (Keychain) or Linux (`~/.claude/.credentials.json` fallback)
- For API key: just configure a `provider` with `apiKey` in your OpenCode config as usual

## Environment overrides

All OAuth and header parameters can be overridden via environment variables:

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_CLIENT_ID` | `9d1c250a-...` | OAuth client ID |
| `ANTHROPIC_TOKEN_URL` | `https://platform.claude.com/v1/oauth/token` | Token endpoint |
| `ANTHROPIC_AUTHORIZE_URL` | `https://claude.ai/oauth/authorize` | Authorization endpoint |
| `ANTHROPIC_CLI_VERSION` | Auto-detected from `claude --version` or `2.1.98` | Claude CLI version string |
| `ANTHROPIC_CLI_BUILD_ID` | `835` | Build ID for headers |
| `ANTHROPIC_ENTRYPOINT` | `sdk-cli` | Entrypoint value for billing |
| `ANTHROPIC_SDK_VERSION` | `0.81.0` | Stainless SDK version |
| `ANTHROPIC_BETA_FLAGS` | Current Claude Code beta flags | Comma-separated beta feature flags |
| `ANTHROPIC_BILLING_CCH` | (computed) | Client attestation hash override |
| `ANTHROPIC_SYSTEM_PROMPT_PATH` | `~/.cache/opencode-claude-bridge/claude-system-prompt.json` | Path to cached system prompt |
| `ANTHROPIC_DEFAULT_EFFORT` | `medium` | Thinking effort level |
| `ANTHROPIC_SESSION_ID` | (generated) | Override session ID |

Most users won't need to change these — the bridge auto-detects the installed Claude CLI version and uses matching defaults.

## Local validation

To validate how local OpenCode traffic is being classified and how closely it matches Claude Code on the wire:

```bash
npm run validate:oauth -- --model claude-sonnet-4-6 --prompt "Reply with exactly VALIDATE."
```

The validator will:

- Query the OAuth usage endpoint before and after each run
- Capture an official Claude Code request through a local proxy
- Capture an OpenCode request using this repo's local `dist/index.js`
- Write Claude Code's captured system prompt to `~/.cache/opencode-claude-bridge/claude-system-prompt.json`
- Save request and response artifacts under `tmp/validate-*`
- Write a `report.json` with request diffs, body hashes, and usage snapshots

After the first successful validator run, the bridge will automatically reuse that cached Claude Code system prompt. This is currently the key step that makes OpenCode traffic behave like standard Claude Code usage.

If OpenCode is being treated as an OAuth app / extra-usage flow, the report will usually show it in one of two ways:

- The OpenCode run fails with an extra-usage style API error
- The usage buckets diverge from the Claude Code run even when the headers look similar

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
- `x-claude-code-session-id`
- Billing header shape (`cc_version`, `cc_entrypoint`, `cch`)
- Tool definitions and parameter schemas

## Architecture

```
src/
  index.ts          — Main plugin entry point: tool replacement, request/response
                      transformation, bidirectional parameter translation (~886 lines)
  claude-tools.ts   — 24 Claude Code tool definitions, fingerprint computation,
                      parameter translation maps (~757 lines)
  constants.ts      — Version strings, URLs, env overrides, header values (117 lines)
  keychain.ts       — macOS Keychain access for OAuth tokens
  oauth.ts          — OAuth PKCE flow with local callback server

scripts/
  validate-opencode-oauth.js  — Side-by-side wire comparison tool
  intercept-claude.sh         — mitmproxy-based Claude CLI request capture
```

## Important limitation

Anthropic's own Claude Code docs say third-party integrations should use API key authentication. This bridge can make OAuth requests look much closer to current Claude Code traffic, but Anthropic may still apply server-side classification that a bridge cannot fully control.

## Credits

Combines approaches from [shahidshabbir-se/opencode-anthropic-oauth](https://github.com/shahidshabbir-se/opencode-anthropic-oauth), [ex-machina-co/opencode-anthropic-auth](https://github.com/ex-machina-co/opencode-anthropic-auth), [vinzabe/PERMANENT-opencode-anthropic-oauth-fix](https://github.com/vinzabe/PERMANENT-opencode-anthropic-oauth-fix), and [lehdqlsl/opencode-claude-auth-sync](https://github.com/lehdqlsl/opencode-claude-auth-sync).

## License

MIT
