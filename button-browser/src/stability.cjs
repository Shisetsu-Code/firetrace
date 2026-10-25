'use strict';

const sharp = require('sharp');

const STABILITY_RULES = Object.freeze({ requiredSamples: 3, intervalMs: 2000, geometryTolerancePx: 1, maxCropDifference: 0.015 });

function finitePoint(point) {
  return point && typeof point === 'object' && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function normalizeCandidate(candidate, viewport) {
  if (!candidate || typeof candidate !== 'object' || typeof candidate.targetKey !== 'string' || !candidate.targetKey || typeof candidate.source !== 'string' || !candidate.source || typeof candidate.label !== 'string' || typeof candidate.kind !== 'string' || !candidate.kind || typeof candidate.actionable !== 'boolean') return null;
  const box = candidate.bbox;
  if (!box || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) || box.width <= 0 || box.height <= 0) return null;
  const right = box.x + box.width, bottom = box.y + box.height;
  if (!Number.isFinite(right) || !Number.isFinite(bottom) || right <= 0 || bottom <= 0 || box.x >= viewport.width || box.y >= viewport.height) return null;
  if (candidate.clickPoint !== undefined && !finitePoint(candidate.clickPoint)) return null;
  if (candidate.center !== undefined && !finitePoint(candidate.center)) return null;
  const point = candidate.clickPoint || candidate.center || { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (!finitePoint(point) || point.x < 0 || point.y < 0 || point.x >= viewport.width || point.y >= viewport.height) return null;
  return {
    targetKey: candidate.targetKey, source: candidate.source, label: candidate.label,
    kind: candidate.kind, actionable: candidate.actionable,
    bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
    geometry: [box.x, box.y, box.width, box.height, point.x, point.y],
  };
}

function geometryDelta(a, b) {
  let maximum = 0;
  for (let index = 0; index < a.geometry.length; index++) {
    maximum = Math.max(maximum, Math.abs(a.geometry[index] - b.geometry[index]));
  }
  return Number.isFinite(maximum) ? maximum : Number.MAX_VALUE;
}

function geometryCost(a, b) {
  const delta = geometryDelta(a, b);
  let distance = 0;
  for (let index = 0; index < a.geometry.length; index++) {
    distance += Math.min(1000, Math.abs(a.geometry[index] - b.geometry[index])) ** 2;
  }
  // A complete matching within tolerance takes priority over any closer but invalid assignment.
  return (delta > STABILITY_RULES.geometryTolerancePx ? 1e9 : 0) + distance;
}

// Minimum-cost one-to-one assignment. Unlike greedy nearest-neighbor matching,
// this also handles repeated vision labels with overlapping matching choices.
function closestAssignment(left, right) {
  const count = left.length;
  const costs = left.map(a => right.map(b => geometryCost(a, b)));
  const rowPotential = Array(count + 1).fill(0), columnPotential = Array(count + 1).fill(0);
  const rowAtColumn = Array(count + 1).fill(0), previousColumn = Array(count + 1).fill(0);
  for (let row = 1; row <= count; row++) {
    rowAtColumn[0] = row;
    let column = 0;
    const minimum = Array(count + 1).fill(Infinity), used = Array(count + 1).fill(false);
    do {
      used[column] = true;
      const activeRow = rowAtColumn[column];
      let delta = Infinity, nextColumn = 0;
      for (let candidateColumn = 1; candidateColumn <= count; candidateColumn++) {
        if (used[candidateColumn]) continue;
        const cost = costs[activeRow - 1][candidateColumn - 1] - rowPotential[activeRow] - columnPotential[candidateColumn];
        if (cost < minimum[candidateColumn]) {
          minimum[candidateColumn] = cost;
          previousColumn[candidateColumn] = column;
        }
        if (minimum[candidateColumn] < delta) {
          delta = minimum[candidateColumn];
          nextColumn = candidateColumn;
        }
      }
      for (let candidateColumn = 0; candidateColumn <= count; candidateColumn++) {
        if (used[candidateColumn]) {
          rowPotential[rowAtColumn[candidateColumn]] += delta;
          columnPotential[candidateColumn] -= delta;
        } else minimum[candidateColumn] -= delta;
      }
      column = nextColumn;
    } while (rowAtColumn[column] !== 0);
    do {
      const preceding = previousColumn[column];
      rowAtColumn[column] = rowAtColumn[preceding];
      column = preceding;
    } while (column !== 0);
  }
  const matches = Array(count);
  for (let column = 1; column <= count; column++) matches[rowAtColumn[column] - 1] = column - 1;
  return matches.map((rightIndex, leftIndex) => [left[leftIndex], right[rightIndex]]);
}

function visionGroups(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    if (candidate.source !== 'vision') continue;
    const key = JSON.stringify([candidate.label, candidate.kind, candidate.actionable]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  return groups;
}

function pairControls(left, right, reject) {
  const matches = [];
  const identity = candidate => JSON.stringify([candidate.source, candidate.targetKey]);
  const rightByIdentity = new Map(right.filter(candidate => candidate.source !== 'vision').map(candidate => [identity(candidate), candidate]));
  if (left.length !== right.length) reject('Cambió el conjunto de controles');
  for (const a of left) {
    if (a.source === 'vision') continue;
    const key = identity(a), b = rightByIdentity.get(key);
    if (!b) { reject('Cambió la identidad o el conjunto de controles'); continue; }
    rightByIdentity.delete(key);
    if (a.label !== b.label || a.kind !== b.kind || a.actionable !== b.actionable) reject('Cambió la etiqueta, el tipo o el estado de un control');
    matches.push([a, b]);
  }
  if (rightByIdentity.size) reject('Cambió la identidad o el conjunto de controles');
  const leftGroups = visionGroups(left), rightGroups = visionGroups(right);
  for (const [key, group] of leftGroups) {
    const other = rightGroups.get(key);
    if (!other || group.length !== other.length) { reject('Cambió el conjunto, la etiqueta, el tipo o el estado de controles visuales'); continue; }
    rightGroups.delete(key);
    matches.push(...closestAssignment(group, other));
  }
  if (rightGroups.size) reject('Cambió el conjunto, la etiqueta, el tipo o el estado de controles visuales');
  return matches;
}

async function cropPixels(record, decoded, viewport) {
  const scaleX = decoded.info.width / viewport.width, scaleY = decoded.info.height / viewport.height;
  const left = Math.max(0, Math.floor(record.bbox.x * scaleX));
  const top = Math.max(0, Math.floor(record.bbox.y * scaleY));
  const right = Math.min(decoded.info.width, Math.ceil((record.bbox.x + record.bbox.width) * scaleX));
  const bottom = Math.min(decoded.info.height, Math.ceil((record.bbox.y + record.bbox.height) * scaleY));
  if (right <= left || bottom <= top) throw new Error('Invalid crop');
  return sharp(decoded.data, { raw: { width: decoded.info.width, height: decoded.info.height, channels: 3 } })
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize(32, 32, { fit: 'fill' }).raw().toBuffer();
}

function appearanceDifference(a, b) {
  let total = 0;
  for (let index = 0; index < a.length; index++) total += Math.abs(a[index] - b[index]);
  return total / (a.length * 255);
}

/** Compare observations without publishing any candidate coordinates or mutating samples. */
async function compareSamples(samples) {
  const result = { stable: false, reasons: [], maxGeometryDeltaPx: 0, maxAppearanceDifference: 0 };
  const reasons = new Set();
  const finish = () => ({ ...result, stable: reasons.size === 0, reasons: [...reasons] });
  try {
    if (!Array.isArray(samples) || samples.length !== STABILITY_RULES.requiredSamples) {
      reasons.add('Se requieren exactamente tres lecturas completas.');
      return finish();
    }
    const prepared = [];
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      if (!sample || sample.complete !== true) { reasons.add(`La lectura ${index + 1} está incompleta.`); continue; }
      const viewport = sample.viewport;
      if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0 || typeof sample.url !== 'string' || !sample.url || !Number.isFinite(sample.epoch) || typeof sample.timestamp !== 'string' || !sample.timestamp || !Array.isArray(sample.candidates) || !Buffer.isBuffer(sample.png) || sample.png.length === 0) {
        reasons.add(`La lectura ${index + 1} contiene datos o píxeles inválidos.`);
        continue;
      }
      const candidates = sample.candidates.map(candidate => normalizeCandidate(candidate, viewport));
      const identities = new Set();
      let invalid = candidates.some(candidate => !candidate);
      for (const candidate of candidates) {
        if (!candidate || candidate.source === 'vision') continue;
        const key = JSON.stringify([candidate.source, candidate.targetKey]);
        if (identities.has(key)) invalid = true;
        identities.add(key);
      }
      if (invalid) { reasons.add(`La lectura ${index + 1} contiene controles inválidos o identidades repetidas.`); continue; }
      prepared.push({ sample, candidates });
    }
    if (reasons.size) return finish();

    // Decode complete screenshots, including empty control sets, so corrupt pixels
    // cannot accidentally pass verification just because there are no crops.
    for (let index = 0; index < prepared.length; index++) {
      const current = prepared[index];
      try {
        const decoded = await sharp(current.sample.png, { failOn: 'error' }).flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
        if (decoded.info.channels !== 3 || decoded.data.length !== decoded.info.width * decoded.info.height * 3) throw new Error('Invalid pixels');
        for (const candidate of current.candidates) candidate.pixels = await cropPixels(candidate, decoded, current.sample.viewport);
      } catch {
        reasons.add(`No se pudieron validar los píxeles de la lectura ${index + 1}.`);
      }
    }
    if (reasons.size) return finish();

    for (const [leftIndex, rightIndex] of [[0, 1], [0, 2], [1, 2]]) {
      const left = prepared[leftIndex], right = prepared[rightIndex];
      const reject = message => reasons.add(`${message} entre las lecturas ${leftIndex + 1} y ${rightIndex + 1}.`);
      if (left.sample.url !== right.sample.url || left.sample.epoch !== right.sample.epoch) reject('Cambió la página o su navegación');
      if (left.sample.viewport.width !== right.sample.viewport.width || left.sample.viewport.height !== right.sample.viewport.height) reject('Cambió el viewport');
      for (const [a, b] of pairControls(left.candidates, right.candidates, reject)) {
        const delta = geometryDelta(a, b);
        result.maxGeometryDeltaPx = Math.max(result.maxGeometryDeltaPx, delta);
        if (delta > STABILITY_RULES.geometryTolerancePx) reject('Cambió la geometría de un control');
        const difference = appearanceDifference(a.pixels, b.pixels);
        result.maxAppearanceDifference = Math.max(result.maxAppearanceDifference, difference);
        if (difference > STABILITY_RULES.maxCropDifference) reject('Cambió la apariencia de un control');
      }
    }
  } catch {
    reasons.add('No se pudieron comparar las lecturas por datos inválidos.');
  }
  return finish();
}

module.exports = { STABILITY_RULES, compareSamples };
