/* Zero-dependency static server. `node tools/serve.mjs [port]` */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8099);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.bin': 'application/octet-stream', '.md': 'text/markdown; charset=utf-8',
};

http.createServer((req, res) => {
  /* QA screenshot sink: the page POSTs a PNG data URL and we drop it in qa/.
     Only reachable from this local dev server, which is never shipped. */
  if (req.method === 'POST' && req.url.startsWith('/_qa/')) {
    const raw = path.basename(decodeURIComponent(req.url.slice(5)));
    // sanitise without a regex literal: keep letters, digits, dot, dash, underscore
    const ok = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_';
    let name = '';
    for (const ch of raw) name += ok.includes(ch) ? ch : '_';
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const comma = body.indexOf(',');
        const b64 = comma >= 0 ? body.slice(comma + 1) : body;
        const dir = path.join(ROOT, 'qa');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, name.endsWith('.png') ? name : name + '.png');
        fs.writeFileSync(file, Buffer.from(b64, 'base64'));
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end(String(fs.statSync(file).size));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(e.message));
      }
    });
    return;
  }

  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
