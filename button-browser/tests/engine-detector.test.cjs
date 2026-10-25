'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { detectEngineButtons } = require('../src/engine-detector.cjs');

const pixiPath = path.resolve(path.dirname(require.resolve('pixi.js')), '../browser/pixi.js');
let browser;

test.before(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--site-per-process'] });
});
test.after(async () => { await browser?.close(); });

async function makeFixture(page, { child = false, megaton = false, masked = false } = {}) {
  await page.setContent('<style>html,body{margin:0}canvas{position:absolute;left:40px;top:30px;width:600px;height:450px}</style>');
  await page.addScriptTag({ path: pixiPath });
  await page.evaluate(({ child, megaton, masked }) => {
    const P = window.PIXI;
    const renderer = new P.Renderer({ width: 400, height: 300, resolution: 2, antialias: false });
    document.body.append(renderer.view);
    if (child) renderer.view.style.cssText = 'position:absolute;left:10px;top:20px;width:400px;height:300px';
    const root = new P.Container();
    let events = 0;
    const rect = (label, x, y, width, height, active = true) => {
      const node = new P.Graphics().beginFill(0x2345ff).drawRect(0, 0, width, height).endFill();
      node.position.set(x, y);
      node.name = label;
      if (active) {
        node.interactive = true;
        node.buttonMode = true;
        node.on('pointertap', () => { events++; });
      }
      root.addChild(node);
      return node;
    };
    const spin = rect('Spin', 20, 30, 100, 40);
    if (megaton) {
      spin.name = '';
      spin._sceneNode = { priority: 0 };
      root._sceneNode = { priority: 0, _timeLine: { elements: [{ instanceName: 'spinBtn' }] }, elements: [spin._sceneNode] };
      spin._buttonHandler = { _clickHandler() {}, _enabled: true };
      spin.hitArea = new P.Polygon([0, 0, 100, 0, 0, 20]);
    }
    if (masked) {
      const mask = new P.Graphics().beginFill(0xffffff).drawRect(20, 30, 10, 40).endFill();
      root.addChild(mask);
      spin.mask = mask;
    }
    if (!child) {
      rect('Decoration', 200, 20, 60, 40, false);
      const hidden = rect('Invisible', 20, 100, 80, 30);
      hidden.visible = false;
      const disabled = rect('Disabled', 120, 100, 80, 30);
      disabled.interactive = false;
      rect('Behind', 230, 100, 80, 30);
      rect('Front', 230, 100, 80, 30);
    }
    renderer.render(root);
    if (megaton) {
      spin.getBounds = spin.getButtonHandler = () => { throw new Error('Detector invoked a mutating/lazy engine method'); };
      Object.defineProperty(spin, 'worldVisible', { get() { throw new Error('Detector evaluated a game getter'); } });
    }
    window.fixtureEvents = () => events;
    // There is deliberately no exported application, renderer, or PIXI global.
    window.PIXI = undefined;
  }, { child, megaton, masked });
}

function nearBox(actual, expected) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 0.8, `${key}: got ${actual[key]}, expected ${expected[key]}`);
  }
}

// Removing bound-listener recovery, resolution conversion, scene filtering, or
// z-order checks must break this test. Expectations are hand-derived CSS pixels.
test('recovers a private Pixi scene without clicking and returns visible topmost buttons in CSS pixels', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await makeFixture(page);
    const result = await detectEngineButtons(page);
    assert.equal(result.canvasCount, 1);
    assert.deepEqual(result.buttons.map(b => b.label).sort(), ['Front', 'Spin']);
    const spin = result.buttons.find(b => b.label === 'Spin');
    nearBox(spin.bbox, { x: 70, y: 75, width: 150, height: 60 });
    assert.equal(spin.source, 'pixi');
    assert.equal(spin.actionable, true);
    assert.ok(spin.targetKey);
    assert.equal(await page.evaluate(() => window.fixtureEvents()), 0);
  } finally { await page.close(); }
});

test('reports disabled controls only when requested and never marks them actionable', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await makeFixture(page);
    const result = await detectEngineButtons(page, { includeDisabled: true });
    const disabled = result.buttons.find(b => b.label === 'Disabled');
    assert.ok(disabled, 'disabled interactive control was lost');
    assert.equal(disabled.actionable, false);
    assert.ok(!result.buttons.some(b => b.label === 'Decoration' || b.label === 'Invisible' || b.label === 'Behind'));
  } finally { await page.close(); }
});

