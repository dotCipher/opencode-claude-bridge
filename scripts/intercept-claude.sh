#!/usr/bin/env bash
# Intercept Claude Code network calls to see exactly what headers/body it sends.
# Usage: ./scripts/intercept-claude.sh [model]
#
# Starts a local proxy, runs Claude CLI through it, and saves the full request
# to /tmp/claude-intercept-{headers,body}.json for analysis.

MODEL="${1:-claude-sonnet-4-6}"
PORT=18899

echo "=== Claude Code Network Interceptor ==="
echo "Model: $MODEL"
echo "Proxy: localhost:$PORT"
echo ""

# Start interceptor proxy
node -e "
const http = require('http'), https = require('https'), fs = require('fs');
let count = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    count++;
    const file = '/tmp/claude-intercept-' + count;
    fs.writeFileSync(file + '-headers.json', JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers
    }, null, 2));
    fs.writeFileSync(file + '-body.json', body);

    console.error('[REQ ' + count + '] ' + req.method + ' ' + req.url);

    // Print key headers
    const h = req.headers;
    console.error('  auth: ' + (h.authorization ? 'Bearer ...' + h.authorization.slice(-8) : h['x-api-key'] ? 'API key ...' + h['x-api-key'].slice(-8) : 'NONE'));
    console.error('  beta: ' + (h['anthropic-beta'] || 'NONE'));
    console.error('  ua:   ' + (h['user-agent'] || 'NONE'));

    // Print body structure
    try {
      const parsed = JSON.parse(body);
      console.error('  body keys: ' + Object.keys(parsed).sort().join(', '));
      console.error('  model: ' + parsed.model);
      console.error('  tools: ' + (parsed.tools?.length || 0));
      console.error('  system blocks: ' + (parsed.system?.length || 0));
      if (parsed.thinking) console.error('  thinking: ' + JSON.stringify(parsed.thinking));
      if (parsed.metadata) console.error('  metadata: present');
    } catch {}

    // Forward to real API
    const opts = {
      hostname: 'api.anthropic.com',
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: 'api.anthropic.com' }
    };
    const proxy = https.request(opts, proxyRes => {
      console.error('  -> ' + proxyRes.statusCode);
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxy.write(body);
    proxy.end();
  });
});

server.listen($PORT, () => {
  console.error('Proxy ready on $PORT');
  console.error('');
});

setTimeout(() => { server.close(); process.exit(0); }, 60000);
" &
PROXY_PID=$!
sleep 1

# Run Claude CLI through proxy (force OAuth by clearing API key)
echo "Running: claude -p 'say hi' --model $MODEL"
echo ""
ANTHROPIC_API_KEY= ANTHROPIC_BASE_URL=http://localhost:$PORT \
  claude -p "say hi" --model "$MODEL" 2>/dev/null

kill $PROXY_PID 2>/dev/null
wait $PROXY_PID 2>/dev/null

echo ""
echo "=== Saved to /tmp/claude-intercept-*-{headers,body}.json ==="
echo ""
echo "Inspect with:"
echo "  cat /tmp/claude-intercept-1-headers.json | python3 -m json.tool"
echo "  python3 -c \"import json; d=json.load(open('/tmp/claude-intercept-1-body.json')); print(sorted(d.keys()))\""
