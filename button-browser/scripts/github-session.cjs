#!/usr/bin/env node
'use strict';

// One explicit-command browser session. This script never chooses an action,
// invokes verification from a timer, or retries a browser command.
const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { BrowserController } = require('../src/browser.cjs');
const { parseCommand } = require('../src/commands.cjs');

const REPOSITORY = 'Shisetsu-Code/firetrace';
const BRANCH = 'codex/button-browser-playngo-20261025';
const START_PATH = 'button-browser/ci/start.json';
const COMMANDS_PATH = 'button-browser/ci/commands.json';
const POLL_MS = 3000;
const MAX_SESSION_MS = 25 * 60 * 1000;
const BOOTSTRAP_ID = '__start__';
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const FIXED_ID = /^f[1-9]\d{0,5}$/;
const MAX_FIXED_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_FIXED_PNG_BYTES = 16 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const failure = (code, message) => Object.assign(new Error(message), { code });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function commandFingerprint(command) { return sha256(JSON.stringify(canonical(command))); }
function isStop(command) {
  return typeof command === 'string' ? command.trim().toUpperCase() === 'STOP' : command?.action?.toUpperCase?.() === 'STOP';
}

function redactURL(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '[URL omitida]';
    return `${url.origin}${url.pathname}${url.search ? '?[redacted]' : ''}${url.hash ? '#[redacted]' : ''}`;
  } catch { return '[URL omitida]'; }
}

function makeSanitizer(secrets = []) {
  const knownSecrets = [...new Set(secrets.filter(value => typeof value === 'string' && value.length >= 4))];
  function text(value) {
    let result = String(value);
    for (const secret of knownSecrets) result = result.split(secret).join('[redacted]');
    return result.replace(/https?:\/\/[^\s<>"']+/gi, redactURL)
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[redacted]')
      .replace(/\b(token|password|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
      .slice(0, 20000);
  }
  function visit(value, depth = 0) {
    if (depth > 24) return '[omitted]';
    if (typeof value === 'string') return text(value);
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (Buffer.isBuffer(value)) return '[binary omitted]';
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (typeof value !== 'object') return undefined;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('_') || /token|password|secret|credential|authorization|cookie|api[_-]?key|storageState|headers|postData|responseBody/i.test(key)) continue;
      result[key] = visit(item, depth + 1);
    }
    return result;
  }
  visit.text = text;
  return visit;
}

function safeError(error, sanitize) {
  return { code: sanitize.text(error?.code || 'SESSION_ERROR').slice(0, 100), message: sanitize.text(String(error?.message || 'Error de sesión').split('\n')[0]).slice(0, 600) };
}

function validateStart(value) {
  if (!value || typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)) throw failure('INVALID_START', 'start.json necesita un sessionId nuevo, de 1 a 80 caracteres seguros.');
  const command = parseCommand({ action: 'goto', url: value.gameURL });
  const config = { sessionId: value.sessionId, gameURL: command.url };
  if (Object.hasOwn(value, 'fixedButtonsFrom')) {
    if (typeof value.fixedButtonsFrom !== 'string' || !SESSION_ID.test(value.fixedButtonsFrom) || value.fixedButtonsFrom === value.sessionId) {
      throw failure('INVALID_START', 'fixedButtonsFrom debe indicar otra sesión previa con un identificador seguro.');
    }
    config.fixedButtonsFrom = value.fixedButtonsFrom;
  }
  return config;
}

async function regularFile(file, limit) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw failure('INVALID_FIXED_SOURCE', 'El catálogo o sus recortes contienen un archivo inválido o demasiado grande.');
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw failure('INVALID_FIXED_SOURCE', 'El archivo de botones fijos excede el límite permitido.');
    return bytes;
  } finally { await handle?.close(); }
}

function fixedIndex(bytes) {
  let index;
  try { index = JSON.parse(bytes.toString('utf8')); }
  catch { throw failure('INVALID_FIXED_SOURCE', 'El catálogo de botones fijos no contiene JSON válido.'); }
  if (index?.version !== 1 || !Number.isInteger(index.nextId) || index.nextId < 1 || index.nextId > 1000000 ||
      !Array.isArray(index.buttons) || index.buttons.length > 200) throw failure('INVALID_FIXED_SOURCE', 'El catálogo de botones fijos tiene un formato inválido.');
  const ids = new Set();
  for (const button of index.buttons) {
    if (!FIXED_ID.test(button?.id || '') || ids.has(button.id) || Number(button.id.slice(1)) >= index.nextId) {
      throw failure('INVALID_FIXED_SOURCE', 'El catálogo de botones fijos contiene identificadores inválidos.');
    }
    ids.add(button.id);
  }
  return index;
}

