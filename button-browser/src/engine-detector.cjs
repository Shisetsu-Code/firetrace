'use strict';

const { randomUUID } = require('node:crypto');

const MAX_FRAMES = 24;
const MAX_CANVASES = 32;
const MAX_BUTTONS = 250;

function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

function mapRect(rect, transform) {
  return { x: transform.x + rect.x * transform.sx, y: transform.y + rect.y * transform.sy, width: rect.width * transform.sx, height: rect.height * transform.sy };
}

// These functions run in a frame's main world. They read geometry and event
// listener state; they never call a game's getters, hitTest, or event handlers.
function probeElement() {
  const element = this;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const px = value => Number.parseFloat(value) || 0;
  const bx = px(style.borderLeftWidth) + px(style.borderRightWidth);
  const by = px(style.borderTopWidth) + px(style.borderBottomWidth);
  const pLeft = px(style.paddingLeft), pTop = px(style.paddingTop);
  const paddingX = pLeft + px(style.paddingRight), paddingY = pTop + px(style.paddingBottom);
  const borderWidth = style.boxSizing === 'border-box' ? px(style.width) : px(style.width) + bx + paddingX;
  const borderHeight = style.boxSizing === 'border-box' ? px(style.height) : px(style.height) + by + paddingY;
  const sx = borderWidth ? rect.width / borderWidth : 0, sy = borderHeight ? rect.height / borderHeight : 0;
  const content = {
    x: rect.left + (px(style.borderLeftWidth) + pLeft) * sx,
    y: rect.top + (px(style.borderTopWidth) + pTop) * sy,
    width: Math.max(0, (borderWidth - bx - paddingX) * sx),
    height: Math.max(0, (borderHeight - by - paddingY) * sy)
  };
  let clip = { x: 0, y: 0, width: innerWidth, height: innerHeight };
  let visible = true, supported = true, depth = 0;
  const cut = (a, b, horizontal = true, vertical = true) => {
    const x = horizontal ? Math.max(a.x, b.x) : a.x;
    const y = vertical ? Math.max(a.y, b.y) : a.y;
    return { x, y, width: horizontal ? Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x) : a.width, height: vertical ? Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) : a.height };
  };
  for (let node = element; node && depth++ < 80; node = node.parentElement || node.getRootNode()?.host) {
    const css = getComputedStyle(node);
    if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || Number(css.opacity) <= 0.01) visible = false;
    if (css.transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(css.transform);
      if (!matrix.is2D || Math.abs(matrix.b) > 1e-6 || Math.abs(matrix.c) > 1e-6 || matrix.a <= 0 || matrix.d <= 0) supported = false;
    }
    if (css.rotate && css.rotate !== 'none' && !/^0(?:deg|rad|turn)?$/.test(css.rotate)) supported = false;
    if (css.scale && css.scale !== 'none' && css.scale.split(/\s+/).some(value => Number(value) <= 0)) supported = false;
    if (node !== element && /hidden|clip|scroll|auto/.test(css.overflowX + ' ' + css.overflowY)) {
      const b = node.getBoundingClientRect();
      clip = cut(clip, { x: b.left, y: b.top, width: b.width, height: b.height }, css.overflowX !== 'visible', css.overflowY !== 'visible');
    }
  }
  if (element.tagName === 'CANVAS' && style.objectFit !== 'fill') supported = false;
  clip = cut(clip, content);
  return { content, clip, visible: visible && clip.width > 0 && clip.height > 0, supported, viewport: { width: innerWidth, height: innerHeight } };
}

function pointsReachElement(points) {
  return points.map(point => {
    let target = document.elementFromPoint(point.x, point.y);
    for (let depth = 0; target?.shadowRoot && depth < 20; depth++) {
      const inner = target.shadowRoot.elementFromPoint(point.x, point.y);
      if (!inner || inner === target) break;
      target = inner;
    }
    return target === this;
  });
}

