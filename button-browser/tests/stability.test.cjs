'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { STABILITY_RULES, compareSamples } = require('../src/stability.cjs');

const viewport = { width: 80, height: 60 };
const control = (overrides = {}) => ({ targetKey: 'dom:a', source: 'dom', label: 'Inicio', kind: 'button', actionable: true, bbox: { x: 8, y: 8, width: 20, height: 16 }, ...overrides });
const sample = (candidates, png, overrides = {}) => ({ candidates, png, viewport: { ...viewport }, url: 'https://example.test/game', epoch: 7, timestamp: '2026-10-25T12:00:00.000Z', complete: true, ...overrides });

async function image(background = 240, rectangles = []) {
  const bytes = Buffer.alloc(viewport.width * viewport.height * 3, background);
  for (const rectangle of rectangles) {
    for (let y = rectangle.y; y < rectangle.y + rectangle.height; y++) {
      for (let x = rectangle.x; x < rectangle.x + rectangle.width; x++) {
        const offset = (y * viewport.width + x) * 3;
        bytes[offset] = rectangle.color;
        bytes[offset + 1] = rectangle.color;
        bytes[offset + 2] = rectangle.color;
      }
    }
  }
  return sharp(bytes, { raw: { ...viewport, channels: 3 } }).png().toBuffer();
}

test('stability preserves controls across reordering, including disabled controls', async () => {
  const a = control();
  const b = control({ targetKey: 'pixi:b', source: 'pixi', label: 'Atrás', actionable: false, bbox: { x: 42, y: 30, width: 18, height: 18 } });
  const png = await image(240, [{ x: 8, y: 8, width: 20, height: 16, color: 30 }, { x: 42, y: 30, width: 18, height: 18, color: 90 }]);
  const result = await compareSamples([sample([a, b], png), sample([b, a], png), sample([a, b], png)]);
  assert.deepEqual(result, { stable: true, reasons: [], maxGeometryDeltaPx: 0, maxAppearanceDifference: 0 });
  assert.equal(Object.isFrozen(STABILITY_RULES), true);
});

test('matching first and third readings cannot hide movement in the middle reading', async () => {
  const png = await image();
  const moved = control({ bbox: { x: 11, y: 8, width: 20, height: 16 } });
  const result = await compareSamples([sample([control()], png), sample([moved], png), sample([control()], png)]);
  assert.equal(result.stable, false);
  assert.equal(result.maxGeometryDeltaPx, 3);
  assert.ok(result.reasons.some(reason => /geometr/i.test(reason)));
  assert.doesNotMatch(result.reasons.join(' '), /bbox|width|height|\bx\s*[:=]|\by\s*[:=]/i);
});

test('geometry drift is compared across all pairs, not only consecutive readings', async () => {
  const png = await image();
  const samples = [8, 8.75, 9.5].map(x => sample([control({ bbox: { x, y: 8, width: 20, height: 16 } })], png));
  const result = await compareSamples(samples);
  assert.equal(result.stable, false);
  assert.equal(result.maxGeometryDeltaPx, 1.5);
});

test('a new or missing control prevents publication', async () => {
  const png = await image();
  const added = control({ targetKey: 'dom:b', label: 'Nuevo', bbox: { x: 42, y: 30, width: 18, height: 18 } });
  for (const middle of [[], [control(), added]]) {
    const result = await compareSamples([sample([control()], png), sample(middle, png), sample([control()], png)]);
    assert.equal(result.stable, false);
    assert.ok(result.reasons.some(reason => /control/i.test(reason)));
  }
});

test('identity, label, source, kind, and actionable state must persist', async () => {
  const png = await image();
  for (const change of [{ targetKey: 'dom:replacement' }, { label: 'Comprar' }, { source: 'pixi' }, { kind: 'toggle' }, { actionable: false }]) {
    const result = await compareSamples([sample([control()], png), sample([control(change)], png), sample([control()], png)]);
    assert.equal(result.stable, false, JSON.stringify(change));
  }
});

test('click point changes are checked even when the button rectangle is unchanged', async () => {
  const png = await image();
  const a = control({ clickPoint: { x: 12, y: 12 } });
  const b = control({ clickPoint: { x: 14, y: 12 } });
  const result = await compareSamples([sample([a], png), sample([b], png), sample([a], png)]);
  assert.equal(result.stable, false);
  assert.equal(result.maxGeometryDeltaPx, 2);
});

test('changed button pixels invalidate unchanged geometry even when the third matches the first', async () => {
  const before = await image(240, [{ x: 8, y: 8, width: 20, height: 16, color: 40 }]);
  const changed = await image(240, [{ x: 8, y: 8, width: 20, height: 16, color: 80 }]);
  const result = await compareSamples([sample([control()], before), sample([control()], changed), sample([control()], before)]);
  assert.equal(result.stable, false);
  assert.equal(result.maxGeometryDeltaPx, 0);
  assert.ok(Math.abs(result.maxAppearanceDifference - 40 / 255) < 1e-9);
  assert.ok(result.reasons.some(reason => /apariencia/i.test(reason)));
});