test('excludes a button covered by a DOM overlay over its canvas', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await makeFixture(page);
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:absolute;left:65px;top:70px;width:160px;height:70px;background:white;z-index:100';
      document.body.append(overlay);
    });
    const result = await detectEngineButtons(page);
    assert.ok(!result.buttons.some(b => b.label === 'Spin'));
    assert.ok(result.buttons.some(b => b.label === 'Front'));
  } finally { await page.close(); }
});

test('gives an explicit limitation for a visible opaque canvas', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<canvas width="300" height="200"></canvas>');
    const result = await detectEngineButtons(page);
    assert.equal(result.canvasCount, 1);
    assert.deepEqual(result.buttons, []);
    assert.ok(result.warnings.length > 0);
  } finally { await page.close(); }
});

test('uses Megaton scene names and chooses a point inside the explicit polygon without calling engine methods', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await makeFixture(page, { megaton: true });
    const result = await detectEngineButtons(page);
    const spin = result.buttons.find(b => b.label === 'spinBtn');
    assert.ok(spin, JSON.stringify(result.warnings));
    nearBox(spin.bbox, { x: 70, y: 75, width: 150, height: 60 });
    assert.ok(spin.center.x < 145 && spin.center.y < 105, 'geometric center is outside the triangle');
    assert.equal(await page.evaluate(() => window.fixtureEvents()), 0);
  } finally { await page.close(); }
});

test('clips an interactive button to its Pixi mask before choosing its click point', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await makeFixture(page, { masked: true });
    const result = await detectEngineButtons(page);
    const spin = result.buttons.find(b => b.label === 'Spin');
    assert.ok(spin);
    nearBox(spin.bbox, { x: 70, y: 75, width: 15, height: 60 });
    assert.ok(spin.center.x >= 70 && spin.center.x <= 85);
  } finally { await page.close(); }
});

test('requires handler evidence before returning a passive interactive stage as a control', async () => {
  const page = await browser.newPage();
  try {
    await page.addScriptTag({ path: pixiPath });
    await page.evaluate(() => {
      const P = window.PIXI;
      const renderer = new P.Renderer({ width: 300, height: 200 });
      document.body.append(renderer.view);
      const stage = new P.Container();
      stage.name = 'Intro stage';
      stage.interactive = true;
      stage.addChild(new P.Graphics().beginFill(0x123456).drawRect(0, 0, 300, 200).endFill());
      renderer.render(stage);
      window.addIntroListener = () => stage.on('pointertap', () => {});
      window.PIXI = undefined;
    });
    const passive = await detectEngineButtons(page);
    assert.equal(passive.buttons.length, 0, 'a passive stage is not an input control');
    await page.evaluate(() => window.addIntroListener());
    const active = await detectEngineButtons(page);
    assert.equal(active.buttons.length, 1, 'a click-to-continue stage is a real input control');
    assert.equal(active.buttons[0].label, 'Intro stage');
  } finally { await page.close(); }
});

// Fails if frame border, parent scale, OOPIF discovery, or viewport origin is lost.
test('maps a private Pixi canvas in a cross-origin scaled iframe to the main viewport', async () => {
  const pixiSource = fs.readFileSync(pixiPath);
  let port;
  const server = http.createServer((req, res) => {
    if (req.url === '/pixi.js') { res.setHeader('content-type', 'application/javascript'); res.end(pixiSource); return; }
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/child' ? '<style>html,body{margin:0}</style>' : `<style>body{margin:0}iframe{position:absolute;left:80px;top:40px;width:400px;height:300px;border:4px solid black;transform:scale(1.25);transform-origin:0 0}</style><iframe src="http://localhost:${port}/child"></iframe>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    const child = page.frames().find(frame => frame !== page.mainFrame());
    await makeFixture(child, { child: true });
    const result = await detectEngineButtons(page);
    const spin = result.buttons.find(b => b.label === 'Spin');
    assert.ok(spin, JSON.stringify(result.warnings));
    nearBox(spin.bbox, { x: 122.5, y: 107.5, width: 125, height: 50 });
  } finally {
    await page.close();
    await new Promise(resolve => server.close(resolve));
  }
});
