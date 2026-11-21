import { mergeWords } from './kiso.js';
// 壁（筋かい・面材）の記号を見つける処理。記号は文字ではなく線で描かれているので、形を比べて探す。
// 画面・pdf.js に依存しない純粋な関数だけ。座標は PDF の座標（左下が原点・ポイント）。
// 線分は [x0, y0, x1, y1]。

const WALL_TITLE_RE = /軸組.*(種類|壁倍率)|壁倍率|耐力壁/;
const NUM_RE = /^-?\d+(\.\d+)?$/;
const len = (s) => Math.hypot(s[2] - s[0], s[3] - s[1]);
const boxOf = (segs) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs) {
    x0 = Math.min(x0, s[0], s[2]); x1 = Math.max(x1, s[0], s[2]);
    y0 = Math.min(y0, s[1], s[3]); y1 = Math.max(y1, s[1], s[3]);
  }
  return { x0, y0, x1, y1 };
};
const overlaps = (a, b, m = 0) => a.x0 - m <= b.x1 && b.x0 - m <= a.x1 && a.y0 - m <= b.y1 && b.y0 - m <= a.y1;
const segIn = (s, b) => Math.min(s[0], s[2]) >= b.x0 && Math.max(s[0], s[2]) <= b.x1 && Math.min(s[1], s[3]) >= b.y0 && Math.max(s[1], s[3]) <= b.y1;

/**
 * 「軸組みの種類と壁倍率」の表を読む。
 * 行は表の横線で分け、各行の左端の図形をその行の記号とする。斜線の行は「使わない」。
 * @returns { title, page, rows: [{ key, label, rate, cy, y0, y1, symbol: {segs, box}, struck }], box, rowH } または null
 */
const CODE_RE = /^\d{1,2}-\d{1,2}$/;
const codeOf = (str) => str.normalize('NFKC').replace(/[\s　]+/g, '').replace(/[‐－−ー―]/g, '-');

/** 字の四角（横書き・縦書きどちらも） */
export function glyphBox(g) {
  const [a, b] = g.m || [1, 0];
  const vertical = Math.abs(b) > Math.abs(a);
  const hw = (vertical ? g.size * 0.5 : g.w / 2), hh = (vertical ? g.w / 2 : g.size * 0.5);
  return { x0: g.cx - hw, x1: g.cx + hw, y0: g.cy - hh, y1: g.cy + hh };
}

/**
 * 番号で書く壁（6-1・12-1 など）を図面の字から探す。
 * @param pages [{ glyphs }]（探さないページは glyphs を空にして渡す） @param exclude ページごとの除く範囲（表など）
 */
export function findCodeWallMarks(pages, wallLegend, { exclude = {} } = {}) {
  const byCode = new Map(wallLegend.rows.filter((r) => r.code).map((r) => [r.code, r]));
  const marks = [];
  pages.forEach((p, i) => {
    const zones = exclude[i] || [];
    // 縦書きの番号は1字ずつ書かれている（「1」「2」「-」「1」）。縦書きの字だけつないで読む
    const vert = p.glyphs.filter((g) => g.m && Math.abs(g.m[1]) > Math.abs(g.m[0]));
    const words = [...p.glyphs.filter((g) => !vert.includes(g)), ...mergeWords(vert)];
    for (const g of words) {
      const r = byCode.get(codeOf(g.s));
      if (!r) continue;
      if (i === wallLegend.page && g.cx >= wallLegend.box.x0 && g.cx <= wallLegend.box.x1 && g.cy >= wallLegend.box.y0 && g.cy <= wallLegend.box.y1) continue;
      if (zones.some((z) => g.cx >= z.x0 && g.cx <= z.x1 && g.cy >= z.y0 && g.cy <= z.y1)) continue;
      const box = g.box || glyphBox(g);
      marks.push({ key: r.key, page: i, cx: g.cx, cy: g.cy, box, code: r.code });
    }
  });
  return marks;
}

