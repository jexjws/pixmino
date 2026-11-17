export const SAVE_ROOT = '/home/web_user/love';

// One owner for populate and flush operations. No Lua-to-JS bridge is required.
export function createSaveCoordinator({ onState = () => {}, debounceMs = 500, retryMs = 3000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let fs, idbfs, release, mounted = false, initialized = false, temporary = false;
  let busy = false, dirty = false, timer = null, released = false, phase = 'waiting';
  const emit = (state, error) => { phase = state; onState({ state, error, dirty, busy, temporary }); };
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const releaseOnce = () => { if (!released) { released = true; release(); } };
  const belongs = path => typeof path === 'string' && (path === SAVE_ROOT || path.startsWith(SAVE_ROOT + '/'));
  function schedule(delay = debounceMs) {
    cancelTimer();
    timer = setTimer(() => { timer = null; flush(); }, delay);
  }
  function markDirty(...paths) {
    if (!initialized || temporary || !paths.some(belongs)) return;
    dirty = true;
    if (!busy) { emit('pending'); schedule(); }
  }
  function track() {
    const delegate = fs.trackingDelegate;
    for (const name of ['onWriteToFile', 'onDeletePath', 'onMovePath']) {
      const previous = delegate[name];
      delegate[name] = (...args) => { try { previous?.(...args); } finally { markDirty(...args); } };
    }
  }
  function initialize(FS, IDBFS, done) {
    if (fs || typeof done !== 'function') throw new Error('Storage initialization must be called exactly once');
    fs = FS; idbfs = IDBFS; release = done;
    populate();
  }
  function populate() {
    if (busy || initialized || temporary || !fs) return;
    busy = true;
    emit('initializing');
    let completed = false;
    const finish = error => {
      if (completed) return;
      completed = true; busy = false;
      if (error) { emit('init-error', error); return; }
      initialized = true;
      track();
      emit('saved');
      releaseOnce();
    };
    try {
      if (!mounted) {
        fs.mkdirTree(SAVE_ROOT);
        fs.mount(idbfs, {}, SAVE_ROOT);
        mounted = true;
      }
      fs.syncfs(true, finish);
    } catch (error) { finish(error); }
  }
  function flush() {
    cancelTimer();
    if (!initialized || temporary || busy || !dirty) return;
    busy = true; dirty = false;
    emit('saving');
    let completed = false;
    const finish = error => {
      if (completed) return;
      completed = true; busy = false;
      if (error) { dirty = true; emit('save-error', error); schedule(retryMs); }
      else if (dirty) { emit('pending'); schedule(); }
      else emit('saved');
    };
    try { fs.syncfs(false, finish); } catch (error) { finish(error); }
  }
  function retry() {
    if (phase === 'init-error') populate();
    else flush();
  }
  function playTemporarily() {
    if (phase !== 'init-error' || busy || initialized) return false;
    // Never flush after a failed populate: it could replace an existing save with defaults.
    temporary = true;
    cancelTimer();
    emit('temporary');
    releaseOnce();
    return true;
  }
  return { initialize, markDirty, flush, retry, playTemporarily, snapshot: () => ({ state: phase, dirty, busy, temporary, initialized }) };
}

// Emscripten forwards window focus/blur to SDL without requiring trusted events.
// A toolbar click otherwise blurs only the canvas, leaving love.focus unaware.
export function installCanvasFocusBridge(canvas, document, window, isRunning) {
  const blur = () => { if (isRunning() && document.hasFocus()) window.dispatchEvent(new Event('blur')); };
  const focus = () => { if (isRunning()) window.dispatchEvent(new Event('focus')); };
  canvas.addEventListener('blur', blur);
  canvas.addEventListener('focus', focus);
  return () => { canvas.removeEventListener('blur', blur); canvas.removeEventListener('focus', focus); };
}

export function installLifecycleFlush(coordinator, document, window) {
  const hidden = () => { if (document.visibilityState === 'hidden') coordinator.flush(); };
  const flush = () => coordinator.flush();
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', flush);
  window.addEventListener('blur', flush);
  window.addEventListener('beforeunload', flush);
  return () => {
    document.removeEventListener('visibilitychange', hidden);
    for (const event of ['pagehide', 'blur', 'beforeunload']) window.removeEventListener(event, flush);
  };
}
