import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';
import { createStaticHandler } from '../scripts/serve-web.mjs';

const server = createServer(createStaticHandler(new URL('../build/', import.meta.url).pathname));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir('build/browser-results', { recursive: true });
const results = [];
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
      results.push({ browser: name, version: browser.version(), languageReload: true, settingsReload: true, recordReload: true, gameplayNoException: true, smoke: passed, errors });
      await context.close();
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify(results, null, 2));
  await writeFile('build/browser-results/results.json', JSON.stringify(results, null, 2) + '\n');
} finally { await new Promise(resolve => server.close(resolve)); }
