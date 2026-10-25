const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const cliPath = path.resolve(__dirname, '../src/cli.cjs');

async function serve(t, handler) {
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    await handler(req, res, JSON.parse(raw));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function run(args = [], input = '', env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, BUTTON_BROWSER_URL: '', BUTTON_BROWSER_TOKEN: '', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('CLI sends a quoted text command once with an id and bearer token', async t => {
  const requests = [];
  const baseURL = await serve(t, (req, res, body) => {
    requests.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body });
    res.end(JSON.stringify({ ok: true, result: { url: 'https://example.test/?a=1&b=two' } }));
  });
  const result = await run(['--url', baseURL, '--token', 'cli-secret', 'goto https://example.test/?a=1&b=two']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: { url: 'https://example.test/?a=1&b=two' } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/command');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].authorization, 'Bearer cli-secret');
  assert.equal(requests[0].body.command, 'goto https://example.test/?a=1&b=two');
  assert.match(requests[0].body.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('CLI reads text, JSON commands, and request envelopes sequentially with env configuration', async t => {
  const requests = [];
  let active = 0;
  let maximumActive = 0;
  const baseURL = await serve(t, async (req, res, body) => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    requests.push({ body, authorization: req.headers.authorization });
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    res.end(JSON.stringify({ ok: true, result: { sequence: requests.length } }));
  });
  const result = await run([], '\n detect\n{"action":"observe","vision":true}\n{"command":{"action":"click","id":"b1","observationId":"o1"},"commandId":"stable-1"}\n', {
    BUTTON_BROWSER_URL: baseURL,
    BUTTON_BROWSER_TOKEN: 'env-secret',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(maximumActive, 1);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.command, 'detect');
  assert.deepEqual(requests[1].body.command, { action: 'observe', vision: true });
  assert.deepEqual(requests[2].body, { command: { action: 'click', id: 'b1', observationId: 'o1' }, commandId: 'stable-1' });
  assert.equal(new Set(requests.map(request => request.body.commandId)).size, 3);
  assert.ok(requests.every(request => request.authorization === 'Bearer env-secret'));
  assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line).result.sequence), [1, 2, 3]);
});

test('CLI reports server failure to stderr, emits its JSON, and never retries', async t => {
  let requests = 0;
  const baseURL = await serve(t, (req, res) => {
    requests++;
    res.statusCode = 409;
    res.end(JSON.stringify({ ok: false, error: { code: 'STALE_OBSERVATION', message: 'Observation expired' } }));
  });
  const result = await run(['--url', baseURL, 'click', 'b1']);
  assert.equal(result.code, 1);
  assert.equal(requests, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'STALE_OBSERVATION');
  assert.match(result.stderr, /STALE_OBSERVATION/);
});

test('CLI rejects malformed JSON locally and continues subsequent input with failing exit status', async t => {
  const requests = [];
  const baseURL = await serve(t, (req, res, body) => {
    requests.push(body);
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
  const result = await run(['--url', baseURL], '{bad}\ndetect\n');
  assert.equal(result.code, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].command, 'detect');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.match(result.stderr, /JSON/);
});

test('CLI surfaces a broken response without leaking arbitrary response text', async t => {
  const baseURL = await serve(t, (req, res) => { res.end('untrusted-provider-secret'); });
  const result = await run(['--url', baseURL, 'detect']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /JSON/);
  assert.doesNotMatch(result.stderr, /untrusted-provider-secret/);
});
