import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { createSaveCoordinator, installLifecycleFlush, installCanvasFocusBridge, SAVE_ROOT } from '../web/runtime.mjs';
import { buildWeb, packageFiles, patchRuntime, upstreamStorage, LOVE_VERSION, MEMORY, PACKAGE_ROOTS } from '../scripts/build-web.mjs';
import { createStaticHandler } from '../scripts/serve-web.mjs';

function harness() {
  const calls = [], states = [], timers = new Map();
  let sequence = 0, released = 0, mounted = 0;
  const fs = { trackingDelegate: {}, mkdirTree() {}, mount() { mounted++; }, syncfs(populate, callback) { calls.push({ populate, callback }); } };
  const coordinator = createSaveCoordinator({ onState: state => states.push(state), setTimer(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; }, clearTimer(id) { timers.delete(id); } });
  const tick = () => { const ready = [...timers.values()]; timers.clear(); for (const timer of ready) timer.fn(); };
  const initialize = () => coordinator.initialize(fs, {}, () => { released++; });
  return { coordinator, fs, calls, states, timers, tick, initialize, released: () => released, mounted: () => mounted };
}

function ready() { const h = harness(); h.initialize(); h.calls.shift().callback(null); return h; }

test('populate precedes runtime release; tracks only save writes and debounces', () => {
  const h = harness(); h.initialize();
  assert.equal(h.released(), 0); assert.equal(h.calls[0].populate, true);
  h.coordinator.flush(); assert.equal(h.calls.length, 1);
  h.calls.shift().callback(null); assert.equal(h.released(), 1);
  h.fs.trackingDelegate.onWriteToFile('/game.love'); assert.equal(h.timers.size, 0);
  h.fs.trackingDelegate.onWriteToFile(SAVE_ROOT + '-other/settings.json'); assert.equal(h.timers.size, 0);
  for (let i = 0; i < 4; i++) h.fs.trackingDelegate.onWriteToFile(SAVE_ROOT + '/pixmino/settings.json');
  assert.equal(h.timers.size, 1); assert.equal(h.calls.length, 0);
  h.tick(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].populate, false);
  h.calls.shift().callback(null); assert.equal(h.coordinator.snapshot().state, 'saved');
});

test('writes during sync schedule a second flush without overlapping', () => {
  const h = ready(); h.coordinator.markDirty(SAVE_ROOT + '/a'); h.coordinator.flush();
  h.coordinator.markDirty(SAVE_ROOT + '/b'); h.coordinator.flush(); h.coordinator.retry();
  assert.equal(h.calls.length, 1);
  h.calls.shift().callback(null); assert.equal(h.timers.size, 1);
  h.tick(); assert.equal(h.calls.length, 1);
  h.calls.shift().callback(null); assert.equal(h.coordinator.snapshot().dirty, false);
});

test('failed sync preserves dirty data, retries and handles synchronous throws', () => {
  const h = ready(); h.coordinator.markDirty(SAVE_ROOT + '/a'); h.tick();
  h.calls.shift().callback(new Error('quota'));
  assert.equal(h.coordinator.snapshot().state, 'save-error'); assert.equal(h.coordinator.snapshot().dirty, true);
  assert.equal([...h.timers.values()][0].delay, 3000);
  h.coordinator.retry(); assert.equal(h.timers.size, 0); assert.equal(h.calls.length, 1);
  h.calls.shift().callback(null); assert.equal(h.coordinator.snapshot().state, 'saved');
  h.fs.syncfs = () => { throw new Error('unavailable'); };
  h.coordinator.markDirty(SAVE_ROOT + '/a'); h.tick();
  assert.equal(h.coordinator.snapshot().state, 'save-error'); assert.equal(h.coordinator.snapshot().busy, false);
});

test('initialization failure waits for a decision; retry does not remount', () => {
  const h = harness(); h.initialize(); h.calls.shift().callback(new Error('blocked'));
  assert.equal(h.released(), 0); assert.equal(h.coordinator.snapshot().state, 'init-error');
  h.coordinator.flush(); assert.equal(h.calls.length, 0);
  h.coordinator.retry(); assert.equal(h.calls.length, 1); assert.equal(h.mounted(), 1);
  h.calls.shift().callback(null); assert.equal(h.released(), 1);
  assert.equal(h.coordinator.playTemporarily(), false);
});

