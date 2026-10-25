'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { chromium } = require('playwright');
const { createCoordinateSVG, showCoordinateOverlay, clearCoordinateOverlay } = require('../src/overlay.cjs');
const { saveObservation } = require('../src/artifacts.cjs');
const { detectDOMButtons } = require('../src/detector.cjs');

let browser;
test.before(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
});
test.after(async () => { await browser?.close(); });

const viewport = { width: 320, height: 200 };
const coordinateButton = { id: 'b1', label: 'Real button', bbox: { x: 40, y: 50, width: 100, height: 40 }, center: { x: 90, y: 70 }, clickPoint: { x: 70, y: 65 }, source: 'dom' };

test('SVG visibly spells the reported click coordinates, with fallback center and escaped IDs', async () => {
  const page = await browser.newPage({ viewport });
  try {
    const maliciousId = '<script>window.injected=1</script>&"';
    const svg = createCoordinateSVG([
      coordinateButton,
      { id: maliciousId, bbox: { x: 280, y: 160, width: 30, height: 30 }, center: { x: 295, y: 175 } }
    ], viewport);
    await page.setContent(svg);
    const texts = await page.locator('svg text').allTextContents();
    assert.ok(texts.join(' ').includes('b1 · x 70 · y 65'));
    assert.ok(texts.join(' ').includes(maliciousId), 'ID is literal visible text');
    assert.ok(texts.join(' ').includes('x 295 · y 175'));
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator('svg script').count(), 0);
    const crosshairs = await page.locator('[data-coordinate-crosshair]').evaluateAll(elements => elements.map(el => ({ x: Number(el.getAttribute('data-x')), y: Number(el.getAttribute('data-y')) })));
    assert.deepEqual(crosshairs, [{ x: 70, y: 65 }, { x: 295, y: 175 }]);
  } finally { await page.close(); }
});

test('controlled-page overlay is fixed, noninteractive, detector-neutral, and does not change page layout', async () => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent('<style>body{margin:0;height:800px}button{position:absolute;left:40px;top:50px;width:100px;height:40px}</style><button onclick="window.clicked=(window.clicked||0)+1">Real button</button>');
    const before = await page.locator('button').boundingBox();
    const oldScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    assert.equal((await detectDOMButtons(page)).buttons.length, 1);
    await showCoordinateOverlay(page, [coordinateButton], viewport);
    const host = page.locator('[data-button-browser-coordinate-overlay]');
    assert.equal(await host.count(), 1);
    assert.deepEqual(await page.locator('button').boundingBox(), before);
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), oldScrollHeight);
    const state = await host.evaluate(el => ({
      style: { position: getComputedStyle(el).position, pointerEvents: getComputedStyle(el).pointerEvents, zIndex: getComputedStyle(el).zIndex },
      text: el.shadowRoot?.textContent,
      nodesAreInert: [...el.shadowRoot.querySelectorAll('*')].every(node => getComputedStyle(node).pointerEvents === 'none'),
      roles: [...el.shadowRoot.querySelectorAll('[role],button,input,a[href],[tabindex]')].length,
      box: { x: el.getBoundingClientRect().x, y: el.getBoundingClientRect().y, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }
    }));
    assert.equal(state.style.position, 'fixed');
    assert.equal(state.style.pointerEvents, 'none');
    assert.equal(state.style.zIndex, '2147483647');
    assert.equal(state.nodesAreInert, true);
    assert.equal(state.roles, 0);
    assert.ok(state.text.includes('b1 · x 70 · y 65'));
    assert.deepEqual(state.box, { x: 0, y: 0, width: 320, height: 200 });
    assert.deepEqual((await detectDOMButtons(page)).buttons.map(button => button.label), ['Real button']);
    assert.equal(await page.evaluate(() => window.clicked || 0), 0, 'show must not dispatch input');
    assert.equal(await page.evaluate(() => document.elementFromPoint(70, 65).tagName), 'BUTTON');
    await page.mouse.click(70, 65);
    assert.equal(await page.evaluate(() => window.clicked), 1, 'click passes through the crosshair');
    await page.evaluate(() => scrollTo(0, 100));
    const afterScroll = await host.boundingBox();
    assert.equal(afterScroll.y, 0);
  } finally { await page.close(); }
});

