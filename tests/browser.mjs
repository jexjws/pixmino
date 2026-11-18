import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';
import { createStaticHandler } from '../scripts/serve-web.mjs';
import { litRatio } from './pixels.mjs';

const server = createServer(createStaticHandler(new URL('../build/', import.meta.url).pathname));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir('build/browser-results', { recursive: true });
const results = [];

const canvasState = page => page.evaluate(() => {
  const canvas = document.getElementById('canvas');
  const rect = canvas.getBoundingClientRect();
  const player = document.getElementById('player').getBoundingClientRect();
  return {
    backing: [canvas.width, canvas.height],
    css: [Math.round(rect.width), Math.round(rect.height)],
    player: [Math.round(player.width), Math.round(player.height)],
    dpr: devicePixelRatio,
    fullscreen: Boolean(document.fullscreenElement),
  };
});

// The game canvas must actually show the game: a fully black canvas is the reported bug.
async function assertVisibleGame(page, label, minimum = 0.5) {
  const box = await page.locator('#player').boundingBox();
  const shot = await page.screenshot({ clip: box });
  const { ratio, width, height } = litRatio(shot);
  await writeFile(`build/browser-results/${label}.png`, shot);
  assert.ok(ratio > minimum, `${label}: game canvas is black (${(ratio * 100).toFixed(1)}% lit, ${width}x${height})`);
  return ratio;
}

// HiDPI screens must keep the backing store at CSS size x devicePixelRatio, or rendering breaks.
async function assertHiDpiBacking(page, label) {
  const state = await canvasState(page);
  assert.ok(Math.abs(state.backing[0] - state.css[0] * state.dpr) <= 2,
    `${label}: backing ${state.backing.join('x')} must track CSS ${state.css.join('x')} at DPR ${state.dpr}`);
  assert.ok(Math.abs(state.backing[1] - state.css[1] * state.dpr) <= 2,
    `${label}: backing ${state.backing.join('x')} must track CSS ${state.css.join('x')} at DPR ${state.dpr}`);
  return state;
}

async function checkCanvasRendering(browser, name, deviceScaleFactor) {
  const label = `${name}-dpr${deviceScaleFactor}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${origin}/web/`);
    await page.locator('#start').click();
    await page.locator('#cover').waitFor({ state: 'hidden', timeout: 60000 });
    await page.waitForTimeout(1500);
    const windowed = await assertHiDpiBacking(page, `${label}-windowed`);
    assert.ok(Math.abs(windowed.player[0] / windowed.player[1] - 16 / 9) < 0.02, `${label}: windowed viewport must stay 16:9`);
    const windowedRatio = await assertVisibleGame(page, `${label}-windowed`);

    await page.locator('#canvas').click();
    await page.locator('#fullscreen').click();
    await page.waitForTimeout(1500);
    const full = await canvasState(page);
    assert.equal(full.fullscreen, true, `${label}: fullscreen was not entered`);
    const fullRatio = await assertVisibleGame(page, `${label}-fullscreen`, 0.35);

    await page.locator('#canvas').click();
    await page.keyboard.press('F4');
    await page.waitForTimeout(1500);
    await assertHiDpiBacking(page, `${label}-restored`);
    const restored = await page.evaluate(() => {
      const player = document.getElementById('player').getBoundingClientRect();
      return { fullscreen: Boolean(document.fullscreenElement), player: [Math.round(player.width), Math.round(player.height)] };
    });
    assert.equal(restored.fullscreen, false, `${label}: fullscreen was not exited`);
    assert.deepEqual(restored.player, windowed.player, `${label}: layout must return to its windowed size after fullscreen`);
    const backRatio = await assertVisibleGame(page, `${label}-restored`);

    await page.setViewportSize({ width: 900, height: 800 });
    await page.waitForTimeout(1500);
    await assertHiDpiBacking(page, `${label}-resized`);
    const resizedRatio = await assertVisibleGame(page, `${label}-resized`);

    // A resize handler that re-enters itself would keep the runtime busy forever.
    const resizeEvents = await page.evaluate(() => new Promise(resolve => {
      let count = 0;
      const bump = () => { count += 1; };
      window.addEventListener('resize', bump);
      setTimeout(() => { window.removeEventListener('resize', bump); resolve(count); }, 1000);
    }));
    assert.ok(resizeEvents <= 3, `${label}: resize events must settle, saw ${resizeEvents} in one second`);

    assert.deepEqual(errors, [], `${label}: no browser exceptions expected`);
    return { label, windowed, windowedRatio, full, fullRatio, restored, backRatio, resizedRatio };
  } finally { await context.close(); }
}