function inspectPixiScene(options, canvas) {
  const started = performance.now();
  // Use data descriptors to avoid lazy game properties that create components
  // or alter enabled state. Pixi worldTransform is read through transform.
  const read = (object, key, fallback) => {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return fallback;
    let cursor = object;
    for (let depth = 0; cursor && depth < 10; depth++, cursor = Object.getPrototypeOf(cursor)) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
      if (descriptor) return Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : fallback;
    }
    return fallback;
  };
  const renderer = read(this, 'renderer');
  const eventCanvas = read(this, 'interactionDOMElement') || read(this, 'domElement');
  const boundary = read(this, 'rootBoundary');
  const root = read(renderer, '_lastObjectRendered') || read(boundary, 'rootTarget');
  if (eventCanvas !== canvas || !root || !Array.isArray(read(root, 'children'))) return null;
  const resolution = Number(read(renderer, 'resolution', 1)) || 1;
  const logicalWidth = canvas.width / resolution, logicalHeight = canvas.height / resolution;
  if (!logicalWidth || !logicalHeight) return { buttons: [], warnings: [] };
  const css = options.content, clip = options.clip;
  const scaleX = css.width / logicalWidth, scaleY = css.height / logicalHeight;
  const identity = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  const finite = value => Number.isFinite(value);
  const point = (matrix, x, y) => ({ x: matrix.a * x + matrix.c * y + matrix.tx, y: matrix.b * x + matrix.d * y + matrix.ty });
  const multiply = (a, b) => ({ a: a.a * b.a + a.c * b.b, b: a.b * b.a + a.d * b.b, c: a.a * b.c + a.c * b.d, d: a.b * b.c + a.d * b.d, tx: a.a * b.tx + a.c * b.ty + a.tx, ty: a.b * b.tx + a.d * b.ty + a.ty });
  const matrixOf = node => {
    const matrix = read(read(node, 'transform'), 'worldTransform') || read(node, 'worldTransform');
    if (!matrix) return identity;
    const result = {};
    for (const key of ['a', 'b', 'c', 'd', 'tx', 'ty']) {
      result[key] = read(matrix, key, identity[key]);
      if (!finite(result[key])) return identity;
    }
    return result;
  };
  const union = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
  };
  const clipBox = (a, b) => {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
  };
  const boundsOf = points => {
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  };
  const shape = (source, matrix = identity, padding = 0) => {
    if (!source) return null;
    const points = read(source, 'points');
    let normalized;
    if (Array.isArray(points) || ArrayBuffer.isView(points)) {
      if (points.length < 6 || points.length > 4096) return null;
      normalized = { type: 'polygon', points: Array.from(points) };
    } else {
      const x = Number(read(source, 'x', 0)), y = Number(read(source, 'y', 0));
      const radius = read(source, 'radius');
      const width = read(source, 'width'), height = read(source, 'height');
      if (finite(radius) && !finite(width)) normalized = { type: 'ellipse', x, y, rx: radius + padding, ry: radius + padding };
      else if (finite(width) && finite(height)) {
        normalized = read(source, 'type') === 3
          ? { type: 'ellipse', x, y, rx: width + padding, ry: height + padding }
          : { type: 'rect', x: x - padding, y: y - padding, width: width + padding * 2, height: height + padding * 2 };
      } else return null;
    }
    normalized.matrix = matrix;
    const m = matrix;
    if (normalized.type === 'ellipse') {
      const center = point(m, normalized.x, normalized.y);
      const rx = Math.hypot(m.a * normalized.rx, m.c * normalized.ry), ry = Math.hypot(m.b * normalized.rx, m.d * normalized.ry);
      normalized.bounds = { x: center.x - rx, y: center.y - ry, width: 2 * rx, height: 2 * ry };
    } else {
      const points = normalized.type === 'polygon' ? normalized.points : [normalized.x, normalized.y, normalized.x + normalized.width, normalized.y, normalized.x + normalized.width, normalized.y + normalized.height, normalized.x, normalized.y + normalized.height];
      const transformed = [];
      for (let i = 0; i < points.length; i += 2) transformed.push(point(m, points[i], points[i + 1]));
      normalized.bounds = boundsOf(transformed);
    }
    return normalized;
  };
  const containsShape = (s, p) => {
    if (!s) return false;
    const m = s.matrix, determinant = m.a * m.d - m.b * m.c;
    if (Math.abs(determinant) < 1e-10) return false;
    const dx = p.x - m.tx, dy = p.y - m.ty;
    const x = (m.d * dx - m.c * dy) / determinant, y = (m.a * dy - m.b * dx) / determinant;
    if (s.type === 'rect') return x >= s.x && y >= s.y && x <= s.x + s.width && y <= s.y + s.height;
    if (s.type === 'ellipse') return s.rx > 0 && s.ry > 0 && ((x - s.x) / s.rx) ** 2 + ((y - s.y) / s.ry) ** 2 <= 1;
    let inside = false;
    const pxy = s.points;
    for (let i = 0, j = pxy.length - 2; i < pxy.length; j = i, i += 2) {
      const xi = pxy[i], yi = pxy[i + 1], xj = pxy[j], yj = pxy[j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const visualShapes = (node, matrix) => {
    const result = [];
    const geometry = read(node, 'geometry') || read(node, '_geometry');
    const graphics = read(geometry, 'graphicsData');
    if (Array.isArray(graphics)) {
      for (const graphic of graphics.slice(0, 256)) {
        const local = read(graphic, 'matrix');
        const world = local ? multiply(matrix, local) : matrix;
        const line = read(graphic, 'lineStyle');
        const item = shape(read(graphic, 'shape'), world, (Number(read(line, 'width', 0)) || 0) / 2);
        if (item) {
          item.holes = (read(graphic, 'holes', []) || []).slice(0, 64).map(h => shape(read(h, 'shape'), world)).filter(Boolean);
          result.push(item);
        }
      }
    }
    const texture = read(node, '_texture') || read(node, 'texture');
    const original = read(texture, 'orig');
    if (original && read(original, 'width', 0) > 0 && read(original, 'height', 0) > 0) {
      const anchor = read(node, '_anchor') || read(node, 'anchor');
      const ax = Number(read(anchor, '_x', read(anchor, 'x', 0))) || 0;
      const ay = Number(read(anchor, '_y', read(anchor, 'y', 0))) || 0;
      const trim = read(texture, 'trim');
      const box = { x: (read(trim, 'x', 0) || 0) - ax * read(original, 'width'), y: (read(trim, 'y', 0) || 0) - ay * read(original, 'height'), width: read(trim, 'width', read(original, 'width')), height: read(trim, 'height', read(original, 'height')) };
      const item = shape(box, matrix);
      if (item) result.push(item);
    }
    return result;
  };
  const names = new WeakMap();
  const componentNames = new WeakMap();
  const megatonButtons = new WeakMap();
  const entities = read(read(read(root, '_resourceManager'), '_entityManager'), '_root');
  const entityStack = entities ? [{ entity: entities, prefix: '' }] : [];
  const entitySeen = new Set();
  while (entityStack.length && entitySeen.size < 1500) {
    const { entity, prefix } = entityStack.pop();
    if (!entity || entitySeen.has(entity)) continue;
    entitySeen.add(entity);
    const scene = read(entity, '_sceneNode');
    if (scene && prefix) names.set(scene, prefix);
    const components = read(entity, '_components', {});
    for (const key of Object.keys(components).slice(0, 1000)) {
      const component = read(components, key);
      const componentNode = read(component, '_node');
      if (componentNode && typeof componentNode === 'object' && typeof read(component, '_onPress') === 'function' &&
          read(read(component, '_clickEvent'), 'type') === 'button_click' &&
          read(read(component, '_mouseDownEvent'), 'type') === 'button_mouse_down' &&
          read(read(component, '_mouseUpEvent'), 'type') === 'button_mouse_up' &&
          read(read(component, '_mouseMoveEvent'), 'type') === 'button_mouse_move') {
        const buttons = megatonButtons.get(componentNode) || [];
        if (!buttons.includes(component)) buttons.push(component);
        megatonButtons.set(componentNode, buttons);
      }
      if (componentNode && key.includes('$')) {
        const label = read(component, '_name') || key.split('$')[0];
        if (typeof label === 'string' && label) componentNames.set(componentNode, label);
      }
      const items = read(component, '_items');
      if (items) for (const label of Object.keys(items).slice(0, 1000)) entityStack.push({ entity: read(items, label), prefix: prefix ? prefix + '.' + label : label });
    }
  }
  const clickEventTypes = ['click', 'tap', 'pointertap', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];
  const actionEventTypes = new Set([...clickEventTypes, 'mouseupoutside', 'touchendoutside', 'pointerupoutside', 'mousemove', 'pointermove', 'touchmove']);
  const isPassiveMegaton = (node, scene, handler, events) => {
    // Zr.updateHandlers always installs press/hover bridges, including on a
    // full-scene wrapper with no action. Do not mistake those bridges for a
    // button. Unknown adapters, independent Pixi listeners and real controls
    // retain their existing behavior; no engine method or getter is invoked.
    if (read(handler, '_node') !== node || read(handler, '_clickHandler') !== null || read(handler, '_moveHandler') !== null) return false;
    const internal = read(handler, '_onButton');
    if (typeof internal !== 'function') return false;
    const components = (megatonButtons.get(scene) || []).filter(component => read(component, '_onPress') === read(handler, '_pressHandler'));
    if (!components.length) return false;
    for (const component of components) {
      const dispatchers = read(component, '_dispatchers');
      if (!dispatchers || typeof dispatchers !== 'object') return false;
      for (const type of ['', 'button_click', 'button_mouse_down', 'button_mouse_up', 'button_mouse_move']) {
        const descriptor = Object.getOwnPropertyDescriptor(dispatchers, type);
        if (!descriptor) { if (type === '') return false; continue; }
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false;
        const sentinel = read(descriptor.value, '_children');
        // A missing/unreadable list is unknown, not evidence of no action.
        if (!sentinel || read(sentinel, 'next') !== sentinel) return false;
      }
    }
    if (!events || typeof events !== 'object') return false;
    const types = Object.keys(events);
    if (types.length > 1000) return false;
    for (const type of types) {
      // Lifecycle and hover listeners alone are not click/press/drag actions.
      if (!actionEventTypes.has(type)) continue;
      const entry = read(events, type);
      const listeners = Array.isArray(entry) ? entry : [entry];
      if (listeners.length > 1000) return false;
      for (let i = 0; i < listeners.length; i++) {
        const listener = read(listeners, i);
        if ((typeof listener === 'function' ? listener : read(listener, 'fn')) !== internal) return false;
      }
    }
    return true;
  };
  const stack = [{ node: root, parent: null, path: '0', visible: true, interactiveChildren: true, depth: 0 }];
  const records = [], seen = new Set();
  let truncated = false, unknownMask = false;
  while (stack.length) {
    if (records.length >= 12000 || performance.now() - started > 350) { truncated = true; break; }
    const entry = stack.pop(), node = entry.node;
    if (!node || seen.has(node) || entry.depth > 96) continue;
    seen.add(node);
    const scene = read(node, '_sceneNode');
    const visible = entry.visible && read(node, 'visible', true) !== false && read(node, 'renderable', true) !== false && read(node, 'worldAlpha', 1) > 0.01 && read(scene, 'priority', 0) <= 5;
    if (!visible) continue;
    const timelineElements = read(read(scene, '_timeLine'), 'elements', []);
    const sceneElements = read(scene, 'elements', []);
    for (let i = 0; i < Math.min(sceneElements.length || 0, 3000); i++) {
      const name = read(timelineElements[i], 'instanceName');
      if (sceneElements[i] && typeof name === 'string' && name) names.set(sceneElements[i], name);
    }
    const matrix = matrixOf(node);
    const hit = shape(read(node, 'hitArea'), matrix);
    const own = read(node, 'isMask') ? [] : visualShapes(node, matrix);
    const maskData = read(node, '_mask');
    const maskObject = read(maskData, 'maskObject', maskData);
    const masks = [];
    if (maskObject) {
      const pending = [maskObject];
      for (let visited = 0; pending.length && visited < 100; visited++) {
        const masked = pending.pop();
        masks.push(...visualShapes(masked, matrixOf(masked)));
        const children = read(masked, 'children', []);
        if (Array.isArray(children)) pending.push(...children.slice(0, 100));
      }
    }
    const handler = read(node, '_buttonHandler');
    const events = read(node, '_events', {});
    const clickEvents = clickEventTypes.some(key => read(events, key));
    const explicitClick = typeof read(handler, '_clickHandler') === 'function';
    const interactive = read(node, 'interactive') === true || ['static', 'dynamic'].includes(read(node, '_eventMode', read(node, 'eventMode')));
    const actionable = interactive && entry.interactiveChildren && read(handler, '_enabled', true) !== false;
    const name = componentNames.get(scene) || read(node, 'label') || read(node, 'name') || names.get(scene) || '';
    const button = explicitClick || clickEvents || read(node, 'cursor') === 'pointer' || /(?:btn|button)(?:$|[._])/i.test(name);
    const controlHandler = typeof read(handler, '_pressHandler') === 'function' || typeof read(handler, '_moveHandler') === 'function';
    const eligible = entry.interactiveChildren && (button || controlHandler) && (interactive || (options.includeDisabled && (clickEvents || explicitClick || controlHandler))) && !isPassiveMegaton(node, scene, handler, events);
    const record = { node, parent: entry.parent, path: entry.path, matrix, hit, own, masks, unknownMask: !!maskObject && !masks.length, children: [], name: typeof name === 'string' ? name.slice(0, 180) : '', button, eligible, actionable, interactive, explicitClick, clickEvents, bounds: own.reduce((box, s) => union(box, s.bounds), null) };
    if (!record.bounds && hit) record.bounds = hit.bounds;
    records.push(record);
    if (entry.parent) entry.parent.children.push(record);
    const children = read(node, 'children', []);
    if (Array.isArray(children)) {
      for (let i = Math.min(children.length, 6000) - 1; i >= 0; i--) stack.push({ node: children[i], parent: record, path: entry.path + '.' + i, visible, interactiveChildren: entry.interactiveChildren && read(node, 'interactiveChildren', true) !== false, depth: entry.depth + 1 });
    }
  }
  for (let i = records.length - 1; i >= 0; i--) if (records[i].parent) records[i].parent.bounds = union(records[i].parent.bounds, records[i].bounds);
  const pointInVisual = (record, p, depth = 0) => {
    if (depth > 96) return false;
    if (record.hit) return containsShape(record.hit, p);
    for (const s of record.own) if (containsShape(s, p) && !s.holes?.some(h => containsShape(h, p))) return true;
    return read(record.node, 'interactiveChildren', true) !== false && record.children.some(child => pointInVisual(child, p, depth + 1));
  };
  const pointAllowed = (record, p) => {
    for (let ancestor = record, depth = 0; ancestor && depth < 96; ancestor = ancestor.parent, depth++) {
      if (ancestor.unknownMask) return false;
      if (ancestor.masks.length && !ancestor.masks.some(s => containsShape(s, p) && !s.holes?.some(h => containsShape(h, p)))) return false;
      if (ancestor !== record && ancestor.hit && !containsShape(ancestor.hit, p)) return false;
    }
    return pointInVisual(record, p);
  };
  const inBox = (p, b) => b && p.x >= b.x && p.y >= b.y && p.x <= b.x + b.width && p.y <= b.y + b.height;
  const hitRecords = records.filter(record => record.actionable && record.bounds);
  const reachesCanvas = p => {
    let target = document.elementFromPoint(p.x, p.y);
    for (let depth = 0; target?.shadowRoot && depth < 20; depth++) {
      const inner = target.shadowRoot.elementFromPoint(p.x, p.y);
      if (!inner || inner === target) break;
      target = inner;
    }
    return target === canvas;
  };
  const buttons = [];
  for (const record of records) {
    if (buttons.length >= options.maxButtons || performance.now() - started > 550) { truncated = true; break; }
    if (!record.eligible || !record.bounds) continue;
    let b = record.bounds;
    let unsupported = false;
    for (let ancestor = record, depth = 0; ancestor && depth < 96; ancestor = ancestor.parent, depth++) {
      if (ancestor.unknownMask) { unknownMask = true; unsupported = true; break; }
      if (ancestor.masks.length) b = clipBox(b, ancestor.masks.reduce((box, s) => union(box, s.bounds), null));
    }
    if (unsupported || b.width <= 0 || b.height <= 0) continue;
    const raw = { x: css.x + b.x * scaleX, y: css.y + b.y * scaleY, width: b.width * scaleX, height: b.height * scaleY };
    const x = Math.max(raw.x, clip.x), y = Math.max(raw.y, clip.y);
    const box = { x, y, width: Math.max(0, Math.min(raw.x + raw.width, clip.x + clip.width) - x), height: Math.max(0, Math.min(raw.y + raw.height, clip.y + clip.height) - y) };
    if (box.width < 2 || box.height < 2) continue;
    const points = [];
    for (const [u, v] of [[.5, .5], [.25, .25], [.75, .25], [.25, .75], [.75, .75], [.1, .5], [.9, .5], [.5, .1], [.5, .9]]) {
      const p = { x: box.x + box.width * u, y: box.y + box.height * v };
      const world = { x: (p.x - css.x) / scaleX, y: (p.y - css.y) / scaleY };
      if (!pointAllowed(record, world) || !reachesCanvas(p)) continue;
      let blocker = null;
      for (let i = hitRecords.length - 1; i >= 0; i--) {
        const other = hitRecords[i];
        if (inBox(world, other.bounds) && pointAllowed(other, world)) { blocker = other; break; }
      }
      if (blocker && blocker !== record) continue;
      points.push(p);
    }
    if (!points.length) continue;
    let label = record.name;
    if (!label) {
      const texts = record.children.map(child => read(child.node, '_text')).filter(value => typeof value === 'string' && value.trim());
      label = texts.join(' ').slice(0, 120) || (record.button ? 'Botón Pixi' : 'Control Pixi');
    }
    buttons.push({ label, kind: record.button ? 'button' : 'control', source: 'pixi', confidence: record.explicitClick ? .99 : record.clickEvents ? .97 : .88, actionable: record.actionable, bbox: box, points, nodePath: record.path });
  }
  const warnings = [];
  if (truncated) warnings.push('Se alcanzó el límite de recorrido de la escena Pixi; puede haber controles adicionales.');
  if (unknownMask) warnings.push('Se omitieron controles con máscaras Pixi de geometría no recuperable.');
  return { buttons, warnings };
}

/** Recover private Pixi scenes through bound canvas listeners, without hooks or clicks. */
async function detectEngineButtons(page, { includeDisabled = false } = {}) {
  const result = { buttons: [], warnings: [], canvasCount: 0 };
  const group = 'button-browser-pixi-' + randomUUID();
  const sessions = [];
  const frames = new Map();
  const contexts = new Map();
  const mappings = new Map();
  const deadline = Date.now() + 7500;
  const warning = message => { if (!result.warnings.includes(message) && result.warnings.length < 20) result.warnings.push(message); };
  const send = async (session, method, params = {}) => {
    const remaining = Math.min(1600, deadline - Date.now());
    if (remaining <= 0) throw new Error('inspection-timeout');
    let timer;
    try {
      return await Promise.race([session.send(method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('inspection-timeout')), remaining); })]);
    } finally { clearTimeout(timer); }
  };
  const call = async (session, objectId, fn, args = []) => {
    const response = await send(session, 'Runtime.callFunctionOn', { objectId, functionDeclaration: fn.toString(), arguments: args, returnByValue: true, silent: true, objectGroup: group });
    if (response.exceptionDetails) throw new Error('inspection-evaluation-failed');
    return response.result?.value;
  };
  const rememberTree = (tree, parentId) => {
    const id = tree.frame.id;
    frames.set(id, { parentId: tree.frame.parentId || parentId || frames.get(id)?.parentId });
    for (const child of tree.childFrames || []) rememberTree(child, id);
  };
  const attach = async subject => {
    const session = await page.context().newCDPSession(subject);
    sessions.push(session);
    session.on('Runtime.executionContextCreated', ({ context }) => {
      if (context.auxData?.isDefault && context.auxData.frameId) contexts.set(context.auxData.frameId, { session, contextId: context.id });
    });
    await send(session, 'Runtime.enable');
    const { frameTree } = await send(session, 'Page.getFrameTree');
    rememberTree(frameTree);
    return frameTree.frame.id;
  };
  const viewport = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  let mainId;
  const mappingFor = async (frameId, depth = 0) => {
    if (mappings.has(frameId)) return mappings.get(frameId);
    if (depth > 24) return null;
    const record = frames.get(frameId), context = contexts.get(frameId);
    if (!record?.parentId || !context) return null;
    const parent = await mappingFor(record.parentId, depth + 1);
    const parentContext = contexts.get(record.parentId);
    if (!parent || !parentContext) return null;
    const owner = await send(parentContext.session, 'DOM.getFrameOwner', { frameId });
    const resolved = await send(parentContext.session, 'DOM.resolveNode', { backendNodeId: owner.backendNodeId, executionContextId: parentContext.contextId, objectGroup: group });
    if (!resolved.object?.objectId) return null;
    const probe = await call(parentContext.session, resolved.object.objectId, probeElement);
    if (!probe?.visible) return null;
    if (!probe.supported) { warning('Se omitió un iframe con rotación, perspectiva o escala invertida: sus coordenadas requieren otro adaptador.'); return null; }
    const dimensions = await send(context.session, 'Runtime.evaluate', { expression: '({width:innerWidth,height:innerHeight})', contextId: context.contextId, returnByValue: true, timeout: 400, objectGroup: group });
    const size = dimensions.result?.value;
    if (!size?.width || !size?.height) return null;
    const content = mapRect(probe.content, parent);
    const mapping = { x: content.x, y: content.y, sx: content.width / size.width, sy: content.height / size.height, clip: intersect(parent.clip, mapRect(probe.clip, parent)), owners: [...parent.owners, { session: parentContext.session, objectId: resolved.object.objectId, transform: parent }] };
    mappings.set(frameId, mapping);
    return mapping;
  };
  try {
    mainId = await attach(page);
    mappings.set(mainId, { x: 0, y: 0, sx: 1, sy: 1, clip: { x: 0, y: 0, ...viewport }, owners: [] });
    const childFrames = page.frames().filter(frame => frame !== page.mainFrame());
    for (const frame of childFrames.slice(0, MAX_FRAMES - 1)) {
      try { await attach(frame); } catch (error) {
        // Same-process frames already have an execution context in their parent
        // target. OOPIFs get their own session. Neither requires cross-origin JS.
        if (Date.now() >= deadline) throw error;
      }
    }
    if (childFrames.length >= MAX_FRAMES) warning('Se alcanzó el límite de iframes de la inspección Pixi.');
    for (const [frameId, context] of contexts) {
      if (result.canvasCount >= MAX_CANVASES || result.buttons.length >= MAX_BUTTONS) { warning('Se alcanzó el límite de canvas o controles de la inspección Pixi.'); break; }
      const { session, contextId } = context;
      try {
        const collection = await send(session, 'Runtime.evaluate', {
          expression: '(() => { const roots=[document], found=[]; let visited=0; while(roots.length && visited++<200 && found.length<32){const r=roots.pop();for(const c of r.querySelectorAll("canvas")){if(found.length<32)found.push(c)}for(const e of r.querySelectorAll("*")){if(e.shadowRoot)roots.push(e.shadowRoot)}} return found })()',
          contextId, objectGroup: group, timeout: 500, silent: true
        });
        if (!collection.result?.objectId || collection.exceptionDetails) continue;
        const properties = await send(session, 'Runtime.getProperties', { objectId: collection.result.objectId, ownProperties: true });
        const canvases = properties.result.filter(property => /^\d+$/.test(property.name) && property.value?.objectId);
        if (!canvases.length) continue;
        let mapping;
        try { mapping = await mappingFor(frameId); } catch { /* detached or unsupported iframe */ }
        if (!mapping) { warning('No se pudo resolver la posición de un iframe con canvas; se omitieron sus coordenadas.'); continue; }
        for (const canvas of canvases) {
          if (result.canvasCount++ >= MAX_CANVASES) break;
          const canvasId = canvas.value.objectId;
          const probe = await call(session, canvasId, probeElement);
          if (!probe?.visible) continue;
          if (!probe.supported) { warning('Se omitió un canvas con una transformación CSS que no permite coordenadas rectangulares fiables.'); continue; }
          const listeners = await send(session, 'DOMDebugger.getEventListeners', { objectId: canvasId, depth: 1 });
          let recovered = null;
          const examined = new Set();
          for (const listener of listeners.listeners.filter(item => /^(pointerdown|mousedown|touchstart|pointerover)$/.test(item.type)).slice(0, 12)) {
            for (const handler of [listener.originalHandler, listener.handler]) {
              if (!handler?.objectId || examined.has(handler.objectId)) continue;
              examined.add(handler.objectId);
              const details = await send(session, 'Runtime.getProperties', { objectId: handler.objectId, ownProperties: true });
              const bound = details.internalProperties?.find(property => property.name === '[[BoundThis]]')?.value;
              if (!bound?.objectId) continue;
              recovered = await call(session, bound.objectId, inspectPixiScene, [
                { value: { includeDisabled, content: probe.content, clip: probe.clip, maxButtons: MAX_BUTTONS - result.buttons.length } },
                { objectId: canvasId }
              ]);
              if (recovered) break;
            }
            if (recovered) break;
          }
          if (!recovered) { warning('Hay canvas visibles cuyo motor no expone una escena Pixi recuperable; la detección DOM no puede enumerar sus botones.'); continue; }
          for (const message of recovered.warnings || []) warning(message);
          const candidates = recovered.buttons || [];
          const mappedPoints = candidates.flatMap(candidate => candidate.points.map(p => ({ x: mapping.x + p.x * mapping.sx, y: mapping.y + p.y * mapping.sy })));
          let allowed = mappedPoints.map(p => p.x >= mapping.clip.x && p.y >= mapping.clip.y && p.x < mapping.clip.x + mapping.clip.width && p.y < mapping.clip.y + mapping.clip.height);
          for (const owner of mapping.owners) {
            const localPoints = mappedPoints.map(p => ({ x: (p.x - owner.transform.x) / owner.transform.sx, y: (p.y - owner.transform.y) / owner.transform.sy }));
            const visible = await call(owner.session, owner.objectId, pointsReachElement, [{ value: localPoints }]);
            allowed = allowed.map((value, index) => value && !!visible?.[index]);
          }
          let offset = 0;
          for (const candidate of candidates) {
            const count = candidate.points.length;
            const index = allowed.slice(offset, offset + count).findIndex(Boolean);
            const center = index < 0 ? null : mappedPoints[offset + index];
            offset += count;
            if (!center) continue;
            const bbox = intersect(mapRect(candidate.bbox, mapping), mapping.clip);
            if (bbox.width < 2 || bbox.height < 2) continue;
            result.buttons.push({ label: candidate.label, kind: candidate.kind, source: 'pixi', confidence: candidate.confidence, actionable: candidate.actionable, bbox, center, targetKey: `pixi:${frameId}:canvas${canvas.name}:${candidate.nodePath}:${encodeURIComponent(candidate.label)}` });
          }
        }
      } catch (error) {
        warning(Date.now() >= deadline || error.message === 'inspection-timeout' ? 'La inspección Pixi alcanzó su límite de tiempo; el resultado puede ser parcial.' : 'Un canvas o iframe cambió durante la inspección Pixi; vuelva a detectar.');
        if (Date.now() >= deadline) break;
      }
    }
  } catch {
    warning('No se pudo completar la inspección CDP de Pixi; se conservaron los resultados disponibles.');
  } finally {
    // Detaching frees listener handles too; they are not always assigned to the
    // evaluate object group by Chromium's DOMDebugger implementation.
    await Promise.allSettled(sessions.map(async session => {
      const bounded = async operation => {
        let timer;
        try { await Promise.race([operation, new Promise(resolve => { timer = setTimeout(resolve, 350); })]); }
        finally { clearTimeout(timer); }
      };
      try { await bounded(session.send('Runtime.releaseObjectGroup', { objectGroup: group })); } catch { /* closed target */ }
      try { await bounded(session.detach()); } catch { /* already detached */ }
    }));
  }
  return result;
}

module.exports = { detectEngineButtons };