/** Restore only explicitly selected catalog files from the checked-out repository.
 * Validation is completed in staging before a controller or browser is created.
 * This does not broaden GitHubReader or GitPublisher's allowed paths. */
async function restoreFixedButtons({ repositoryRoot, sourceSessionId, targetDirectory }) {
  if (typeof sourceSessionId !== 'string' || !SESSION_ID.test(sourceSessionId)) throw failure('INVALID_FIXED_SOURCE', 'La sesión de origen de los botones fijos es inválida.');
  const target = path.resolve(targetDirectory);
  try { await fs.lstat(target); throw failure('FIXED_RESTORE_DESTINATION_EXISTS', 'El catálogo de destino ya existe; no se reemplazará.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let staging;
  try {
    let source = await fs.realpath(repositoryRoot);
    for (const part of ['button-browser', 'ci-results', sourceSessionId, 'fixed']) {
      source = path.join(source, part);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw failure('INVALID_FIXED_SOURCE', 'La ruta del catálogo de origen debe contener directorios normales.');
    }
    const bytes = await regularFile(path.join(source, 'index.json'), MAX_FIXED_INDEX_BYTES);
    const index = fixedIndex(bytes);
    await fs.mkdir(path.dirname(target), { recursive: true });
    staging = await fs.mkdtemp(path.join(path.dirname(target), '.fixed-restore-'));
    await fs.writeFile(path.join(staging, 'index.json'), bytes);
    for (const button of index.buttons) {
      const png = await regularFile(path.join(source, `${button.id}.png`), MAX_FIXED_PNG_BYTES);
      await fs.writeFile(path.join(staging, `${button.id}.png`), png);
    }
    const { FixedButtonStore } = require('../src/fixed-buttons.cjs');
    const store = new FixedButtonStore(staging);
    const restored = await store.list();
    for (const button of restored) await store.template(button.id);
    await fs.rename(staging, target);
    staging = null;
    return { count: restored.length, sourceSessionId };
  } catch (error) {
    if (error.code === 'INVALID_FIXED_SOURCE' || error.code === 'FIXED_RESTORE_DESTINATION_EXISTS') throw error;
    throw failure('INVALID_FIXED_SOURCE', 'No se pudo restaurar un catálogo válido y completo de la sesión indicada.');
  } finally { if (staging) await fs.rm(staging, { recursive: true, force: true }); }
}

function validateQueue(value, sessionId) {
  if (!value || value.sessionId !== sessionId) throw failure('SESSION_MISMATCH', 'commands.json debe indicar el sessionId de esta sesión.');
  if (!Array.isArray(value.commands) || value.commands.length > 500) throw failure('INVALID_QUEUE', 'commands debe ser un arreglo de hasta 500 órdenes.');
  const identities = new Map();
  return value.commands.map(entry => {
    if (!entry || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(entry.commandId || '') ||
      !(typeof entry.command === 'string' || (entry.command && typeof entry.command === 'object' && !Array.isArray(entry.command)))) {
      throw failure('INVALID_QUEUE', 'Cada orden necesita commandId seguro y command de texto u objeto.');
    }
    const fingerprint = commandFingerprint(entry.command);
    if (identities.has(entry.commandId) && identities.get(entry.commandId) !== fingerprint) throw failure('COMMAND_ID_CONFLICT', 'Un commandId aparece con dos órdenes diferentes.');
    identities.set(entry.commandId, fingerprint);
    return { commandId: entry.commandId, command: entry.command, fingerprint };
  });
}

function verificationState(controller) {
  const value = controller.verification || {};
  return { status: ['idle', 'checking', 'stable', 'unstable'].includes(value.status) ? value.status : 'idle',
    currentSample: Math.max(0, Math.min(3, Number(value.currentSample) || 0)), requiredSamples: 3, intervalMs: 2000 };
}

class GitHubReader {
  constructor(token, fetchImpl = fetch) { this.token = token; this.fetch = fetchImpl; }
  async readJSON(file, optional = false) {
    if (![START_PATH, COMMANDS_PATH].includes(file)) throw failure('READ_SCOPE', 'Ruta de entrada no permitida.');
    const url = `https://api.github.com/repos/${REPOSITORY}/contents/${file}?ref=${encodeURIComponent(BRANCH)}`;
    let response;
    try {
      response = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: {
        Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'button-browser-session/1.1',
      } });
    } catch { throw failure('GITHUB_READ_FAILED', 'No se pudo leer la entrada de GitHub.'); }
    if (response.status === 404 && optional) return null;
    if (!response.ok) throw failure('GITHUB_READ_FAILED', `GitHub rechazó la lectura (HTTP ${response.status}).`);
    const fileData = await response.json();
    if (fileData.type !== 'file' || fileData.encoding !== 'base64' || fileData.size > 512000) throw failure('INVALID_INPUT_FILE', 'La entrada debe ser un archivo JSON de hasta 512 KB.');
    try { return { sha: fileData.sha, data: JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8')) }; }
    catch { throw failure('INVALID_INPUT_JSON', 'El archivo de entrada no contiene JSON válido.'); }
  }
}

// Every commit starts at the freshly fetched remote tree. Only this session's
// result directory is changed. A non-fast-forward push is retried as a CHECKPOINT,
// never as a browser action; concurrent command-file edits remain in the tree.
class GitPublisher {
  constructor({ repositoryRoot, token, prefix, owner }) {
    this.repositoryRoot = repositoryRoot; this.prefix = prefix; this.owner = owner;
    this.remote = `https://github.com/${REPOSITORY}.git`;
    this.tail = Promise.resolve(); this.temporary = null;
    this.env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_TRACE: '0', GIT_TRACE_CURL: '0', GIT_CURL_VERBOSE: '0',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_COMMITTER_NAME: 'github-actions[bot]',
      GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
      GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' };
  }
  assertPath(file) {
    if (!file.startsWith(`${this.prefix}/`) || file.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f\\]/.test(file)) throw failure('WRITE_SCOPE', 'El checkpoint intentó escribir fuera de su sesión.');
  }
  async git(args, input, extra = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: this.repositoryRoot, env: { ...this.env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = []; let settled = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 45000);
      child.stdout.on('data', chunk => chunks.push(chunk));
      child.stderr.resume(); // Never echo Git HTTP diagnostics or credentials.
      child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); reject(failure('GIT_FAILED', 'No se pudo iniciar Git.')); } });
      child.on('close', code => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (code !== 0) reject(failure('GIT_FAILED', `Falló Git durante ${args[0]} (código ${code ?? 'timeout'}).`));
        else resolve(Buffer.concat(chunks).toString('utf8').trim());
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  publish(files, message) {
    const operation = this.tail.then(() => this.publishOnce(files, message));
    this.tail = operation.catch(() => {});
    return operation;
  }
  async publishOnce(files, message) {
    if (!this.temporary) this.temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'button-browser-git-'));
    const ownerPath = `${this.prefix}/owner.json`;
    const output = new Map(files);
    output.set(ownerPath, jsonBytes(this.owner));
    for (const file of output.keys()) this.assertPath(file);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.git(['fetch', '--quiet', '--no-tags', this.remote, `refs/heads/${BRANCH}`]);
        const base = await this.git(['rev-parse', 'FETCH_HEAD']);
        const exists = await this.git(['ls-tree', base, '--', ownerPath]);
        if (exists) {
          const previous = JSON.parse(await this.git(['show', `${base}:${ownerPath}`]));
          if (previous.nonce !== this.owner.nonce) throw failure('SESSION_ALREADY_USED', 'Este sessionId ya pertenece a otro proceso. Creá un sessionId nuevo; no se repetirán órdenes de una sesión anterior.');
        }
        const index = path.join(this.temporary, 'checkpoint.index');
        await fs.rm(index, { force: true });
        const indexEnv = { GIT_INDEX_FILE: index };
        await this.git(['read-tree', base], undefined, indexEnv);
        const entries = [];
        for (const [file, bytes] of output) {
          const blob = await this.git(['hash-object', '-w', '--stdin'], bytes);
          entries.push(`100644 ${blob}\t${file}\n`);
        }
        await this.git(['update-index', '--index-info'], entries.join(''), indexEnv);
        const tree = await this.git(['write-tree'], undefined, indexEnv);
        if (tree === await this.git(['rev-parse', `${base}^{tree}`])) return base;
        const commit = await this.git(['commit-tree', tree, '-p', base], `${message}\n`);
        await this.git(['push', '--quiet', this.remote, `${commit}:refs/heads/${BRANCH}`]);
        return commit;
      } catch (error) {
        if (error.code === 'SESSION_ALREADY_USED' || error.code === 'WRITE_SCOPE') throw error;
        lastError = error;
        if (attempt < 2) await sleep(750 * (attempt + 1));
      }
    }
    throw lastError || failure('CHECKPOINT_FAILED', 'No se pudo publicar el checkpoint.');
  }
  async close() { await this.tail; if (this.temporary) await fs.rm(this.temporary, { recursive: true, force: true }); }
}

