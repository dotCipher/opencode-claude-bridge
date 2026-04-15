/**
 * Claude Code tool definitions — exact wire-captured schemas.
 *
 * This module provides:
 *   1. The exact tool definitions Claude Code sends to the API (24 core tools)
 *   2. Bidirectional parameter-name translation maps (snake_case ↔ camelCase)
 *   3. A helper to build the full sorted tool array matching Claude Code's wire format
 *
 * The tool definitions were captured from Claude Code 2.1.98 via mitmproxy and
 * represent the exact JSON the API receives. Only descriptions/schemas from the
 * wire capture are used — no inference or fabrication.
 */

import { createHash } from "node:crypto";
import { CLI_VERSION } from "./constants.js";

// ── Types ──────────────────────────────────────────────────────────

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

// ── Fingerprint ────────────────────────────────────────────────────

const FINGERPRINT_SALT = "59cf53e54c78";

/**
 * Compute the 3-char hex fingerprint that goes into cc_version.
 * Algorithm: SHA256(SALT + msg[4] + msg[7] + msg[20] + version).slice(0,3)
 */
export function computeFingerprint(
  firstUserMessageText: string,
  version: string = CLI_VERSION,
): string {
  const indices = [4, 7, 20];
  const chars = indices.map((i) => firstUserMessageText[i] || "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${version}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

/**
 * Extract the text of the first user message from the messages array
 * in the API request body (Anthropic wire format).
 */
export function extractFirstUserMessageText(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "";
  if (typeof first.content === "string") return first.content;
  if (Array.isArray(first.content)) {
    const text = first.content.find(
      (b: { type?: string }) => b.type === "text",
    );
    if (text && typeof (text as { text?: string }).text === "string") {
      return (text as { text: string }).text;
    }
  }
  return "";
}

// ── Parameter Translation ──────────────────────────────────────────

/**
 * Per-tool maps from OpenCode camelCase → Claude Code snake_case.
 * Used for outbound tool_use argument translation (API response → OpenCode
 * needs to process the tool call using its own param names).
 *
 * Actually, the flow is:
 *   Outbound (request to API): OpenCode sends camelCase tool_use results,
 *     but the model will generate tool_use calls using Claude's snake_case names.
 *   Inbound (response from API): Model returns tool_use with snake_case args,
 *     which we translate to camelCase for OpenCode to execute.
 */
export const PARAM_SNAKE_TO_CAMEL: Record<string, Record<string, string>> = {
  Edit: {
    file_path: "filePath",
    old_string: "oldString",
    new_string: "newString",
    replace_all: "replaceAll",
  },
  Read: {
    file_path: "filePath",
  },
  Write: {
    file_path: "filePath",
    content: "content", // same name, but include for completeness
  },
  // Grep: Claude has many more params but OpenCode only understands pattern/path/include
  // We map the ones that overlap
  Grep: {
    // pattern → pattern (same)
    // path → path (same)
    // glob → include (Claude uses "glob", OpenCode uses "include")
    glob: "include",
  },
  // Agent: Claude has model/run_in_background/isolation that OpenCode doesn't have.
  // OpenCode has task_id/command that Claude doesn't have.
  Agent: {
    // All shared params have same names, no renaming needed
  },
  // WebFetch: Claude uses "prompt", OpenCode uses "format".
  // We strip "prompt" inbound and inject a default "format" so OpenCode's
  // webfetch tool receives a valid payload. Outbound does the reverse:
  // synthesizes a "prompt" from "format" so Claude's schema is satisfied.
  WebFetch: {
    // Handled specially in translateToolArgsJsonString / translateArgsOpencodeToClaude
  },
  TodoWrite: {
    // Item shape differs — handled specially (activeForm → priority per item)
  },
  Skill: {
    skill: "name", // Claude sends "skill" (the name), OpenCode expects "name"
  },
};

export const PARAM_CAMEL_TO_SNAKE: Record<string, Record<string, string>> = {
  Edit: {
    filePath: "file_path",
    oldString: "old_string",
    newString: "new_string",
    replaceAll: "replace_all",
  },
  Read: {
    filePath: "file_path",
  },
  Write: {
    filePath: "file_path",
  },
  Grep: {
    include: "glob",
  },
  Skill: {
    name: "skill",
  },
};

/**
 * Single source of truth for Claude ↔ OpenCode subagent_type mappings.
 *
 * Inbound (Claude → OpenCode) and outbound (OpenCode → Claude) are kept
 * explicit rather than derived because they're not perfect inverses:
 * both OpenCode "build" and "general" map to Claude "general-purpose".
 */
export const AGENT_TYPE_CLAUDE_TO_OPENCODE: Record<string, string> = {
  "general-purpose": "general",
  "statusline-setup": "build",
  "Explore": "explore",
  "Plan": "plan",
};

export const AGENT_TYPE_OPENCODE_TO_CLAUDE: Record<string, string> = {
  build: "general-purpose",
  general: "general-purpose",
  explore: "Explore",
  plan: "Plan",
};

/**
 * Fields to strip from Claude's schema that OpenCode's tool doesn't accept.
 * Keyed by Claude tool name. These are fields present in Claude's wire
 * schema but not in OpenCode's Zod schema — Zod in non-strict mode would
 * silently drop them, but we drop them explicitly so behavior is
 * independent of OpenCode's validation mode.
 */
const INBOUND_FIELDS_TO_STRIP: Record<string, string[]> = {
  Agent: ["model", "run_in_background", "isolation"],
  Bash: ["run_in_background", "dangerouslyDisableSandbox"],
  Read: ["pages"],
  Grep: ["output_mode", "-B", "-A", "-C", "context", "-n", "-i", "type", "head_limit", "offset", "multiline"],
  Skill: ["args"],
  WebFetch: ["prompt"], // stripped because we inject "format" instead
};

/**
 * Translate tool argument JSON from Claude's schema to OpenCode's schema.
 * Used by the SSE stream processor after all partial_json fragments for a
 * tool_use block have been buffered.
 *
 * Parses the JSON and walks the object — do NOT regex-substitute on the
 * raw string, because a key name can legitimately appear inside a value
 * (e.g. a TodoWrite item whose content literally says 'activeForm',
 * or a Bash command with "file_path=..." inside a heredoc).
 */
export function translateToolArgsJsonString(json: string, toolName: string): string {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    // Malformed — pass through rather than corrupt. The downstream
    // consumer will surface the parse error with a clearer message.
    return json;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return json;
  }
  const record = obj as Record<string, unknown>;

  // 1. Top-level key renames from PARAM_SNAKE_TO_CAMEL (Read, Write, Edit,
  //    Grep, Skill).
  const keyMap = PARAM_SNAKE_TO_CAMEL[toolName];
  let out: Record<string, unknown> = record;
  if (keyMap && Object.keys(keyMap).length > 0) {
    out = {};
    for (const [k, v] of Object.entries(record)) {
      out[keyMap[k] || k] = v;
    }
  }

  // 2. Strip Claude-only fields OpenCode doesn't accept.
  const stripFields = INBOUND_FIELDS_TO_STRIP[toolName];
  if (stripFields) {
    for (const field of stripFields) delete out[field];
  }

  // 3. Tool-specific deeper translations.
  if (toolName === "TodoWrite" && Array.isArray(out.todos)) {
    // Claude: { content, status, activeForm }. OpenCode: { content, status, priority }.
    // OpenCode's priority is typed as z.string() so the activeForm text works fine.
    for (const item of out.todos as Array<Record<string, unknown>>) {
      if (item && typeof item === "object" && "activeForm" in item) {
        item.priority = item.activeForm;
        delete item.activeForm;
      }
    }
  }
  if (toolName === "Agent" && typeof out.subagent_type === "string") {
    const mapped = AGENT_TYPE_CLAUDE_TO_OPENCODE[out.subagent_type];
    if (mapped) out.subagent_type = mapped;
  }
  if (toolName === "AskUserQuestion" && Array.isArray(out.questions)) {
    // Claude uses "multiSelect", OpenCode's question tool uses "multiple".
    for (const item of out.questions as Array<Record<string, unknown>>) {
      if (item && typeof item === "object" && "multiSelect" in item) {
        item.multiple = item.multiSelect;
        delete item.multiSelect;
      }
    }
  }
  if (toolName === "WebFetch") {
    // OpenCode's webfetch takes a `format` field (markdown/text/html).
    // Default it to markdown if Claude didn't send one (it never does,
    // since Claude's WebFetch has no equivalent field).
    if (typeof out.format !== "string") {
      out.format = "markdown";
    }
  }
  if (toolName === "Agent" && typeof out.subagent_type !== "string") {
    // OpenCode's task tool requires subagent_type. Default to "general"
    // (the closest equivalent to Claude's default "general-purpose").
    out.subagent_type = "general";
  }

  return JSON.stringify(out);
}

/**
 * Translate tool_use arguments from OpenCode's schema to Claude's schema.
 * Used on the outbound path (message history being sent back to the API).
 *
 * This is the counterpart to translateToolArgsJsonString — they must stay
 * in lockstep so round-trips preserve meaning.
 */
export function translateArgsOpencodeToClaude(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  // 1. Top-level key renames (camelCase → snake_case)
  const map = PARAM_CAMEL_TO_SNAKE[toolName];
  let out: Record<string, unknown> = args;
  if (map && Object.keys(map).length > 0) {
    out = {};
    for (const [k, v] of Object.entries(args)) {
      out[map[k] || k] = v;
    }
  }

  // 2. Agent: translate OpenCode subagent_type values → Claude values;
  //    strip OpenCode-only fields that aren't in Claude's schema.
  if (toolName === "Agent") {
    if (typeof out.subagent_type === "string") {
      const mapped = AGENT_TYPE_OPENCODE_TO_CLAUDE[out.subagent_type];
      if (mapped) out.subagent_type = mapped;
    }
    delete out.task_id;
    delete out.command;
  }

  // 3. TodoWrite: OpenCode { priority, status∈{…,cancelled} } → Claude
  //    { activeForm, status∈{pending,in_progress,completed} }.
  if (toolName === "TodoWrite" && Array.isArray(out.todos)) {
    for (const item of out.todos as Array<Record<string, unknown>>) {
      if (item.priority && !item.activeForm) {
        item.activeForm = item.priority;
        delete item.priority;
      }
      if (item.status === "cancelled") {
        item.status = "completed";
      }
    }
  }

  // 4. AskUserQuestion: OpenCode uses "multiple", Claude uses "multiSelect".
  if (toolName === "AskUserQuestion" && Array.isArray(out.questions)) {
    for (const item of out.questions as Array<Record<string, unknown>>) {
      if (typeof item.multiple === "boolean" && item.multiSelect === undefined) {
        item.multiSelect = item.multiple;
        delete item.multiple;
      }
    }
  }

  // 5. WebFetch: OpenCode uses "format", Claude uses a freeform "prompt".
  //    Best-effort bridge: synthesize a prompt from the requested format.
  if (toolName === "WebFetch") {
    if (typeof out.format === "string" && out.prompt === undefined) {
      const format = out.format;
      out.prompt = format === "text"
        ? "Fetch this URL and return the content as plain text."
        : format === "html"
        ? "Fetch this URL and return the raw HTML."
        : "Fetch this URL and return the content as markdown.";
      delete out.format;
    }
    delete out.timeout; // OpenCode-only
  }

  return out;
}

// ── Claude Code Tool Definitions (wire-captured) ───────────────────

/**
 * The 10 shared tools that exist in both Claude Code and OpenCode,
 * using Claude Code's exact wire definitions.
 */
const SHARED_TOOLS: ToolDefinition[] = [
  {
    name: "Agent",
    description: "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.\n\nAvailable agent types and the tools they have access to:\n- general-purpose: General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you. (Tools: *)\n- statusline-setup: Use this agent to configure the user's Claude Code status line setting. (Tools: Read, Edit)\n- Explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions. (Tools: All tools except Agent, ExitPlanMode, Edit, Write, NotebookEdit)\n- Plan: Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs. (Tools: All tools except Agent, ExitPlanMode, Edit, Write, NotebookEdit)\n\nWhen using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.\n\n## When not to use\n\nIf the target is already known, use the direct tool: Read for a known path, the Grep tool for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.\n\n## Usage notes\n\n- Always include a short description summarizing what the agent will do\n- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses\n- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.\n- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will be automatically notified when it completes \u2014 do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.\n- **Foreground vs background**: Use foreground (default) when you need the agent's results before you can proceed \u2014 e.g., research agents whose findings inform your next steps. Use background when you have genuinely independent work to do in parallel.\n- To continue a previously spawned agent, use SendMessage with the agent's ID or name as the `to` field \u2014 that resumes it with full context. A new Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.\n- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent\n- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first.\n- If the user specifies that they want you to run agents \"in parallel\", you MUST send a single message with multiple Agent tool use content blocks. For example, if you need to launch both a build-validator agent and a test-runner agent in parallel, send a single message with both tool calls.\n- With `isolation: \"worktree\"`, the worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.\n\n## Writing the prompt\n\nBrief the agent like a smart colleague who just walked into the room \u2014 it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.\n- Explain what you're trying to accomplish and why.\n- Describe what you've already learned or ruled out.\n- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.\n- If you need a short response, say so (\"report in under 200 words\").\n- Lookups: hand over the exact command. Investigations: hand over the question \u2014 prescribed steps become dead weight when the premise is wrong.\n\nTerse command-style prompts produce shallow, generic work.\n\n**Never delegate understanding.** Don't write \"based on your findings, fix the bug\" or \"based on the research, implement it.\" Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.\n\nExample usage:\n\n<example>\nuser: \"What's left on this branch before we can ship?\"\nassistant: <thinking>A survey question across git state, tests, and config. I'll delegate it and ask for a short report so the raw command output stays out of my context.</thinking>\nAgent({\n  description: \"Branch ship-readiness audit\",\n  prompt: \"Audit what's left before this branch can ship. Check: uncommitted changes, commits ahead of main, whether tests exist, whether the GrowthBook gate is wired up, whether CI-relevant files changed. Report a punch list \u2014 done vs. missing. Under 200 words.\"\n})\n<commentary>\nThe prompt is self-contained: it states the goal, lists what to check, and caps the response length. The agent's report comes back as the tool result; relay the findings to the user.\n</commentary>\n</example>\n\n<example>\nuser: \"Can you get a second opinion on whether this migration is safe?\"\nassistant: <thinking>I'll ask the code-reviewer agent \u2014 it won't see my analysis, so it can give an independent read.</thinking>\nAgent({\n  description: \"Independent migration review\",\n  subagent_type: \"code-reviewer\",\n  prompt: \"Review migration 0042_user_schema.sql for safety. Context: we're adding a NOT NULL column to a 50M-row table. Existing rows get a backfill default. I want a second opinion on whether the backfill approach is safe under concurrent writes \u2014 I've checked locking behavior but want independent verification. Report: is this safe, and if not, what specifically breaks?\"\n})\n<commentary>\nThe agent starts with no context from this conversation, so the prompt briefs it: what to assess, the relevant background, and what form the answer should take.\n</commentary>\n</example>\n",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        description: {
          description: "A short (3-5 word) description of the task",
          type: "string",
        },
        prompt: {
          description: "The task for the agent to perform",
          type: "string",
        },
        subagent_type: {
          description: "The type of specialized agent to use for this task",
          type: "string",
        },
        model: {
          description: "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent.",
          type: "string",
          enum: ["sonnet", "opus", "haiku"],
        },
        run_in_background: {
          description: "Set to true to run this agent in the background. You will be notified when it completes.",
          type: "boolean",
        },
        isolation: {
          description: "Isolation mode. \"worktree\" creates a temporary git worktree so the agent works on an isolated copy of the repo.",
          type: "string",
          enum: ["worktree"],
        },
      },
      required: ["description", "prompt", "subagent_type"],
      additionalProperties: false,
    },
  },
  {
    name: "Bash",
    description: "Executes a given bash command and returns its output.\n\nThe working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).\n\nIMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:\n\n - File search: Use Glob (NOT find or ls)\n - Content search: Use Grep (NOT grep or rg)\n - Read files: Use Read (NOT cat/head/tail)\n - Edit files: Use Edit (NOT sed/awk)\n - Write files: Use Write (NOT echo >/cat <<EOF)\n - Communication: Output text directly (NOT echo/printf)\nWhile the Bash tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.\n\n# Instructions\n - If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.\n - Always quote file paths that contain spaces with double quotes in your command (e.g., cd \"path with spaces/file.txt\")\n - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.\n - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms (2 minutes).\n - You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.\n - When issuing multiple commands:\n  - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. Example: if you need to run \"git status\" and \"git diff\", send a single message with two Bash tool calls in parallel.\n  - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.\n  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.\n  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).\n - For git commands:\n  - Prefer to create a new commit rather than amending an existing commit.\n  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.\n  - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.\n - Avoid unnecessary `sleep` commands:\n  - Do not sleep between commands that can run immediately \u2014 just run them.\n  - Use the Monitor tool to stream events from a background process (each stdout line is a notification). For one-shot \"wait until done,\" use Bash with run_in_background instead.\n  - If your command is long running and you would like to be notified when it finishes \u2014 use `run_in_background`. No sleep needed.\n  - Do not retry failing commands in a sleep loop \u2014 diagnose the root cause.\n  - If waiting for a background task you started with `run_in_background`, you will be notified when it completes \u2014 do not poll.\n  - `sleep N` as the first command with N \u2265 2 is blocked. If you need a delay (rate limiting, deliberate pacing), keep it under 2 seconds.\n\n\n# Committing changes with git\n\nOnly create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:\n\nYou can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. The numbered steps below indicate which commands should be batched in parallel.\n\nGit Safety Protocol:\n- NEVER update the git config\n- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions. Taking unauthorized destructive actions is unhelpful and can result in lost work, so it's best to ONLY run these commands when given direct instructions \n- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it\n- NEVER run force push to main/master, warn the user if they request it\n- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen \u2014 so --amend would modify the PREVIOUS commit, which may result in destroying work or losing previous changes. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit\n- When staging files, prefer adding specific files by name rather than using \"git add -A\" or \"git add .\", which can accidentally include sensitive files (.env, credentials) or large binaries\n- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive\n\n1. Run the following bash commands in parallel, each using the Bash tool:\n  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.\n  - Run a git diff command to see both staged and unstaged changes that will be committed.\n  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.\n2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:\n  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. \"add\" means a wholly new feature, \"update\" means an enhancement to an existing feature, \"fix\" means a bug fix, etc.).\n  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files\n  - Draft a concise (1-2 sentences) commit message that focuses on the \"why\" rather than the \"what\"\n  - Ensure it accurately reflects the changes and their purpose\n3. Run the following commands in parallel:\n   - Add relevant untracked files to the staging area.\n   - Create the commit with a message.\n   - Run git status after the commit completes to verify success.\n   Note: git status depends on the commit completing, so run it sequentially after the commit.\n4. If the commit fails due to pre-commit hook: fix the issue and create a NEW commit\n\nImportant notes:\n- NEVER run additional commands to read or explore code, besides git bash commands\n- NEVER use the TodoWrite or Agent tools\n- DO NOT push to the remote repository unless the user explicitly asks you to do so\n- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.\n- IMPORTANT: Do not use --no-edit with git rebase commands, as the --no-edit flag is not a valid option for git rebase.\n- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit\n- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:\n<example>\ngit commit -m \"$(cat <<'EOF'\n   Commit message here.\n   EOF\n   )\"\n</example>\n\n# Creating pull requests\nUse the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.\n\nIMPORTANT: When the user asks you to create a pull request, follow these steps carefully:\n\n1. Run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:\n   - Run a git status command to see all untracked files (never use -uall flag)\n   - Run a git diff command to see both staged and unstaged changes that will be committed\n   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote\n   - Run a git log command and `git diff [base-branch]...HEAD` to understand the full commit history for the current branch (from the time it diverged from the base branch)\n2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request title and summary:\n   - Keep the PR title short (under 70 characters)\n   - Use the description/body for details, not the title\n3. Run the following commands in parallel:\n   - Create new branch if needed\n   - Push to remote with -u flag if needed\n   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.\n<example>\ngh pr create --title \"the pr title\" --body \"$(cat <<'EOF'\n## Summary\n<1-3 bullet points>\n\n## Test plan\n[Bulleted markdown checklist of TODOs for testing the pull request...]\nEOF\n)\"\n</example>\n\nImportant:\n- DO NOT use the TodoWrite or Agent tools\n- Return the PR URL when you're done, so the user can see it\n\n# Other common operations\n- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        command: {
          description: "The command to execute",
          type: "string",
        },
        timeout: {
          description: "Optional timeout in milliseconds (max 600000)",
          type: "number",
        },
        description: {
          description: "Clear, concise description of what this command does in active voice. Never use words like \"complex\" or \"risk\" in the description - just describe what it does.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls \u2192 \"List files in current directory\"\n- git status \u2192 \"Show working tree status\"\n- npm install \u2192 \"Install package dependencies\"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n- find . -name \"*.tmp\" -exec rm {} \\; \u2192 \"Find and delete all .tmp files recursively\"\n- git reset --hard origin/main \u2192 \"Discard all local changes and match remote main\"\n- curl -s url | jq '.data[]' \u2192 \"Fetch JSON from URL and extract data array elements\"",
          type: "string",
        },
        run_in_background: {
          description: "Set to true to run this command in the background. Use Read to read the output later.",
          type: "boolean",
        },
        dangerouslyDisableSandbox: {
          description: "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
          type: "boolean",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "Edit",
    description: "Performs exact string replacements in files.\n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.\n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.\n- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        file_path: {
          description: "The absolute path to the file to modify",
          type: "string",
        },
        old_string: {
          description: "The text to replace",
          type: "string",
        },
        new_string: {
          description: "The text to replace it with (must be different from old_string)",
          type: "string",
        },
        replace_all: {
          description: "Replace all occurrences of old_string (default false)",
          default: false,
          type: "boolean",
        },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "Glob",
    description: "- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        pattern: {
          description: "The glob pattern to match files against",
          type: "string",
        },
        path: {
          description: "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided.",
          type: "string",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "Grep",
    description: "A powerful search tool built on ripgrep\n\n  Usage:\n  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.\n  - Supports full regex syntax (e.g., \"log.*Error\", \"function\\s+\\w+\")\n  - Filter files with glob parameter (e.g., \"*.js\", \"**/*.tsx\") or type parameter (e.g., \"js\", \"py\", \"rust\")\n  - Output modes: \"content\" shows matching lines, \"files_with_matches\" shows only file paths (default), \"count\" shows match counts\n  - Use Agent tool for open-ended searches requiring multiple rounds\n  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use `interface\\{\\}` to find `interface{}` in Go code)\n  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like `struct \\{[\\s\\S]*?field`, use `multiline: true`\n",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        pattern: {
          description: "The regular expression pattern to search for in file contents",
          type: "string",
        },
        path: {
          description: "File or directory to search in (rg PATH). Defaults to current working directory.",
          type: "string",
        },
        glob: {
          description: "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob",
          type: "string",
        },
        output_mode: {
          description: "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\".",
          type: "string",
          enum: ["content", "files_with_matches", "count"],
        },
        "-B": {
          description: "Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise.",
          type: "number",
        },
        "-A": {
          description: "Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise.",
          type: "number",
        },
        "-C": {
          description: "Alias for context.",
          type: "number",
        },
        context: {
          description: "Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise.",
          type: "number",
        },
        "-n": {
          description: "Show line numbers in output (rg -n). Requires output_mode: \"content\", ignored otherwise. Defaults to true.",
          type: "boolean",
        },
        "-i": {
          description: "Case insensitive search (rg -i)",
          type: "boolean",
        },
        type: {
          description: "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
          type: "string",
        },
        head_limit: {
          description: "Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly \u2014 large result sets waste context).",
          type: "number",
        },
        offset: {
          description: "Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0.",
          type: "number",
        },
        multiline: {
          description: "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
          type: "boolean",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "Read",
    description: "Reads a file from the local filesystem. You can access any file directly by using this tool.\nAssume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- The file_path parameter must be an absolute path, not a relative path\n- By default, it reads up to 2000 lines starting from the beginning of the file\n- When you already know which part of the file you need, only read that part. This can be important for larger files.\n- Results are returned using cat -n format, with line numbers starting at 1\n- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.\n- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: \"1-5\"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.\n- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.\n- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.\n- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.\n- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        file_path: {
          description: "The absolute path to the file to read",
          type: "string",
        },
        offset: {
          description: "The line number to start reading from. Only provide if the file is too large to read at once",
          type: "integer",
          minimum: 0,
          maximum: 9007199254740991,
        },
        limit: {
          description: "The number of lines to read. Only provide if the file is too large to read at once.",
          type: "integer",
          exclusiveMinimum: 0,
          maximum: 9007199254740991,
        },
        pages: {
          description: "Page range for PDF files (e.g., \"1-5\", \"3\", \"10-20\"). Only applicable to PDF files. Maximum 20 pages per request.",
          type: "string",
        },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  {
    name: "Skill",
    description: "Execute a skill within the main conversation\n\nWhen users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.\n\nWhen users reference a \"slash command\" or \"/<something>\" (e.g., \"/commit\", \"/review-pr\"), they are referring to a skill. Use this tool to invoke it.\n\nHow to invoke:\n- Use this tool with the skill name and optional arguments\n- Examples:\n  - `skill: \"pdf\"` - invoke the pdf skill\n  - `skill: \"commit\", args: \"-m 'Fix bug'\"` - invoke with arguments\n  - `skill: \"review-pr\", args: \"123\"` - invoke with arguments\n  - `skill: \"ms-office-suite:pdf\"` - invoke using fully qualified name\n\nImportant:\n- Available skills are listed in system-reminder messages in the conversation\n- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task\n- NEVER mention a skill without actually calling this tool\n- Do not invoke a skill that is already running\n- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)\n- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again\n",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        skill: {
          description: "The skill name. E.g., \"commit\", \"review-pr\", or \"pdf\"",
          type: "string",
        },
        args: {
          description: "Optional arguments for the skill",
          type: "string",
        },
      },
      required: ["skill"],
      additionalProperties: false,
    },
  },
  {
    name: "TodoWrite",
    description: "Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.\nIt also helps the user understand the progress of the task and overall progress of their requests.\n\n## When to Use This Tool\nUse this tool proactively in these scenarios:\n\n1. Complex multi-step tasks - When a task requires 3 or more distinct steps or actions\n2. Non-trivial and complex tasks - Tasks that require careful planning or multiple operations\n3. User explicitly requests todo list - When the user directly asks you to use the todo list\n4. User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)\n5. After receiving new instructions - Immediately capture user requirements as todos\n6. When you start working on a task - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time\n7. After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation\n\n## When NOT to Use This Tool\n\nSkip using this tool when:\n1. There is only a single, straightforward task\n2. The task is trivial and tracking it provides no organizational benefit\n3. The task can be completed in less than 3 trivial steps\n4. The task is purely conversational or informational\n\nNOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.\n\n## Task States and Management\n\n1. **Task States**: Use these states to track progress:\n   - pending: Task not yet started\n   - in_progress: Currently working on (limit to ONE task at a time)\n   - completed: Task finished successfully\n\n   **IMPORTANT**: Task descriptions must have two forms:\n   - content: The imperative form describing what needs to be done (e.g., \"Run tests\", \"Build the project\")\n   - activeForm: The present continuous form shown during execution (e.g., \"Running tests\", \"Building the project\")\n\n2. **Task Management**:\n   - Update task status in real-time as you work\n   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)\n   - Exactly ONE task must be in_progress at any time (not less, not more)\n   - Complete current tasks before starting new ones\n   - Remove tasks that are no longer relevant from the list entirely\n\n3. **Task Completion Requirements**:\n   - ONLY mark a task as completed when you have FULLY accomplished it\n   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress\n   - When blocked, create a new task describing what needs to be resolved\n   - Never mark a task as completed if:\n     - Tests are failing\n     - Implementation is partial\n     - You encountered unresolved errors\n     - You couldn't find necessary files or dependencies\n\n4. **Task Breakdown**:\n   - Create specific, actionable items\n   - Break complex tasks into smaller, manageable steps\n   - Use clear, descriptive task names\n   - Always provide both forms:\n     - content: \"Fix authentication bug\"\n     - activeForm: \"Fixing authentication bug\"\n\nWhen in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.\n",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        todos: {
          description: "The updated todo list",
          type: "array",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                minLength: 1,
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
              activeForm: {
                type: "string",
                minLength: 1,
              },
            },
            required: ["content", "status", "activeForm"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
  },
  {
    name: "WebFetch",
    description: "IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.\n\n- Fetches content from a specified URL and processes it using an AI model\n- Takes a URL and a prompt as input\n- Fetches the URL content, converts HTML to markdown\n- Processes the content with the prompt using a small, fast model\n- Returns the model's response about the content\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.\n  - The URL must be a fully-formed valid URL\n  - HTTP URLs will be automatically upgraded to HTTPS\n  - The prompt should describe what information you want to extract from the page\n  - This tool is read-only and does not modify any files\n  - Results may be summarized if the content is very large\n  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL\n  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.\n  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).\n",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        url: {
          description: "The URL to fetch content from",
          type: "string",
          format: "uri",
        },
        prompt: {
          description: "The prompt to run on the fetched content",
          type: "string",
        },
      },
      required: ["url", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "Write",
    description: "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- Prefer the Edit tool for modifying existing files \u2014 it only sends the diff. Only use this tool to create new files or for complete rewrites.\n- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        file_path: {
          description: "The absolute path to the file to write (must be absolute, not relative)",
          type: "string",
        },
        content: {
          description: "The content to write to the file",
          type: "string",
        },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
];

