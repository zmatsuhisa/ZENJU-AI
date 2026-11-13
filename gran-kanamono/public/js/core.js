// 金物着色の中心になる処理（画面・pdf.js・pdf-lib に依存しない。テストしやすいように純粋な関数だけ）
//
// 座標はすべて PDF の座標（左下が原点・単位はポイント）。
// 文字は pdf.js の getTextContent() が返す { str, transform, width } をそのまま受け取る。

/** 色の候補。蛍光ペンに近い、重ねて黒い線が読める色 */
export const PALETTE = [
  { id: 'yellow', name: '黄', hex: '#FFE100' },
  { id: 'sky', name: '水色', hex: '#3CC8F4' },
  { id: 'green', name: '緑', hex: '#46CF5C' },
  { id: 'orange', name: 'だいだい', hex: '#FF9822' },
  { id: 'purple', name: '紫', hex: '#B67CF0' },
  { id: 'red', name: '赤', hex: '#F4475B' },
  { id: 'pink', name: '桃', hex: '#FF86CF' },
  { id: 'blue', name: '青', hex: '#4D7BFF' },
  { id: 'lime', name: '黄緑', hex: '#B9E62A' },
  { id: 'brown', name: '茶', hex: '#C08A52' },
  { id: 'gray', name: '灰', hex: '#A0A0A0' },
];
export const NONE = 'none';
export const colorHex = (id) => PALETTE.find((p) => p.id === id)?.hex || null;

// 記号として扱う字：ひらがな・カタカナ・英数字の1〜2字（「-」は「金物なし」なので除く）
const SYMBOL_RE = /^[ぁ-ゖァ-ヺA-Za-z0-9]{1,2}$/;
const NUM_RE = /^-?\d+(\.\d+)?$/;
const TITLE_RE = /(柱脚柱頭|柱頭柱脚|接合)?金物(リスト|一覧|表)/;

/**
 * pdf.js の文字1つ（1行分のこともある）を、扱いやすい形にする。
 * cx, cy は字の中心。size は字の高さ。
 */
export function toGlyph(item, page = 0) {
  const [a, b, c, d, e, f] = item.transform;
  const sx = Math.hypot(a, b) || 1;
  const size = Math.hypot(c, d);
  const wEm = (item.width || 0) / sx; // 字の幅（字の大きさを1としたとき）
  // 字の中心：横は幅の半分、縦は下の線から字の高さの 0.38（和文の書体はおよそ -0.12〜0.88）
  const u = wEm / 2, v = 0.38;
  return {
    s: String(item.str).trim(), page, size,
    x: e, y: f, w: item.width || 0,
    cx: e + a * u + c * v, cy: f + b * u + d * v,
  };
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
};

/**
 * 金物リスト（柱脚柱頭金物リスト）を探して読む。
 * @param glyphs 1ページ分の toGlyph の結果
 * @param segs そのページの線分 [[x0,y0,x1,y1], ...]（斜線＝使わない金物の見分けに使う。なくてもよい）
 * @returns { title, rows: [{ s, name, kn, cx, cy, struck }], box: {x0,y0,x1,y1}, rowH } または null
 */
export function findLegend(glyphs, segs = []) {
  const titles = glyphs.filter((g) => TITLE_RE.test(g.s));
  for (const title of titles.sort((p, q) => score(q) - score(p))) {
    const legend = readLegendUnder(title, glyphs, segs);
    if (legend) return legend;
  }
  return null;
  function score(g) { return (/柱脚柱頭|柱頭柱脚/.test(g.s) ? 2 : 0) + (/リスト/.test(g.s) ? 1 : 0); }
}

