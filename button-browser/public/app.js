/* Button Browser UI. Server observations are immutable; coordinates are viewport CSS px. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const storageKey = 'button-browser.token';
  const elements = {
    address: $('address-input'), command: $('command-input'), screenshot: $('screenshot'),
    stage: $('viewport-stage'), boxes: $('bounding-boxes'), results: $('button-results'),
    output: $('console-output'), manual: $('manual-toggle'), overlays: $('overlay-toggle'),
    vision: $('vision-toggle'), size: $('viewport-size'), search: $('button-search'),
    source: $('source-filter'), token: $('token-input'),
  };
  const state = {
    observation: null, localBusy: false, remoteBusy: false, connected: false,
    visionConfigured: false, selectedId: null, layout: 'list', imageReady: false,
    addressDirty: false, generation: 0, mutationEpoch: 0, requestSequence: 0,
    authVersion: 0, token: readToken(), history: [], historyIndex: 0,
    connectionError: '', noticeKind: '', busyLabel: 'Ejecutando…',
    localVerification: false, coordinatesSuspended: false, coordinatesKey: null,
    verification: { status: 'idle', currentSample: 0, requiredSamples: 3, intervalMs: 2000 },
    lastPollStarted: 0,
  };
  const artifactCache = new Map();
  let toastTimer;

  function readToken() {
    try { return sessionStorage.getItem(storageKey) || ''; } catch { return ''; }
  }

  function headers(json = false) {
    const result = {};
    if (json) result['Content-Type'] = 'application/json';
    if (state.token) result.Authorization = `Bearer ${state.token}`;
    return result;
  }

  function sameOriginURL(path) {
    const url = new URL(path, window.location.href);
    if (url.origin !== window.location.origin || !/^https?:$/.test(url.protocol)) {
      throw new Error('El servidor devolvió una URL de imagen fuera de este origen.');
    }
    return url.href;
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        cache: 'no-store', credentials: 'same-origin', ...options,
        headers: { ...headers(Boolean(options.body)), ...(options.headers || {}) },
      });
    } catch (error) {
      const wrapped = new Error('No se pudo conectar con el servidor.');
      wrapped.code = 'NETWORK_ERROR';
      wrapped.cause = error;
      throw wrapped;
    }
    let body;
    try { body = await response.json(); } catch {
      const error = new Error(`El servidor respondió sin JSON válido (HTTP ${response.status}).`);
      error.code = 'INVALID_RESPONSE';
      throw error;
    }
    if (!response.ok || body.ok === false) {
      const error = new Error(body.error?.message || `La solicitud falló (HTTP ${response.status}).`);
      error.code = body.error?.code || `HTTP_${response.status}`;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  // Images use blob URLs so a configured token is sent through the Authorization header.
  function artifactURL(path) {
    if (!path) return Promise.reject(new Error('No hay una imagen disponible para esta observación.'));
    let url;
    try { url = sameOriginURL(path); } catch (error) { return Promise.reject(error); }
    const key = `${state.authVersion}:${url}`;
    if (artifactCache.has(key)) return artifactCache.get(key).promise;
    const entry = { path, key, controller: new AbortController(), objectURL: null, active: true };
    entry.promise = fetch(url, {
      headers: headers(), cache: 'no-store', credentials: 'same-origin', signal: entry.controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`No se pudo cargar la imagen (HTTP ${response.status}).`);
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw new Error('La respuesta del servidor no es una imagen.');
      if (!entry.active) throw new DOMException('Carga descartada.', 'AbortError');
      entry.objectURL = URL.createObjectURL(blob);
      return entry.objectURL;
    }).catch((error) => {
      if (artifactCache.get(key) === entry) artifactCache.delete(key);
      throw error;
    });
    artifactCache.set(key, entry);
    return entry.promise;
  }

  function pruneArtifacts(paths = []) {
    const keep = new Set(paths.filter(Boolean).map((path) => {
      try { return `${state.authVersion}:${sameOriginURL(path)}`; } catch { return ''; }
    }));
    for (const [key, entry] of artifactCache) {
      if (keep.has(key)) continue;
      entry.active = false;
      entry.controller.abort();
      if (entry.objectURL) URL.revokeObjectURL(entry.objectURL);
      artifactCache.delete(key);
    }
  }

  const cropObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      cropObserver.unobserve(entry.target);
      const img = entry.target.querySelector('img[data-artifact]');
      if (img) loadCrop(img);
    }
  }, { rootMargin: '200px' }) : null;

  function loadCrop(img) {
    const generation = Number(img.dataset.generation);
    artifactURL(img.dataset.artifact).then((url) => {
      if (generation !== state.generation || !img.isConnected) return;
      img.src = url;
      img.hidden = false;
      const placeholder = img.parentElement.querySelector('.crop-placeholder');
      if (placeholder) placeholder.hidden = true;
    }).catch((error) => {
      if (generation !== state.generation || !img.isConnected || error.name === 'AbortError') return;
      const placeholder = img.parentElement.querySelector('.crop-placeholder');
      if (placeholder) { placeholder.textContent = 'Sin recorte'; placeholder.title = error.message; }
    });
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function number(value) {
    return Number.isFinite(Number(value)) ? String(Math.round(Number(value) * 10) / 10) : '—';
  }

  function sourceGroup(source) {
    const normalized = String(source || '').toLowerCase();
    if (/vision|visual|qwen/.test(normalized)) return 'vision';
    if (/pixi/.test(normalized)) return 'pixi';
    if (/dom|aria|html|accessible|shadow|iframe/.test(normalized)) return 'dom';
    return 'other';
  }

  function sourceLabel(group) {
    return { dom: 'DOM', pixi: 'Pixi', vision: 'Visual · est.', other: 'Otra fuente' }[group];
  }

  function timeText(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function isStableObservation(observation = state.observation) {
    const stability = observation?.stability;
    return stability?.status === 'stable' && stability.requiredSamples === 3 &&
      stability.completedSamples === 3 && stability.intervalMs === 2000;
  }

  function isChecking() {
    return state.localVerification || state.verification.status === 'checking';
  }

  function canShowCoordinates() {
    return isStableObservation() && !state.coordinatesSuspended && !isChecking();
  }

  function visibleButtons() {
    return canShowCoordinates() && Array.isArray(state.observation.buttons) ? state.observation.buttons : [];
  }

  function canExportObservation() {
    return Boolean(state.observation) && !state.localBusy && !isChecking() && !state.coordinatesSuspended &&
      (!state.observation.buttons?.length || isStableObservation());
  }

  function setText(id, value) {
    if ($(id).textContent !== value) $(id).textContent = value;
  }

  function renderVerification() {
    const stability = state.observation?.stability;
    const checking = isChecking();
    const stable = canShowCoordinates();
    const unstable = !checking && !state.coordinatesSuspended && stability?.status === 'unstable';
    const current = Math.max(0, Math.min(3, Number(state.verification.currentSample) || 0));
    const completed = stable ? 3 : (unstable ? Math.max(0, Math.min(3, Number(stability.completedSamples) || 0)) : 0);
    const status = checking ? 'checking' : (stable ? 'stable' : (unstable ? 'unstable' : 'unverified'));
    $('verification-strip').dataset.status = status;
    let title = 'Verificación a pedido';
    let description = 'Abrí una página y pedí verify: 3 muestras, con 2 s entre cada una.';
    if (checking) {
      title = current ? `Verificando · muestra ${current} de 3` : 'Preparando 3 muestras';
      description = 'Se comparan las tres muestras, con 2 s entre cada una. Todavía no hay coordenadas disponibles.';
    } else if (stable) {
      title = 'Estable · 3 de 3 muestras';
      description = 'Coordenadas verificadas sobre la imagen. Podés anotarlas sin abrir el JSON.';
    } else if (unstable) {
      title = `Sin estabilidad · ${completed} de 3 muestras`;
      description = 'No se publican coordenadas. Cuando la página deje de cambiar, pedí una nueva verificación.';
    } else if (state.localBusy && state.coordinatesSuspended) {
      title = 'Actualizando captura';
      description = 'Esta acción sólo actualiza la imagen. Pedí verify al terminar para verificar los botones.';
    } else if (state.observation) {
      title = 'Captura sin verificar';
      description = 'Pedí «Verificar estabilidad» o el comando verify. Sólo tres muestras estables habilitan coordenadas.';
    }
    setText('verification-title', title);
    setText('verification-description', description);
    for (const step of document.querySelectorAll('.verification-step')) {
      const index = Number(step.dataset.sample);
      const active = checking && index === Math.max(1, current);
      const done = stable || (checking && index < current) || (unstable && index <= completed);
      step.classList.toggle('active', active);
      step.classList.toggle('done', done);
      step.setAttribute('aria-label', `Muestra ${index}${active ? ', en curso' : (done ? ', recibida' : ', pendiente')}`);
    }
    const reasons = unstable && Array.isArray(stability.reasons) ? stability.reasons.map(String) : [];
    const reasonsKey = JSON.stringify(reasons);
    if ($('verification-reasons').dataset.key !== reasonsKey) {
      $('verification-reasons').dataset.key = reasonsKey;
      $('verification-reasons').replaceChildren(...reasons.map((reason) => node('li', '', reason)));
    }
    $('verification-reasons').hidden = reasons.length === 0;
  }

  function renderSourceSummary() {
    const verified = canShowCoordinates();
    const buttons = visibleButtons();
    const counts = { dom: 0, pixi: 0, vision: 0, other: 0 };
    buttons.forEach((button) => counts[sourceGroup(button.source)]++);
    for (const group of ['dom', 'pixi', 'vision']) $(`${group}-count`).textContent = verified ? counts[group] : '—';
    $('other-source-count')?.remove();
    if (counts.other) {
      const other = node('span', 'source-pill source-other', `Otras ${counts.other}`);
      other.id = 'other-source-count';
      $('source-summary').append(other);
    }
    $('button-count').textContent = verified ? buttons.length : '—';
  }

  function refreshVerifiedArtifactLinks() {
    setLink($('open-annotated'), null);
    setLink($('contact-sheet'), null);
    if (!canShowCoordinates()) return;
    const observation = state.observation;
    const generation = state.generation;
    for (const [path, id] of [[observation.annotatedUrl, 'open-annotated'], [observation.contactSheetUrl, 'contact-sheet']]) {
      if (!path) continue;
      artifactURL(path).then((url) => {
        if (generation === state.generation && canShowCoordinates()) setLink($(id), url);
      }).catch((error) => {
        if (generation === state.generation && error.name !== 'AbortError') $(id).title = error.message;
      });
    }
  }

  function showNotice(message, kind = 'command') {
    $('notice-text').textContent = message;
    $('notice').hidden = false;
    state.noticeKind = kind;
  }

  function clearNotice(kind) {
    if (!kind || state.noticeKind === kind) {
      $('notice').hidden = true;
      state.noticeKind = '';
    }
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2800);
  }

  function updateStatus() {
    const busy = state.localBusy || state.remoteBusy;
    const coordinatesKey = `${state.observation?.observationId || ''}:${canShowCoordinates()}:${isChecking()}:${state.observation?.stability?.status || ''}`;
    if (state.coordinatesKey !== coordinatesKey) {
      state.coordinatesKey = coordinatesKey;
      renderSourceSummary();
      renderBoxes();
      renderButtons();
      refreshVerifiedArtifactLinks();
    }
    const status = $('connection-status');
    status.className = `connection-status ${state.connected ? (busy ? 'working' : 'connected') : (state.connectionError ? 'error' : '')}`;
    $('connection-label').textContent = state.connected ? (busy ? 'Trabajando' : 'Conectado') : (state.connectionError || 'Conectando');
    $('busy-overlay').hidden = !busy;
    $('busy-label').textContent = isChecking() ? `Verificando · muestra ${Math.max(1, Math.min(3, Number(state.verification.currentSample) || 1))} de 3 · intervalo 2 s` : (state.localBusy ? state.busyLabel : 'El navegador está ocupado…');
    $('reload-button').classList.toggle('spinning', busy);
    for (const control of document.querySelectorAll('[data-mutation], [data-text-command], #viewport-size, .click-target')) {
      control.disabled = busy || (control.dataset.textCommand && !state.observation) || control.dataset.actionable === 'false' || (control.classList.contains('click-target') && !canShowCoordinates());
    }
    $('apply-token').disabled = state.localBusy;
    $('clear-token').disabled = state.localBusy;
    elements.token.disabled = state.localBusy;
    elements.manual.disabled = busy || !state.imageReady;
    elements.vision.disabled = busy || !state.visionConfigured;
    $('vision-control').hidden = !state.visionConfigured;
    $('copy-json').disabled = !canExportObservation();
    $('download-json').disabled = !canExportObservation();
    $('auth-badge').textContent = state.token ? 'Token activo' : 'Sin token';
    renderVerification();
  }

  function setLink(link, url) {
    if (url) {
      link.href = url;
      link.removeAttribute('aria-disabled');
      link.removeAttribute('tabindex');
    } else {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
      link.setAttribute('tabindex', '-1');
    }
  }

  function setObservation(observation) {
    if (observation && observation.observationId === state.observation?.observationId) return;
    if (!observation && !state.observation) return;
    state.observation = observation;
    state.coordinatesSuspended = false;
    state.selectedId = null;
    state.imageReady = false;
    const generation = ++state.generation;
    elements.screenshot.hidden = true;
    elements.screenshot.removeAttribute('src');
    elements.boxes.replaceChildren();
    $('image-error').hidden = true;
    $('image-loading').hidden = !observation;
    $('viewport-empty').hidden = Boolean(observation);
    setLink($('open-screenshot'), null);
    setLink($('open-annotated'), null);
    setLink($('contact-sheet'), null);
    $('warnings').hidden = true;
    $('warning-list').replaceChildren();
    if (!observation) {
      pruneArtifacts();
      $('observation-meta').textContent = 'Sin observación';
      $('last-update').textContent = 'Sin observación';
      document.title = 'Button Browser · Inspector';
      updateStatus();
      return;
    }
    const buttons = isStableObservation(observation) && Array.isArray(observation.buttons) ? observation.buttons : [];
    const width = Number(observation.viewport?.width) || 1280;
    const height = Number(observation.viewport?.height) || 720;
    elements.stage.style.aspectRatio = `${width} / ${height}`;
    $('viewport-dimensions').textContent = `${width} × ${height}`;
    let customOption = elements.size.querySelector('option[data-custom]');
    if (customOption) customOption.remove();
    if (!Array.from(elements.size.options).some((option) => option.value === `${width} ${height}`)) {
      customOption = node('option', '', `${width} × ${height}`);
      customOption.value = `${width} ${height}`;
      customOption.dataset.custom = 'true';
      elements.size.append(customOption);
    }
    elements.size.value = `${width} ${height}`;
    if (!state.addressDirty) elements.address.value = observation.url || '';
    $('observation-meta').textContent = `OBS ${observation.observationId} · ${timeText(observation.timestamp)}${Number.isFinite(observation.timingMs) ? ` · ${number(observation.timingMs)} ms` : ''}`;
    $('observation-meta').title = `Observación ${observation.observationId}\n${observation.timestamp || ''}\n${observation.coordinateSpace || 'viewport-css-px'}`;
    $('last-update').textContent = `Captura ${timeText(observation.timestamp)}`;
    document.title = observation.title ? `${observation.title} · Button Browser` : 'Button Browser · Inspector';
    if (observation.warnings?.length) {
      $('warnings').hidden = false;
      $('warning-count').textContent = `${observation.warnings.length} ${observation.warnings.length === 1 ? 'aviso' : 'avisos'}`;
      for (const warning of observation.warnings) $('warning-list').append(node('li', '', String(warning)));
    }
    pruneArtifacts([observation.screenshotUrl, observation.annotatedUrl, observation.contactSheetUrl, ...buttons.map((button) => button.cropUrl)]);
    updateStatus();
    artifactURL(observation.screenshotUrl).then((url) => {
      if (generation !== state.generation) return;
      elements.screenshot.onload = () => {
        if (generation !== state.generation) return;
        state.imageReady = true;
        elements.screenshot.hidden = false;
        $('image-loading').hidden = true;
        updateStatus();
      };
      elements.screenshot.onerror = () => {
        if (generation !== state.generation) return;
        showImageError('El navegador no pudo mostrar esta captura.');
      };
      elements.screenshot.src = url;
      elements.screenshot.alt = `Captura de ${observation.title || observation.url || 'la página'}; viewport de ${width} por ${height} píxeles CSS.`;
      setLink($('open-screenshot'), url);
    }).catch((error) => {
      if (generation !== state.generation || error.name === 'AbortError') return;
      showImageError(error.message);
    });
  }

  function showImageError(message) {
    state.imageReady = false;
    $('image-loading').hidden = true;
    $('image-error-text').textContent = message;
    $('image-error').hidden = false;
    updateStatus();
  }

  function renderBoxes() {
    elements.boxes.replaceChildren();
    elements.boxes.hidden = !elements.overlays.checked || !canShowCoordinates();
    const observation = state.observation;
    if (!canShowCoordinates()) return;
    const { width, height } = observation.viewport;
    const stageWidth = elements.stage.clientWidth;
    const stageHeight = elements.stage.clientHeight;
    if (!stageWidth || !stageHeight) return;
    const lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    lines.setAttribute('class', 'overlay-connectors');
    lines.setAttribute('viewBox', `0 0 ${stageWidth} ${stageHeight}`);
    lines.setAttribute('preserveAspectRatio', 'none');
    const fragment = document.createDocumentFragment();
    const labels = [];
    fragment.append(lines);
    for (const button of visibleButtons()) {
      const bbox = button.bbox;
      if (!bbox || ![bbox.x, bbox.y, bbox.width, bbox.height].every(Number.isFinite) || bbox.width <= 0 || bbox.height <= 0) continue;
      const point = button.clickPoint || button.center;
      if (!point || ![point.x, point.y].every(Number.isFinite)) continue;
      const left = Math.max(0, bbox.x);
      const top = Math.max(0, bbox.y);
      const right = Math.min(width, bbox.x + bbox.width);
      const bottom = Math.min(height, bbox.y + bbox.height);
      if (right <= left || bottom <= top) continue;
      const group = sourceGroup(button.source);
      const box = node('div', `bounding-box source-${group}`);
      box.dataset.buttonId = String(button.id);
      box.classList.toggle('selected', String(button.id) === state.selectedId);
      box.classList.toggle('unactionable', button.actionable === false);
      box.classList.toggle('estimated', button.estimated === true || group === 'vision');
      box.style.left = `${left / width * 100}%`;
      box.style.top = `${top / height * 100}%`;
      box.style.width = `${(right - left) / width * 100}%`;
      box.style.height = `${(bottom - top) / height * 100}%`;
      fragment.append(box);
      const marker = node('span', `click-point-marker source-${group}`);
      marker.dataset.buttonId = String(button.id);
      marker.classList.toggle('selected', String(button.id) === state.selectedId);
      marker.style.left = `${point.x / width * 100}%`;
      marker.style.top = `${point.y / height * 100}%`;
      const label = node('span', `bounding-box-label source-${group}`);
      label.dataset.buttonId = String(button.id);
      label.classList.toggle('selected', String(button.id) === state.selectedId);
      label.title = `${button.id}: punto de clic x ${number(point.x)}, y ${number(point.y)} CSS px`;
      const coordinates = node('span', 'overlay-coordinate-pair');
      coordinates.append(node('span', '', `x ${number(point.x)}`), node('span', '', `y ${number(point.y)}`));
      label.append(node('strong', '', String(button.id)), coordinates);
      fragment.append(marker, label);
      labels.push({ label, group, left: left / width * stageWidth, right: right / width * stageWidth,
        top: top / height * stageHeight, bottom: bottom / height * stageHeight,
        x: point.x / width * stageWidth, y: point.y / height * stageHeight });
    }
    elements.boxes.append(fragment);
    // Labels stay readable in screen pixels while markers and boxes follow viewport CSS coordinates.
    const occupied = [];
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    for (const item of labels) {
      const labelWidth = item.label.offsetWidth;
      const labelHeight = item.label.offsetHeight;
      const candidates = [
        [item.left, item.top - labelHeight - 5], [item.left, item.bottom + 5],
        [item.right - labelWidth, item.top - labelHeight - 5], [item.right + 5, item.top],
        [item.left - labelWidth - 5, item.top],
      ];
      for (let step = 1; step <= 5; step++) {
        candidates.push([item.x - labelWidth / 2, item.top - (labelHeight + 5) * (step + 1)]);
        candidates.push([item.x - labelWidth / 2, item.bottom + 5 + (labelHeight + 5) * step]);
      }
      let chosen = null;
      for (const [x, y] of candidates) {
        const rect = { x: clamp(x, 3, stageWidth - labelWidth - 3), y: clamp(y, 3, stageHeight - labelHeight - 3), width: labelWidth, height: labelHeight };
        let overlap = 0;
        for (const other of occupied) {
          const overlapWidth = Math.max(0, Math.min(rect.x + rect.width + 3, other.x + other.width + 3) - Math.max(rect.x, other.x));
          const overlapHeight = Math.max(0, Math.min(rect.y + rect.height + 3, other.y + other.height + 3) - Math.max(rect.y, other.y));
          overlap += overlapWidth * overlapHeight;
        }
        const score = overlap * 1000 + Math.hypot(rect.x + rect.width / 2 - item.x, rect.y + rect.height / 2 - item.y);
        if (!chosen || score < chosen.score) chosen = { ...rect, score };
        if (!overlap) break;
      }
      occupied.push(chosen);
      item.label.style.left = `${chosen.x}px`;
      item.label.style.top = `${chosen.y}px`;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', `point-connector source-${item.group}`);
      line.setAttribute('x1', String(clamp(item.x, chosen.x, chosen.x + chosen.width)));
      line.setAttribute('y1', String(clamp(item.y, chosen.y, chosen.y + chosen.height)));
      line.setAttribute('x2', String(item.x));
      line.setAttribute('y2', String(item.y));
      lines.append(line);
    }
  }

  function selectButton(id) {
    state.selectedId = state.selectedId === String(id) ? null : String(id);
    for (const item of document.querySelectorAll('[data-button-id]')) {
      const selected = item.dataset.buttonId === state.selectedId;
      item.classList.toggle('selected', selected);
      for (const control of item.querySelectorAll('.crop-select, .button-card-label')) control.setAttribute('aria-pressed', String(selected));
    }
  }

  function renderButtons() {
    cropObserver?.disconnect();
    elements.results.replaceChildren();
    elements.results.classList.toggle('gallery', state.layout === 'gallery');
    const buttons = visibleButtons();
    const query = elements.search.value.trim().toLocaleLowerCase('es');
    const filter = elements.source.value;
    const filtered = buttons.filter((button) => {
      const group = sourceGroup(button.source);
      const text = `${button.id || ''} ${button.label || ''} ${button.source || ''} ${sourceLabel(group)} ${button.kind || ''} ${button.estimated || group === 'vision' ? 'estimado estimación' : ''}`.toLocaleLowerCase('es');
      return (filter === 'all' || filter === group) && (!query || text.includes(query));
    });
    $('filtered-count').textContent = canShowCoordinates() ? `${filtered.length} de ${buttons.length} visibles` : (isChecking() ? 'Verificando…' : (state.observation ? 'Sin coordenadas' : 'Sin observación'));
    $('results-empty').hidden = filtered.length > 0;
    if (!filtered.length) {
      const hasObservation = Boolean(state.observation);
      let title = 'Todo empieza con una página';
      let description = 'Las coordenadas aparecen después de pedir una verificación y obtener tres muestras estables.';
      if (isChecking()) {
        title = 'Comprobando las 3 muestras';
        description = 'Los objetivos aparecerán sólo si las tres muestras coinciden. Cada muestra se separa de la anterior por 2 s.';
      } else if (hasObservation && !canShowCoordinates()) {
        title = !state.coordinatesSuspended && state.observation.stability?.status === 'unstable' ? 'No se alcanzó estabilidad' : 'Captura sin verificar';
        description = 'Pedí «Verificar estabilidad» para obtener botones, recortes y coordenadas. Navegar o hacer clic no inicia esta comprobación.';
      } else if (hasObservation) {
        title = buttons.length ? 'Sin coincidencias' : 'Sin botones visibles';
        description = buttons.length ? 'Probá otro texto o seleccioná todas las fuentes.' : 'Las tres muestras son estables, pero no contienen botones accionables. Revisá los avisos de detección.';
      }
      $('results-empty-title').textContent = title;
      $('results-empty-text').textContent = description;
    }
    const fragment = document.createDocumentFragment();
    for (const button of filtered) {
      const observationId = state.observation.observationId;
      const id = String(button.id);
      const label = String(button.label || 'Sin etiqueta');
      const group = sourceGroup(button.source);
      const estimated = button.estimated === true || group === 'vision';
      const bbox = button.bbox || {};
      const center = button.center || { x: Number(bbox.x) + Number(bbox.width) / 2, y: Number(bbox.y) + Number(bbox.height) / 2 };
      const clickPoint = button.clickPoint || center;
      const card = node('article', 'button-card');
      card.setAttribute('role', 'listitem');
      card.dataset.buttonId = id;
      card.classList.toggle('selected', state.selectedId === id);
      const crop = node('button', 'crop-select');
      crop.type = 'button';
      crop.setAttribute('aria-label', `Resaltar ${id}: ${label}`);
      crop.setAttribute('aria-pressed', String(state.selectedId === id));
      crop.title = 'Resaltar en la captura';
      crop.addEventListener('click', () => selectButton(id));
      const image = node('img');
      image.alt = `Recorte de ${label}`;
      image.hidden = true;
      image.decoding = 'async';
      image.dataset.generation = String(state.generation);
      if (button.cropUrl) image.dataset.artifact = button.cropUrl;
      crop.append(image, node('span', 'crop-placeholder', button.cropUrl ? 'Cargando…' : 'Sin recorte'));
      const details = node('div', 'button-card-details');
      const top = node('div', 'button-card-top');
      const source = node('span', `source-pill source-${group}`, `${sourceLabel(group)}${estimated && group !== 'vision' ? ' · est.' : ''}`);
      source.title = `Fuente: ${button.source || 'desconocida'}${estimated ? (group === 'vision' ? '. Estimación visual' : '. Candidato estimado por heurística') : ''}${Number.isFinite(button.confidence) ? `. Puntuación del detector: ${Math.round(button.confidence * 1000) / 1000} (no calibrada)` : ''}`;
      source.setAttribute('aria-label', source.title);
      top.append(node('span', 'button-id', id), source);
      const title = node('button', 'button-card-label', label);
      title.type = 'button';
      title.title = `${label}${button.kind ? ` · ${button.kind}` : ''}`;
      title.setAttribute('aria-label', `Resaltar ${id}: ${label}`);
      title.setAttribute('aria-pressed', String(state.selectedId === id));
      title.addEventListener('click', () => selectButton(id));
      const coordinates = node('span', 'button-coordinates', `x ${number(bbox.x)} · y ${number(bbox.y)} · ${number(bbox.width)} × ${number(bbox.height)}`);
      coordinates.title = 'Rectángulo: x, y, ancho y alto, en píxeles CSS del viewport';
      const bottom = node('div', 'button-card-bottom');
      const centerLabel = node('span', 'button-center');
      centerLabel.append(node('span', 'coordinate-caption', 'Punto de clic'), node('span', '', `${number(clickPoint.x)}, ${number(clickPoint.y)}`));
      centerLabel.title = `Punto de clic: x ${number(clickPoint.x)}, y ${number(clickPoint.y)} CSS px. Centro geométrico: x ${number(center.x)}, y ${number(center.y)} CSS px.`;
      const click = node('button', 'click-target', button.actionable === false ? 'No activo' : 'Clic');
      click.type = 'button';
      click.dataset.actionable = String(button.actionable !== false);
      click.disabled = state.localBusy || state.remoteBusy || button.actionable === false || !canShowCoordinates();
      click.setAttribute('aria-label', `Hacer clic en ${id}: ${label}`);
      click.title = button.actionable === false ? 'Este candidato no está disponible para hacer clic.' : `Hacer clic en ${id} usando esta observación`;
      if (button.actionable !== false) click.append(icon('pointer'));
      click.addEventListener('click', () => runCommand({ action: 'click', id, observationId }, `click ${id}`));
      bottom.append(centerLabel, click);
      details.append(top, title, coordinates, bottom);
      card.append(crop, details);
      fragment.append(card);
    }
    elements.results.append(fragment);
    for (const image of elements.results.querySelectorAll('img[data-artifact]')) {
      // The image is initially hidden; observe its sized container instead.
      if (cropObserver) cropObserver.observe(image.parentElement);
      else loadCrop(image);
    }
  }

  function addConsoleEntry(command, commandId) {
    elements.output.querySelector('.console-welcome')?.remove();
    const entry = node('details', 'console-entry pending');
    const summary = node('summary');
    const resultLabel = node('span', 'console-result-label', 'en curso');
    summary.append(node('span', 'console-time', timeText(Date.now())), node('span', 'console-command', command), resultLabel);
    const body = node('pre', '', `commandId: ${commandId}`);
    entry.append(summary, body);
    elements.output.append(entry);
    while (elements.output.children.length > 40) elements.output.firstElementChild.remove();
    elements.output.scrollTop = elements.output.scrollHeight;
    return { entry, resultLabel, body };
  }

  function finishConsoleEntry(log, response, error, warning = false, resultLabel = null) {
    log.entry.classList.remove('pending');
    log.entry.classList.toggle('error', Boolean(error));
    log.entry.classList.toggle('warning', Boolean(warning));
    log.resultLabel.textContent = resultLabel || (error ? 'error' : (warning ? 'sin captura' : 'ok'));
    log.body.textContent = JSON.stringify(response, null, 2);
    if (error || warning) log.entry.open = true;
    elements.output.scrollTop = elements.output.scrollHeight;
  }

  function commandID() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function commandAction(command) {
    const action = String(typeof command === 'string' ? command.trim().split(/\s+/)[0] : command.action || '').toLowerCase();
    return ['verify', 'detect', 'observe'].includes(action) ? 'verify' : action;
  }

  async function runCommand(command, displayCommand) {
    if (state.localBusy || state.remoteBusy) { toast('Esperá a que termine el comando actual.'); return; }
    const commandId = commandID();
    const action = commandAction(command);
    const verificationRequested = action === 'verify';
    const label = displayCommand || (typeof command === 'string' ? command : JSON.stringify(command));
    const log = addConsoleEntry(label, commandId);
    state.localBusy = true;
    state.localVerification = verificationRequested;
    if (!['help', 'tabs', 'export'].includes(action)) {
      state.coordinatesSuspended = true;
      state.selectedId = null;
    }
    if (verificationRequested) state.verification = { status: 'checking', currentSample: 0, requiredSamples: 3, intervalMs: 2000 };
    state.mutationEpoch++;
    state.busyLabel = label.length > 65 ? `${label.slice(0, 62)}…` : label;
    clearNotice();
    updateStatus();
    try {
      // One POST per user action. A failed request is never automatically retried.
      const pendingCommand = api('/api/command', { method: 'POST', body: JSON.stringify({ command, commandId }) });
      if (verificationRequested) refreshState();
      const response = await pendingCommand;
      state.connected = true;
      state.connectionError = '';
      state.localVerification = false;
      if (response.result?.observationError) {
        state.verification = { status: 'idle', currentSample: 0, requiredSamples: 3, intervalMs: 2000 };
        setObservation(null);
        showNotice(`La acción se ejecutó, pero no se pudo actualizar la captura: ${response.result.observationError}. Pedí snapshot o verify para recuperar la vista; no repitas la acción.`);
        finishConsoleEntry(log, response, false, true);
      } else {
        const observation = response.observation || (response.result?.observationId && Array.isArray(response.result.buttons) ? response.result : null);
        if (observation) {
          const status = observation.stability?.status;
          state.verification = { status: ['stable', 'unstable'].includes(status) ? status : 'idle', currentSample: observation.stability?.completedSamples || 0, requiredSamples: 3, intervalMs: 2000 };
          setObservation(observation);
        } else if (verificationRequested) {
          state.verification = { status: 'idle', currentSample: 0, requiredSamples: 3, intervalMs: 2000 };
        }
        const unstable = observation?.stability?.status === 'unstable';
        finishConsoleEntry(log, response, false, unstable, unstable ? 'inestable' : (isStableObservation(observation) && verificationRequested ? 'estable 3/3' : null));
      }
    } catch (error) {
      let message = error.message;
      if (error.code === 'NETWORK_ERROR' || error.code === 'INVALID_RESPONSE') {
        message += ' No se pudo confirmar el resultado. Revisá el estado antes de volver a enviarlo.';
      }
      finishConsoleEntry(log, { ok: false, commandId, error: { code: error.code || 'ERROR', message } }, true);
      showNotice(message);
      if (error.status === 401 || error.status === 403) $('access-settings').open = true;
    } finally {
      state.localBusy = false;
      state.localVerification = false;
      if (verificationRequested && state.verification.status === 'checking') state.verification = { status: 'idle', currentSample: 0, requiredSamples: 3, intervalMs: 2000 };
      state.mutationEpoch++;
      updateStatus();
      // Refreshing read-only state is safe even when a command's network result is unknown.
      await refreshState();
    }
  }

  async function refreshState() {
    if (state.localBusy && !state.localVerification) return;
    state.lastPollStarted = Date.now();
    const sequence = ++state.requestSequence;
    const epoch = state.mutationEpoch;
    try {
      const response = await api('/api/state');
      if (sequence !== state.requestSequence || epoch !== state.mutationEpoch || (state.localBusy && !state.localVerification)) return;
      state.connected = true;
      state.connectionError = '';
      state.remoteBusy = Boolean(response.busy);
      state.visionConfigured = Boolean(response.visionConfigured);
      if (!state.visionConfigured) elements.vision.checked = false;
      if (state.localBusy) {
        // During the POST, cached state is useful only for progress. Never replace its eventual observation.
        if (response.verification?.status === 'checking') state.verification = response.verification;
      } else {
        state.verification = response.verification || { status: 'idle', currentSample: 0, requiredSamples: 3, intervalMs: 2000 };
        if ('observation' in response) setObservation(response.observation);
        if (!response.observation) $('last-update').textContent = 'Sin observación';
      }
      clearNotice('connection');
      updateStatus();
    } catch (error) {
      if (sequence !== state.requestSequence || epoch !== state.mutationEpoch || (state.localBusy && !state.localVerification)) return;
      state.connected = false;
      state.remoteBusy = false;
      const unauthorized = error.status === 401 || error.status === 403;
      state.connectionError = unauthorized ? 'Acceso requerido' : 'Sin conexión';
      if (!state.noticeKind || state.noticeKind === 'connection') {
        showNotice(unauthorized ? 'Este servidor requiere acceso. Abrí «Acceso», ingresá el token y aplicalo.' : error.message, 'connection');
      }
      if (unauthorized) $('access-settings').open = true;
      updateStatus();
    }
  }

  function updateToken(value) {
    if (state.localBusy) return;
    state.token = value.trim();
    elements.token.value = state.token;
    try {
      if (state.token) sessionStorage.setItem(storageKey, state.token);
      else sessionStorage.removeItem(storageKey);
    } catch { toast('El navegador no permite guardar el token en esta pestaña.'); }
    state.authVersion++;
    state.mutationEpoch++;
    state.remoteBusy = false;
    state.localVerification = false;
    state.coordinatesSuspended = false;
    state.verification = { status: 'idle', currentSample: 0, requiredSamples: 3, intervalMs: 2000 };
    state.connected = false;
    state.connectionError = '';
    setObservation(null);
    pruneArtifacts();
    clearNotice();
    $('access-settings').open = false;
    updateStatus();
    refreshState();
  }

  function viewportPoint(event) {
    const observation = state.observation;
    if (!observation || !state.imageReady) return null;
    const rect = elements.screenshot.getBoundingClientRect();
    if (!rect.width || !rect.height || event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return null;
    const { width, height } = observation.viewport;
    return {
      x: Math.round(Math.max(0, Math.min(width - 0.1, (event.clientX - rect.left) / rect.width * width)) * 10) / 10,
      y: Math.round(Math.max(0, Math.min(height - 0.1, (event.clientY - rect.top) / rect.height * height)) * 10) / 10,
    };
  }

  function setLayout(layout) {
    state.layout = layout;
    $('list-view').classList.toggle('active', layout === 'list');
    $('grid-view').classList.toggle('active', layout === 'gallery');
    $('list-view').setAttribute('aria-pressed', String(layout === 'list'));
    $('grid-view').setAttribute('aria-pressed', String(layout === 'gallery'));
    renderButtons();
  }

  async function copyJSON() {
    if (!canExportObservation()) return;
    const value = JSON.stringify(state.observation, null, 2);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const textarea = node('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.left = '-10000px';
        document.body.append(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('El portapapeles no está disponible.');
      }
      toast('JSON de la observación copiado.');
    } catch { showNotice('No se pudo acceder al portapapeles. Podés descargar el JSON.'); }
  }

  function downloadJSON() {
    if (!canExportObservation()) return;
    const blob = new Blob([JSON.stringify(state.observation, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = node('a');
    link.href = url;
    link.download = `button-browser-${String(state.observation.observationId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  $('address-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const url = elements.address.value.trim();
    if (!url) { elements.address.focus(); return; }
    state.addressDirty = false;
    runCommand({ action: 'goto', url }, `goto ${url}`);
  });
  elements.address.addEventListener('input', () => { state.addressDirty = true; });
  for (const button of document.querySelectorAll('[data-text-command]')) {
    button.addEventListener('click', () => {
      state.addressDirty = false;
      runCommand(button.dataset.textCommand);
    });
  }
  for (const button of document.querySelectorAll('[data-demo]')) {
    button.addEventListener('click', () => {
      state.addressDirty = false;
      const url = new URL('/demo', window.location.origin).href;
      runCommand({ action: 'goto', url }, 'goto /demo');
    });
  }
  $('detect-button').addEventListener('click', () => runCommand({ action: 'verify', vision: elements.vision.checked && state.visionConfigured }, elements.vision.checked ? 'verify · visión' : 'verify'));
  elements.size.addEventListener('change', () => runCommand(`resize ${elements.size.value}`));
  elements.overlays.addEventListener('change', renderBoxes);
  elements.manual.addEventListener('change', () => {
    elements.stage.classList.toggle('manual', elements.manual.checked);
    $('interaction-hint').textContent = elements.manual.checked ? 'Clic manual activo · no verifica el objetivo.' : 'Activá «Interactuar» para hacer clic en la captura.';
  });
  elements.stage.addEventListener('pointermove', (event) => {
    const point = canShowCoordinates() || elements.manual.checked ? viewportPoint(event) : null;
    $('pointer-position').textContent = point ? `x ${number(point.x)}   y ${number(point.y)}` : 'x —   y —';
  });
  elements.stage.addEventListener('pointerleave', () => { $('pointer-position').textContent = 'x —   y —'; });
  elements.stage.addEventListener('click', (event) => {
    if (!elements.manual.checked || state.localBusy || state.remoteBusy) return;
    const point = viewportPoint(event);
    if (!point) return;
    runCommand({ action: 'click', ...point, observationId: state.observation.observationId }, `click ${number(point.x)} ${number(point.y)}`);
  });
  elements.search.addEventListener('input', renderButtons);
  elements.source.addEventListener('change', renderButtons);
  $('list-view').addEventListener('click', () => setLayout('list'));
  $('grid-view').addEventListener('click', () => setLayout('gallery'));
  $('copy-json').addEventListener('click', copyJSON);
  $('download-json').addEventListener('click', downloadJSON);
  $('dismiss-notice').addEventListener('click', () => clearNotice());
  $('token-form').addEventListener('submit', (event) => { event.preventDefault(); updateToken(elements.token.value); });
  $('clear-token').addEventListener('click', () => updateToken(''));
  $('clear-console').addEventListener('click', () => {
    elements.output.replaceChildren(node('p', 'console-welcome', 'Consola limpia. Lista para el próximo comando.'));
  });
  $('help-toggle').addEventListener('click', () => {
    const open = $('command-help').hidden;
    $('command-help').hidden = !open;
    $('help-toggle').setAttribute('aria-expanded', String(open));
  });
  for (const button of document.querySelectorAll('[data-example]')) {
    button.addEventListener('click', () => {
      elements.command.value = button.dataset.example;
      elements.command.focus();
    });
  }
  $('command-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = elements.command.value.trim();
    if (!text) { elements.command.focus(); return; }
    if (state.localBusy || state.remoteBusy) return;
    state.history.push(text);
    if (state.history.length > 100) state.history.shift();
    state.historyIndex = state.history.length;
    let command = text;
    const verification = /^(verify|detect|observe)(?:\s+(vision))?$/i.exec(text);
    if (verification) command = { action: 'verify', vision: Boolean(verification[2]) || (elements.vision.checked && state.visionConfigured) };
    const idClick = /^click\s+(\S+)$/i.exec(text);
    if (idClick && state.observation) command = { action: 'click', id: idClick[1], observationId: state.observation.observationId };
    if (/^(goto|back|forward|reload|switch|newtab|close)(\s|$)/i.test(text)) state.addressDirty = false;
    elements.command.value = '';
    runCommand(command, text);
  });
  elements.command.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (!state.history.length) return;
    event.preventDefault();
    state.historyIndex = Math.max(0, Math.min(state.history.length, state.historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
    elements.command.value = state.history[state.historyIndex] || '';
    elements.command.setSelectionRange(elements.command.value.length, elements.command.value.length);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $('access-settings').open = false;
      if (elements.manual.checked) { elements.manual.checked = false; elements.manual.dispatchEvent(new Event('change')); }
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshState(); });
  window.addEventListener('pagehide', (event) => { if (!event.persisted) pruneArtifacts(); });
  if ('ResizeObserver' in window) new ResizeObserver(renderBoxes).observe(elements.stage);

  elements.token.value = state.token;
  updateStatus();
  refreshState();
  setInterval(() => {
    if (document.hidden || (state.localBusy && !state.localVerification)) return;
    if (Date.now() - state.lastPollStarted >= (isChecking() ? 500 : 3000)) refreshState();
  }, 500);
})();
