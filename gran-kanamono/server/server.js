// グランOS 金物着色（gran-kanamono）のサーバー
// 画面（public/）を配るだけ。図面の読み込み・着色・保存はすべてブラウザの中で行い、図面はこのPCから出ない。
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 3986);
const HOST = process.env.HOST || '127.0.0.1';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf',
};

http.createServer((req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/index.html';
    const file = normalize(join(PUB, path));
    if (!file.startsWith(PUB + sep)) { res.writeHead(403); return res.end(); }
    const st = statSync(file, { throwIfNoEntry: false });
    if (!st || !st.isFile()) { res.writeHead(404); return res.end('見つかりません'); }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(400); res.end();
  }
}).listen(PORT, HOST, () => console.log(`金物着色: http://${HOST}:${PORT}/`));
