// 金物着色の画面
// 流れ：1 図面を選ぶ → 2 金物リストで記号ごとの色を決める（設定）→ 3 図面全体の同じ記号に同じ色をつけて、PDFで保存
import * as pdfjs from '../vendor/pdf.min.mjs';
import * as PDFLib from '../vendor/pdf-lib.esm.min.js';
import { PALETTE, NONE, colorHex, countBySymbol, defaultColors, buildPaint, ALPHA } from './core.js';
import { analyze } from './pdfread.js';
import { paintPdf } from './paint.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = {
  cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href, cMapPacked: true,
  standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
};
const STORE = 'gran-kanamono.colors';
const PLAN_SCALE = 2.2; // 図面の下書き表示の細かさ（拡大しても記号が読める程度）

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const st = { name: '', bytes: null, doc: null, legend: null, found: null, colors: {}, views: [], open: null };

// ---------- 保存してある色（この端末だけ） ----------
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { return {}; }
}
function saveColors() {
  try { localStorage.setItem(STORE, JSON.stringify({ ...loadSaved(), ...st.colors })); } catch { /* 保存できなくても動かす */ }
}

function status(text, warn = false) {
  $('sync-text').textContent = text;
  $('sync-dot').classList.toggle('warn', warn);
}
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.tm); toast.tm = setTimeout(() => { t.hidden = true; }, 2600);
}
function fileMsg(text, kind = '') {
  const m = $('filemsg');
  m.textContent = text; m.className = 'filemsg ' + kind; m.hidden = !text;
}

// ---------- 1 図面を選ぶ ----------
const drop = $('drop');
$('file').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ''; });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  const f = [...(e.dataTransfer?.files || [])].find((x) => /\.pdf$/i.test(x.name) || x.type === 'application/pdf');
  if (f) openFile(f); else fileMsg('PDFのファイルを選んでください', 'error');
});

async function openFile(file) {
  $('step-legend').hidden = true; $('step-plan').hidden = true;
  fileMsg(`「${file.name}」を読んでいます…`);
  status('読み込み中', true);
  try {
    st.name = file.name;
    st.bytes = new Uint8Array(await file.arrayBuffer());
    st.doc?.destroy();
    // pdf.js は渡したデータを手放すことがあるので、写しを渡す（保存のときに元のデータを使う）
    st.doc = await pdfjs.getDocument({ ...PDF_OPTS, data: st.bytes.slice() }).promise;
    const { legend, found } = await analyze(pdfjs, st.doc);
    if (!legend) {
      fileMsg(`「${file.name}」から「金物リスト」の表が見つかりませんでした。柱脚柱頭金物リストが入った構造図（金物図）を選んでください。文字が画像になっているPDF（スキャンなど）は、今は読めません。`, 'error');
      status('リストなし', true);
      return;
    }
    st.legend = legend; st.found = found;
    st.colors = defaultColors(legend.rows, loadSaved());
    drop.classList.add('has');
    drop.querySelector('.drop-main').textContent = '別の図面を選ぶ';
    fileMsg(`「${file.name}」（${st.doc.numPages}ページ）を読みました。金物リストは ${legend.page + 1} ページ目です。`, 'done');
    await showLegend();
    await showPlan();
    status('端末の中で処理');
  } catch (e) {
    console.error(e);
    fileMsg(`読み込めませんでした（${e?.message || e}）。PDFが壊れていないか、パスワードがかかっていないか確かめてください。`, 'error');
    status('読み込み失敗', true);
  }
}

// ---------- 下書き表示（pdf.js で描いた上に、色を「乗算」で重ねる） ----------
/** ページの一部（PDF の座標の箱）を描く。box がなければページ全体 */
async function renderView(pageIndex, scale, box = null) {
  const page = await st.doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale });
  let ox = 0, oy = 0, w = vp.width, h = vp.height;
  if (box) {
    const [ax, ay] = vp.convertToViewportPoint(box.x0, box.y0);
    const [bx, by] = vp.convertToViewportPoint(box.x1, box.y1);
    ox = Math.floor(Math.min(ax, bx)); oy = Math.floor(Math.min(ay, by));
    w = Math.ceil(Math.abs(bx - ax)); h = Math.ceil(Math.abs(by - ay));
  }
  const base = document.createElement('canvas');
  base.width = w; base.height = h;
  const ctx = base.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -ox, -oy] }).promise;
  const at = (x, y) => { const [px, py] = vp.convertToViewportPoint(x, y); return [px - ox, py - oy]; };
  return { pageIndex, base, at, scale, canvas: null };
}

