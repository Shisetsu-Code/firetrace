'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const {
  validateStart, commandFingerprint, makeSanitizer, GitPublisher, SessionRunner, restoreFixedButtons,
} = require('../scripts/github-session.cjs');

const observationId = '11f96dbb-f0a0-48cb-9ca8-d064ae55d262';
const clone = value => JSON.parse(JSON.stringify(value));
const entry = (id = 'f1') => ({
  id, name: 'Giro fijo', label: 'spinBtn', kind: 'button', source: 'fixed', detectedSource: 'pixi',
  fixed: true, verification: 'user-fixed', bbox: { x: 40, y: 40, width: 120, height: 50 },
  center: { x: 100, y: 65 }, clickPoint: { x: 100, y: 65 },
  normalized: { x: .03125, y: .055556, width: .09375, height: .069444 },
  scope: { urlKey: 'a'.repeat(64), label: 'https://demo.example/ContainerLauncher?gid=rise',
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, scroll: { x: 0, y: 0 } },
  createdAt: '2026-10-25T20:00:00.000Z', updatedAt: '2026-10-25T20:00:00.000Z',
  basedOnObservationId: observationId, cropUrl: `/artifacts/fixed/${id}.png`,
});

async function fixture(t, buttons = [entry()]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-fixed-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 120, height: 50, channels: 4, background: '#33aa66' } }).png().toBuffer();
  const directory = path.join(root, 'runtime', 'fixed');
  const config = { sessionId: 'fixed-test-new', gameURL: 'https://demo.example/ContainerLauncher?gid=rise' };
  const owner = { runId: 'test', runAttempt: '1', runURL: 'https://github.com/example/test/actions/runs/1', nonce: 'local-test-owner' };
  const prefix = `button-browser/ci-results/${config.sessionId}`;
  let current = clone(buttons), calls = 0;
  const store = { directory, list: async () => clone(current), template: id => fs.readFile(path.join(directory, `${id}.png`)) };
  const controller = { fixedStore: store, fixedButtons: current.map(button => ({ ...clone(button), available: true })),
    observation: null, verification: { status: 'idle', currentSample: 0 }, artifactDir: path.join(root, 'observations'),
    execute: async command => { calls++; return { result: { action: command.action }, fixedButtons: clone(controller.fixedButtons) }; },
    close: async () => {},
  };
  class RecordingPublisher extends GitPublisher {
    constructor() { super({ repositoryRoot: root, token: 'fake-test-token', prefix, owner }); this.bundles = []; this.failAt = 0; this.calls = 0; }
    async publish(files) {
      this.calls++;
      for (const file of files.keys()) this.assertPath(file);
      if (this.calls === this.failAt) throw new Error('Simulated checkpoint transport failure');
      this.bundles.push(new Map([...files].map(([file, bytes]) => [file, Buffer.from(bytes)])));
    }
    async close() {}
  }
  const publisher = new RecordingPublisher();
  const runner = new SessionRunner({ config, controller, reader: {}, publisher,
    evidenceRoot: path.join(root, 'evidence'), sanitize: makeSanitizer(['fake-test-token']), owner });
  async function setCatalog(records, nextId = 2) {
    current = clone(records);
    controller.fixedButtons = current.map(button => ({ ...clone(button), available: true }));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'index.json'), JSON.stringify({ version: 1, nextId, buttons: current }));
    for (const button of current) await fs.writeFile(path.join(directory, `${button.id}.png`), png);
  }
  await setCatalog(buttons);
  return { root, png, directory, config, controller, publisher, runner, prefix, setCatalog, calls: () => calls };
}

test('start restoration requires a different safe source session and preserves the explicit choice', () => {
  const input = { sessionId: 'next-session', gameURL: 'https://demo.example/game', fixedButtonsFrom: 'previous-session' };
  assert.equal(validateStart(input).fixedButtonsFrom, 'previous-session');
  for (const fixedButtonsFrom of ['../previous', 'a/b', 'a\\b', 'next-session', '', null, 12]) {
    assert.throws(() => validateStart({ ...input, fixedButtonsFrom }), error => error.code === 'INVALID_START');
  }
  assert.equal(Object.hasOwn(validateStart({ sessionId: 'plain', gameURL: input.gameURL }), 'fixedButtonsFrom'), false);
});

