// 日照3D をパソコンで開くための小さなサーバー（ライブラリ不要）。
// 使い方: SITES=<敷地データのフォルダ> npm start → http://127.0.0.1:3986/?site=<記号>
// 敷地データ（sites/<記号>.json）はお客様の敷地の情報なので、リポジトリには入れず外のフォルダから読む。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUB = path.join(__dirname, 'public');
const SITES = process.env.SITES ? path.resolve(process.env.SITES) : path.join(PUB, 'sites');
const PORT = +process.env.PORT || 3986;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [base, rel] = u.startsWith('/sites/') ? [SITES, u.slice(7)] : [PUB, u === '/' ? 'index.html' : u.slice(1)];
  const f = path.join(base, rel);
  if (!f.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('見つかりません'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`日照3D: http://127.0.0.1:${PORT}/  （敷地データ: ${SITES}）`));