/** 色を重ねて canvas に描き直す（色を変えるたびに呼ぶ） */
function drawView(view, paint) {
  const c = view.canvas;
  c.width = view.base.width; c.height = view.base.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(view.base, 0, 0);
  const order = { band: 0, legend: 1, mark: 2, warn: 3 };
  for (const p of [...paint].filter((q) => q.page === view.pageIndex).sort((a, b) => order[a.kind] - order[b.kind])) {
    ctx.save();
    ctx.globalAlpha = ALPHA[p.kind];
    if (p.kind === 'band') {
      ctx.globalCompositeOperation = 'multiply';
      const [ax, ay] = view.at(p.x0, p.y0), [bx, by] = view.at(p.x1, p.y1);
      ctx.fillStyle = p.hex;
      ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    } else {
      const [x, y] = view.at(p.cx, p.cy);
      ctx.beginPath(); ctx.arc(x, y, p.r * view.scale, 0, Math.PI * 2);
      if (p.kind === 'warn') { ctx.strokeStyle = p.hex; ctx.lineWidth = Math.max(1.5, 0.9 * view.scale); ctx.stroke(); }
      else { ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = p.hex; ctx.fill(); }
    }
    ctx.restore();
  }
}

const currentPaint = () => buildPaint(st.legend, st.found.marks, st.colors);
function redrawAll() {
  const paint = currentPaint();
  for (const v of st.views) drawView(v, paint);
}

// ---------- 2 金物リストの色分け（設定） ----------
async function showLegend() {
  const { legend } = st;
  $('step-legend').hidden = false;
  $('legend-where').textContent = `${legend.page + 1}ページ目「${legend.title.replace(/^●/, '')}」`;
  const pad = legend.rowH * 0.8;
  const box = { x0: legend.box.x0 - pad, x1: legend.box.x1 + pad, y0: legend.box.y0 - pad, y1: legend.box.y1 + pad };
  const scale = Math.min(6, 900 / (box.x1 - box.x0));
  const v = await renderView(legend.page, scale, box);
  v.canvas = $('legend-canvas');
  st.views = st.views.filter((x) => x.canvas !== v.canvas).concat(v);
  renderRows();
  redrawAll();
}

function renderRows() {
  const cnt = countBySymbol(st.found.marks);
  $('krows').innerHTML = st.legend.rows.map((r) => {
    const id = st.colors[r.s];
    const hex = colorHex(id);
    const n = cnt.get(r.s) || 0;
    const open = st.open === r.s;
    const pal = open ? `<div class="palette" role="group" aria-label="${esc(r.s)} の色">
      ${PALETTE.map((p) => `<button type="button" data-s="${esc(r.s)}" data-c="${p.id}" class="${p.id === id ? 'on' : ''}" style="background:${p.hex}" aria-label="${p.name}" title="${p.name}"></button>`).join('')}
      <button type="button" class="none-btn ${id === NONE ? 'on' : ''}" data-s="${esc(r.s)}" data-c="${NONE}">塗らない</button></div>` : '';
    return `<li class="krow ${hex ? '' : 'off'}">
      <div class="main">
        <button type="button" class="swatch ${hex ? '' : 'none'}" style="${hex ? `background:${hex}` : ''}" data-open="${esc(r.s)}" aria-expanded="${open}" aria-label="${esc(r.s)} の色を変える（今は${hex ? PALETTE.find((p) => p.id === id).name : '塗らない'}）"></button>
        <span class="sym">${esc(r.s)}</span>
        <span class="nm"><b>${esc(r.name || '（名前なし）')}</b><span>${r.kn != null ? `引張 ${r.kn} kN` : ''}${r.struck ? '　<span class="chip chip-gray">斜線＝使わない</span>' : ''}</span></span>
        <span class="cnt">図面に<br><span class="num">${n}</span> か所</span>
      </div>${pal}</li>`;
  }).join('');
}

$('krows').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.open) { st.open = st.open === b.dataset.open ? null : b.dataset.open; renderRows(); return; }
  if (b.dataset.c) {
    st.colors[b.dataset.s] = b.dataset.c;
    st.open = null;
    saveColors(); renderRows(); redrawAll(); renderSummary();
  }
});
$('reset-colors').addEventListener('click', () => {
  st.colors = defaultColors(st.legend.rows);
  try { localStorage.removeItem(STORE); } catch { /* なにもしない */ }
  renderRows(); redrawAll(); renderSummary();
  toast('はじめの色に戻しました');
});

