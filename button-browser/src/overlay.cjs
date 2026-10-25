'use strict';

const { randomUUID } = require('node:crypto');

const ownedOverlays = new WeakMap();
const OVERLAY_ATTRIBUTE = 'data-button-browser-coordinate-overlay';
const rounded = value => Math.round(value * 100) / 100;
const clamp = (value, low, high) => Math.max(low, Math.min(Math.max(low, high), value));
const escapeXML = value => String(value ?? '').toWellFormed()
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));

function normalizedButtons(buttons, viewport) {
  const { width, height } = viewport || {};
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new RangeError('La superposición necesita un viewport válido.');
  const result = [];
  for (const button of (Array.isArray(buttons) ? buttons : []).slice(0, 300)) {
    const box = button?.bbox;
    if (!box || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) || box.width <= 0 || box.height <= 0) continue;
    const x = Math.max(0, box.x), y = Math.max(0, box.y);
    const right = Math.min(width, box.x + box.width), bottom = Math.min(height, box.y + box.height);
    if (right <= x || bottom <= y) continue;
    const point = [button.clickPoint, button.center, { x: (x + right) / 2, y: (y + bottom) / 2 }]
      .find(candidate => candidate && Number.isFinite(candidate.x) && Number.isFinite(candidate.y));
    // An invalid reported point must not silently become a different coordinate.
    if (!point || point.x < 0 || point.y < 0 || point.x > width || point.y > height) continue;
    result.push({
      id: String(button.id ?? `b${result.length + 1}`).toWellFormed().slice(0, 80),
      fixed:button.fixed===true,
      bbox: { x: rounded(x), y: rounded(y), width: rounded(right - x), height: rounded(bottom - y) },
      point: { x: rounded(point.x), y: rounded(point.y) },
      color: button.fixed ? '#7cb7ff' : button.estimated ? '#fbbf24' : '#33e1bb'
    });
  }
  return result;
}

function labelPlacement(button, viewport, occupied) {
  const { bbox: box, point, id } = button;
  const margin = Math.min(3, viewport.width / 8, viewport.height / 8);
  const availableWidth = Math.max(1, viewport.width - margin * 2);
  const coordinates = `x ${point.x} · y ${point.y}`;
  const text = `${button.fixed?'Fijo · ':''}${id} · ${coordinates}`;
  const padding = Math.min(7, availableWidth / 8);
  let lines = [text], fontSize = 12;
  const length = line => Array.from(line).length;
  if (length(text) * fontSize * .64 + padding * 2 > availableWidth) lines = [id, coordinates];
  const longest = Math.max(...lines.map(length), 1);
  fontSize = Math.min(fontSize, Math.max(8, (availableWidth - padding * 2) / (longest * .64)));
  const lineHeight = fontSize + 3;
  const width = Math.min(availableWidth, Math.ceil(longest * fontSize * .64 + padding * 2));
  const height = Math.min(viewport.height - margin * 2, Math.ceil(lines.length * lineHeight + 8));
  const positions = [
    [box.x, box.y - height - 4],
    [box.x, box.y + box.height + 4],
    [box.x + box.width - width, box.y - height - 4],
    [box.x + box.width - width, box.y + box.height + 4],
    [box.x + box.width + 4, box.y],
    [box.x - width - 4, box.y],
    [box.x + 4, box.y + 4]
  ].map(([x, y]) => ({ x: clamp(x, margin, viewport.width - width - margin), y: clamp(y, margin, viewport.height - height - margin), width, height }));
  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const score = (position, index) => occupied.reduce((sum, old) => sum + overlap(position, old), 0) * 100 + overlap(position, box) + index * .01;
  let best = positions[0], bestScore = score(best, 0);
  for (let i = 1; i < positions.length; i++) {
    const value = score(positions[i], i);
    if (value < bestScore) { best = positions[i]; bestScore = value; }
  }
  occupied.push(best);
  return { ...best, lines, text, padding, fontSize, lineHeight };
}

