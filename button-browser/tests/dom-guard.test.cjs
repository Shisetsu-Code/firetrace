'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { detectDOMButtons, guardDOMTarget } = require('../src/detector.cjs');

let browser;
test.before(async () => {
  browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox'] });
});
test.after(async () => { await browser?.close(); });

const viewport = { width: 800, height: 600 };

async function prohibitSearch(frame) {
  await frame.evaluate(() => {
    const state = globalThis.__buttonBrowserProbe;
    for (const key of ['collect', 'describe', 'hitsTarget']) state[key] = () => { throw new Error('Guard must not call ' + key); };
    const original = document.elementFromPoint.bind(document);
    globalThis.guardHitPoints = [];
    document.elementFromPoint = (x, y) => {
      globalThis.guardHitPoints.push({ x, y });
      return original(x, y);
    };
  });
}

test('DOM guard checks only the saved point and rejects a 1px blocker after a subpixel move', async () => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent('<button id="target" style="position:absolute;left:40px;top:40px;width:120px;height:40px" onclick="window.clicked=true">Action</button>');
    const candidate = (await detectDOMButtons(page)).buttons[0];
    assert.deepEqual(candidate.clickPoint, { x: 100, y: 60 });
    await prohibitSearch(page.mainFrame());
    const checked = await guardDOMTarget(candidate._target.frame, candidate._target.key, viewport, { x: 100, y: 60 });
    assert.ok(checked, 'the original saved point still reaches the original element');
    assert.equal(checked.label, 'Action');
    assert.equal(checked.disabled, false);
    assert.deepEqual(checked.bbox, { x: 40, y: 40, width: 120, height: 40 });
    assert.ok(!('point' in checked) && !('clickPoint' in checked), 'guard must not publish another point');
    assert.deepEqual(await page.evaluate(() => guardHitPoints), [{ x: 100, y: 60 }]);
    await page.evaluate(() => {
      document.querySelector('#target').style.left = '40.75px';
      const blocker = document.createElement('div');
      blocker.id = 'blocker';
      blocker.style.cssText = 'position:absolute;left:99.5px;top:50px;width:1px;height:20px;background:red;z-index:9';
      blocker.onclick = () => { window.blockerClicked = true; };
      document.body.append(blocker);
    });
    assert.equal(await page.evaluate(() => document.elementFromPoint(100.75, 60).id), 'target', 'an alternative center really remains reachable');
    await page.evaluate(() => { guardHitPoints.length = 0; });
    assert.equal(await guardDOMTarget(candidate._target.frame, candidate._target.key, viewport, { x: 100, y: 60 }), null);
    assert.deepEqual(await page.evaluate(() => guardHitPoints), [{ x: 100, y: 60 }]);
    assert.deepEqual(await page.evaluate(() => [window.clicked || false, window.blockerClicked || false]), [false, false]);
  } finally { await page.close(); }
});

test('DOM guard maps the same stored point through a scaled iframe and rejects a parent overlay', async () => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent('<iframe style="position:absolute;left:100px;top:120px;width:400px;height:200px;border:4px solid;transform:scale(.75);transform-origin:top left"></iframe>');
    await page.locator('iframe').evaluate(el => { el.srcdoc = '<button style="position:absolute;left:30px;top:20px;width:100px;height:50px">Frame action</button>'; });
    await page.frameLocator('iframe').locator('button').waitFor();
    const candidate = (await detectDOMButtons(page)).buttons.find(button => button.label === 'Frame action');
    assert.ok(candidate);
    assert.deepEqual(candidate.clickPoint, { x: 163, y: 156.75 });
    await prohibitSearch(candidate._target.frame);
    const checked = await guardDOMTarget(candidate._target.frame, candidate._target.key, viewport, candidate.clickPoint);
    assert.ok(checked);
    assert.deepEqual(checked.bbox, { x: 125.5, y: 138, width: 75, height: 37.5 });
    assert.deepEqual(await candidate._target.frame.evaluate(() => guardHitPoints), [{ x: 80, y: 45 }]);
    await page.evaluate(() => {
      const blocker = document.createElement('div');
      blocker.style.cssText = 'position:absolute;left:162.5px;top:151.75px;width:1px;height:10px;background:red;z-index:9';
      document.body.append(blocker);
    });
    assert.equal(await guardDOMTarget(candidate._target.frame, candidate._target.key, viewport, candidate.clickPoint), null);
  } finally { await page.close(); }
});

test('DOM guard reads current label and disabled state without rebinding a replaced element', async () => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent('<button id="target" style="position:absolute;left:40px;top:40px;width:120px;height:40px">Original</button>');
    const candidate = (await detectDOMButtons(page)).buttons[0];
    await prohibitSearch(page.mainFrame());
    await page.locator('button').evaluate(el => { el.textContent = 'Changed'; el.disabled = true; });
    const checked = await guardDOMTarget(candidate._target.frame, candidate._target.key, viewport, candidate.clickPoint);
    assert.ok(checked);
    assert.equal(checked.label, 'Changed');
    assert.equal(checked.disabled, true);
    await page.locator('button').evaluate(el => { el.replaceWith(el.cloneNode(true)); });
    assert.equal(await guardDOMTarget(candidate._target.frame, candidate._target.key, viewport, candidate.clickPoint), null);
  } finally { await page.close(); }
});