/**
 * The 14 Claude-only tools that OpenCode doesn't have.
 * These are sent as stubs — the model may try to call them, but they'll
 * never actually execute (handled by returning a graceful error).
 */
const STUB_TOOLS: ToolDefinition[] = [
  {
    name: "AskUserQuestion",
    description: "Use this tool when you need to ask the user questions during execution. This allows you to:\n1. Gather user preferences or requirements\n2. Clarify ambiguous instructions\n3. Get decisions on implementation choices as you work\n4. Offer choices to the user about what direction to take.\n\nUsage notes:\n- Users will always be able to select \"Other\" to provide custom text input\n- Use multiSelect: true to allow multiple answers to be selected for a question\n- If you recommend a specific option, make that the first option in the list and add \"(Recommended)\" at the end of the label\n\nPlan mode note: In plan mode, use this tool to clarify requirements or choose between approaches BEFORE finalizing your plan. Do NOT use this tool to ask \"Is my plan ready?\" or \"Should I proceed?\" - use ExitPlanMode for plan approval. IMPORTANT: Do not reference \"the plan\" in your questions (e.g., \"Do you have feedback about the plan?\", \"Does the plan look good?\") because the user cannot see the plan in the UI until you call ExitPlanMode. If you need plan approval, use ExitPlanMode instead.\n",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        questions: {
          description: "Questions to ask the user (1-4 questions)",
          minItems: 1,
          maxItems: 4,
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { description: "The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: \"Which library should we use for date formatting?\" If multiSelect is true, phrase it accordingly, e.g. \"Which features do you want to enable?\"", type: "string" },
              header: { description: "Very short label displayed as a chip/tag (max 12 chars). Examples: \"Auth method\", \"Library\", \"Approach\".", type: "string" },
              options: {
                description: "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
                minItems: 2, maxItems: 4, type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { description: "The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.", type: "string" },
                    description: { description: "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.", type: "string" },
                    preview: { description: "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.", type: "string" },
                  },
                  required: ["label", "description"],
                  additionalProperties: false,
                },
              },
              multiSelect: { description: "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.", default: false, type: "boolean" },
            },
            required: ["question", "header", "options", "multiSelect"],
            additionalProperties: false,
          },
        },
        answers: { description: "User answers collected by the permission component", type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "string" } },
        annotations: { description: "Optional per-question annotations from the user (e.g., notes on preview selections). Keyed by question text.", type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "object", properties: { preview: { description: "The preview content of the selected option, if the question used previews.", type: "string" }, notes: { description: "Free-text notes the user added to their selection.", type: "string" } }, additionalProperties: false } },
        metadata: { description: "Optional metadata for tracking and analytics purposes. Not displayed to user.", type: "object", properties: { source: { description: "Optional identifier for the source of this question (e.g., \"remember\" for /remember command). Used for analytics tracking.", type: "string" } }, additionalProperties: false },
      },
      required: ["questions"],
      additionalProperties: false,
    },
  },
  {
    name: "CronCreate",
    description: "Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.\n\nUses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. \"0 9 * * *\" means 9am local \u2014 no timezone conversion needed.\n\nReturns a job ID you can pass to CronDelete.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        cron: { description: "Standard 5-field cron expression in local time.", type: "string" },
        prompt: { description: "The prompt to enqueue at each fire time.", type: "string" },
        recurring: { description: "true (default) = fire on every cron match. false = fire once then auto-delete.", type: "boolean" },
        durable: { description: "true = persist to disk and survive restarts. false (default) = in-memory only.", type: "boolean" },
      },
      required: ["cron", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "CronDelete",
    description: "Cancel a cron job previously scheduled with CronCreate. Removes it from the in-memory session store.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        id: { description: "Job ID returned by CronCreate.", type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "CronList",
    description: "List all cron jobs scheduled via CronCreate in this session.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "EnterPlanMode",
    description: "Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "EnterWorktree",
    description: "Use this tool ONLY when the user explicitly asks to work in a worktree. This tool creates an isolated git worktree and switches the current session into it.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        name: { description: "Optional name for the worktree.", type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ExitPlanMode",
    description: "Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        allowedPrompts: {
          description: "Prompt-based permissions needed to implement the plan.",
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { description: "The tool this prompt applies to", type: "string", enum: ["Bash"] },
              prompt: { description: "Semantic description of the action", type: "string" },
            },
            required: ["tool", "prompt"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: {},
    },
  },
  {
    name: "ExitWorktree",
    description: "Exit a worktree session created by EnterWorktree and return the session to the original working directory.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        action: { description: "\"keep\" leaves the worktree and branch on disk; \"remove\" deletes both.", type: "string", enum: ["keep", "remove"] },
        discard_changes: { description: "Required true when action is \"remove\" and the worktree has uncommitted files or unmerged commits.", type: "boolean" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "Monitor",
    description: "Start a background monitor that streams events from a long-running script. Each stdout line is an event \u2014 you keep working and notifications arrive in the chat.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        description: { description: "Short human-readable description of what you are monitoring.", type: "string" },
        timeout_ms: { description: "Kill the monitor after this deadline. Default 300000ms, max 3600000ms.", default: 300000, type: "number", minimum: 1000 },
        persistent: { description: "Run for the lifetime of the session (no timeout).", default: false, type: "boolean" },
        command: { description: "Shell command or script. Each stdout line is an event; exit ends the watch.", type: "string" },
      },
      required: ["description", "timeout_ms", "persistent", "command"],
      additionalProperties: false,
    },
  },
  {
    name: "NotebookEdit",
    description: "Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        notebook_path: { description: "The absolute path to the Jupyter notebook file to edit", type: "string" },
        cell_id: { description: "The ID of the cell to edit.", type: "string" },
        new_source: { description: "The new source for the cell", type: "string" },
        cell_type: { description: "The type of the cell (code or markdown).", type: "string", enum: ["code", "markdown"] },
        edit_mode: { description: "The type of edit to make (replace, insert, delete). Defaults to replace.", type: "string", enum: ["replace", "insert", "delete"] },
      },
      required: ["notebook_path", "new_source"],
      additionalProperties: false,
    },
  },
  {
    name: "RemoteTrigger",
    description: "Call the claude.ai remote-trigger API. Use this instead of curl \u2014 the OAuth token is added automatically in-process and never exposed.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "run"] },
        trigger_id: { description: "Required for get, update, and run", type: "string", pattern: "^[\\w-]+$" },
        body: { description: "JSON body for create and update", type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "TaskOutput",
    description: "DEPRECATED: Prefer using the Read tool on the task's output file path instead. Retrieves output from a running or completed task.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        task_id: { description: "The task ID to get output from", type: "string" },
        block: { description: "Whether to wait for completion", default: true, type: "boolean" },
        timeout: { description: "Max wait time in ms", default: 30000, type: "number", minimum: 0, maximum: 600000 },
      },
      required: ["task_id", "block", "timeout"],
      additionalProperties: false,
    },
  },
  {
    name: "TaskStop",
    description: "Stops a running background task by its ID.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        task_id: { description: "The ID of the background task to stop", type: "string" },
        shell_id: { description: "Deprecated: use task_id instead", type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "WebSearch",
    description: "Allows Claude to search the web and use the results to inform responses. Provides up-to-date information for current events and recent data.",
    input_schema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        query: { description: "The search query to use", type: "string", minLength: 2 },
        allowed_domains: { description: "Only include search results from these domains", type: "array", items: { type: "string" } },
        blocked_domains: { description: "Never include search results from these domains", type: "array", items: { type: "string" } },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

// ── Public API ──────────────────────────────────────────────────────

/** All 24 Claude Code core tools, sorted alphabetically by name. */
export function getClaudeTools(): ToolDefinition[] {
  return [...SHARED_TOOLS, ...STUB_TOOLS].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/** Names of tools that only exist in Claude Code (stubs). */
export const STUB_TOOL_NAMES = new Set(STUB_TOOLS.map((t) => t.name));

/** Names of tools shared between Claude Code and OpenCode. */
export const SHARED_TOOL_NAMES = new Set(SHARED_TOOLS.map((t) => t.name));