test('temporary play releases once and never overwrites a failed-to-load save', () => {
  const h = harness(); h.initialize(); assert.equal(h.coordinator.playTemporarily(), false);
  h.calls.shift().callback(new Error('denied'));
  assert.equal(h.coordinator.playTemporarily(), true); assert.equal(h.released(), 1);
  assert.equal(h.coordinator.playTemporarily(), false);
  h.coordinator.markDirty(SAVE_ROOT + '/a'); h.coordinator.flush(); h.coordinator.retry(); h.tick();
  assert.equal(h.calls.length, 0); assert.equal(h.released(), 1); assert.equal(h.coordinator.snapshot().temporary, true);
});

test('synchronous mount/populate failures reach recoverable init-error', () => {
  const h = harness(); h.fs.mount = () => { throw new Error('mount'); }; h.initialize();
  assert.equal(h.coordinator.snapshot().state, 'init-error'); assert.equal(h.released(), 0);
  h.fs.mount = () => {}; h.fs.syncfs = () => { throw new Error('populate'); }; h.coordinator.retry();
  assert.equal(h.coordinator.snapshot().state, 'init-error'); assert.equal(h.coordinator.snapshot().busy, false);
  h.coordinator.playTemporarily(); assert.equal(h.released(), 1);
});

test('rename and delete tracking preserve existing delegates', () => {
  const h = harness(); let called = 0;
  h.fs.trackingDelegate.onMovePath = () => { called++; };
  h.initialize(); h.calls.shift().callback(null);
  h.fs.trackingDelegate.onMovePath('/tmp/a', SAVE_ROOT + '/a'); assert.equal(called, 1); assert.equal(h.timers.size, 1);
  h.tick(); h.calls.shift().callback(null);
  h.fs.trackingDelegate.onDeletePath(SAVE_ROOT + '/a'); h.tick(); assert.equal(h.calls.length, 1);
});

test('visibility/pagehide/blur/unload share a single coordinator', () => {
  const h = ready(); const doc = new EventTarget(); const win = new EventTarget();
  doc.visibilityState = 'visible';
  const cleanup = installLifecycleFlush(h.coordinator, doc, win);
  h.coordinator.markDirty(SAVE_ROOT + '/a'); doc.dispatchEvent(new Event('visibilitychange')); assert.equal(h.calls.length, 0);
  doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
  for (const name of ['pagehide', 'blur', 'beforeunload']) win.dispatchEvent(new Event(name));
  assert.equal(h.calls.length, 1); h.calls.shift().callback(null); cleanup();
  h.coordinator.markDirty(SAVE_ROOT + '/b'); win.dispatchEvent(new Event('pagehide')); assert.equal(h.calls.length, 0);
});

test('canvas focus bridges toolbar blur to SDL window events only while running', () => {
  const canvas = new EventTarget(), window = new EventTarget();
  let running = false, focused = true, blurs = 0, focuses = 0;
  window.addEventListener('blur', () => blurs++); window.addEventListener('focus', () => focuses++);
  const cleanup = installCanvasFocusBridge(canvas, { hasFocus: () => focused }, window, () => running);
  canvas.dispatchEvent(new Event('blur')); assert.equal(blurs, 0);
  running = true; canvas.dispatchEvent(new Event('blur')); assert.equal(blurs, 1);
  canvas.dispatchEvent(new Event('focus')); assert.equal(focuses, 1);
  focused = false; canvas.dispatchEvent(new Event('blur')); assert.equal(blurs, 1);
  cleanup(); canvas.dispatchEvent(new Event('focus')); assert.equal(focuses, 1);
});