test('a checkpoint publishes the fixed catalog and durable images without any observation', async t => {
  const { runner, prefix, png, publisher } = await fixture(t);
  const bundle = await runner.buildCheckpoint();
  assert(bundle.has(`${prefix}/fixed/index.json`), 'fixed index must be part of a checkpoint');
  const index = JSON.parse(bundle.get(`${prefix}/fixed/index.json`));
  assert.equal(index.nextId, 2);
  assert.equal(index.buttons[0].scope.label, entry().scope.label, 'restore metadata must not be redacted');
  assert.equal(index.buttons[0].cropUrl, '/artifacts/fixed/f1.png', 'persisted catalog keeps local template references');
  assert.deepEqual(bundle.get(`${prefix}/fixed/f1.png`), png);
  for (const file of bundle.keys()) publisher.assertPath(file);
  assert.throws(() => publisher.assertPath('button-browser/ci-results/other-session/fixed/index.json'), { code: 'WRITE_SCOPE' });
  assert.throws(() => publisher.assertPath(`${prefix}/fixed/../../other/index.json`), { code: 'WRITE_SCOPE' });
});

test('metadata-only commands rewrite fixed crop URLs and persist the latest catalog', async t => {
  const { runner, controller, prefix, setCatalog } = await fixture(t);
  controller.execute = async () => {
    await setCatalog([{ ...entry(), name: 'Nombre actualizado' }]);
    return { result: { action: 'rename' }, fixedButtons: clone(controller.fixedButtons) };
  };
  const command = { action: 'rename', id: 'f1', name: 'Nombre actualizado' };
  await runner.executeEntry({ commandId: 'metadata-change', command, fingerprint: commandFingerprint(command) });
  assert.equal(runner.lastResponse.observation, undefined);
  assert.equal(runner.lastResponse.fixedButtons[0].cropUrl, runner.rawURL('fixed/f1.png'));
  const last = runner.publisher.bundles.at(-1);
  assert.equal(JSON.parse(last.get(`${prefix}/fixed/index.json`)).buttons[0].name, 'Nombre actualizado');
  const state = JSON.parse(last.get(`${prefix}/state.json`));
  assert.equal(state.fixedButtons[0].cropUrl, runner.rawURL('fixed/f1.png'));
  assert.equal(state.fixedButtons[0].available, true);
  assert.equal(state.lastResponse.fixedButtons[0].cropUrl, runner.rawURL('fixed/f1.png'));
});

test('running states mark saved positions unavailable and deletion updates the index without reusing IDs', async t => {
  const { runner, controller, publisher, prefix, setCatalog, directory } = await fixture(t);
  const running = runner.snapshot();
  assert.equal(running.fixedButtons[0].available, false);
  assert.equal(running.fixedButtons[0].unavailableReason, 'Hay una acción en curso.');
  controller.execute = async command => {
    assert.equal(command.action, 'unpin');
    await setCatalog([], 2);
    return { result: { action: 'unpin', removed: 'f1' }, fixedButtons: [] };
  };
  const command = { action: 'unpin', id: 'f1' };
  await runner.executeEntry({ commandId: 'remove-fixed', command, fingerprint: commandFingerprint(command) });
  const bundle = publisher.bundles.at(-1);
  assert.deepEqual(JSON.parse(bundle.get(`${prefix}/fixed/index.json`)), { version: 1, nextId: 2, buttons: [] });
  assert.equal(bundle.has(`${prefix}/fixed/f1.png`), false, 'an old retained PNG is not an active catalog entry');
  assert((await fs.stat(path.join(directory, 'f1.png'))).isFile(), 'historical PNG need not be deleted');
});

test('failed result checkpoints retain fixed image bytes and never repeat the command', async t => {
  const { runner, publisher, prefix, png, directory, calls } = await fixture(t);
  publisher.failAt = 2;
  const command = { action: 'pins' };
  await runner.executeEntry({ commandId: 'single-metadata-action', command, fingerprint: commandFingerprint(command) });
  assert.equal(calls(), 1);
  assert(runner.pendingCheckpoint);
  assert.deepEqual(runner.pendingCheckpoint.get(`${prefix}/fixed/f1.png`), png);
  await fs.rm(path.join(directory, 'f1.png'));
  assert.equal(await runner.flushPending(), true);
  assert.equal(calls(), 1);
  assert.deepEqual(publisher.bundles.at(-1).get(`${prefix}/fixed/f1.png`), png);
});

