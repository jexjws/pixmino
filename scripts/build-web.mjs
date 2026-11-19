import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOVE_VERSION = '11.4.1';
export const MEMORY = 128 * 1024 * 1024;
export const PACKAGE_ROOTS = ['assets', 'conf.lua', 'lib', 'main.lua', 'user_script.lua', 'custom_cp.lua', 'LICENSE', 'src'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamStorage = 'if(typeof ENVIRONMENT_IS_PTHREAD==="undefined"||!ENVIRONMENT_IS_PTHREAD){Module.addRunDependency("IDBFS_sync");FS.mkdir("/home/web_user/love");FS.mount(IDBFS,{},"/home/web_user/love");FS.syncfs(true,function(err){if(err){Module["printErr"](err)}else{Module.removeRunDependency("IDBFS_sync")}});window.addEventListener("beforeunload",function(event){FS.syncfs(false,function(err){if(err){Module["printErr"](err)}})})}';
const guardedStorage = 'if(typeof ENVIRONMENT_IS_PTHREAD==="undefined"||!ENVIRONMENT_IS_PTHREAD){Module.addRunDependency("IDBFS_sync");Module["FS"]=FS;if(typeof Module["pixminoInitStorage"]!=="function")throw new Error("Pixmino storage coordinator missing");Module["pixminoInitStorage"](FS,IDBFS,function(){Module.removeRunDependency("IDBFS_sync")})}';

export function patchRuntime(source, version) {
  if (version !== LOVE_VERSION) throw new Error(`Expected love.js ${LOVE_VERSION}; got ${version}`);
  if (source.split(upstreamStorage).length !== 2) throw new Error('love.js storage patch guard failed: upstream source changed');
  for (const hook of ['onWriteToFile', 'onMovePath', 'onDeletePath']) {
    if (!source.includes(`FS.trackingDelegate["${hook}"]`)) throw new Error(`Missing required FS tracking hook: ${hook}`);
  }
  // OpenAL (used by LÖVE) and SDL both call this helper. Expose their contexts
  // so every explicit page gesture can retry audio resume, not only the first one.
  const audioHook = 'function autoResumeAudioContext(ctx,elements){';
  if (source.split(audioHook).length !== 2) throw new Error('love.js audio patch guard failed: upstream source changed');
  return source.replace(upstreamStorage, guardedStorage).replace(audioHook,
    audioHook + '(Module["pixminoAudioContexts"]||(Module["pixminoAudioContexts"]=[])).push(ctx);');
}

export async function packageFiles(base) {
  const result = [];
  async function visit(relative) {
    const path = join(base, relative);
    const { lstat } = await import('node:fs/promises');
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink in game package: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) {
        if (entry.startsWith('.')) continue;
        await visit(join(relative, entry));
      }
    } else if (stat.isFile()) {
      if (relative.includes('\n') || relative.includes('\r')) throw new Error('Unsupported newline in package path');
      result.push(relative);
    } else throw new Error(`Unsupported game package entry: ${relative}`);
  }
  for (const entry of PACKAGE_ROOTS) await visit(entry);
  return result;
}

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${bin} failed: ${result.error?.message || result.stderr || result.stdout}`);
}

export async function buildWeb() {
  const require = createRequire(import.meta.url);
  const dependency = dirname(require.resolve('love.js/package.json'));
  const { version } = JSON.parse(await readFile(join(dependency, 'package.json'), 'utf8'));
  const runtime = patchRuntime(await readFile(join(dependency, 'src/compat/love.js'), 'utf8'), version);
  const files = await packageFiles(root);
  // Resolve and verify the exact cleanup targets; never remove build/ or other platform artifacts.
  const output = join(root, 'build', 'web');
  const staging = join(root, 'build', '.web-stage');
  await mkdir(join(root, 'build'), { recursive: true });
  if (await realpath(join(root, 'build')) !== join(root, 'build')) throw new Error('Refusing symlinked build directory');
  for (const target of [output, staging]) {
    if (![join(root, 'build', 'web'), join(root, 'build', '.web-stage')].includes(resolve(target)) || !target.startsWith(root + sep)) throw new Error('Unsafe cleanup target');
  }
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const archive = join(staging, 'pixmino.love');
    command('zip', ['-q', '-X', archive, '-@'], { input: files.join('\n') + '\n' });
    const site = join(staging, 'site');
    command(process.execPath, [join(dependency, 'index.js'), archive, site, '-c', '-m', String(MEMORY), '-t', 'Pixmino']);
    await writeFile(join(site, 'love.js'), runtime);
    for (const entry of ['index.html', 'style.css', 'runtime.mjs', 'app.mjs']) await cp(join(root, 'web', entry), join(site, entry));
    await cp(archive, join(site, 'pixmino.love'));
    await cp(join(root, 'LICENSE'), join(site, 'LICENSE'));
    await cp(join(dependency, 'LICENSE'), join(site, 'LOVE-JS-LICENSE.txt'));
    await writeFile(join(site, 'RUNTIME-NOTICE.txt'), 'Built with love.js ' + version + ' (MIT).\nhttps://github.com/Davidobot/love.js\nThis distribution modifies the runtime storage initialization and exposes audio contexts for user-gesture resume.\nSee scripts/build-web.mjs in the Pixmino source for the guarded patches.\n');
    await writeFile(join(site, 'build-info.json'), JSON.stringify({ loveVersion: version, compatibility: true, initialMemory: MEMORY, files }, null, 2) + '\n');
    await rm(output, { recursive: true, force: true });
    await cp(site, output, { recursive: true });
    console.log(`Built build/web with love.js ${version} compatibility, ${MEMORY} bytes initial memory, ${files.length} whitelisted files.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildWeb().catch(error => { console.error(error.message); process.exitCode = 1; });
}
