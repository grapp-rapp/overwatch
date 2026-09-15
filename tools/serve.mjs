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
  /* Profile save: the game mirrors your headshot bank, unlocks and skin here,
     in save/profile.json, so they outlive the browser's own storage. */
  if (req.url === '/_save/profile') {
    const file = path.join(ROOT, 'save', 'profile.json');
    if (req.method === 'GET') {
      fs.readFile(file, 'utf8', (err, txt) => {
        // no save yet is not an error: answer null, and the first save creates it
        if (err) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('null'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(txt);
      });
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', c => { body += c; if (body.length > 16384) req.destroy(); });
      req.on('end', () => {
        try {
          const p = JSON.parse(body);
          if (!p || typeof p !== 'object' || typeof p.headshots !== 'number') throw new Error('not a profile');
          const keep = {};
          for (const k of ['headshots', 'earned', 'unlocked', 'skin', 'hand', 'savedAt']) if (k in p) keep[k] = p[k];
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify(keep, null, 2));
          res.writeHead(200, { 'Content-Type': 'text/plain' }).end('saved');
        } catch (e) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end(String(e.message)); }
      });
      return;
    }
    res.writeHead(405).end();
    return;
  }
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
        // screenshots are JPEG (a 1080p PNG is 2-4 MB and the repo went past
        // GitHub's upload limit); a PNG data URL is still saved as .png
        const ext = body.startsWith('data:image/jpeg') ? '.jpg' : '.png';
        const stem = name.endsWith('.png') || name.endsWith('.jpg') ? name.slice(0, -4) : name;
        const file = path.join(dir, stem + ext);
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