test('patch is version/exact-source guarded and delegates initialization exactly once', async () => {
  const source = await readFile(new URL('../node_modules/love.js/src/compat/love.js', import.meta.url), 'utf8');
  const patched = patchRuntime(source, LOVE_VERSION);
  assert.ok(patched.includes('Module["FS"]=FS')); assert.ok(!patched.includes(upstreamStorage));
  assert.throws(() => patchRuntime(source.replace('function autoResumeAudioContext(ctx,elements){', 'function changedAudio(ctx,elements){'), LOVE_VERSION), /audio patch guard/);
  const audioStart = patched.indexOf('function autoResumeAudioContext(ctx,elements){');
  const audioCode = patched.slice(audioStart, patched.indexOf('function callRuntimeCallbacks', audioStart));
  const audioModule = {}, audioContext = { state: 'suspended', resume() {} };
  vm.runInNewContext(audioCode + ';autoResumeAudioContext(context, []);', { Module: audioModule, context: audioContext });
  assert.equal(audioModule.pixminoAudioContexts[0], audioContext);
  assert.throws(() => patchRuntime(source, '11.4.2'), /Expected/);
  assert.throws(() => patchRuntime(source.replace(upstreamStorage, ''), LOVE_VERSION), /guard failed/);
  assert.throws(() => patchRuntime(source + upstreamStorage, LOVE_VERSION), /guard failed/);
  const marker = 'if(typeof ENVIRONMENT_IS_PTHREAD';
  const tail = patched.slice(patched.lastIndexOf(marker)).split(/\r?\n/, 1)[0];
  const h = harness(); let added = 0, removed = 0;
  const Module = { addRunDependency() { added++; }, removeRunDependency() { removed++; }, pixminoInitStorage: (fs, idbfs, done) => h.coordinator.initialize(fs, idbfs, done) };
  vm.runInNewContext(tail, { Module, FS: h.fs, IDBFS: {} });
  assert.equal(added, 1); assert.equal(removed, 0); assert.equal(Module.FS, h.fs);
  h.calls.shift().callback(new Error('denied')); h.coordinator.playTemporarily(); assert.equal(removed, 1);
});

test('packaging selects only explicit roots and rejects symlink escapes', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'pixmino-package-'));
  try {
    for (const name of PACKAGE_ROOTS) {
      if (name.includes('.') || name === 'LICENSE') await writeFile(join(fixture, name), 'test');
      else { await mkdir(join(fixture, name)); await writeFile(join(fixture, name, 'entry.lua'), 'test'); }
    }
    await writeFile(join(fixture, '.env'), 'private'); await mkdir(join(fixture, 'node_modules'));
    await writeFile(join(fixture, 'assets', '.secret'), 'private');
    const files = await packageFiles(fixture);
    assert.ok(files.includes('main.lua')); assert.ok(!files.some(path => path.includes('secret') || path.includes('node_modules') || path.includes('.env')));
    await symlink('/etc/passwd', join(fixture, 'assets', 'escape'));
    await assert.rejects(packageFiles(fixture), /symlink/);
  } finally { assert.ok(fixture.startsWith(join(tmpdir(), 'pixmino-package-'))); await rm(fixture, { recursive: true, force: true }); }
});

test('real build packages root main.lua, compat assets and fixed memory without touching siblings', async () => {
  const sentinel = resolve('build/.web-test-sentinel');
  await mkdir(resolve('build'), { recursive: true }); await writeFile(sentinel, 'preserve');
  try {
    await buildWeb();
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve');
    const info = JSON.parse(await readFile('build/web/build-info.json', 'utf8'));
    assert.equal(info.initialMemory, MEMORY); assert.equal(info.loveVersion, LOVE_VERSION); assert.equal(info.compatibility, true);
    assert.ok(info.files.every(path => PACKAGE_ROOTS.some(root => path === root || path.startsWith(root + '/'))));
    const list = spawnSync('unzip', ['-Z1', 'build/web/pixmino.love'], { encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr); assert.deepEqual(list.stdout.trim().split('\n'), info.files);
    assert.deepEqual(await readFile('build/web/game.data'), await readFile('build/web/pixmino.love'));
    assert.match(await readFile('build/web/app.mjs', 'utf8'), /INITIAL_MEMORY: 134217728/);
    assert.match(await readFile('build/web/game.js', 'utf8'), /"filename":"\/game.love"/);
    assert.equal((await readFile('build/web/love.wasm')).subarray(0, 4).toString('hex'), '0061736d');
  } finally { assert.equal(sentinel, resolve('build/.web-test-sentinel')); await rm(sentinel, { force: true }); }
});

test('static handler serves wasm/modules, rejects unsafe access, and supports HEAD without opening a port', async () => {
  const handler = createStaticHandler(resolve('build/web'));
  async function request(url, method = 'GET') {
    const result = {};
    await handler({ url, method }, { writeHead(status, headers) { result.status = status; result.headers = headers; return this; }, end(body) { result.body = body; } });
    return result;
  }
  assert.equal((await request('/')).status, 200);
  assert.equal((await request('/love.wasm', 'HEAD')).headers['Content-Type'], 'application/wasm');
  assert.equal((await request('/love.wasm', 'HEAD')).body, undefined);
  assert.equal((await request('/app.mjs')).headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/%2e%2e%2fpackage.json')).status, 403);
  assert.equal((await request('/', 'POST')).status, 405);
});