test('the initial owner checkpoint can publish a new empty store without creating its runtime files', async t => {
  const { runner, controller, root, prefix } = await fixture(t, []);
  const { FixedButtonStore } = require('../src/fixed-buttons.cjs');
  const fresh = path.join(root, 'fresh-runtime', 'fixed');
  controller.fixedStore = new FixedButtonStore(fresh);
  const bundle = await runner.buildCheckpoint();
  assert.deepEqual(JSON.parse(bundle.get(`${prefix}/fixed/index.json`)), { version: 1, nextId: 1, buttons: [] });
  await assert.rejects(fs.stat(fresh), { code: 'ENOENT' });
});

test('an observation rewrites fixed references separately from its dynamic button crops', async t => {
  const { runner, controller, png } = await fixture(t);
  const directory = path.join(controller.artifactDir, observationId);
  await fs.mkdir(directory, { recursive: true });
  for (const file of ['screenshot.png', 'annotated.png', 'buttons.png', 'b1.png']) await fs.writeFile(path.join(directory, file), png);
  const saved = await runner.saveObservation({ observationId, buttons: [{ id: 'b1', cropUrl: '/artifacts/example/b1.png' }],
    fixedButtons: [{ ...entry(), available: true }] });
  assert.equal(saved.observation.buttons[0].cropUrl, runner.rawURL(`crops/${observationId}/b1.png`));
  assert.equal(saved.observation.fixedButtons[0].cropUrl, runner.rawURL('fixed/f1.png'));
});

test('restoration validates and copies only the indexed templates into a new runtime directory', async t => {
  const { root, directory, png } = await fixture(t);
  const source = path.join(root, 'button-browser', 'ci-results', 'previous-session', 'fixed');
  await fs.mkdir(source, { recursive: true });
  await fs.copyFile(path.join(directory, 'index.json'), path.join(source, 'index.json'));
  await fs.writeFile(path.join(source, 'f1.png'), png);
  await fs.writeFile(path.join(source, 'f99.png'), png);
  const destination = path.join(root, 'future-runtime', 'fixed');
  await restoreFixedButtons({ repositoryRoot: root, sourceSessionId: 'previous-session', targetDirectory: destination });
  assert.deepEqual((await fs.readdir(destination)).sort(), ['f1.png', 'index.json']);
  assert.deepEqual(await fs.readFile(path.join(destination, 'f1.png')), png);
  assert.equal(JSON.parse(await fs.readFile(path.join(destination, 'index.json'), 'utf8')).nextId, 2);
  await assert.rejects(restoreFixedButtons({ repositoryRoot: root, sourceSessionId: '../escape', targetDirectory: destination }), error => error.code === 'INVALID_FIXED_SOURCE');
  await assert.rejects(restoreFixedButtons({ repositoryRoot: root, sourceSessionId: 'previous-session', targetDirectory: destination }), error => error.code === 'FIXED_RESTORE_DESTINATION_EXISTS');
});

test('restoration rejects symlinked input and unsafe or missing indexed files without partial output', async t => {
  const { root, directory } = await fixture(t);
  const source = path.join(root, 'button-browser', 'ci-results', 'previous-session', 'fixed');
  await fs.mkdir(source, { recursive: true });
  await fs.copyFile(path.join(directory, 'index.json'), path.join(source, 'index.json'));
  await fs.symlink(path.join(directory, 'f1.png'), path.join(source, 'f1.png'));
  const destination = path.join(root, 'future-runtime', 'fixed');
  await assert.rejects(restoreFixedButtons({ repositoryRoot: root, sourceSessionId: 'previous-session', targetDirectory: destination }), error => error.code === 'INVALID_FIXED_SOURCE');
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await fs.rm(path.join(source, 'f1.png'));
  await assert.rejects(restoreFixedButtons({ repositoryRoot: root, sourceSessionId: 'previous-session', targetDirectory: destination }));
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  const corrupt = { version: 1, nextId: 2, buttons: [{ ...entry(), id: '../../outside' }] };
  await fs.writeFile(path.join(source, 'index.json'), JSON.stringify(corrupt));
  await assert.rejects(restoreFixedButtons({ repositoryRoot: root, sourceSessionId: 'previous-session', targetDirectory: destination }), error => error.code === 'INVALID_FIXED_SOURCE');
});