export function findWallLegend(glyphs, segs, page = 0) {
  const titles = glyphs.filter((g) => WALL_TITLE_RE.test(g.s));
  for (const title of titles) {
    const r = readWallTable(title, glyphs, segs, page);
    if (r) return r;
  }
  return null;
}

function readWallTable(title, glyphs, segs, page) {
  // 見出しのすぐ下から始まる、長い横線（表の罫線）
  const horiz = segs.filter((s) => Math.abs(s[1] - s[3]) < 0.3 && len(s) > 60 && Math.min(s[0], s[2]) < title.x + 20 && Math.min(s[0], s[2]) > title.x - 40 && s[1] < title.y && s[1] > title.y - 600);
  if (horiz.length < 3) return null;
  const tx0 = Math.min(...horiz.map((s) => Math.min(s[0], s[2])));
  const tx1 = Math.max(...horiz.map((s) => Math.max(s[0], s[2])));
  const width = tx1 - tx0;
  const ys = [...new Set(horiz.filter((s) => len(s) > width * 0.85).map((s) => Math.round(s[1] * 2) / 2))].sort((a, b) => b - a);
  // 表の続きだけ（見出しから離れすぎた線や、間があきすぎた線で終わり）
  const lines = [];
  for (const y of ys) {
    if (!lines.length) { if (title.y - y > 40) return null; lines.push(y); continue; }
    if (lines[lines.length - 1] - y > 80) break;
    lines.push(y);
  }
  const bands = [];
  for (let i = 1; i < lines.length; i++) if (lines[i - 1] - lines[i] > 6) bands.push({ y1: lines[i - 1], y0: lines[i] });
  if (bands.length < 2) return null;
  // いちばん上の帯は見出し（「記号」の字がある）
  const isHead = (b) => glyphs.some((g) => (g.s === '記号' || g.s === '番号') && g.cy < b.y1 && g.cy > b.y0 && g.cx > tx0 && g.cx < tx1);
  const body = bands.filter((b) => !isHead(b));
  if (!body.length) return null;
  // 「壁倍率」の見出し（その真下の数字だけを壁倍率として読む）
  const head = bands.find(isHead);
  const rateHead = head && glyphs.find((g) => /倍率/.test(g.s) && g.cy < head.y1 && g.cy > head.y0 && g.cx > tx0 && g.cx < tx1);
  const rowH = Math.min(...body.map((b) => b.y1 - b.y0));
  const rows = [];
  for (const b of body) {
    const texts = glyphs.filter((g) => g.cy < b.y1 && g.cy > b.y0 && g.cx > tx0 && g.cx < tx1).sort((p, q) => p.x - q.x || q.cy - p.cy);
    const firstX = texts.length ? texts[0].x : tx1;
    const h = b.y1 - b.y0;
    const cell = { x0: tx0 + 0.6, x1: firstX - 1, y0: b.y0 + 0.4, y1: b.y1 - 0.4 };
    const inCell = segs.filter((s) => segIn(s, cell));
    // 表の縦の罫線（行の高さいっぱい）や、斜線（取り消し）を除いた図形が記号
    const struck = segs.some((s) => len(s) > width * 0.3 && Math.abs(s[3] - s[1]) > 1 && Math.abs(s[3] - s[1]) < h * 1.6
      && Math.min(s[1], s[3]) < (b.y0 + b.y1) / 2 && Math.max(s[1], s[3]) > (b.y0 + b.y1) / 2 && Math.min(s[0], s[2]) < tx0 + width * 0.3);
    const sym = inCell.filter((s) => !(Math.abs(s[0] - s[2]) < 0.3 && Math.abs(s[3] - s[1]) > h * 0.8));
    // 記号の代わりに番号（6-1・12-1 など）で書く表：図面にも同じ番号の字が書いてある
    const codeG = texts.length && CODE_RE.test(codeOf(texts[0].s)) ? texts[0] : null;
    if (codeG) {
      const rest = texts.filter((g) => g !== codeG);
      const alone2 = (g) => !rest.some((o) => o !== g && Math.abs(o.cy - g.cy) < g.size * 0.6
        && (Math.abs(o.x + o.w - g.x) < g.size * 0.5 || Math.abs(g.x + g.w - o.x) < g.size * 0.5));
      const nums2 = rest.filter((g) => NUM_RE.test(g.s) && alone2(g));
      const rG = rateHead ? nums2.find((g) => Math.abs(g.cx - rateHead.cx) < Math.max(rateHead.w, 12)) || null : nums2[nums2.length - 1] || null;
      const label = readCells(rest.filter((g) => g !== rG && g.s !== '-'));
      const code = codeOf(codeG.s);
      rows.push({ key: 'w:' + label, label, code, rate: rG ? Number(rG.s) : null, cy: (b.y0 + b.y1) / 2, y0: b.y0, y1: b.y1, symbol: { code, segs: [], box: glyphBox(codeG) }, struck });
      continue;
    }
    if (!sym.length) continue;
    // 数字だけで、左右に字がくっついていないもの（「接合金物5 倍」の 5 は壁倍率ではない）
    const alone = (g) => !texts.some((o) => o !== g && Math.abs(o.cy - g.cy) < g.size * 0.6
      && (Math.abs(o.x + o.w - g.x) < g.size * 0.5 || Math.abs(g.x + g.w - o.x) < g.size * 0.5));
    const nums = texts.filter((g) => NUM_RE.test(g.s) && alone(g));
    const rateG = rateHead
      ? nums.find((g) => Math.abs(g.cx - rateHead.cx) < Math.max(rateHead.w, 12)) || null
      : (nums.length && nums[nums.length - 1].x > tx0 + width * 0.6 ? nums[nums.length - 1] : null);
    const label = readCells(texts.filter((g) => g !== rateG && g.s !== '-'));
    rows.push({ key: 'w:' + label, label, rate: rateG ? Number(rateG.s) : null, cy: (b.y0 + b.y1) / 2, y0: b.y0, y1: b.y1, symbol: { segs: sym, box: boxOf(sym) }, struck });
  }
  if (!rows.length) return null;
  return { title: title.s, page, rows, rowH, box: { x0: tx0, x1: tx1, y0: lines[lines.length - 1], y1: title.y + title.size + 2 } };
}