test('labels remain inside the viewport and repeated show or clear touches only the owned overlay', async () => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent('<p id="content">Preserve this content</p>');
    await showCoordinateOverlay(page, [
      { id: 'b1', bbox: { x: 0, y: 0, width: 20, height: 20 }, clickPoint: { x: 10, y: 10 } },
      { id: 'b2', bbox: { x: 300, y: 180, width: 20, height: 20 }, clickPoint: { x: 310, y: 190 } }
    ], viewport);
    const geometry = await page.locator('[data-button-browser-coordinate-overlay]').evaluate(el => [...el.shadowRoot.querySelectorAll('[data-coordinate-label]')].map(label => {
      const box = label.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
    }));
    assert.equal(geometry.length, 2);
    for (const label of geometry) assert.ok(label.x >= 0 && label.y >= 0 && label.right <= 320 && label.bottom <= 200, JSON.stringify(label));
    await showCoordinateOverlay(page, [{ ...coordinateButton, id: 'b7' }], viewport);
    assert.equal(await page.locator('[data-button-browser-coordinate-overlay]').count(), 1);
    const text = await page.locator('[data-button-browser-coordinate-overlay]').evaluate(el => el.shadowRoot.textContent);
    assert.ok(text.includes('b7 · x 70 · y 65'));
    assert.ok(!text.includes('b1 ·'));
    await page.evaluate(() => {
      const other = document.createElement('div');
      other.id = 'page-owned-marker';
      other.setAttribute('data-button-browser-coordinate-overlay', 'not-our-overlay');
      document.body.append(other);
    });
    await clearCoordinateOverlay(page);
    assert.equal(await page.locator('#page-owned-marker').count(), 1);
    assert.equal(await page.locator('#content').innerText(), 'Preserve this content');
    assert.equal(await page.locator('[data-button-browser-coordinate-overlay]').count(), 1);
    await showCoordinateOverlay(page, [coordinateButton], viewport);
    await showCoordinateOverlay(page, [], viewport);
    assert.equal(await page.locator('[data-button-browser-coordinate-overlay]').count(), 1);
  } finally { await page.close(); }
});

test('saved annotation marks the reported click point and unverified empty candidates expose no coordinates', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-coordinate-artifact-'));
  try {
    const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#111111' } }).png().toBuffer();
    const observation = { observationId: 'verified', viewport };
    await saveObservation({ directory: path.join(directory, 'verified'), png, observation, candidates: [{ label: 'Target', source: 'dom', bbox: { x: 80, y: 60, width: 120, height: 60 }, clickPoint: { x: 95, y: 75 } }] });
    assert.deepEqual(observation.buttons[0].clickPoint, { x: 95, y: 75 });
    const annotated = path.join(directory, 'verified', 'annotated.png');
    const metadata = await sharp(annotated).metadata();
    assert.equal(metadata.width, 320);
    assert.equal(metadata.height, 200);
    const marker = await sharp(annotated).extract({ left: 95, top: 75, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.notDeepEqual([...marker], [17, 17, 17], 'crosshair must mark the actual report click point');
    const geometricCenter = await sharp(annotated).extract({ left: 140, top: 90, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    assert.deepEqual([...geometricCenter], [17, 17, 17], 'do not substitute the bbox center for clickPoint');
    assert.ok(createCoordinateSVG(observation.buttons, viewport).includes('b1 · x 95 · y 75'));
    const unverified = { observationId: 'unverified', viewport, buttons: [{ id: 'old-result', clickPoint: { x: 99, y: 99 } }] };
    await saveObservation({ directory: path.join(directory, 'unverified'), png, observation: unverified, candidates: [] });
    assert.deepEqual(unverified.buttons, []);
    const blank = await sharp(path.join(directory, 'unverified', 'annotated.png')).removeAlpha().raw().toBuffer();
    const original = await sharp(png).removeAlpha().raw().toBuffer();
    assert.deepEqual(blank, original);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'unverified', 'buttons.json'), 'utf8')).buttons, []);
    assert.ok(!(await fs.readdir(path.join(directory, 'unverified'))).includes('b1.png'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
