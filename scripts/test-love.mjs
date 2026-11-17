import { mkdtemp, mkdir, cp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { packageFiles } from './build-web.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'pixmino-love-test-'));
const canonical = await realpath(scratch);
try {
  const source = join(scratch, 'game');
  for (const file of await packageFiles(root)) {
    await mkdir(dirname(join(source, file)), { recursive: true });
    await cp(join(root, file), join(source, file));
  }
  await writeFile(join(source, 'main.lua'), await readFile(join(root, 'main.lua'), 'utf8') + '\n' + await readFile(join(root, 'tests/love-smoke.lua'), 'utf8'));
  if (process.argv.includes('--web')) {
    // Use a separate test page; the release artifact never contains the harness.
    await writeFile(join(source, 'conf.lua'), (await readFile(join(source, 'conf.lua'), 'utf8')).replace('"pixmino"', '"pixmino-smoke"'));
    const archive = join(scratch, 'smoke.love');
    const zipped = spawnSync('zip', ['-q', '-r', archive, '.'], { cwd: source, encoding: 'utf8' });
    if (zipped.status !== 0) throw new Error(zipped.stderr || 'Smoke zip failed');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const generator = require.resolve('love.js/index.js');
    const site = join(scratch, 'site');
    const built = spawnSync(process.execPath, [generator, archive, site, '-c', '-m', '134217728', '-t', 'Pixmino smoke'], { encoding: 'utf8' });
    if (built.status !== 0) throw new Error(built.stderr || 'Smoke Web packaging failed');
    const output = join(root, 'build', 'web-smoke');
    await cp(join(root, 'build', 'web'), output, { recursive: true });
    for (const file of ['game.js', 'game.data']) await cp(join(site, file), join(output, file));
    console.log('Prepared build/web-smoke (test harness only)');
  } else {
    const result = spawnSync('love', [source], {
      cwd: root, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, XDG_DATA_HOME: join(scratch, 'data'), ALSOFT_DRIVERS: 'null',
        ...(process.platform === 'linux' ? { SDL_VIDEODRIVER: 'offscreen' } : {}) }
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error || result.status !== 0 || !result.stdout?.includes('SMOKE_PASS:')) {
      throw new Error(`LÖVE smoke failed: ${result.error?.message || `exit ${result.status}`}`);
    }
  }
} finally {
  if (await realpath(scratch) !== canonical || !canonical.startsWith(await realpath(tmpdir()) + '/pixmino-love-test-')) throw new Error('Unsafe smoke cleanup path');
  await rm(scratch, { recursive: true, force: true });
}