/**
 * 表の1行の字を、読む順（列ごとに上から、行の中は左から）につなぐ。
 * 例：「面材 構造用面材 ﾀｲｶﾞｰEXﾊｲﾊﾟｰ 吉野石膏 認定番号FRM-0678」
 */
function readCells(texts) {
  // 横の範囲が重なる字を同じ列にまとめる
  const cols = [];
  for (const g of [...texts].sort((p, q) => p.x - q.x)) {
    const c = cols.find((k) => g.x <= k.x1 + 2 && g.x + g.w >= k.x0 - 2);
    if (c) { c.items.push(g); c.x0 = Math.min(c.x0, g.x); c.x1 = Math.max(c.x1, g.x + g.w); }
    else cols.push({ x0: g.x, x1: g.x + g.w, items: [g] });
  }
  const parts = [];
  for (const c of cols.sort((p, q) => p.x0 - q.x0)) {
    const lines = [];
    for (const g of c.items.sort((p, q) => q.cy - p.cy)) {
      const l = lines.find((k) => Math.abs(k.cy - g.cy) < g.size * 0.5);
      if (l) l.items.push(g); else lines.push({ cy: g.cy, items: [g] });
    }
    for (const l of lines) {
      let s = '', end = null;
      for (const g of l.items.sort((p, q) => p.x - q.x)) {
        s += (end != null && g.x - end > g.size * 0.35 ? ' ' : '') + g.s;
        end = g.x + g.w;
      }
      parts.push(s);
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 点線（通り芯など）の短い線を取り除く。
 * 縦か横の短い線で、同じ線の上に少しすき間をあけて別の短い線が並んでいるもの。
 * 記号の上を点線が通っていても、記号の形だけを比べられるようにする。
 */
export function dropDashes(segs, { maxDash = 5, minGap = 0.3, maxGap = 4 } = {}) {
  const key = (v) => Math.round(v * 20); // 0.05pt 単位で同じ線とみなす
  const lines = new Map();
  const info = segs.map((s) => {
    const horiz = Math.abs(s[1] - s[3]) < 0.02, vert = Math.abs(s[0] - s[2]) < 0.02;
    if ((!horiz && !vert) || len(s) > maxDash || len(s) < 0.05) return null;
    const k = (horiz ? 'h' : 'v') + key(horiz ? s[1] : s[0]);
    const a = horiz ? Math.min(s[0], s[2]) : Math.min(s[1], s[3]);
    const b = horiz ? Math.max(s[0], s[2]) : Math.max(s[1], s[3]);
    const it = { a, b };
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k).push(it);
    return it;
  });
  const dash = new Set();
  for (const list of lines.values()) {
    list.sort((p, q) => p.a - q.a);
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].a - list[i - 1].b;
      if (gap >= minGap && gap <= maxGap) { dash.add(list[i]); dash.add(list[i - 1]); }
    }
  }
  return segs.filter((_, i) => !info[i] || !dash.has(info[i]));
}

