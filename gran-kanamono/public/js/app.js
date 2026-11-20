// 金物着色の画面
// 流れ：1 図面を選ぶ → 2 金物リスト・壁の表で記号ごとの色を決める（設定）→ 3 図面全体の同じ記号に同じ色をつけて、PDFで保存
import * as pdfjs from '../vendor/pdf.min.mjs';
import * as PDFLib from '../vendor/pdf-lib.esm.min.js';
import { PALETTE, NONE, colorHex, countBySymbol, defaultColors, buildPaint, ALPHA, WALL_ORDER, colorGroup } from './core.js';
import { countByKey, buildWallPaint } from './walls.js';
import { kisoRows, buildKisoPaint, kisoKey } from './kiso.js';
import { analyze } from './pdfread.js';
import { paintPdf } from './paint.js';
import { upperPaint } from './upper.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = {
  cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href, cMapPacked: true,
  standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href,
};
const UPPER_KEY = 'up:2F';
const STORE = 'gran-kanamono.colors.v3'; // v3：現場で決めた色（フック青・シナだいだい・オメガ15緑・20黄・Hi-28桃・ハイパーハード濃い水色）
const PLAN_SCALE = 2.2; // 図面の下書き表示の細かさ（拡大しても記号が読める程度）

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const st = { name: '', bytes: null, doc: null, legend: null, found: null, walls: null, kiso: null, colors: {}, views: [], open: null };

// ---------- 保存してある色（この端末だけ） ----------
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { return {}; }
}
function saveColors() {
  try { localStorage.setItem(STORE, JSON.stringify({ ...loadSaved(), ...st.colors })); } catch { /* 保存できなくても動かす */ }
}
function initialColors(saved) {
  const c = {};
  if (st.legend) Object.assign(c, defaultColors(st.legend.rows, saved));
  if (st.walls) Object.assign(c, defaultColors(st.walls.legend.rows, saved, WALL_ORDER));
  if (st.upper) c[UPPER_KEY] = saved[UPPER_KEY] && (saved[UPPER_KEY] === NONE || colorHex(saved[UPPER_KEY])) ? saved[UPPER_KEY] : 'brown';
  // 基礎：現場の手書きに合わせたはじめの色（人通口＝だいだい、開口補強＝桃、ホールダウン＝赤、FG1＝水色…）
  for (const r of kisoAllRows()) {
    const sv = saved[r.key];
    c[r.key] = sv && (sv === NONE || colorHex(sv)) ? sv : (r.struck ? NONE : r.def);
  }
  return c;
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
    const { legend, found, walls, kiso, firstFloor, upper } = await analyze(pdfjs, st.doc, (n, all) => fileMsg(`「${file.name}」を読んでいます…（${n} / ${all} ページ）`));
    if (!legend && !walls && !kiso) {
      fileMsg(`「${file.name}」から「金物リスト」や「軸組みの種類と壁倍率」の表が見つかりませんでした。構造図（金物図）を選んでください。文字や線が画像になっているPDF（スキャンなど）は、今は読めません。`, 'error');
      status('表なし', true);
      return;
    }
    st.legend = legend; st.found = found; st.walls = walls; st.kiso = kiso; st.firstFloor = firstFloor || []; st.upper = upper;
    st.colors = initialColors(loadSaved());
    st.open = null;
    drop.classList.add('has');
    drop.querySelector('.drop-main').textContent = '別の図面を選ぶ';
    const found1 = [legend && `金物リスト（${legend.page + 1}ページ目）`, walls && `壁の表（${walls.legend.page + 1}ページ目）`,
      kiso?.planPages.length && `基礎伏図（${kiso.planPages.map((p) => p + 1).join('・')}ページ目）`, kiso?.list && `基礎リスト（${kiso.list.page + 1}ページ目）`].filter(Boolean).join('・');
    fileMsg(`「${file.name}」（${st.doc.numPages}ページ）を読みました。${found1}を見つけました。`, 'done');
    await showLegends();
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
  // 色の座標は「正しい向き」（左下が原点・y が上向き）。画面の向きの座標は上下を反転するだけ
  const toView = (x, y) => [x * scale, vp.height - y * scale];
  if (box) {
    const [ax, ay] = toView(box.x0, box.y0);
    const [bx, by] = toView(box.x1, box.y1);
    ox = Math.floor(Math.min(ax, bx)); oy = Math.floor(Math.min(ay, by));
    w = Math.ceil(Math.abs(bx - ax)); h = Math.ceil(Math.abs(by - ay));
  }
  const base = document.createElement('canvas');
  base.width = w; base.height = h;
  const ctx = base.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -ox, -oy] }).promise;
  const at = (x, y) => { const [px, py] = toView(x, y); return [px - ox, py - oy]; };
  return { pageIndex, base, at, scale, canvas: null };
}