// ---------- 3 図面全体 ----------
async function showPlan() {
  $('step-plan').hidden = false;
  renderSummary();
  const pagesWith = [...new Set(st.found.marks.map((g) => g.page))].sort((a, b) => a - b);
  const wrap = $('pages');
  wrap.innerHTML = pagesWith.length ? '' : '<p class="muted small">色をつける記号がありませんでした。</p>';
  st.views = st.views.filter((v) => v.canvas === $('legend-canvas'));
  const cnt = {};
  for (const g of st.found.marks) cnt[g.page] = (cnt[g.page] || 0) + 1;
  for (const pi of pagesWith) {
    const box = document.createElement('div');
    box.className = 'pagebox';
    box.innerHTML = `<p class="ph"><b>${pi + 1}ページ目</b>　記号 ${cnt[pi]} か所</p><div class="pageview"><canvas aria-label="${pi + 1}ページ目の図面"></canvas></div>`;
    wrap.append(box);
    const v = await renderView(pi, PLAN_SCALE);
    v.canvas = box.querySelector('canvas');
    st.views.push(v);
  }
  redrawAll();
}

function renderSummary() {
  const { legend, found } = st;
  const cnt = countBySymbol(found.marks);
  const painted = found.marks.filter((g) => colorHex(st.colors[g.s])).length;
  const kinds = legend.rows.filter((r) => (cnt.get(r.s) || 0) > 0).length;
  const struckUsed = legend.rows.filter((r) => r.struck && cnt.get(r.s));
  const notPainted = legend.rows.filter((r) => !r.struck && cnt.get(r.s) && !colorHex(st.colors[r.s]));
  const unused = legend.rows.filter((r) => !r.struck && !cnt.get(r.s));
  const issues = struckUsed.length + found.unknown.length;
  $('summary').innerHTML = `
    <div class="card stat accent"><span class="k">PAINTED</span><span class="n">${painted}<span class="u">か所</span></span><span class="l">色をつけた記号</span></div>
    <div class="card stat"><span class="k">TYPES</span><span class="n">${kinds}<span class="u">種類</span></span><span class="l">図面で使われている金物</span></div>
    <div class="card stat ${issues ? 'alert' : ''}"><span class="k">CHECK</span><span class="n">${issues}<span class="u">件</span></span><span class="l">確かめてほしいこと</span></div>`;
  const w = [];
  for (const r of struckUsed) w.push(['bad', `斜線で消された金物「${r.s}」（${r.name}）が、図面に ${cnt.get(r.s)} か所あります。赤い輪のところを確かめてください。`]);
  if (found.unknown.length) w.push(['bad', `リストにない記号が ${found.unknown.length} か所あります（${[...new Set(found.unknown.map((g) => g.s))].join('・')}）。`]);
  for (const r of notPainted) w.push(['', `「${r.s}」は「塗らない」にしているので、図面の ${cnt.get(r.s)} か所に色がついていません。`]);
  if (unused.length) w.push(['', `リストにあって図面で使われていない金物：${unused.map((r) => r.s).join('・')}`]);
  if (found.otherSize) w.push(['', `通り芯の丸の中の字など、記号より大きさが違う同じ字 ${found.otherSize} 個は塗っていません。`]);
  if (!struckUsed.length && !found.unknown.length) w.unshift(['ok', '斜線の金物は図面にありません。リストにない記号もありません。']);
  $('warns').innerHTML = w.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('');
}

$('zoom').addEventListener('click', (e) => {
  const on = !$('step-plan').classList.contains('zoomed');
  $('step-plan').classList.toggle('zoomed', on);
  e.currentTarget.setAttribute('aria-pressed', String(on));
  e.currentTarget.textContent = on ? '図面を小さく見る' : '図面を大きく見る';
});

$('save').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = '作っています…';
  try {
    const out = await paintPdf(PDFLib, st.bytes, currentPaint());
    const filename = st.name.replace(/\.pdf$/i, '') + '_着色.pdf';
    const blob = new Blob([out], { type: 'application/pdf' });
    // claude.ai の Artifact の中では、ページから直接は保存できないので、保存の確認画面を出してもらう
    const dl = await downloadsApi;
    if (dl) {
      await dl.save({ filename, data: blob });
      toast('色をつけたPDFを保存しました');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast('色をつけたPDFを保存しました');
  } catch (err) {
    console.error(err);
    if (err?.code === 'declined') toast('保存をやめました');
    else toast('保存できませんでした：' + (err?.message || err));
  } finally {
    btn.disabled = false; btn.textContent = '色をつけたPDFを保存';
  }
});

// claude.ai の Artifact の中で開いたときだけある保存の仕組み（ふつうのブラウザでは null）
const downloadsApi = (async () => {
  try { return window.claude?.use ? await window.claude.use('downloads') : null; } catch { return null; }
})();

status('図面を選んでください');