/**
 * 線分を、つながった（重なり合う）図形ごとにまとめる。長い線（壁・通り芯）は除く。
 * @returns [{ segs, box }]
 */
export function clusterSegments(segs, { maxLen = 30, gap = 0.35 } = {}) {
  const items = segs.filter((s) => len(s) <= maxLen).map((s) => ({ s, b: boxOf([s]) }));
  const parent = items.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const cell = 4;
  const grid = new Map();
  items.forEach((it, i) => {
    const gx0 = Math.floor((it.b.x0 - gap) / cell), gx1 = Math.floor((it.b.x1 + gap) / cell);
    const gy0 = Math.floor((it.b.y0 - gap) / cell), gy1 = Math.floor((it.b.y1 + gap) / cell);
    for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
      const k = gx + ',' + gy;
      const list = grid.get(k);
      if (list) {
        for (const j of list) if (overlaps(it.b, items[j].b, gap)) { const a = find(i), c = find(j); if (a !== c) parent[a] = c; }
        list.push(i);
      } else grid.set(k, [i]);
    }
  });
  const groups = new Map();
  items.forEach((it, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(it.s); });
  return [...groups.values()].map((g) => ({ segs: g, box: boxOf(g) }));
}

/**
 * 探さない範囲：表そのものと、「凡例」の見出しから右下（見本の記号が並ぶ欄）
 * @param glyphsByPage ページごとの文字
 * @param tables [{ page, box }]
 */
export function excludeZones(glyphsByPage, tables, pageSizes = []) {
  const ex = {};
  for (const t of tables) if (t) (ex[t.page] ??= []).push(t.box);
  glyphsByPage.forEach((glyphs, page) => {
    const W = pageSizes[page]?.w ?? 1e5;
    for (const g of glyphs) {
      if (!/^●?凡例$/.test(g.s)) continue;
      (ex[page] ??= []).push({ x0: g.x - 10, x1: W, y0: -1e5, y1: g.y + g.size + 4 });
    }
  });
  return ex;
}

/**
 * くっついた図形を記号ごとに分ける。
 * 端と端がつながっている線を1つの部品にし、ほかの部品の内側にすっぽり入る部品（丸の中の三角、塗りつぶしの線など）は
 * その部品と同じ記号とする。
 */