/** 色を重ねて canvas に描き直す（色を変えるたびに呼ぶ） */
function drawView(view, paint) {
  const c = view.canvas;
  c.width = view.base.width; c.height = view.base.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(view.base, 0, 0);
  const order = { band: 0, outer: 0, outline: 0, legend: 1, mark: 2, ring: 3, warn: 3, dim: 4, label: 4 };
  for (const p of paint.filter((q) => q.page === view.pageIndex).sort((a, b) => order[a.kind] - order[b.kind])) {
    ctx.save();
    ctx.globalAlpha = ALPHA[p.kind];
    if (p.kind === 'dim') {
      ctx.beginPath();
      p.points.forEach(([x, y], k) => { const [a, b] = view.at(x, y); if (k) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
      ctx.strokeStyle = p.hex; ctx.lineWidth = Math.max(1, p.width * view.scale);
      ctx.stroke();
    } else if (p.kind === 'outline') {
      ctx.globalCompositeOperation = 'multiply';
      ctx.beginPath();
      p.points.forEach(([x, y], k) => { const [a, b] = view.at(x, y); if (k) ctx.lineTo(a, b); else ctx.moveTo(a, b); });
      if (!p.open) ctx.closePath();
      ctx.strokeStyle = p.hex; ctx.lineWidth = p.width * view.scale; ctx.lineJoin = 'miter';
      ctx.stroke();
    } else if (p.kind === 'label') {
      const [x, y] = view.at(p.x, p.y);
      ctx.fillStyle = p.hex;
      ctx.font = `bold ${(p.size || 6) * view.scale}px Poppins, Arial, sans-serif`;
      ctx.fillText(p.text, x, y);
    } else if (p.kind === 'band' || p.kind === 'outer') {
      ctx.globalCompositeOperation = 'multiply';
      const [ax, ay] = view.at(p.x0, p.y0), [bx, by] = view.at(p.x1, p.y1);
      ctx.fillStyle = p.hex;
      ctx.fillRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    } else {
      const [x, y] = view.at(p.cx, p.cy);
      ctx.beginPath();
      ctx.ellipse(x, y, (p.rx ?? p.r) * view.scale, (p.ry ?? p.r) * view.scale, 0, 0, Math.PI * 2);
      if (p.kind === 'warn' || p.kind === 'ring') { ctx.strokeStyle = p.hex; ctx.lineWidth = Math.max(1.2, (p.kind === 'ring' ? 0.8 : 0.9) * view.scale); ctx.stroke(); }
      else { ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = p.hex; ctx.fill(); }
    }
    ctx.restore();
  }
}

function currentPaint() {
  const out = [];
  if (st.legend) out.push(...buildPaint(st.legend, st.found.marks, st.colors, { firstFloor: st.firstFloor }));
  if (st.walls) out.push(...buildWallPaint(st.walls.legend, st.walls.marks, st.colors, colorHex));
  if (st.upper) out.push(...upperPaint(st.upper, colorHex(st.colors[UPPER_KEY])));
  if (st.kiso) out.push(...buildKisoPaint(st.kiso, st.colors, colorHex));
  return out;
}

/** 基礎の行（凡例のホールダウン・人通口、図面にある開口補強・梁符号・スラブ・独立基礎、基礎リストの鉄筋の本数） */
function kisoAllRows() {
  if (!st.kiso) return [];
  const rows = kisoRows(st.kiso.legend, st.kiso.marks, st.kiso.list, st.kiso.outer, st.kiso.spans);
  if (st.kiso.list) {
    const n = st.kiso.list.rebars.filter((r) => !r.panel?.unused).length;
    rows.push({ key: kisoKey('rebar', ''), kind: 'rebar', text: '2-D13', name: '鉄筋の本数（基礎リスト）', struck: false, n, def: 'red', ring: true });
  }
  return rows;
}
function redrawAll() {
  const paint = currentPaint();
  for (const v of st.views) drawView(v, paint);
}

// ---------- 2 色分け（設定）：金物リストと壁の表 ----------
/** 画面に出す表の一覧（行の形をそろえる） */
function groups() {
  const out = [];
  if (st.legend) {
    const cnt = countBySymbol(st.found.marks);
    out.push({
      id: 'kana', head: '金物リスト', page: st.legend.page, title: st.legend.title, box: st.legend.box, rowH: st.legend.rowH,
      rows: st.legend.rows.map((r) => ({ src: r, key: r.s, text: r.s, name: r.name || '（名前なし）', sub: r.kn != null ? `引張 ${r.kn} kN` : '', struck: r.struck, n: cnt.get(r.s) || 0 })),
    });
  }
  if (st.walls) {
    const L = st.walls.legend, cnt = countByKey(st.walls.marks);
    out.push({
      id: 'kabe', head: '壁（筋かい・面材）', page: L.page, title: L.title, box: L.box, rowH: L.rowH,
      rows: [...L.rows.map((r) => ({ src: r, key: r.key, symbol: r.symbol, name: r.label || '（名前なし）', sub: r.rate != null ? `壁倍率 ${r.rate}` : '', struck: r.struck, n: cnt.get(r.key) || 0 })),
        ...(st.upper ? [{ src: { name: '2階の耐力壁' }, key: UPPER_KEY, text: '2階', small: true, name: '2階の耐力壁の位置（1階の図面に線で落とす）', sub: `${st.upper.from + 1}ページ目 → ${st.upper.page + 1}ページ目`, struck: false, n: st.upper.walls.length }] : [])],
    });
  }
  if (st.kiso) {
    const L = st.kiso.legend;
    const subOf = { span: '立上りの間に赤い寸法（mm）', outer: '外まわりの壁に沿って帯', hd: 'ホールダウン（番号付き）', w: '人通口', kaiko: '開口補強', fg: '梁符号', slab: 'スラブ', dok: '独立基礎', rebar: '断面の鉄筋の本数に輪' };
    out.push({
      id: 'kiso', head: '基礎（基礎伏図・基礎リスト）', page: L ? L.page : st.kiso.list.page, title: L ? L.title : '基礎リスト', box: L ? L.box : null, rowH: 20,
      rows: kisoAllRows().map((r) => ({ src: r, key: r.key, text: r.text, small: true, name: r.name, sub: subOf[r.kind] || '', struck: r.struck, n: r.n, nLabel: r.kind === 'rebar' ? '基礎リストに' : '図面に' })),
    });
  }
  return out;
}

/** 壁の記号の見本を小さな絵にする */
function symbolSvg(sym) {
  const b = sym.box, w = b.x1 - b.x0, h = b.y1 - b.y0;
  const s = 22 / Math.max(w, h, 0.1);
  const ox = (28 - w * s) / 2, oy = (28 - h * s) / 2;
  const d = sym.segs.map((q) => `M${(ox + (q[0] - b.x0) * s).toFixed(1)} ${(oy + (b.y1 - q[1]) * s).toFixed(1)}L${(ox + (q[2] - b.x0) * s).toFixed(1)} ${(oy + (b.y1 - q[3]) * s).toFixed(1)}`).join('');
  return `<svg class="symsvg" viewBox="0 0 28 28" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>`;
}

async function showLegends() {
  $('step-legend').hidden = false;
  const wrap = $('legend-groups');
  wrap.innerHTML = '';
  st.views = [];
  for (const g of groups()) {
    const el = document.createElement('div');
    el.className = 'legend-group';
    el.innerHTML = `<h3 class="lg-head">${esc(g.head)}<span>${g.page + 1}ページ目「${esc(g.title.replace(/^●/, ''))}」</span></h3>
      <div class="legend-wrap">
        ${g.box ? `<div class="legend-view"><canvas aria-label="色をつけた${esc(g.head)}の表"></canvas></div>` : '<div class="legend-view muted small pad">凡例の表は見つかりませんでした</div>'}
        <ul class="krows" data-group="${g.id}"></ul>
      </div>`;
    wrap.append(el);
    if (!g.box) continue;
    const pad = Math.min(g.rowH * 0.8, 9);
    const box = { x0: g.box.x0 - pad, x1: g.box.x1 + pad, y0: g.box.y0 - pad, y1: g.box.y1 + pad };
    const v = await renderView(g.page, Math.min(6, 900 / (box.x1 - box.x0)), box);
    v.canvas = el.querySelector('canvas');
    st.views.push(v);
  }
  renderRows();
  redrawAll();
}

function renderRows() {
  for (const g of groups()) {
    const ul = document.querySelector(`.krows[data-group="${g.id}"]`);
    if (!ul) continue;
    ul.innerHTML = g.rows.map((r) => {
      const id = st.colors[r.key];
      const hex = colorHex(id);
      const open = st.open === r.key;
      const k = esc(r.key);
      const pal = open ? `<div class="palette" role="group" aria-label="${esc(r.name)} の色">
        ${PALETTE.map((p) => `<button type="button" data-k="${k}" data-c="${p.id}" class="${p.id === id ? 'on' : ''}" style="background:${p.hex}" aria-label="${p.name}" title="${p.name}"></button>`).join('')}
        <button type="button" class="none-btn ${id === NONE ? 'on' : ''}" data-k="${k}" data-c="${NONE}">塗らない</button></div>` : '';
      return `<li class="krow ${hex ? '' : 'off'}">
        <div class="main">
          <button type="button" class="swatch ${hex ? '' : 'none'}" style="${hex ? `background:${hex}` : ''}" data-open="${k}" aria-expanded="${open}" aria-label="${esc(r.text || r.name)} の色を変える（今は${hex ? PALETTE.find((p) => p.id === id).name : '塗らない'}）"></button>
          <span class="sym${r.small ? ' sym-sm' : ''}">${r.symbol ? symbolSvg(r.symbol) : esc(r.text)}</span>
          <span class="nm"><b>${esc(r.name)}</b><span>${esc(r.sub)}${r.struck ? '　<span class="chip chip-gray">斜線＝使わない</span>' : ''}</span></span>
          <span class="cnt">${r.nLabel || '図面に'}<br><span class="num">${r.n}</span> か所</span>
        </div>${pal}</li>`;
    }).join('');
  }
}

$('legend-groups').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.open) { st.open = st.open === b.dataset.open ? null : b.dataset.open; renderRows(); return; }
  if (b.dataset.c) {
    // 同じ名前の行（フックコーナーの ろ・は など）はまとめて同じ色にする
    for (const g of groups()) {
      const row = g.rows.find((r) => r.key === b.dataset.k);
      if (!row) continue;
      for (const r of g.rows) if (!r.struck && colorGroup(r.src) === colorGroup(row.src)) st.colors[r.key] = b.dataset.c;
    }
    st.colors[b.dataset.k] = b.dataset.c;
    st.open = null;
    saveColors(); renderRows(); redrawAll(); renderSummary();
  }
});
$('reset-colors').addEventListener('click', () => {
  try { localStorage.removeItem(STORE); } catch { /* なにもしない */ }
  st.colors = initialColors({});
  renderRows(); redrawAll(); renderSummary();
  toast('はじめの色に戻しました');
});

