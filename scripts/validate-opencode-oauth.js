#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const distPluginPath = join(repoRoot, "dist", "index.js");
const promptCachePath = join(homedir(), ".cache", "opencode-claude-bridge", "claude-system-prompt.json");

function parseArgs(argv) {
  const args = {
    model: "claude-sonnet-4-6",
    prompt: "Reply with exactly VALIDATE.",
    outDir: join(repoRoot, "tmp", `validate-${Date.now()}`),
    skipClaude: false,
    skipOpenCode: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model") args.model = argv[++i];
    else if (arg === "--prompt") args.prompt = argv[++i];
    else if (arg === "--out-dir") args.outDir = resolve(argv[++i]);
    else if (arg === "--skip-claude") args.skipClaude = true;
    else if (arg === "--skip-opencode") args.skipOpenCode = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/validate-opencode-oauth.js [options]

Options:
  --model <id>       Model to use (default: claude-sonnet-4-6)
  --prompt <text>    Prompt to send to both clients
  --out-dir <dir>    Directory for capture artifacts
  --skip-claude      Skip official Claude Code capture
  --skip-opencode    Skip OpenCode capture
`);
      process.exit(0);
    }
  }

  return args;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readClaudeCredentials() {
  if (process.platform === "darwin") {
    try {
      const raw = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      return JSON.parse(raw);
    } catch {}
  }

  try {
    return JSON.parse(readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

function getOAuthAccessToken() {
  const credentials = readClaudeCredentials();
  const token = credentials?.claudeAiOauth?.accessToken;
  if (!token) throw new Error("No Claude Code OAuth access token found. Run `claude login` first.");
  return token;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function fetchUsage(accessToken) {
  return fetchJson("https://api.anthropic.com/api/oauth/usage", {
    authorization: `Bearer ${accessToken}`,
    "user-agent": "claude-cli/2.1.98 (external, sdk-cli)",
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-dangerous-direct-browser-access": "true",
  });
}

async function safeFetchUsage(accessToken) {
  try {
    return await fetchUsage(accessToken);
  } catch (error) {
    return {
      _error: error instanceof Error ? error.message : String(error),
    };
  }
}

function redactHeaders(headers) {
  const copy = { ...headers };
  if (copy.authorization) {
    copy.authorization = `Bearer ...${String(copy.authorization).slice(-8)}`;
  }
  return copy;
}

function splitHeaderList(value) {
  if (typeof value !== "string") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function sortedDifference(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item)).sort();
}

async function startCaptureProxy(label, outDir) {
  let requestCount = 0;
  const captures = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyBuffer = Buffer.concat(chunks);
      requestCount += 1;
      const capture = {
        index: requestCount,
        label,
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: bodyBuffer.toString("utf8"),
      };
      captures.push(capture);

      writeFileSync(
        join(outDir, `${label}-${requestCount}-headers.json`),
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: redactHeaders(req.headers),
        }, null, 2),
      );
      writeFileSync(join(outDir, `${label}-${requestCount}-body.json`), capture.body);

      let upstreamPath = req.url || "/";
      if (upstreamPath !== "/" && !upstreamPath.startsWith("/v1/")) {
        upstreamPath = `/v1${upstreamPath.startsWith("/") ? "" : "/"}${upstreamPath}`;
      }

      const upstream = https.request({
        hostname: "api.anthropic.com",
        method: req.method,
        path: upstreamPath,
        headers: {
          ...req.headers,
          host: "api.anthropic.com",
        },
      }, (upstreamRes) => {
        const responseChunks = [];
        upstreamRes.on("data", (chunk) => responseChunks.push(chunk));
        upstreamRes.on("end", () => {
          const responseBody = Buffer.concat(responseChunks).toString("utf8");
          writeFileSync(
            join(outDir, `${label}-${requestCount}-response.json`),
            JSON.stringify({
              status: upstreamRes.statusCode,
              headers: redactHeaders(upstreamRes.headers),
              body: responseBody,
            }, null, 2),
          );
          res.writeHead(upstreamRes.statusCode || 500, upstreamRes.headers);
          res.end(Buffer.concat(responseChunks));
        });
      });

      upstream.on("error", (error) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      });

      upstream.write(bodyBuffer);
      upstream.end();
    });
  });

  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind proxy port");
  }

  return {
    port: address.port,
    close: () => new Promise((resolvePromise) => server.close(resolvePromise)),
    getCaptures: () => captures,
  };
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

async function captureClaudeCode({ model, prompt, outDir }) {
  const proxy = await startCaptureProxy("claude", outDir);
  try {
    const result = await runCommand("claude", ["-p", prompt, "--model", model], {
      env: {
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
      },
    });
    return { result, captures: proxy.getCaptures() };
  } finally {
    await proxy.close();
  }
}

async function captureOpenCode({ model, prompt, outDir, replaySession }) {
  const configRoot = mkdtempSync(join(tmpdir(), "opencode-bridge-"));
  const configDir = join(configRoot, "opencode");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    plugin: [distPluginPath],
  }, null, 2));

  const proxy = await startCaptureProxy("opencode", outDir);
  try {
    const result = await runCommand("opencode", [
      "run",
      "--model",
      `anthropic/${model}`,
      "--format",
      "json",
      prompt,
    ], {
      env: {
        XDG_CONFIG_HOME: configRoot,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
        ...(replaySession?.sessionID ? { ANTHROPIC_SESSION_ID: replaySession.sessionID } : {}),
        ...(replaySession?.billingCch ? { ANTHROPIC_BILLING_CCH: replaySession.billingCch } : {}),
      },
    });
    return { result, captures: proxy.getCaptures() };
  } finally {
    await proxy.close();
    rmSync(configRoot, { recursive: true, force: true });
  }
}

function extractSessionReplay(captures) {
  const messageCapture = firstMessageCapture(captures);
  if (!messageCapture) return null;
  const sessionID = messageCapture.headers?.["x-claude-code-session-id"];
  let billingCch = null;
  try {
    const parsed = JSON.parse(messageCapture.body);
    const billingText = parsed.system?.[0]?.text;
    const billingMatch = typeof billingText === "string"
      ? billingText.match(/cch=([^;]+);/)
      : null;
    billingCch = billingMatch?.[1] || null;
  } catch {}
  if (typeof sessionID !== "string" && !billingCch) return null;
  return {
    sessionID: typeof sessionID === "string" ? sessionID : null,
    billingCch,
  };
}

function firstMessageCapture(captures) {
  const messageCaptures = captures.filter((capture) =>
    capture.method === "POST"
    && (capture.url?.startsWith("/v1/messages") || capture.url?.startsWith("/messages"))
  );
  return messageCaptures.at(-1);
}

function compareRequests(reference, candidate) {
  if (!reference || !candidate) {
    return { available: false };
  }

  const ignoredHeaders = new Set([
    "authorization",
    "content-length",
    "host",
    "connection",
    "accept-encoding",
  ]);

  const headerDiff = {};
  const headerKeys = new Set([
    ...Object.keys(reference.headers || {}),
    ...Object.keys(candidate.headers || {}),
  ]);

  for (const key of [...headerKeys].sort()) {
    if (ignoredHeaders.has(key)) continue;
    const left = reference.headers?.[key];
    const right = candidate.headers?.[key];
    if (left !== right) {
      headerDiff[key] = { claude: left ?? null, opencode: right ?? null };
    }
  }

  let parsedReference = null;
  let parsedCandidate = null;
  try { parsedReference = JSON.parse(reference.body); } catch {}
  try { parsedCandidate = JSON.parse(candidate.body); } catch {}

  const summary = {
    available: true,
    sameMethod: reference.method === candidate.method,
    sameUrl: reference.url === candidate.url,
    bodyHash: {
      claude: sha256(reference.body),
      opencode: sha256(candidate.body),
      equal: sha256(reference.body) === sha256(candidate.body),
    },
    headerDiff,
    betaFlags: {
      claude: splitHeaderList(reference.headers?.["anthropic-beta"]),
      opencode: splitHeaderList(candidate.headers?.["anthropic-beta"]),
    },
    bodyShape: null,
  };

  summary.betaFlags.missingFromOpenCode = sortedDifference(
    summary.betaFlags.claude,
    summary.betaFlags.opencode,
  );
  summary.betaFlags.extraInOpenCode = sortedDifference(
    summary.betaFlags.opencode,
    summary.betaFlags.claude,
  );

  if (parsedReference && parsedCandidate) {
    const refTools = Array.isArray(parsedReference.tools) ? parsedReference.tools.map((tool) => tool.name) : [];
    const candTools = Array.isArray(parsedCandidate.tools) ? parsedCandidate.tools.map((tool) => tool.name) : [];
    summary.bodyShape = {
      topLevelKeys: {
        claude: Object.keys(parsedReference).sort(),
        opencode: Object.keys(parsedCandidate).sort(),
      },
      model: {
        claude: parsedReference.model ?? null,
        opencode: parsedCandidate.model ?? null,
      },
      thinking: {
        claude: parsedReference.thinking ?? null,
        opencode: parsedCandidate.thinking ?? null,
      },
      output_config: {
        claude: parsedReference.output_config ?? null,
        opencode: parsedCandidate.output_config ?? null,
      },
      context_management: {
        claude: parsedReference.context_management ?? null,
        opencode: parsedCandidate.context_management ?? null,
      },
      systemCount: {
        claude: Array.isArray(parsedReference.system) ? parsedReference.system.length : 0,
        opencode: Array.isArray(parsedCandidate.system) ? parsedCandidate.system.length : 0,
      },
      firstSystem: {
        claude: parsedReference.system?.[0]?.text ?? null,
        opencode: parsedCandidate.system?.[0]?.text ?? null,
      },
      metadataUserIdPresent: {
        claude: Boolean(parsedReference.metadata?.user_id),
        opencode: Boolean(parsedCandidate.metadata?.user_id),
      },
      toolCount: {
        claude: refTools.length,
        opencode: candTools.length,
      },
      toolNamesEqual: JSON.stringify(refTools) === JSON.stringify(candTools),
      toolNames: {
        claude: refTools,
        opencode: candTools,
        missingFromOpenCode: sortedDifference(refTools, candTools),
        extraInOpenCode: sortedDifference(candTools, refTools),
      },
    };
  }

  return summary;
}

function printUsage(label, usage) {
  console.log(`\n${label}`);
  if (usage?._error) {
    console.log(`error: ${usage._error}`);
    return;
  }
  for (const key of ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_oauth_apps", "extra_usage"]) {
    console.log(`${key}: ${JSON.stringify(usage?.[key] ?? null)}`);
  }
}

function printCommandResult(label, result) {
  console.log(`\n${label} exit=${result.code}`);
  if (result.stdout.trim()) {
    console.log(`${label} stdout:\n${result.stdout.trim()}`);
  }
  if (result.stderr.trim()) {
    console.log(`${label} stderr:\n${result.stderr.trim()}`);
  }
}

function writePromptCache(captures) {
  const messageCapture = firstMessageCapture(captures);
  if (!messageCapture) return false;
  try {
    const parsed = JSON.parse(messageCapture.body);
    if (!Array.isArray(parsed.system) || parsed.system.length < 2) return false;
    const billingText = parsed.system[0]?.text;
    const billingMatch = typeof billingText === "string"
      ? billingText.match(/cc_version=([^;]+);\s*cc_entrypoint=([^;]+);/)
      : null;
    mkdirSync(dirname(promptCachePath), { recursive: true });
    writeFileSync(promptCachePath, JSON.stringify({
      source: "claude-code-capture",
      updated_at: new Date().toISOString(),
      billing: billingMatch ? {
        ccVersion: billingMatch[1],
        ccVersionSuffix: billingMatch[1].split(".").at(-1),
        ccEntrypoint: billingMatch[2],
      } : undefined,
      system: parsed.system.slice(1),
    }, null, 2));
    return true;
  } catch {
    return false;
  }
}

function summarizeRun(run) {
  if (!run) return null;
  return {
    result: run.result,
    captureCount: run.captures.length,
    messageRequestCount: run.captures.filter((capture) =>
      capture.method === "POST"
      && (capture.url?.startsWith("/v1/messages") || capture.url?.startsWith("/messages"))
    ).length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });

  if (!readFileSync(distPluginPath, "utf8")) {
    throw new Error(`Missing built plugin at ${distPluginPath}. Run \`npm run build\` first.`);
  }

  const accessToken = getOAuthAccessToken();
  const report = {
    model: args.model,
    prompt: args.prompt,
    outDir: args.outDir,
    usage: {},
    claude: null,
    opencode: null,
    comparison: null,
  };
  let claudeRun = null;
  let openCodeRun = null;

  report.usage.before = await safeFetchUsage(accessToken);
  printUsage("Usage before", report.usage.before);

  if (!args.skipClaude) {
    claudeRun = await captureClaudeCode(args);
    report.claude = summarizeRun(claudeRun);
    printCommandResult("Claude Code", claudeRun.result);
    report.claude.promptCacheWritten = writePromptCache(claudeRun.captures);
    report.usage.afterClaude = await safeFetchUsage(accessToken);
    printUsage("Usage after Claude Code", report.usage.afterClaude);
  }

  if (!args.skipOpenCode) {
    openCodeRun = await captureOpenCode({
      ...args,
      replaySession: extractSessionReplay(claudeRun?.captures || []),
    });
    report.opencode = summarizeRun(openCodeRun);
    printCommandResult("OpenCode", openCodeRun.result);
    report.usage.afterOpenCode = await safeFetchUsage(accessToken);
    printUsage("Usage after OpenCode", report.usage.afterOpenCode);
  }

  report.comparison = compareRequests(
    firstMessageCapture(claudeRun?.captures || []),
    firstMessageCapture(openCodeRun?.captures || []),
  );

  writeFileSync(join(args.outDir, "report.json"), JSON.stringify(report, null, 2));

  console.log(`\nArtifacts saved to ${args.outDir}`);
  if (report.comparison?.available) {
    console.log(`Body hash equal: ${report.comparison.bodyHash.equal}`);
    console.log(`Header differences: ${Object.keys(report.comparison.headerDiff).length}`);
    console.log(`Missing beta flags: ${report.comparison.betaFlags.missingFromOpenCode.length}`);
    console.log(`Extra beta flags: ${report.comparison.betaFlags.extraInOpenCode.length}`);
    if (report.comparison.bodyShape) {
      console.log(`Tool names equal: ${report.comparison.bodyShape.toolNamesEqual}`);
      console.log(`Claude tool count: ${report.comparison.bodyShape.toolCount.claude}`);
      console.log(`OpenCode tool count: ${report.comparison.bodyShape.toolCount.opencode}`);
      console.log(`Missing tools: ${report.comparison.bodyShape.toolNames.missingFromOpenCode.length}`);
      console.log(`Extra tools: ${report.comparison.bodyShape.toolNames.extraInOpenCode.length}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