export function splitCluster(segs) {
  const n = segs.length;
  const parent = segs.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  // 1) 端と端がぴったり同じ点でつなぐ。3本までが集まる点だけ（4本以上が集まる点は、2つの記号が角で接している
  //    ところかもしれないのでつながない。三角や丸はほかの角でつながっているので、ばらばらにはならない）
  const k = (x, y) => Math.round(x * 20) + ',' + Math.round(y * 20);
  const pt = new Map();
  segs.forEach((s, i) => {
    for (const [x, y] of [[s[0], s[1]], [s[2], s[3]]]) {
      const key = k(x, y);
      if (!pt.has(key)) pt.set(key, { x, y, list: [] });
      pt.get(key).list.push(i);
    }
  });
  for (const nd of pt.values()) {
    if (nd.list.length > 3) continue;
    for (let j = 1; j < nd.list.length; j++) { const a = find(nd.list[0]), b = find(nd.list[j]); if (a !== b) parent[a] = b; }
  }
  // 2) 相手のいない端（丸がいくつかの弧に分けて描かれたときの切れ目など）は、0.35pt 以内のほかの切れ目とつなぐ
  const TOL = 0.35, CELL = 0.5;
  const loose = [...pt.values()].filter((nd) => nd.list.length === 1);
  const grid = new Map();
  for (const nd of loose) {
    const gx = Math.floor(nd.x / CELL), gy = Math.floor(nd.y / CELL);
    for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++) {
      for (const o of grid.get(i + ',' + j) || []) {
        if (Math.hypot(o.x - nd.x, o.y - nd.y) > TOL) continue;
        const a = find(o.list[0]), b = find(nd.list[0]);
        if (a !== b) parent[a] = b;
      }
    }
    const key = gx + ',' + gy;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(nd);
  }
  const comps = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(segs[i]); }
  // 大きい部品から順に、内側に入る部品をまとめる
  const list = [...comps.values()].map((g) => ({ segs: g, box: boxOf(g) }))
    .sort((p, q) => (q.box.x1 - q.box.x0) * (q.box.y1 - q.box.y0) - (p.box.x1 - p.box.x0) * (p.box.y1 - p.box.y0));
  const out = [];
  for (const c of list) {
    const host = out.find((o) => c.box.x0 >= o.box.x0 - 0.3 && c.box.x1 <= o.box.x1 + 0.3 && c.box.y0 >= o.box.y0 - 0.3 && c.box.y1 <= o.box.y1 + 0.3);
    if (host) host.segs.push(...c.segs);
    else out.push({ segs: [...c.segs], box: c.box });
  }
  return out;
}

const N = 24; // 形を比べるときのます目の数

/**
 * 図形を N×N のます目に描く。t は向きの変え方（0〜7：回転と裏返し）。
 * 向きを変えたあと、横と縦をそれぞれます目いっぱいに引き伸ばす（細長い記号でも細かく比べられるように。
 * 縦横の比は別に比べる）。
 */
export function rasterize(segs, box, t = 0) {
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  let hw = (box.x1 - box.x0) / 2 || 0.01, hh = (box.y1 - box.y0) / 2 || 0.01;
  if ((t & 3) % 2 === 1) [hw, hh] = [hh, hw];
  const g = new Uint8Array(N * N);
  const put = (x, y) => {
    let u = x - cx, v = y - cy;
    if (t & 4) u = -u;
    for (let r = 0; r < (t & 3); r++) [u, v] = [-v, u];
    const i = Math.min(N - 1, Math.max(0, Math.floor((u / hw + 1) / 2 * N)));
    const j = Math.min(N - 1, Math.max(0, Math.floor((v / hh + 1) / 2 * N)));
    g[j * N + i] = 1;
  };
  for (const s of segs) {
    // ます目1つにつき2点ほど（横と縦の引き伸ばしが違うので、それぞれの向きで数える）
    const dx = Math.abs(s[2] - s[0]), dy = Math.abs(s[3] - s[1]);
    const bw = (box.x1 - box.x0) || 0.01, bh = (box.y1 - box.y0) || 0.01;
    const steps = Math.min(4 * N, Math.max(1, Math.ceil(Math.max(dx / bw, dy / bh) * N * 2)));
    for (let k = 0; k <= steps; k++) put(s[0] + (s[2] - s[0]) * k / steps, s[1] + (s[3] - s[1]) * k / steps);
  }
  return g;
}