// ---------- 3 図面全体 ----------
async function showPlan() {
  $('step-plan').hidden = false;
  renderSummary();
  const cnt = {};
  for (const g of st.found?.marks || []) cnt[g.page] = (cnt[g.page] || 0) + 1;
  const wcnt = {};
  for (const m of st.walls?.marks || []) wcnt[m.page] = (wcnt[m.page] || 0) + 1;
  const kcnt = {};
  for (const m of st.kiso?.marks || []) kcnt[m.page] = (kcnt[m.page] || 0) + 1;
  if (st.kiso?.list) kcnt[st.kiso.list.page] = kcnt[st.kiso.list.page] || 0;
  const pagesWith = [...new Set([...Object.keys(cnt), ...Object.keys(wcnt), ...Object.keys(kcnt)].map(Number))].sort((a, b) => a - b);
  const wrap = $('pages');
  wrap.innerHTML = pagesWith.length ? '' : '<p class="muted small">色をつける記号がありませんでした。</p>';
  for (const pi of pagesWith) {
    const box = document.createElement('div');
    box.className = 'pagebox';
    const parts = [cnt[pi] && `金物 ${cnt[pi]} か所`, wcnt[pi] && `壁 ${wcnt[pi]} か所`, kcnt[pi] && `基礎 ${kcnt[pi]} か所`, st.kiso?.list?.page === pi && '基礎リスト'].filter(Boolean).join('・');
    box.innerHTML = `<p class="ph"><b>${pi + 1}ページ目</b>　${parts}</p><div class="pageview"><canvas aria-label="${pi + 1}ページ目の図面"></canvas></div>`;
    wrap.append(box);
    const v = await renderView(pi, PLAN_SCALE);
    v.canvas = box.querySelector('canvas');
    st.views.push(v);
  }
  redrawAll();
}