function buildCoordinateSVG(buttons, viewport) {
  const normalized = normalizedButtons(buttons, viewport);
  const { width, height } = viewport;
  const occupied = [], outlines = [], labels = [];
  for (const button of normalized) {
    const { bbox: box, point, color } = button;
    const label = labelPlacement(button, viewport, occupied);
    const rect = `x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="2" fill="none"`;
    const crosshair = `M ${point.x - 8} ${point.y} H ${point.x + 8} M ${point.x} ${point.y - 8} V ${point.y + 8}`;
    outlines.push(`<g data-coordinate-button="${escapeXML(button.id)}" pointer-events="none"><rect ${rect} stroke="#031019" stroke-width="4"/><rect ${rect} stroke="${color}" stroke-width="2"/><g data-coordinate-crosshair="${escapeXML(button.id)}" data-x="${point.x}" data-y="${point.y}" pointer-events="none"><path d="${crosshair}" fill="none" stroke="#031019" stroke-width="4"/><path d="${crosshair}" fill="none" stroke="${color}" stroke-width="2"/><circle cx="${point.x}" cy="${point.y}" r="4" fill="none" stroke="${color}" stroke-width="1.5"/></g></g>`);
    const available = Math.max(1, label.width - label.padding * 2);
    const lines = label.lines.map((line, index) => {
      const fit = Array.from(line).length * label.fontSize * .64 > available ? ` textLength="${available}" lengthAdjust="spacingAndGlyphs"` : '';
      return `<tspan x="${rounded(label.x + label.padding)}" y="${rounded(label.y + 4 + label.fontSize + index * label.lineHeight)}"${fit}>${escapeXML(line)}</tspan>`;
    }).join('');
    labels.push(`<g data-coordinate-label="${escapeXML(button.id)}" pointer-events="none"><rect x="${rounded(label.x)}" y="${rounded(label.y)}" width="${rounded(label.width)}" height="${rounded(label.height)}" rx="4" fill="#06131f" fill-opacity=".96" stroke="${color}" stroke-width="1"/><text fill="#effffb" font-family="DejaVu Sans Mono,Consolas,monospace" font-size="${rounded(label.fontSize)}" font-weight="600" pointer-events="none">${lines}</text></g>`);
  }
  return {
    count: normalized.length,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false" pointer-events="none" style="pointer-events:none;display:block;overflow:hidden">${outlines.join('')}${labels.join('')}</svg>`
  };
}

/** Render supplied dynamic or explicitly saved coordinates without detection. */
function createCoordinateSVG(buttons, viewport) {
  return buildCoordinateSVG(buttons, viewport).svg;
}

/** Add an owned, inert viewport overlay without dispatching page input events. */
async function showCoordinateOverlay(page, buttons, viewport) {
  const built = buildCoordinateSVG(buttons, viewport);
  if (!built.count) { await clearCoordinateOverlay(page); return { count: 0 }; }
  let id = ownedOverlays.get(page);
  if (!id) { id = 'bb-coordinates-' + randomUUID(); ownedOverlays.set(page, id); }
  await page.evaluate(({ id, attribute, svg, width, height }) => {
    let host = document.getElementById(id);
    if (host && host.getAttribute(attribute) !== id) throw new Error('El identificador de la superposición ya está ocupado.');
    if (!host) {
      host = document.createElement('div');
      host.id = id;
      host.setAttribute(attribute, id);
      host.setAttribute('aria-hidden', 'true');
      host.setAttribute('inert', '');
      host.attachShadow({ mode: 'open' });
      document.documentElement.append(host);
    }
    const styles = {
      all: 'initial', position: 'fixed', left: '0px', top: '0px', right: 'auto', bottom: 'auto',
      width: `${width}px`, height: `${height}px`, margin: '0px', padding: '0px', border: '0px',
      display: 'block', 'box-sizing': 'border-box', 'pointer-events': 'none', 'user-select': 'none',
      'z-index': '2147483647', overflow: 'hidden', opacity: '1', visibility: 'visible',
      background: 'transparent', transform: 'none', transition: 'none', animation: 'none',
      'clip-path': 'none', filter: 'none', 'mix-blend-mode': 'normal', isolation: 'isolate',
      contain: 'strict', zoom: '1', cursor: 'default'
    };
    for (const [property, value] of Object.entries(styles)) host.style.setProperty(property, value, 'important');
    // SVG strings contain only fixed markup, finite numbers, and escaped text.
    // The isolated style also prevents inherited page cursors or pointer rules
    // from making any overlay descendant appear interactive to a detector.
    host.shadowRoot.innerHTML = '<style>:host,*{pointer-events:none!important;user-select:none!important;cursor:default!important}svg{display:block!important}</style>' + svg;
  }, { id, attribute: OVERLAY_ATTRIBUTE, svg: built.svg, width: viewport.width, height: viewport.height });
  return { count: built.count };
}

/** Remove only the host created for this Page; unrelated page markers survive. */
async function clearCoordinateOverlay(page) {
  const id = ownedOverlays.get(page);
  if (!id || page.isClosed?.()) return;
  await page.evaluate(({ id, attribute }) => {
    const host = document.getElementById(id);
    if (host?.getAttribute(attribute) === id) host.remove();
  }, { id, attribute: OVERLAY_ATTRIBUTE });
}

module.exports = { createCoordinateSVG, showCoordinateOverlay, clearCoordinateOverlay };