/** ます目のうち線のある割合 */
function density(g) { let n = 0; for (const v of g) n += v; return n / g.length; }

function dilate(g) {
  const o = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    if (!g[j * N + i]) continue;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj;
      if (a >= 0 && a < N && b >= 0 && b < N) o[b * N + a] = 1;
    }
  }
  return o;
}

/** 2つの形の似ている度合い（0〜1）。線の位置が1ます以内で重なる割合を両方向で見る */
export function similarity(a, b, bDil = dilate(b), aDil = dilate(a)) {
  let na = 0, nb = 0, ha = 0, hb = 0;
  for (let k = 0; k < N * N; k++) {
    if (a[k]) { na++; if (bDil[k]) ha++; }
    if (b[k]) { nb++; if (aDil[k]) hb++; }
  }
  if (!na || !nb) return 0;
  return Math.min(ha / na, hb / nb);
}

/** 記号の見本を用意する（8つの向きのます目） */
export function makeTemplates(wallLegend) {
  return wallLegend.rows.map((r) => {
    const b = r.symbol.box;
    const size = Math.max(b.x1 - b.x0, b.y1 - b.y0);
    const minor = Math.min(b.x1 - b.x0, b.y1 - b.y0);
    const rasters = [];
    for (let t = 0; t < 8; t++) { const g = rasterize(r.symbol.segs, b, t); rasters.push({ g, d: dilate(g) }); }
    return { key: r.key, size, aspect: minor / (size || 1), rasters, density: density(rasters[0].g) };
  });
}

/**
 * 図面全体から壁の記号を探す。
 * @param pages [{ segs }]（ページ順）
 * @param wallLegend findWallLegend の結果
 * @param exclude ページごとの「探さない範囲」（表や凡例） { [page]: [box, ...] }
 * @returns marks: [{ key, page, box, cx, cy, size, score }]
 */