function renderSummary() {
  const { legend, found, walls, kiso } = st;
  const w = [];
  let kanaPainted = 0, wallPainted = 0, kisoPainted = 0, issues = 0;
  if (legend) {
    const cnt = countBySymbol(found.marks);
    kanaPainted = found.marks.filter((g) => colorHex(st.colors[g.s])).length;
    const struckUsed = legend.rows.filter((r) => r.struck && cnt.get(r.s));
    issues += struckUsed.length + found.unknown.length;
    for (const r of struckUsed) w.push(['bad', `斜線で消された金物「${r.s}」（${r.name}）が、図面に ${cnt.get(r.s)} か所あります。赤い輪のところを確かめてください。`]);
    if (found.unknown.length) w.push(['bad', `金物リストにない記号が ${found.unknown.length} か所あります（${[...new Set(found.unknown.map((g) => g.s))].join('・')}）。`]);
    for (const r of legend.rows.filter((x) => !x.struck && cnt.get(x.s) && !colorHex(st.colors[x.s]))) w.push(['', `金物「${r.s}」は「塗らない」にしているので、図面の ${cnt.get(r.s)} か所に色がついていません。`]);
    const unused = legend.rows.filter((r) => !r.struck && !cnt.get(r.s));
    if (unused.length) w.push(['', `金物リストにあって図面で使われていない金物：${unused.map((r) => r.s).join('・')}`]);
    if (!struckUsed.length && !found.unknown.length) w.push(['ok', '斜線の金物は図面にありません。リストにない金物の記号もありません。']);
    if (found.otherSize) w.push(['', `通り芯の丸の中の字など、記号と大きさが違う同じ字 ${found.otherSize} 個は塗っていません。`]);
  }
  if (walls) {
    const cnt = countByKey(walls.marks);
    wallPainted = walls.marks.filter((m) => colorHex(st.colors[m.key])).length;
    const struckUsed = walls.legend.rows.filter((r) => r.struck && cnt.get(r.key));
    issues += struckUsed.length;
    for (const r of struckUsed) w.push(['bad', `斜線で消された壁「${r.label}」の記号が、図面に ${cnt.get(r.key)} か所あります。赤い輪のところを確かめてください。`]);
    const unused = walls.legend.rows.filter((r) => !r.struck && !cnt.get(r.key));
    if (unused.length) w.push(['', `壁の表にあって図面で見つからなかった記号：${unused.map((r) => r.label).join('／')}`]);
    w.push(['', '壁の記号は形で探しています。線が欠けていたり、ほかの線と重なったりしている記号は塗れないことがあるので、色のない記号が残っていないか図面で確かめてください。']);
  }
  if (kiso) {
    kisoPainted = kiso.marks.filter((m) => colorHex(st.colors[m.key])).length;
    const rows = kisoAllRows();
    const hdUsed = rows.filter((r) => r.kind === 'hd' && !r.struck);
    for (const r of hdUsed) {
      if (r.n) w.push(['', `ホールダウン ${r.text}：図面で ${r.n} か所（番号 1〜${r.n}）。凡例の行にも数を書きました。`]);
      else { issues++; w.push(['bad', `凡例で使うことになっているホールダウン ${r.text} が、図面で見つかりません。凡例か図面を確かめてください。`]); }
    }
    const hdBad = rows.filter((r) => r.kind === 'hd' && r.struck && r.n);
    issues += hdBad.length;
    for (const r of hdBad) w.push(['bad', `凡例で斜線のホールダウン ${r.text} が、図面に ${r.n} か所あります。赤い輪のところを確かめてください。`]);
    if (kiso.list) {
      const unused = kiso.list.panels.filter((p) => p.unused).map((p) => p.code);
      if (unused.length) w.push(['', `基礎リストで×の断面（使わない）：${[...new Set(unused)].join('・')}。塗っていません。`]);
    }
    if (!kiso.legend) w.push(['', '基礎伏図の「●凡例」の表が見つからなかったので、ホールダウンは表と照らし合わせていません。']);
  }
  $('summary').innerHTML = `
    <div class="card stat accent"><span class="k">HARDWARE</span><span class="n">${legend ? kanaPainted : '-'}<span class="u">か所</span></span><span class="l">色をつけた金物の記号</span></div>
    <div class="card stat accent"><span class="k">WALL</span><span class="n">${walls ? wallPainted : '-'}<span class="u">か所</span></span><span class="l">色をつけた壁の記号</span></div>
    <div class="card stat accent"><span class="k">FOUNDATION</span><span class="n">${kiso ? kisoPainted : '-'}<span class="u">か所</span></span><span class="l">色をつけた基礎の記号</span></div>
    <div class="card stat ${issues ? 'alert' : ''}"><span class="k">CHECK</span><span class="n">${issues}<span class="u">件</span></span><span class="l">確かめてほしいこと</span></div>`;
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