test('geometry and appearance reasons name the responsible control without exposing positions', async () => {
  const before = control({ targetKey: 'pixi:continue', source: 'pixi', label: 'Continue', bbox: { x: 43, y: 27, width: 14, height: 12 } });
  const after = { ...before, bbox: { x: 45, y: 27, width: 14, height: 12 } };
  const beforePNG = await image(240, [{ x: 43, y: 27, width: 14, height: 12, color: 40 }]);
  const afterPNG = await image(240, [{ x: 45, y: 27, width: 14, height: 12, color: 80 }]);
  const result = await compareSamples([sample([before], beforePNG), sample([after], afterPNG), sample([before], beforePNG)]);
  assert.equal(result.stable, false);
  assert.equal(result.maxGeometryDeltaPx, 2);
  for (const kind of ['geometría', 'apariencia']) {
    const reasons = result.reasons.filter(reason => reason.includes(kind));
    assert.ok(reasons.length > 0);
    assert.ok(reasons.every(reason => reason.includes('pixi') && reason.includes('Continue')));
  }
  const reasons = result.reasons.join(' ');
  assert.doesNotMatch(reasons, /bbox|clickPoint|positions?|coordinates?|coordenadas|\bx\s*[:=]|\by\s*[:=]|width|height/i);
  assert.doesNotMatch(reasons, /\b(?:43|45|27|14|12)\b/);
});

test('appearance drift must satisfy the threshold between the first and third readings too', async () => {
  const samples = await Promise.all([100, 102, 104].map(async color => sample([control()], await image(240, [{ x: 8, y: 8, width: 20, height: 16, color }]))));
  const result = await compareSamples(samples);
  assert.equal(result.stable, false);
  assert.ok(Math.abs(result.maxAppearanceDifference - 4 / 255) < 1e-9);
});

test('background changes outside button crops do not prevent stability', async () => {
  const rectangle = { x: 8, y: 8, width: 20, height: 16, color: 70 };
  const samples = await Promise.all([0, 128, 255].map(async background => sample([control()], await image(background, [rectangle]))));
  const result = await compareSamples(samples);
  assert.equal(result.stable, true);
  assert.equal(result.maxAppearanceDifference, 0);
});

test('each crop is aligned using its own rectangle when a button moves within tolerance', async () => {
  const before = await image(240, [{ x: 8, y: 8, width: 20, height: 16, color: 30 }]);
  const after = await image(240, [{ x: 9, y: 8, width: 20, height: 16, color: 30 }]);
  const moved = control({ bbox: { x: 9, y: 8, width: 20, height: 16 } });
  const result = await compareSamples([sample([control()], before), sample([moved], after), sample([control()], before)]);
  assert.equal(result.stable, true);
  assert.equal(result.maxGeometryDeltaPx, 1);
  assert.equal(result.maxAppearanceDifference, 0);
});

test('vision hashes may change while duplicate labels are matched one-to-one within tolerance', async () => {
  const png = await image();
  const vision = (x, hash) => control({ source: 'vision', targetKey: hash, label: 'Más', bbox: { x, y: 8, width: 20, height: 16 } });
  // Greedily taking 10 -> 10.1 would strand the second control at 11.
  const first = [vision(10, 'vision:first-a'), vision(11, 'vision:first-b')];
  const middle = [vision(10.1, 'vision:middle-b'), vision(9.1, 'vision:middle-a')];
  const third = [vision(11, 'vision:third-b'), vision(10, 'vision:third-a')];
  const result = await compareSamples([sample(first, png), sample(middle, png), sample(third, png)]);
  assert.equal(result.stable, true);
  assert.ok(Math.abs(result.maxGeometryDeltaPx - 0.9) < 1e-9);
});

test('vision controls cannot reuse one close candidate to cover two original controls', async () => {
  const png = await image();
  const vision = (x, hash) => control({ source: 'vision', targetKey: hash, label: 'Más', bbox: { x, y: 8, width: 20, height: 16 } });
  const first = [vision(10, 'vision:a'), vision(11, 'vision:b')];
  const middle = [vision(10, 'vision:c'), vision(30, 'vision:d')];
  const result = await compareSamples([sample(first, png), sample(middle, png), sample(first, png)]);
  assert.equal(result.stable, false);
});

test('exactly three complete readings with the same page, epoch, and viewport are required', async () => {
  const png = await image();
  const a = sample([control()], png);
  for (const samples of [[], [a, a], [a, a, a, a], [a, { ...a, complete: false }, a], [a, { ...a, url: 'https://other.test/' }, a], [a, { ...a, epoch: 8 }, a], [a, { ...a, viewport: { width: 90, height: 60 } }, a]]) {
    const result = await compareSamples(samples);
    assert.equal(result.stable, false);
    assert.ok(result.reasons.length);
  }
});

test('malformed candidates and missing or invalid image pixels return unstable without throwing', async () => {
  const png = await image();
  const good = sample([control()], png);
  const badSamples = [
    null,
    { ...good, candidates: null },
    { ...good, png: Buffer.alloc(0) },
    { ...good, png: Buffer.from('not an image') },
    { ...good, viewport: { width: NaN, height: 60 } },
    { ...good, candidates: [control({ bbox: { x: NaN, y: 8, width: 20, height: 16 } })] },
    { ...good, candidates: [control({ bbox: { x: 8, y: 8, width: 0, height: 16 } })] },
    { ...good, candidates: [control({ clickPoint: { x: Infinity, y: 12 } })] },
    { ...good, candidates: [control({ actionable: undefined })] },
    { ...good, candidates: [control({ label: undefined })] },
    { ...good, candidates: [control({ targetKey: undefined })] },
    { ...good, candidates: [control(), control()] },
  ];
  for (const bad of badSamples) {
    const result = await compareSamples([good, bad, good]);
    assert.equal(result.stable, false);
    assert.ok(result.reasons.length);
    assert.equal(Number.isFinite(result.maxGeometryDeltaPx), true);
    assert.equal(Number.isFinite(result.maxAppearanceDifference), true);
  }
});

test('three identical empty control sets are stable without publishing positions', async () => {
  const samples = await Promise.all([0, 128, 255].map(async background => sample([], await image(background))));
  assert.deepEqual(await compareSamples(samples), { stable: true, reasons: [], maxGeometryDeltaPx: 0, maxAppearanceDifference: 0 });
});