export function findWallMarks(pages, wallLegend, { exclude = {}, minScore = 0.9, margin = 0.04 } = {}) {
  const temps = makeTemplates(wallLegend);
  if (!temps.length) return [];
  const maxSize = Math.max(...temps.map((t) => t.size));
  const minSize = Math.min(...temps.map((t) => t.size));
  const marks = [];
  pages.forEach((p, page) => {
    const ex = exclude[page] || [];
    const tryMatch = (c) => {
      const w = c.box.x1 - c.box.x0, h = c.box.y1 - c.box.y0;
      const size = Math.max(w, h);
      if (size < minSize * 0.6 || size > maxSize * 1.4 || c.segs.length < 2) return null;
      const aspect = Math.min(w, h) / size;
      // 大きさと縦横の比が合う見本がなければ、描かずに次へ
      if (!temps.some((t) => size >= t.size * 0.6 && size <= t.size * 1.4 && Math.abs(aspect - t.aspect) <= 0.22)) return null;
      // 見本ごとに、いちばん似ている向きの点数
      const g = rasterize(c.segs, c.box);
      const gDil = dilate(g);
      const scored = [];
      for (const t of temps) {
        if (size < t.size * 0.6 || size > t.size * 1.4) continue;
        if (Math.abs(aspect - t.aspect) > 0.22) continue;
        // 線の混み具合（ます目のうち線のある割合）が大きく違うものは別の記号（塗りつぶしと重ね線など）
        const dens = density(g);
        if (dens > t.density * 1.45 || dens < t.density / 1.45) continue;
        let sc = 0;
        for (const r of t.rasters) sc = Math.max(sc, similarity(g, r.g, r.d, gDil));
        scored.push({ key: t.key, score: sc });
      }
      scored.sort((p, q) => q.score - p.score);
      const best = scored[0];
      // 2番目に似た記号と差がほとんどないものは、どちらか決められないので塗らない
      if (!best || best.score < minScore || (scored[1] && best.score - scored[1].score < margin)) return null;
      return { key: best.key, page, box: c.box, cx: (c.box.x0 + c.box.x1) / 2, cy: (c.box.y0 + c.box.y1) / 2, size, score: best.score };
    };
    for (const c of clusterSegments(dropDashes(p.segs), { maxLen: maxSize * 1.3 })) {
      if (ex.some((b) => overlaps(c.box, b))) continue;
      const size = Math.max(c.box.x1 - c.box.x0, c.box.y1 - c.box.y0);
      if (size < minSize * 0.6 || size > maxSize * 3) continue;
      const whole = size <= maxSize * 1.4 ? tryMatch(c) : null;
      if (whole) { marks.push(whole); continue; }
      // 記号どうしがくっついて描かれている（丸の面材の横に筋かいの三角など）ときは、部品に分けて1つずつ比べる
      const parts = splitCluster(c.segs);
      if (parts.length < 2) continue;
      let left = [];
      for (const part of parts) { const m = tryMatch(part); if (m) marks.push(m); else left.push(part); }
      // 組み合わせを比べるのは、記号より小さい部品だけ（数が多いかたまりは比べない。時間がかかりすぎるため）
      left = left.filter((q) => Math.max(q.box.x1 - q.box.x0, q.box.y1 - q.box.y0) <= maxSize * 1.4);
      if (left.length > 24) continue;
      // 合わなかった部品どうしが接していれば、合わせて比べる（たすき掛の2つの三角など）
      for (let i = 0; i < left.length; i++) for (let j = i + 1; j < left.length; j++) {
        if (!left[i] || !left[j] || !overlaps(left[i].box, left[j].box, 0.3)) continue;
        const both = [...left[i].segs, ...left[j].segs];
        const m = tryMatch({ segs: both, box: boxOf(both) });
        if (m) { marks.push(m); left[i] = left[j] = null; }
      }
    }
  });
  return marks;
}

/** 記号ごとの数 */
export function countByKey(marks) {
  const m = new Map();
  for (const g of marks) m.set(g.key, (m.get(g.key) || 0) + 1);
  return m;
}

/**
 * 壁の記号の塗るもの（core.js の buildPaint と同じ形。丸の代わりに記号を囲む楕円）
 * @param colorHex 色の id → 色
 */
export function buildWallPaint(wallLegend, marks, colors, colorHex) {
  const out = [];
  const rowOf = new Map(wallLegend.rows.map((r) => [r.key, r]));
  const pad = 2.6; // 記号のまわりの色の幅（ひとまわり大きく）
  for (const r of wallLegend.rows) {
    const hex = colorHex(colors[r.key]);
    if (!hex) continue;
    const b = r.symbol.box;
    out.push({ kind: 'band', page: wallLegend.page, hex, x0: wallLegend.box.x0 + 1, x1: wallLegend.box.x1 - 1, y0: r.y0 + 0.8, y1: r.y1 - 0.8 });
    out.push({ kind: 'legend', page: wallLegend.page, hex, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, rx: (b.x1 - b.x0) / 2 + pad, ry: (b.y1 - b.y0) / 2 + pad });
  }
  for (const m of marks) {
    const hex = colorHex(colors[m.key]);
    // 細い記号でも色が見えるように、輪は少し丸みを持たせる
    const rx = Math.max((m.box.x1 - m.box.x0) / 2 + pad, 4.8), ry = Math.max((m.box.y1 - m.box.y0) / 2 + pad, 4.8);
    if (hex) out.push({ kind: 'mark', page: m.page, hex, cx: m.cx, cy: m.cy, rx, ry });
    if (rowOf.get(m.key)?.struck) out.push({ kind: 'warn', page: m.page, hex: '#E0001B', cx: m.cx, cy: m.cy, rx: rx + 2, ry: ry + 2 });
  }
  return out;
}
