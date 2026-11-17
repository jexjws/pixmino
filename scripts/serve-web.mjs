import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../build/web');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.data': 'application/octet-stream', '.love': 'application/zip' };

export function createStaticHandler(directory = root) {
  const base = resolve(directory);
  return async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let file = resolve(base, '.' + path);
      if (file !== base && !file.startsWith(base + sep)) { response.writeHead(403).end(); return; }
      if ((await stat(file)).isDirectory()) {
        if (!path.endsWith('/')) { response.writeHead(301, { Location: path + '/' }).end(); return; }
        file = resolve(file, 'index.html');
      }
      const canonical = await realpath(file);
      if (!canonical.startsWith((await realpath(base)) + sep)) { response.writeHead(403).end(); return; }
      const data = await readFile(file);
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 400).end('File unavailable');
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let port = 8000, host = '127.0.0.1';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--port') port = Number(args[++index]);
    else if (args[index] === '--host') host = args[++index];
    else throw new Error(`Unknown option: ${args[index]}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !host) throw new Error('Expected --port 1..65535 and --host ADDRESS');
  await stat(resolve(root, 'index.html')).catch(() => { throw new Error('Run pnpm build:web first'); });
  const server = createServer(createStaticHandler());
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Pixmino: http://${host}:${port}/ (build/web, development only)`));
}