class SessionRunner {
  constructor({ config, controller, reader, publisher, evidenceRoot, sanitize, owner, pollMs = POLL_MS, maxMs = MAX_SESSION_MS }) {
    Object.assign(this, { config, controller, reader, publisher, evidenceRoot, sanitize, owner, pollMs, maxMs });
    this.prefix = `button-browser/ci-results/${config.sessionId}`;
    this.startedAt = new Date().toISOString(); this.expiresAt = Date.now() + maxMs;
    this.seq = 0; this.ledger = new Map(); this.history = []; this.responseFiles = new Map();
    this.lastCommandId = null; this.lastResponse = null; this.latestFiles = null;
    this.status = 'running'; this.phase = 'starting'; this.stopReason = null;
    this.pendingCheckpoint = null; this.lastHeartbeat = 0; this.checkpointError = null; this.queueError = null;
    this.claimed = false; this.currentAction = null;
    this.fixedFiles = null;
  }
  rawURL(relative) { return `https://raw.githubusercontent.com/${REPOSITORY}/refs/heads/${BRANCH}/${this.prefix}/${relative}`; }
  rewriteFixedReferences(value) {
    if (Array.isArray(value)) { for (const item of value) this.rewriteFixedReferences(item); }
    else if (value && typeof value === 'object') {
      if (FIXED_ID.test(value.id || '') && (value.fixed === true || value.source === 'fixed')) value.cropUrl = this.rawURL(`fixed/${value.id}.png`);
      for (const item of Object.values(value)) this.rewriteFixedReferences(item);
    }
    return value;
  }
  publicFixedButtons() {
    const buttons = this.rewriteFixedReferences(this.sanitize(this.controller.fixedButtons || []));
    if (this.status !== 'ready' || this.controller.verification?.status === 'checking') {
      const unavailableReason = this.status === 'stopped' || this.status === 'error' ? 'La sesión está cerrada.' : 'Hay una acción en curso.';
      for (const button of buttons) { button.available = false; button.unavailableReason = unavailableReason; }
    }
    return buttons;
  }
  async writeLocal(relative, bytes) {
    const target = path.join(this.evidenceRoot, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  snapshot() {
    const publishResult = this.status !== 'running';
    return this.sanitize({ schemaVersion: 1, runId: this.owner.runId, runAttempt: this.owner.runAttempt,
      runURL: this.owner.runURL, branch: BRANCH, sessionId: this.config.sessionId, status: this.status, phase: this.phase,
      seq: this.seq, lastCommandId: this.lastCommandId, lastResponse: publishResult ? this.lastResponse : null,
      verification: verificationState(this.controller), startedAt: this.startedAt, updatedAt: new Date().toISOString(),
      fixedButtons: this.publicFixedButtons(), fixedCatalog: this.fixedFiles, fixedButtonsFrom: this.config.fixedButtonsFrom || null,
      expiresAt: new Date(this.expiresAt).toISOString(), gameURL: this.config.gameURL,
      stopReason: this.stopReason, checkpointError: this.checkpointError, queueError: this.queueError,
      activeObservationId: publishResult && this.status === 'ready' ? this.controller.observation?.observationId || null : null,
      files: publishResult ? this.latestFiles : (this.latestFiles ? { current: this.latestFiles.current } : null),
      commands: [...this.ledger.values()], index: `${this.prefix}/index.json`, history: `${this.prefix}/history.json` });
  }
  async buildCheckpoint(assets = new Map()) {
    const fixedAssets = await this.saveFixedCatalog();
    const snapshot = this.snapshot();
    const index = { sessionId: this.config.sessionId, seq: this.seq, status: this.status,
      activeObservationId: snapshot.activeObservationId, current: snapshot.files,
      responses: [...this.responseFiles.keys()], fixed: this.fixedFiles, state: `${this.prefix}/state.json`, history: `${this.prefix}/history.json` };
    const local = new Map([['state.json', jsonBytes(snapshot)], ['index.json', jsonBytes(index)], ['history.json', jsonBytes(this.history)]]);
    for (const [file, bytes] of local) await this.writeLocal(file, bytes);
    return new Map([...assets, ...fixedAssets, ...[...local].map(([file, bytes]) => [`${this.prefix}/${file}`, bytes]), ...this.responseFiles]);
  }
  async saveFixedCatalog() {
    const store = this.controller.fixedStore;
    if (!store) return new Map();
    const buttons = await store.list();
    let index;
    try { index = fixedIndex(await regularFile(path.join(store.directory, 'index.json'), MAX_FIXED_INDEX_BYTES)); }
    catch (error) {
      if (error.code !== 'ENOENT' || buttons.length) throw error;
      index = { version: 1, nextId: 1, buttons: [] };
    }
    // Store.list validates all fields. Preserve that exact catalog for future
    // sessions: applying the output sanitizer would alter scope labels/metadata.
    if (JSON.stringify(canonical(index.buttons)) !== JSON.stringify(canonical(buttons))) throw failure('FIXED_CATALOG_CHANGED', 'El catálogo cambió durante la preparación del checkpoint.');
    const assets = new Map(), crops = [];
    const catalog = jsonBytes({ version: 1, nextId: index.nextId, buttons });
    assets.set(`${this.prefix}/fixed/index.json`, catalog);
    await this.writeLocal('fixed/index.json', catalog);
    for (const button of buttons) {
      const file = `${button.id}.png`, stat = await fs.lstat(path.join(store.directory, file));
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FIXED_PNG_BYTES) throw failure('INVALID_FIXED_SOURCE', 'El recorte fijo debe ser un archivo PNG normal.');
      const bytes = await store.template(button.id);
      assets.set(`${this.prefix}/fixed/${file}`, bytes);
      await this.writeLocal(`fixed/${file}`, bytes);
      crops.push(`${this.prefix}/fixed/${file}`);
    }
    this.fixedFiles = { index: `${this.prefix}/fixed/index.json`, crops };
    return assets;
  }
  async checkpoint(assets = new Map()) {
    const bundle = await this.buildCheckpoint(assets);
    await this.publisher.publish(bundle, `Button Browser ${this.config.sessionId}: ${this.phase} ${this.seq}`);
    this.lastHeartbeat = Date.now(); this.checkpointError = null;
  }
  async publishResult(assets = new Map()) {
    const retainedAssets = new Map(this.pendingCheckpoint || []);
    for (const [file, bytes] of assets) retainedAssets.set(file, bytes);
    for (const file of ['state.json', 'index.json', 'history.json']) retainedAssets.delete(`${this.prefix}/${file}`);
    const bundle = await this.buildCheckpoint(retainedAssets);
    try {
      await this.publisher.publish(bundle, `Button Browser ${this.config.sessionId}: result ${this.seq}`);
      this.pendingCheckpoint = null; this.checkpointError = null; this.lastHeartbeat = Date.now();
    } catch (error) {
      this.checkpointError = safeError(error, this.sanitize);
      this.pendingCheckpoint = bundle; // Retry these bytes only; never execute the command again.
      await this.writeLocal('checkpoint-error.json', jsonBytes(this.checkpointError));
      if (error.code === 'SESSION_ALREADY_USED') throw error;
    }
  }
  async flushPending() {
    if (!this.pendingCheckpoint) return true;
    try {
      await this.publisher.publish(this.pendingCheckpoint, `Button Browser ${this.config.sessionId}: retry checkpoint ${this.seq}`);
      this.pendingCheckpoint = null; this.checkpointError = null; this.lastHeartbeat = Date.now();
      return true;
    } catch (error) {
      this.checkpointError = safeError(error, this.sanitize);
      await this.writeLocal('checkpoint-error.json', jsonBytes(this.checkpointError));
      if (error.code === 'SESSION_ALREADY_USED') throw error;
      return false;
    }
  }
  async saveObservation(observation) {
    if (!observation) { this.latestFiles = null; return { observation: null, assets: new Map() }; }
    if (!/^[a-f0-9-]{36}$/.test(observation.observationId || '')) throw failure('INVALID_OBSERVATION', 'Identificador de observación inválido.');
    const id = observation.observationId;
    const directory = path.join(this.controller.artifactDir, id);
    const publicObservation = this.rewriteFixedReferences(this.sanitize(observation));
    const assets = new Map();
    const mapping = { 'screenshot.png': 'current.png', 'annotated.png': 'annotated.png', 'buttons.png': 'buttons.png' };
    const names = (await fs.readdir(directory)).filter(file => /^(screenshot|annotated|buttons)\.png$|^b\d{1,4}\.png$/.test(file)).sort();
    const crops = [];
    for (const file of names) {
      const bytes = await fs.readFile(path.join(directory, file));
      const relative = mapping[file] || `crops/${id}/${file}`;
      assets.set(`${this.prefix}/${relative}`, bytes);
      if (mapping[file]) assets.set(`${this.prefix}/observations/${id}/${file}`, bytes);
      await this.writeLocal(`observations/${id}/${file}`, bytes);
      if (mapping[file]) await this.writeLocal(relative, bytes);
      else crops.push(`${this.prefix}/${relative}`);
    }
    publicObservation.screenshotUrl = this.rawURL(`observations/${id}/screenshot.png`);
    publicObservation.annotatedUrl = this.rawURL(`observations/${id}/annotated.png`);
    publicObservation.contactSheetUrl = this.rawURL(`observations/${id}/buttons.png`);
    publicObservation.jsonUrl = this.rawURL(`observations/${id}/buttons.json`);
    for (const button of publicObservation.buttons || []) button.cropUrl = this.rawURL(`crops/${id}/${button.id}.png`);
    const observationBytes = jsonBytes(publicObservation);
    assets.set(`${this.prefix}/observation.json`, observationBytes);
    assets.set(`${this.prefix}/observations/${id}/buttons.json`, observationBytes);
    await this.writeLocal('observation.json', observationBytes);
    await this.writeLocal(`observations/${id}/buttons.json`, observationBytes);
    this.latestFiles = { observationId: id, current: `${this.prefix}/current.png`, annotated: `${this.prefix}/annotated.png`,
      buttons: `${this.prefix}/buttons.png`, observation: `${this.prefix}/observation.json`, crops };
    return { observation: publicObservation, assets };
  }
  async progressWhile(work) {
    let completed = false, previous = '';
    const watch = (async () => {
      while (!completed && !this.stopReason) {
        const verification = verificationState(this.controller);
        const key = JSON.stringify(verification);
        if (verification.status === 'checking' && key !== previous) {
          previous = key;
          try { await this.checkpoint(); } catch (error) { this.checkpointError = safeError(error, this.sanitize); }
        }
        await sleep(250);
      }
    })();
    try { return await work(); } finally { completed = true; await watch; }
  }
  async executeEntry(entry) {
    this.seq++;
    const record = { commandId: entry.commandId, fingerprint: entry.fingerprint, seq: this.seq, status: 'reserved', startedAt: new Date().toISOString() };
    this.ledger.set(entry.commandId, record); this.lastCommandId = entry.commandId;
    this.lastResponse = null; this.status = 'running'; this.phase = 'executing';
    let command, parseError;
    try { command = isStop(entry.command) ? { action: 'STOP' } : parseCommand(entry.command); }
    catch (error) { parseError = error; command = { action: 'invalid' }; }
    const publicCommand = this.sanitize(command.action === 'type' ? { action: 'type', text: '[redacted input]' } : command);
    const history = { seq: this.seq, commandId: entry.commandId, command: publicCommand, startedAt: record.startedAt, status: 'reserved' };
    this.history.push(history);
    let response, assets = new Map();
    if (command.action === 'STOP') {
      this.stopReason = 'STOP';
      await this.controller.close();
      response = { ok: true, result: { action: 'STOP', stopped: true } };
    } else {
      try { await this.checkpoint(); }
      catch (error) {
        response = { ok: false, actionExecuted: false, error: { code: 'CHECKPOINT_BEFORE_EXECUTION_FAILED', message: 'No se pudo confirmar la reserva remota. La orden no se ejecutó y su ID quedó consumido; usá un ID nuevo si decidís enviarla otra vez.', checkpoint: safeError(error, this.sanitize) } };
      }
      if (!response) {
        try {
          if (parseError) throw parseError;
          if (this.stopReason || Date.now() >= this.expiresAt) throw failure('SESSION_STOPPED', 'La sesión terminó antes de ejecutar la orden.');
          this.currentAction = command.action;
          const operation = () => this.controller.execute(command);
          const result = command.action === 'verify' ? await this.progressWhile(operation) : await operation();
          response = { ok: true, ...result };
        } catch (error) { response = { ok: false, actionExecuted: parseError ? false : 'unknown', error: safeError(error, this.sanitize) }; }
        finally { this.currentAction = null; }
      }
      this.phase = 'publishing';
      try {
        const observation = response.observation || this.controller.observation;
        const saved = await this.saveObservation(observation);
        assets = saved.assets;
        if ('observation' in response) response.observation = saved.observation;
        if (response.result?.observation) response.result.observation = saved.observation;
      } catch (error) {
        this.latestFiles = null;
        response.evidenceError = safeError(error, this.sanitize);
      }
    }
    record.status = 'finished'; record.completedAt = new Date().toISOString();
    record.ok = Boolean(response.ok); record.actionExecuted = response.actionExecuted ?? response.result?.actionExecuted ?? response.ok;
    this.lastResponse = this.rewriteFixedReferences(this.sanitize(response));
    const relative = `responses/${String(this.seq).padStart(6, '0')}.json`;
    const responseBytes = jsonBytes({ seq: this.seq, commandId: entry.commandId, completedAt: record.completedAt, response: this.lastResponse });
    await this.writeLocal(relative, responseBytes);
    this.responseFiles.set(`${this.prefix}/${relative}`, responseBytes);
    Object.assign(history, { status: 'finished', completedAt: record.completedAt, ok: record.ok,
      actionExecuted: record.actionExecuted, responsePath: relative, observationId: response.observation?.observationId || null,
      error: response.error || null });
    this.status = this.stopReason ? 'stopped' : 'ready'; this.phase = this.stopReason ? 'stopped' : 'waiting';
    await this.publishResult(assets);
  }
  requestStop(reason) {
    if (this.stopReason) return;
    this.stopReason = reason;
    this.closing = this.controller.close().catch(() => {});
  }
  async run() {
    await fs.mkdir(this.evidenceRoot, { recursive: true });
    const stopTimer = setTimeout(() => this.requestStop('timeout'), this.maxMs);
    const onSignal = () => this.requestStop('signal');
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    try {
      await this.checkpoint(); // Atomic owner claim, before opening Chromium or navigating.
      this.claimed = true;
      await this.executeEntry({ commandId: BOOTSTRAP_ID, command: { action: 'goto', url: this.config.gameURL }, fingerprint: commandFingerprint({ action: 'goto', url: this.config.gameURL }) });
      while (!this.stopReason && Date.now() < this.expiresAt) {
        let entries = [];
        try {
          const input = await this.reader.readJSON(COMMANDS_PATH, true);
          if (input) entries = validateQueue(input.data, this.config.sessionId);
          this.queueError = null;
          for (const entry of entries) {
            const previous = this.ledger.get(entry.commandId);
            if (previous && previous.fingerprint !== entry.fingerprint) throw failure('COMMAND_ID_CONFLICT', 'Una orden ya registrada cambió de contenido. Conservá su contenido o usá un commandId nuevo.');
          }
        } catch (error) { this.queueError = safeError(error, this.sanitize); entries = []; }
        if (this.stopReason || Date.now() >= this.expiresAt) break;
        const next = entries.find(entry => !this.ledger.has(entry.commandId));
        const publicationReady = await this.flushPending();
        if (next && (publicationReady || isStop(next.command))) await this.executeEntry(next);
        else if (!this.pendingCheckpoint && Date.now() - this.lastHeartbeat >= 30000) {
          try { await this.checkpoint(); } catch (error) { this.checkpointError = safeError(error, this.sanitize); }
        }
        if (!this.stopReason) await sleep(Math.min(this.pollMs, Math.max(0, this.expiresAt - Date.now())));
      }
      if (!this.stopReason) this.stopReason = 'timeout';
    } catch (error) {
      this.status = 'error'; this.phase = 'error'; this.lastResponse = { ok: false, error: safeError(error, this.sanitize) };
      await this.writeLocal('fatal.json', jsonBytes(this.lastResponse));
      console.error(`[button-browser] ${this.lastResponse.error.code}: ${this.lastResponse.error.message}`);
    } finally {
      clearTimeout(stopTimer); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
      await this.closing; await this.controller.close().catch(() => {});
      if (this.status !== 'error') { this.status = 'stopped'; this.phase = 'stopped'; }
      if (this.claimed) {
        // Preserve an unacknowledged result's asset bytes in the final checkpoint.
        const assets = new Map(this.pendingCheckpoint || []);
        for (const file of ['state.json', 'index.json', 'history.json']) assets.delete(`${this.prefix}/${file}`);
        await this.publishResult(assets).catch(() => {});
      } else await this.buildCheckpoint().catch(() => {});
      await this.publisher.close();
    }
    return this.status === 'error' ? 1 : 0;
  }
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw failure('MISSING_GITHUB_TOKEN', 'El workflow debe proporcionar GITHUB_TOKEN.');
  if (process.env.GITHUB_REPOSITORY?.toLowerCase() !== REPOSITORY.toLowerCase() || process.env.GITHUB_REF_NAME !== BRANCH) throw failure('WRONG_REPOSITORY_OR_BRANCH', 'Esta sesión sólo puede escribir en el repositorio y la rama dedicados.');
  const sanitize = makeSanitizer([token, process.env.VISION_API_KEY, process.env.BUTTON_BROWSER_TOKEN]);
  const reader = new GitHubReader(token);
  const input = await reader.readJSON(START_PATH);
  const config = validateStart(input.data);
  const projectRoot = path.resolve(__dirname, '..');
  const repositoryRoot = process.env.GITHUB_WORKSPACE || path.resolve(projectRoot, '..');
  const runtimeRoot = path.join(projectRoot, '.session-runtime', config.sessionId);
  const fixedButtonDir = path.join(runtimeRoot, 'fixed');
  if (config.fixedButtonsFrom) await restoreFixedButtons({ repositoryRoot, sourceSessionId: config.fixedButtonsFrom, targetDirectory: fixedButtonDir });
  const owner = { sessionId: config.sessionId, runId: process.env.GITHUB_RUN_ID || 'unknown', runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
    runURL: `https://github.com/${REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`, nonce: crypto.randomUUID() };
  const publisher = new GitPublisher({ repositoryRoot, token, prefix: `button-browser/ci-results/${config.sessionId}`, owner });
  const controller = new BrowserController({ headless: true, artifactDir: path.join(runtimeRoot, 'observations'), fixedButtonDir });
  const runner = new SessionRunner({ config, controller, reader, publisher, evidenceRoot: path.join(projectRoot, 'evidence', config.sessionId), sanitize, owner });
  console.log(`[button-browser] Sesión ${config.sessionId}; espera órdenes explícitas durante un máximo de 25 minutos.`);
  return runner.run();
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => {
  const sanitize = makeSanitizer([process.env.GITHUB_TOKEN, process.env.VISION_API_KEY, process.env.BUTTON_BROWSER_TOKEN]);
  const safe = safeError(error, sanitize);
  console.error(`[button-browser] ${safe.code}: ${safe.message}`); process.exitCode = 1;
});

module.exports = { REPOSITORY, BRANCH, START_PATH, COMMANDS_PATH, POLL_MS, MAX_SESSION_MS,
  canonical, commandFingerprint, isStop, redactURL, makeSanitizer, safeError, validateStart, validateQueue,
  verificationState, restoreFixedButtons, GitHubReader, GitPublisher, SessionRunner };