function readLegendUnder(title, glyphs, segs) {
  // 見出しのすぐ下にある「記号」の列
  const heads = glyphs.filter((g) => g.s === '記号' && g.y < title.y && title.y - g.y < 120 && Math.abs(g.x - title.x) < 260);
  if (!heads.length) return null;
  const head = heads.sort((p, q) => (title.y - p.y) - (title.y - q.y))[0];
  // 表の下の終わり：見出しより下にある「●」「※」で始まる字のうち、いちばん上のもの
  const enders = glyphs.filter((g) => /^[●※]/.test(g.s) && g.y < head.y - 4 && Math.abs(g.x - title.x) < 260);
  const limitY = enders.length ? Math.max(...enders.map((g) => g.y)) : -Infinity;
  const colL = head.x - 6, colR = head.x + head.w + 6;
  const syms = glyphs
    .filter((g) => g.cy < head.y - 2 && g.cy > limitY && g.cx >= colL && g.cx <= colR && (SYMBOL_RE.test(g.s) || g.s === '-' || g.s === '－'))
    .sort((p, q) => q.cy - p.cy);
  if (syms.length < 2) return null;
  // 行の間隔。間があきすぎたところで表が終わったとみなす
  const gaps = syms.slice(1).map((g, i) => syms[i].cy - g.cy);
  const rowH = median(gaps);
  const rowsG = [syms[0]];
  for (let i = 1; i < syms.length; i++) {
    if (syms[i - 1].cy - syms[i].cy > rowH * 2.5) break;
    rowsG.push(syms[i]);
  }
  const rows = [];
  let x1 = head.x + head.w, x0 = Math.min(head.x, title.x);
  for (const g of rowsG) {
    const same = glyphs.filter((o) => o !== g && Math.abs(o.cy - g.cy) < rowH * 0.42 && o.cy > limitY);
    // 表の中の字だけ：記号から左右へ、間が大きくあく（＝表の外の図面に出る）までの字
    const reach = Math.max(rowH * 4, 70);
    const right = chain(same.filter((o) => o.x > g.x + g.w - 1).sort((p, q) => p.x - q.x), g.x + g.w, reach, 1);
    const left = chain(same.filter((o) => o.x + o.w < g.x + 1).sort((p, q) => q.x - p.x), g.x, reach, -1);
    for (const o of [...right, ...left]) { x1 = Math.max(x1, o.x + o.w); x0 = Math.min(x0, o.x); }
    const name = right.filter((o) => !NUM_RE.test(o.s) && o.s !== '-').map((o) => o.s).join(' ').trim();
    const knG = right.find((o) => NUM_RE.test(o.s));
    if (g.s === '-' || g.s === '－') continue; // 金物を使わない行（短ほぞ差し など）
    rows.push({ s: g.s, name, kn: knG ? Number(knG.s) : null, cx: g.cx, cy: g.cy, no: left.find((o) => NUM_RE.test(o.s))?.s || '' });
  }
  if (!rows.length) return null;
  const last = rowsG[rowsG.length - 1];
  const box = { x0: x0 - 4, x1: x1 + 4, y0: last.cy - rowH * 0.6, y1: title.y + title.size + 2 };
  // 斜線（行の左下から右上へ引いた線）がある行は「使わない金物」
  for (const r of rows) {
    r.struck = segs.some(([sx0, sy0, sx1, sy1]) => {
      const dx = Math.abs(sx1 - sx0), dy = Math.abs(sy1 - sy0);
      if (dx < (box.x1 - box.x0) * 0.3 || dy < rowH * 0.3 || dy > rowH * 1.6) return false;
      if (Math.min(sx0, sx1) < box.x0 - 8 || Math.max(sx0, sx1) > box.x1 + 8) return false;
      return Math.min(sy0, sy1) < r.cy && Math.max(sy0, sy1) > r.cy;
    });
  }
  // 同じ記号が2回出てきたら最初の行だけ使う
  const seen = new Set();
  const uniq = rows.filter((r) => (seen.has(r.s) ? false : (seen.add(r.s), true)));
  return { title: title.s, page: title.page, rows: uniq, box, rowH };
}

/** 並べた字を、間が reach より大きくあくところまでつないで返す（dir=1 右へ / -1 左へ） */
function chain(sorted, from, reach, dir) {
  const out = [];
  let edge = from;
  for (const o of sorted) {
    const gap = dir > 0 ? o.x - edge : edge - (o.x + o.w);
    if (gap > reach) break;
    out.push(o);
    edge = dir > 0 ? Math.max(edge, o.x + o.w) : Math.min(edge, o.x);
  }
  return out;
}

const inBox = (g, b) => g.cx >= b.x0 && g.cx <= b.x1 && g.cy >= b.y0 && g.cy <= b.y1;
const roundSize = (s) => Math.round(s * 10) / 10;