try {
  for (const [name, engine] of Object.entries({ chromium, firefox })) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      const page = await context.newPage();
      const logs = [], errors = [];
      page.on('console', message => logs.push(message.text()));
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/web/`);
      await page.locator('#start').click();
      await page.locator('#cover').waitFor({ state: 'hidden', timeout: 60000 });
      await page.locator('#canvas').focus();
      // Fresh page: select simplified Chinese using real keyboard events.
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const readSettings = () => page.evaluate(() => {
        try { return JSON.parse(Module.FS.readFile('/home/web_user/love/pixmino/settings.json', { encoding: 'utf8' })); }
        catch { return null; }
      });
      await page.waitForFunction(() => {
        try { return JSON.parse(Module.FS.readFile('/home/web_user/love/pixmino/settings.json', { encoding: 'utf8' })).display.locale === 'zh_cn'; }
        catch { return false; }
      });
      await page.waitForFunction(() => document.querySelector('#save-status').textContent === '存档已同步到此浏览器');
      assert.equal((await readSettings()).display.locale, 'zh_cn');
      await page.screenshot({ path: `build/browser-results/${name}-chinese.png`, fullPage: true });
      await page.reload();
      await page.locator('#start').click();
      await page.locator('#cover').waitFor({ state: 'hidden', timeout: 60000 });
      assert.equal((await readSettings()).display.locale, 'zh_cn', 'language survives a real page reload');
      await page.locator('#canvas').focus();
      // Change volume, skin and a key binding using the shipped menus.
      for (const key of ['ArrowDown', 'Enter', 'ArrowDown', 'Enter', 'ArrowLeft', 'Escape',
        'ArrowUp', 'Enter', 'ArrowDown', 'ArrowRight', 'Escape',
        'ArrowDown', 'ArrowDown', 'Enter', 'Enter', 'Enter', 'h', 'Escape', 'Escape', 'Escape']) {
        await page.keyboard.press(key);
      }
      await page.waitForFunction(() => {
        const settings = JSON.parse(Module.FS.readFile('/home/web_user/love/pixmino/settings.json', { encoding: 'utf8' }));
        return settings.input.keys.left === 'h' && settings.display.skin === 'checker' && Math.abs(settings.sound.volume.bgm - 0.3) < 0.001;
      });
      await page.waitForFunction(() => document.querySelector('#save-status').textContent === '存档已同步到此浏览器');
      await page.reload();
      await page.locator('#start').click();
      await page.locator('#cover').waitFor({ state: 'hidden', timeout: 60000 });
      const restored = await readSettings();
      assert.equal(restored.input.keys.left, 'h');
      assert.equal(restored.display.skin, 'checker');
      assert.ok(Math.abs(restored.sound.volume.bgm - 0.3) < 0.001);
      await page.locator('#canvas').focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => Module.pixminoAudioContexts?.some(context => context.state === 'running'));
      await page.locator('#fullscreen').focus();
      await page.screenshot({ path: `build/browser-results/${name}-paused.png`, fullPage: true });
      assert.equal(await page.locator('#cover').isHidden(), true, 'game did not enter a fatal overlay');
      assert.deepEqual(errors, [], 'no browser exceptions during production UI flow');
      // Separate test artifact exercises real Lua rendering, all skins/modes and record reload.
      await page.goto(`${origin}/web-smoke/`);
      const smokeFinished = page.waitForEvent('console', { predicate: message => /SMOKE_(PASS|FAIL):/.test(message.text()), timeout: 60000 });
      await page.locator('#start').click();
      await smokeFinished;
      const passed = logs.find(line => line.includes('SMOKE_PASS:'));
      assert.ok(passed && !logs.some(line => line.includes('SMOKE_FAIL:')), logs.join('\n'));
      await page.waitForFunction(() => document.querySelector('#save-status').textContent === '存档已同步到此浏览器');
      await page.goto(`${origin}/web/`);
      await page.locator('#start').click();
      await page.locator('#cover').waitFor({ state: 'hidden', timeout: 60000 });
      const restoredRecord = await page.evaluate(() => JSON.parse(Module.FS.readFile('/home/web_user/love/pixmino-smoke/record.json', { encoding: 'utf8' })).web_smoke);
      assert.equal(restoredRecord, 42.5, 'record written by the real Lua save module survives reload');
      const rendering = [];
      for (const dpr of [1, 2]) rendering.push(await checkCanvasRendering(browser, name, dpr));
      results.push({ browser: name, version: browser.version(), languageReload: true, settingsReload: true, recordReload: true, gameplayNoException: true, smoke: passed, rendering, errors });
      await context.close();
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify(results, null, 2));
  await writeFile('build/browser-results/results.json', JSON.stringify(results, null, 2) + '\n');
} finally { await new Promise(resolve => server.close(resolve)); }
