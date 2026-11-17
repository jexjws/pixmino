import { createSaveCoordinator, installLifecycleFlush, installCanvasFocusBridge } from './runtime.mjs';

const byId = id => document.getElementById(id);
const canvas = byId('canvas');
const cover = byId('cover');
const status = byId('status');
const notice = byId('notice');
const start = byId('start');
const fullscreen = byId('fullscreen');
let running = false;
let failed = false;
let loadTimer;
const saves = createSaveCoordinator({ onState({ state, error }) {
  const labels = {
    initializing: '正在读取浏览器存档…', saved: '存档已同步到此浏览器', pending: '存档等待同步…',
    saving: '正在保存…', 'save-error': '保存失败；会自动重试。请勿关闭页面。',
    'init-error': '无法读取浏览器存档。可重试，或选择不保存的临时游玩。',
    temporary: '临时游玩：本次进度不会保存；现有浏览器存档不会被覆盖。'
  };
  byId('save-status').textContent = labels[state] || state;
  byId('retry-save').hidden = !['init-error', 'save-error'].includes(state);
  byId('temporary').hidden = state !== 'init-error';
  if (state === 'init-error') {
    clearTimeout(loadTimer);
    status.textContent = '存档初始化失败。请使用下方“重试存档”或“临时游玩”按钮继续。';
  }
  if (error) console.error('Pixmino storage:', error);
} });
installLifecycleFlush(saves, document, window);
installCanvasFocusBridge(canvas, document, window, () => running);
byId('retry-save').addEventListener('click', () => saves.retry());
byId('temporary').addEventListener('click', () => saves.playTemporarily());
byId('reload').addEventListener('click', () => location.reload());

function fail(error) {
  failed = true;
  running = false;
  fullscreen.disabled = true;
  clearTimeout(loadTimer);
  cover.hidden = false;
  byId('heading').textContent = '游戏未能继续运行';
  status.textContent = '加载或运行发生错误。请检查网络、WebGL 与浏览器支持后重试。错误详情见开发者控制台。';
  start.hidden = true;
  byId('reload').hidden = false;
  console.error('Pixmino:', error);
}
function unlockAudio() {
  for (const context of window.Module?.pixminoAudioContexts || []) {
    if (context.state === 'suspended') context.resume().catch(error => {
      notice.textContent = '声音未能恢复，请再次点击游戏画面。';
      console.warn(error);
    });
  }
}
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (byId('player').requestFullscreen) await byId('player').requestFullscreen();
    else throw new Error('Fullscreen API unavailable');
    canvas.focus();
    notice.textContent = '';
  } catch (error) { notice.textContent = '此浏览器未允许全屏，可继续窗口游玩。'; console.warn(error); }
}
let resizeFrame = 0;
function scheduleCanvasSize() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (!running) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
    if (canvas.width === width && canvas.height === height) return;
    // This exported Emscripten helper updates the backing buffer and resize listeners.
    window.Module.setCanvasSize(width, height);
    window.dispatchEvent(new Event('resize'));
  });
}
new ResizeObserver(scheduleCanvasSize).observe(byId('player'));
document.addEventListener('fullscreenchange', scheduleCanvasSize);
window.addEventListener('resize', scheduleCanvasSize);
fullscreen.addEventListener('click', toggleFullscreen);
canvas.addEventListener('pointerdown', () => { if (running) { canvas.focus(); unlockAudio(); } });
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); fail(new Error('WebGL context lost')); });
// SDL's keyboard listeners may live on document/window. Keep toolbar/browser focus out of the game.
window.addEventListener('keydown', event => {
  if (!running || document.activeElement !== canvas) { event.stopImmediatePropagation(); return; }
  unlockAudio();
  if (event.code === 'F4') {
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.repeat) toggleFullscreen();
  } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code)) event.preventDefault();
}, true);
window.addEventListener('keyup', event => {
  if (!running || document.activeElement !== canvas || event.code === 'F4') event.stopImmediatePropagation();
}, true);
window.addEventListener('error', event => { if (window.Module) fail(event.error || event.message); });
window.addEventListener('unhandledrejection', event => { if (window.Module) fail(event.reason); });

function loadScript(path) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL(path, import.meta.url).href;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${path}`));
    document.body.append(script);
  });
}
start.addEventListener('click', async () => {
  start.disabled = true;
  start.hidden = true;
  byId('heading').textContent = '正在加载 Pixmino';
  status.textContent = '正在下载游戏与运行时…';
  // Diagnostic only: never start a second initialization or overlapping sync on timeout.
  loadTimer = setTimeout(() => {
    if (!running && !failed) { status.textContent = '加载时间较长。请检查网络或浏览器存储权限，然后重新加载。'; byId('reload').hidden = false; }
  }, 60000);
  window.Module = {
    arguments: ['./game.love'], INITIAL_MEMORY: 134217728, canvas,
    locateFile: path => new URL(path, import.meta.url).href,
    print: (...args) => {
      console.log(...args);
      if (args.some(value => String(value).includes('PIXMINO_SAVE_ERROR:'))) notice.textContent = '游戏写入存档失败，本次更改可能未保存。请检查浏览器存储权限；错误详情见控制台。';
    },
    printErr: (...args) => console.error(...args),
    setStatus: text => { if (text && !failed) status.textContent = text; },
    monitorRunDependencies: left => { if (left && !failed) status.textContent = `准备运行时…（${left} 项待完成）`; },
    pixminoInitStorage: (fs, idbfs, done) => saves.initialize(fs, idbfs, done),
    onAbort: fail,
    postRun: [() => {
      if (failed) return;
      running = true; clearTimeout(loadTimer); cover.hidden = true;
      fullscreen.disabled = false;
      scheduleCanvasSize();
      canvas.focus({ preventScroll: true });
      unlockAudio();
    }]
  };
  try {
    await loadScript('./game.js');
    await loadScript('./love.js');
    await window.Love(window.Module);
  } catch (error) { fail(error); }
});