/**
 * 図面全体から、リストと同じ記号を探す。
 * 通り芯の丸文字や表の中の字を塗らないように、「いちばん多く使われている字の大きさ」のものだけを金物記号とみなす。
 * @param pages [{ glyphs }]（ページ順）
 * @param legend findLegend の結果
 * @returns { marks, size, otherSize: 大きさが違うので塗らなかった字の数, unknown: リストにない記号 }
 */
export function findMarks(pages, legend, { tolerance = 0.12 } = {}) {
  const symbols = new Set(legend.rows.map((r) => r.s));
  const cands = [];
  pages.forEach((p, i) => {
    for (const g of p.glyphs) {
      if (!symbols.has(g.s)) continue;
      if (i === legend.page && inBox(g, legend.box)) continue;
      cands.push(g);
    }
  });
  if (!cands.length) return { marks: [], size: 0, otherSize: 0, unknown: [] };
  const hist = new Map();
  for (const g of cands) hist.set(roundSize(g.size), (hist.get(roundSize(g.size)) || 0) + 1);
  const size = [...hist.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0])[0][0];
  const ok = (g) => Math.abs(g.size - size) <= size * tolerance;
  const marks = cands.filter(ok);
  // 同じ大きさの1〜2字の記号で、リストにないもの（書き間違い・リストの載せ忘れの確認用）
  const unknown = [];
  pages.forEach((p, i) => {
    for (const g of p.glyphs) {
      if (symbols.has(g.s) || !/^[ぁ-ゖ]$/.test(g.s) || !ok(g)) continue;
      if (i === legend.page && inBox(g, legend.box)) continue;
      unknown.push(g);
    }
  });
  return { marks, size, otherSize: cands.length - marks.length, unknown };
}

/** 記号ごとの数 */
export function countBySymbol(marks) {
  const m = new Map();
  for (const g of marks) m.set(g.s, (m.get(g.s) || 0) + 1);
  return m;
}

/**
 * はじめの色分け。保存してある色（記号→色）を優先し、ないものは上の行から順に色を配る。
 * 斜線の行（使わない金物）は「塗らない」。
 */
export function defaultColors(rows, saved = {}) {
  const out = {};
  const used = new Set(Object.values(saved));
  let k = 0;
  const next = () => {
    for (let n = 0; n < PALETTE.length; n++) {
      const id = PALETTE[(k + n) % PALETTE.length].id;
      if (!used.has(id)) { k = (k + n + 1) % PALETTE.length; used.add(id); return id; }
    }
    return PALETTE[k++ % PALETTE.length].id;
  };
  for (const r of rows) {
    if (saved[r.s] && (saved[r.s] === NONE || colorHex(saved[r.s]))) out[r.s] = saved[r.s];
    else out[r.s] = r.struck ? NONE : next();
  }
  return out;
}

/**
 * 塗るものの一覧（PDF の座標）。画面の下書き表示と PDF への書き込みの両方がこれを使う。
 * kind: 'mark'（図面の記号）/ 'legend'（リストの記号）/ 'band'（リストの行の帯）/ 'warn'（斜線の金物が図面にある＝赤い輪）
 */
export function buildPaint(legend, marks, colors) {
  const out = [];
  const rowOf = new Map(legend.rows.map((r) => [r.s, r]));
  for (const r of legend.rows) {
    const hex = colorHex(colors[r.s]);
    if (!hex) continue;
    out.push({ kind: 'band', page: legend.page, hex, x0: legend.box.x0 + 1, x1: legend.box.x1 - 1, y0: r.cy - legend.rowH / 2 + 0.8, y1: r.cy + legend.rowH / 2 - 0.8 });
    out.push({ kind: 'legend', page: legend.page, hex, cx: r.cx, cy: r.cy, r: legend.rowH * 0.36 });
  }
  for (const g of marks) {
    const hex = colorHex(colors[g.s]);
    if (hex) out.push({ kind: 'mark', page: g.page, hex, cx: g.cx, cy: g.cy, r: g.size * 1.05 });
    if (rowOf.get(g.s)?.struck) out.push({ kind: 'warn', page: g.page, hex: '#E0001B', cx: g.cx, cy: g.cy, r: g.size * 1.6 });
  }
  return out;
}

/** 塗りの強さ（画面と PDF で同じ見え方にする） */
export const ALPHA = { band: 0.3, legend: 0.75, mark: 0.7, warn: 1 };
