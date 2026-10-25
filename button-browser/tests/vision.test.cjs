const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { detectVisionButtons, normalizeVisionButtons } = require('../src/vision.cjs');

const viewport = { width: 800, height: 600 };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iN1sAAAAASUVORK5CYII=', 'base64');

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('vision parser clips CSS boxes and marks estimates without trusting model metadata', () => {
  const result = normalizeVisionButtons('```json\n{"buttons":[{"label":"  Pl\\u0000ay  now ","bbox":[-5,580,40,40],"confidence":0.999,"source":"dom","estimated":false}]}\n```', viewport);
  assert.equal(result.buttons.length, 1);
  assert.deepEqual(result.buttons[0].bbox, { x: 0, y: 580, width: 35, height: 20 });
  assert.equal(result.buttons[0].label, 'Play now');
  assert.equal(result.buttons[0].confidence, 0.9);
  assert.equal(result.buttons[0].source, 'vision');
  assert.equal(result.buttons[0].kind, 'button');
  assert.equal(result.buttons[0].actionable, true);
  assert.equal(result.buttons[0].estimated, true);
  assert.match(result.buttons[0].targetKey, /^vision:/);
  assert.ok(result.warnings.some(warning => /calibrad/i.test(warning)));
});

test('vision parser rejects non-finite, offscreen, disabled, and malformed candidates', () => {
  const result = normalizeVisionButtons({ buttons: [
    { label: 'OK', bbox: { x: 10.5, y: 20, width: 30, height: 40 }, confidence: 0.7 },
    { label: 'Infinity', bbox: [Infinity, 1, 20, 20] },
    { label: 'Strings', bbox: ['4', 1, 20, 20] },
    { label: 'Offscreen', bbox: [900, 1, 20, 20] },
    { label: 'Zero', bbox: [1, 1, 0, 20] },
    { label: 'Negative', bbox: [1, 1, -20, 20] },
    { label: 'Disabled', bbox: [1, 1, 20, 20], enabled: false },
    { label: 'Hidden', bbox: [1, 1, 20, 20], visible: false },
    { label: 'Overflow', bbox: [Number.MAX_VALUE, 1, Number.MAX_VALUE, 20] },
    { label: {}, bbox: [1, 1, 20, 20] },
    null,
  ] }, viewport);
  assert.deepEqual(result.buttons.map(button => button.label), ['OK']);
  assert.deepEqual(result.buttons[0].bbox, { x: 10.5, y: 20, width: 30, height: 40 });
  assert.equal(result.buttons[0].confidence, 0.7);
  assert.ok(result.warnings.some(warning => /10/.test(warning)));
});

test('vision parser limits detections and accepts plain JSON arrays', () => {
  const many = Array.from({ length: 110 }, (_, index) => ({ label: `Button ${index}`, bbox: [10, 10, 20, 20] }));
  const result = normalizeVisionButtons(JSON.stringify(many), viewport);
  assert.equal(result.buttons.length, 100);
  assert.ok(result.buttons.every(button => button.confidence >= 0 && button.confidence <= 0.9));
  assert.ok(result.warnings.some(warning => /100/.test(warning)));
});

test('vision parser fails closed on malformed envelopes and invalid viewport', () => {
  for (const input of ['not JSON', '{"buttons":{}}', '{"other":[]}', 'null', '```json\n[]\n``` extra']) {
    assert.throws(() => normalizeVisionButtons(input, viewport), error => error.code === 'VISION_OUTPUT');
  }
  assert.throws(() => normalizeVisionButtons([], { width: 0, height: 600 }), error => error.code === 'VISION_INPUT');
});

test('vision HTTP request sends the full screenshot and scales prompt coordinates to CSS viewport', async t => {
  let request;
  const baseURL = await serve(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    request = { path: req.url, headers: req.headers, method: req.method, body: JSON.parse(raw) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"buttons":[{"label":"Start","bbox":[12,24,80,35],"confidence":0.8}]}' }, finish_reason: 'stop' }] }));
  });
  const result = await detectVisionButtons({ png, viewport, baseURL: `${baseURL}/v1/`, model: 'local-vl', apiKey: 'test-secret' });
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer test-secret');
  assert.equal(request.body.model, 'local-vl');
  const content = request.body.messages.find(message => message.role === 'user').content;
  assert.equal(content.find(block => block.type === 'image_url').image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  const prompt = request.body.messages.map(message => typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).join('\n');
  assert.match(prompt, /800/);
  assert.match(prompt, /600/);
  assert.match(prompt, /CSS/);
  assert.match(prompt, /decorative/i);
  assert.match(prompt, /enabled/i);
  assert.equal(result.buttons[0].label, 'Start');
  assert.deepEqual(result.buttons[0].bbox, { x: 12, y: 24, width: 80, height: 35 });
});

test('vision accepts root and exact completion URLs without requiring a key for local endpoints', async t => {
  const paths = [];
  const authorizations = [];
  const baseURL = await serve(t, (req, res) => {
    paths.push(req.url);
    authorizations.push(req.headers.authorization);
    res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '{"buttons":[]}' }] } }] }));
  });
  for (const suffix of ['', '/chat/completions']) {
    const result = await detectVisionButtons({ png, viewport, baseURL: `${baseURL}${suffix}`, model: 'local' });
    assert.deepEqual(result.buttons, []);
  }
  assert.deepEqual(paths, ['/chat/completions', '/chat/completions']);
  assert.deepEqual(authorizations, [undefined, undefined]);
});

test('vision HTTP failures and malformed responses never expose key or raw response', async t => {
  let requests = 0;
  const baseURL = await serve(t, (req, res) => {
    requests++;
    if (requests === 1) {
      res.statusCode = 401;
      res.end('provider-secret echoed test-secret');
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: 'provider-secret echoed test-secret' } }] }));
    }
  });
  for (const code of ['VISION_HTTP', 'VISION_OUTPUT']) {
    await assert.rejects(detectVisionButtons({ png, viewport, baseURL, model: 'local', apiKey: 'test-secret' }), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.stack, /provider-secret|test-secret/);
      return true;
    });
  }
  assert.equal(requests, 2);
});

test('vision timeout aborts the request without retrying', async t => {
  let requests = 0;
  const baseURL = await serve(t, () => { requests++; });
  await assert.rejects(detectVisionButtons({ png, viewport, baseURL, model: 'local', timeoutMs: 75 }), error => error.code === 'VISION_TIMEOUT');
  assert.equal(requests, 1);
});
