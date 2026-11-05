// グランOS 資料照合（gran-shogo）のサーバー
// - 画面（public/）を配る
// - 照合そのものはブラウザの中で行う（資料はこのPCから出ない）
// - 「AIでも照合する」を選んだときだけ、資料の文字を Claude API に送る（/api/ai-check）
// - 照合の記録（指摘と確認済みの印）を data/runs.json に残す。資料ファイル自体は保存しない
import http from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, statSync, createReadStream } from 'node:fs';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(root, '.env'));
const { aiCheck, aiEnabled } = await import('./ai.js');

const PORT = Number(process.env.PORT || 3985);
const HOST = process.env.HOST || '127.0.0.1';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const PUB = join(root, 'public');
const DATA = join(root, 'data');
const RUNS = join(DATA, 'runs.json');
mkdirSync(DATA, { recursive: true });

// サンプル資料：配信名（英数字）→ 実ファイル名
const SAMPLES = {
  'plan_old.pdf': '平面図_旧.pdf', 'plan_new.pdf': '平面図_新.pdf', 'tategu.xlsx': '建具表.xlsx',
  'shiage.xlsx': '仕上表.xlsx', 'estimate_old.xlsx': '見積_旧.xlsx', 'estimate_new.xlsx': '見積_新.xlsx',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
// ログイン前でも返すもの（ホーム画面に追加するとき端末が先に取りに来る）
const OPEN = new Set(['/logo.svg', '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/icon-512-maskable.png', '/manifest.webmanifest', '/sw.js', '/api/login']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = decodeURIComponent(url.pathname);
    if (ACCESS_CODE && !OPEN.has(path) && !authed(req)) {
      if (path.startsWith('/api/')) return json(res, 401, { error: '合言葉を入れてください' });
      return send(res, 200, LOGIN_HTML, 'text/html; charset=utf-8');
    }
    if (path === '/api/login' && req.method === 'POST') {
      const { code } = JSON.parse((await body(req, 10_000)) || '{}');
      if (!ACCESS_CODE || !safeEq(String(code || ''), ACCESS_CODE)) return json(res, 401, { error: '合言葉が違います' });
      res.setHeader('Set-Cookie', `gs_auth=${sign(ACCESS_CODE)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/config') return json(res, 200, { ai: aiEnabled(), version: '0.1.0' });
    if (path === '/api/ai-check' && req.method === 'POST') {
      if (!aiEnabled()) return json(res, 400, { error: 'AI照合は未設定です（.env に ANTHROPIC_API_KEY を入れてください）' });
      const input = JSON.parse(await body(req, 40_000_000));
      try {
        return json(res, 200, await aiCheck(input));
      } catch (e) {
        console.error('[ai-check]', e.status || '', e.message);
        return json(res, e.status && e.status < 600 ? e.status : 502, { error: e.message || 'AI照合に失敗しました' });
      }
    }
    if (path === '/api/runs' && req.method === 'GET') {
      return json(res, 200, readRuns().map(({ findings, ...r }) => ({ ...r, counts: countOf(findings, r.confirmed) })));
    }
    if (path === '/api/runs' && req.method === 'POST') {
      const run = JSON.parse(await body(req, 20_000_000));
      const rec = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), mode: run.mode, title: String(run.title || '').slice(0, 120),
        docs: (run.docs || []).map(d => ({ name: String(d.name).slice(0, 200), role: d.role })), findings: run.findings || [], ai: run.ai || null, confirmed: {} };
      const runs = readRuns();
      runs.unshift(rec);
      writeRuns(runs.slice(0, 300));
      return json(res, 200, { id: rec.id });
    }
    const m = path.match(/^\/api\/runs\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const r = readRuns().find(x => x.id === m[1]);
      return r ? json(res, 200, r) : json(res, 404, { error: '記録が見つかりません' });
    }
    if (m && req.method === 'PATCH') {
      const { findingId, confirmed, note } = JSON.parse(await body(req, 100_000));
      const runs = readRuns();
      const r = runs.find(x => x.id === m[1]);
      if (!r) return json(res, 404, { error: '記録が見つかりません' });
      if (confirmed) r.confirmed[findingId] = { at: new Date().toISOString(), note: String(note || '').slice(0, 500) };
      else delete r.confirmed[findingId];
      writeRuns(runs);
      return json(res, 200, { ok: true, confirmed: r.confirmed });
    }
    if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    // 架空のサンプル資料（「サンプルで試す」用）
    if (path.startsWith('/samples/') && SAMPLES[path.slice(9)]) return serveStatic(res, '/' + SAMPLES[path.slice(9)], join(root, 'samples'));
    return serveStatic(res, path === '/' ? '/index.html' : path);
  } catch (e) {
    console.error(e);
    return json(res, e.status || 500, { error: e.status === 413 ? 'ファイルが大きすぎます' : 'サーバーでエラーが起きました' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`資料照合 http://${HOST}:${PORT}/  （AI照合: ${aiEnabled() ? 'あり' : 'なし'}${ACCESS_CODE ? '・合言葉あり' : ''}）`);
});

function serveStatic(res, path, base = PUB) {
  const file = normalize(join(base, path));
  if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  createReadStream(file).pipe(res);
}

function readRuns() {
  try { return JSON.parse(readFileSync(RUNS, 'utf8')); } catch { return []; }
}
function writeRuns(runs) {
  const tmp = RUNS + '.tmp';
  writeFileSync(tmp, JSON.stringify(runs, null, 1));
  renameSync(tmp, RUNS);
}
function countOf(findings = [], confirmed = {}) {
  const c = { ng: 0, check: 0, change: 0, done: 0, total: findings.length };
  for (const f of findings) {
    if (confirmed[f.id]) c.done++;
    else if (f.severity === 'ng') c.ng++;
    else if (f.severity === 'check') c.check++;
    else c.change++;
  }
  return c;
}

function body(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', d => { size += d.length; if (size > limit) { const e = new Error('too large'); e.status = 413; reject(e); req.destroy(); } else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
function send(res, code, text, type) { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(text); }

const SECRET = process.env.SESSION_SECRET || 'gran-shogo';
const sign = v => createHmac('sha256', SECRET).update(v).digest('hex');
function safeEq(a, b) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function authed(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)gs_auth=([a-f0-9]+)/);
  return Boolean(m && safeEq(m[1], sign(ACCESS_CODE)));
}

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// 本家（工程FC）と同じ入口（グランOSデザインプロンプト 付録C）
const LOGIN_HTML = `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>資料照合</title>
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#F6AB00">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="資料照合">
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f0f0f0; color: #272727;
    font-family: "Zen Kaku Gothic New", "Hiragino Sans", "Yu Gothic", sans-serif; padding: 16px; box-sizing: border-box; }
  form { background: #fff; border-radius: 20px; box-shadow: 0 3px 10px rgba(0,0,0,.1); padding: 32px 24px; width: min(360px, 100%); box-sizing: border-box; text-align: center; }
  img { width: 56px; height: 56px; }
  h1 { font-size: 17px; margin: 14px 0 4px; }
  p { font-size: 12px; color: #7c7c7c; margin: 0 0 20px; line-height: 1.7; }
  input { width: 100%; box-sizing: border-box; font-size: 18px; padding: 12px 16px; border: 1px solid #ddd; border-radius: 999px; text-align: center; letter-spacing: .1em; }
  button { width: 100%; margin-top: 12px; font-size: 15px; font-weight: 700; padding: 13px; border: 0; border-radius: 999px; color: #fff;
    background: linear-gradient(135deg, #f7890a, #f9c13c); }
  .err { color: #d6336c; font-size: 13px; min-height: 1.4em; margin-top: 10px; }
</style></head>
<body>
<form id="f">
  <img src="/logo.svg" alt="">
  <h1>資料照合</h1>
  <p>合言葉を入れてください。<br>この端末では、次から入れずに開けます。</p>
  <input id="c" type="password" autocomplete="current-password" inputmode="text" autofocus placeholder="合言葉">
  <button>開く</button>
  <div class="err" id="e"></div>
</form>
<script>
document.getElementById('f').onsubmit = async (ev) => {
  ev.preventDefault();
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: document.getElementById('c').value }) });
  if (r.ok) return location.reload();
  document.getElementById('e').textContent = (await r.json().catch(() => ({}))).error || '開けませんでした';
};
</script>
</body></html>`;
