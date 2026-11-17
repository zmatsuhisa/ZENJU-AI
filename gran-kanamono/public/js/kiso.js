// 基礎図面（基礎伏図・基礎リスト）の着色。画面・pdf.js に依存しない純粋な関数だけ。
// 座標は PDF の座標（左下が原点・ポイント）。文字は core.js の toGlyph の形（m に pdf.js の transform を持つ）。
//
// 現場での手書きの塗り方に合わせる：
//   ホールダウン（15kN など）… 柱の横の文字に色＋番号、凡例の行に数
//   人通口（W600）… だいだい / 開口補強 b・c … 桃色 / 梁符号（FG1 水色・FG4 だいだい・FG5 桃色 …）
//   独立基礎・独立柱 … だいだい / スラブ（S200 以外）… 桃色
//   基礎リスト … 使う断面の見出しに梁符号と同じ色、使わない断面（×）は塗らない、鉄筋の本数（2-D13 など）に赤い輪

const len = (s) => Math.hypot(s[2] - s[0], s[3] - s[1]);
const inBox = (x, y, b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
const overlaps = (a, b, m = 0) => a.x0 - m <= b.x1 && b.x0 - m <= a.x1 && a.y0 - m <= b.y1 && b.y0 - m <= a.y1;

/** 字の四すみ（横書き・縦書きどちらも）から、字の箱を求める */
function glyphCorners(g) {
  const [a, b, c, d, e, f] = g.m || [g.size, 0, 0, g.size, g.x, g.y];
  const sx = Math.hypot(a, b) || 1;
  const wEm = (g.w || 0) / sx;
  return [[0, -0.12], [wEm, -0.12], [wEm, 0.88], [0, 0.88]].map(([u, v]) => [e + a * u + c * v, f + b * u + d * v]);
}
const boxOfPts = (pts) => ({
  x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])),
  y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])),
});

/**
 * 1字ずつばらばらに入っている文字（縦書きの「開口補強b」「W600」など）を、並びどおりにつないで単語にする。
 * 同じ向き・同じ大きさで、前の字のすぐ後ろ（字の大きさの 0.6 倍以内）から始まる字をつなぐ。
 * @returns [{ s, page, size, box, cx, cy, vertical }]
 */
export function mergeWords(glyphs) {
  const items = glyphs.filter((g) => g.s).map((g) => {
    const [a, b] = g.m || [1, 0];
    const n = Math.hypot(a, b) || 1;
    const dir = [a / n, b / n];
    const adv = g.w || 0;
    return { g, dir, start: [g.x, g.y], end: [g.x + dir[0] * adv, g.y + dir[1] * adv], box: boxOfPts(glyphCorners(g)) };
  });
  const used = new Set();
  const words = [];
  // 書き出しの位置の順（横書きは左から、縦書きは下から）に並べてつなぐ
  const order = [...items].sort((p, q) => (p.start[0] * p.dir[0] + p.start[1] * p.dir[1]) - (q.start[0] * q.dir[0] + q.start[1] * q.dir[1]));
  for (const it of order) {
    if (used.has(it)) continue;
    used.add(it);
    const chain = [it];
    let cur = it;
    for (;;) {
      const tol = cur.g.size * 0.6;
      const next = order.find((o) => !used.has(o) && Math.abs(o.g.size - cur.g.size) < cur.g.size * 0.15
        && Math.abs(o.dir[0] - cur.dir[0]) < 0.05 && Math.abs(o.dir[1] - cur.dir[1]) < 0.05
        && Math.hypot(o.start[0] - cur.end[0], o.start[1] - cur.end[1]) < tol);
      if (!next) break;
      used.add(next); chain.push(next); cur = next;
    }
    const box = {
      x0: Math.min(...chain.map((c) => c.box.x0)), x1: Math.max(...chain.map((c) => c.box.x1)),
      y0: Math.min(...chain.map((c) => c.box.y0)), y1: Math.max(...chain.map((c) => c.box.y1)),
    };
    words.push({
      s: chain.map((c) => c.g.s).join(''), page: it.g.page, size: it.g.size, box,
      cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, vertical: Math.abs(it.dir[1]) > 0.7,
    });
  }
  return words;
}

// ---------------------------------------------------------------- 記号の見分け
const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '');
export const HD_RE = /^(\d+kN|Hi-?\d+)$/i;
export const hdCode = (s) => norm(s).replace(/^hi-?/i, 'Hi');
const W_RE = /^W\d{3}$/;
const KAIKO_RE = /^開口補強([a-cA-C])?$/;
const FG_RE = /^FG\d+[A-Z]?(-\d+)?$/;
const SLAB_RE = /^S\d{3}$/;
const DOK_RE = /独立(柱|基礎)/;
const REBAR_RE = /\d-D\d{2}/;

/**
 * 基礎伏図の「●凡例（符号・仕様）」の表を読む。行は表の横線で分け、斜線の行は使わない。
 * @returns { page, box, rows: [{ kind, code, spec, sym, cy, y0, y1, struck }] } または null
 *   kind: 'hd'（ホールダウン）/ 'w'（人通口）/ 'fg'（梁符号）/ 'slab' / 'dok'（独立基礎）/ 'other'
 */
export function findKisoLegend(glyphs, segs, page = 0) {
  for (const title of glyphs.filter((g) => /^●?凡例$/.test(g.s))) {
    const head = glyphs.find((g) => g.s === '符号' && g.y < title.y && title.y - g.y < 40 && Math.abs(g.x - title.x) < 200);
    const spec = head && glyphs.find((g) => g.s === '仕様' && Math.abs(g.y - head.y) < 3 && g.x > head.x);
    if (!head || !spec) continue;
    const horiz = segs.filter((s) => Math.abs(s[1] - s[3]) < 0.3 && len(s) > 60 && s[1] < title.y && s[1] > title.y - 700
      && Math.min(s[0], s[2]) < title.x + 20 && Math.min(s[0], s[2]) > title.x - 40);
    if (horiz.length < 3) continue;
    const tx0 = Math.min(...horiz.map((s) => Math.min(s[0], s[2])));
    const tx1 = Math.max(...horiz.map((s) => Math.max(s[0], s[2])));
    const width = tx1 - tx0;
    const ys = [...new Set(horiz.filter((s) => len(s) > width * 0.85).map((s) => Math.round(s[1] * 2) / 2))].sort((a, b) => b - a);
    const lines = [];
    for (const y of ys) {
      if (!lines.length) { if (title.y - y > 40) break; lines.push(y); continue; }
      if (lines[lines.length - 1] - y > 120) break;
      lines.push(y);
    }
    const symRight = head.x + head.w + 15; // 符号の列の字は「符号」の見出しの下に収まる
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const y1 = lines[i - 1], y0 = lines[i];
      if (y1 - y0 < 6) continue;
      const texts = glyphs.filter((g) => g.cy < y1 && g.cy > y0 && g.cx > tx0 && g.cx < tx1);
      if (texts.some((g) => g === head)) continue;
      if (texts.some((g) => /^●/.test(g.s))) break; // 次の表（●備考 など）で終わり
      const symT = texts.filter((g) => g.x + g.w <= symRight).map((g) => g.s);
      const specS = texts.filter((g) => g.x + g.w > symRight).sort((p, q) => q.cy - p.cy || p.x - q.x).map((g) => g.s).join(' ');
      const cy = (y0 + y1) / 2, h = y1 - y0;
      // 斜線＝行の横幅の3割以上を横切る斜めの線（表の外枠の縦線は含めない）
      const struck = segs.some((s) => Math.abs(s[2] - s[0]) > width * 0.3 && Math.abs(s[3] - s[1]) > 1 && Math.abs(s[3] - s[1]) < h * 1.6
        && Math.min(s[1], s[3]) < cy && Math.max(s[1], s[3]) > cy && Math.min(s[0], s[2]) >= tx0 - 8 && Math.max(s[0], s[2]) <= tx1 + 8);
      const hd = symT.find((t) => HD_RE.test(norm(t)));
      let kind = 'other', code = '';
      if (hd) { kind = 'hd'; code = hdCode(hd); }
      else if (/人通口/.test(specS)) { kind = 'w'; code = 'W'; }
      else if (/梁符号/.test(specS)) { kind = 'fg'; code = 'FG'; }
      else if (/ｽﾗﾌﾞ|スラブ/.test(specS.normalize('NFKC'))) { kind = 'slab'; code = 'S'; }
      else if (/独立基礎/.test(specS)) { kind = 'dok'; code = 'F'; }
      rows.push({ kind, code, spec: specS.normalize('NFKC'), sym: symT.join(' '), cy, y0, y1, struck });
    }
    if (rows.length < 3) continue;
    return { page, title: title.s, box: { x0: tx0, x1: tx1, y0: lines[lines.length - 1], y1: title.y + title.size + 2 }, rows };
  }
  return null;
}

/** 図面の注記「スラブはS200とする」から、ふつうのスラブの符号を読む（なければ S200） */
export function defaultSlab(words) {
  for (const w of words) {
    const m = norm(w.s).match(/スラブ(?:は)?(S\d{3})/);
    if (m) return m[1];
  }
  return 'S200';
}

/**
 * 基礎伏図の上の記号を拾う。
 * @param words mergeWords の結果（基礎伏図のページ）
 * @param legend findKisoLegend の結果（同じページ）
 * @param exclude 探さない範囲 [box]
 * @returns marks: [{ key, kind, code, s, page, box, cx, cy }]
 */
export function findKisoMarks(words, legend, exclude = []) {
  const ex = [legend?.box, ...exclude].filter(Boolean);
  const slab0 = defaultSlab(words);
  const marks = [];
  for (const w of words) {
    if (ex.some((b) => overlaps(w.box, b))) continue;
    const s = norm(w.s);
    let kind = null, code = '';
    if (HD_RE.test(s)) { kind = 'hd'; code = hdCode(s); }
    else if (W_RE.test(s)) { kind = 'w'; code = 'W'; }
    else if (KAIKO_RE.test(s)) { kind = 'kaiko'; code = (s.match(KAIKO_RE)[1] || '').toLowerCase(); }
    else if (FG_RE.test(s)) { kind = 'fg'; code = s; }
    else if (SLAB_RE.test(s) && s !== slab0) { kind = 'slab'; code = s; }
    else if (DOK_RE.test(s)) { kind = 'dok'; code = 'F'; }
    if (!kind) continue;
    marks.push({ key: kisoKey(kind, code), kind, code, s: w.s, page: w.page, box: w.box, cx: w.cx, cy: w.cy });
  }
  return marks;
}

export const kisoKey = (kind, code) => `f:${kind}:${code}`;

/** 梁符号のはじめの色（現場の手書きに合わせる。FG3＝特記なしは塗らない） */
export function fgColor(code) {
  const c = code.toUpperCase();
  if (/^FG1/.test(c)) return 'sky';
  if (/^FG2/.test(c)) return 'green';
  if (/^FG3/.test(c)) return 'none';
  if (/^FG4/.test(c)) return 'orange';
  if (/^FG5/.test(c)) return 'pink';
  if (/^FG6/.test(c)) return 'purple';
  return 'lime';
}

/**
 * 画面に出す行（色を決める単位）と、はじめの色。
 * 凡例のホールダウンの行（斜線は「使わない」）、人通口、開口補強、図面にある梁符号・スラブ・独立基礎。
 */
export function kisoRows(legend, marks, list = null) {
  const rows = [];
  const cnt = (key) => marks.filter((m) => m.key === key).length;
  const seen = new Set();
  for (const r of legend?.rows || []) {
    if (r.kind !== 'hd' && r.kind !== 'w') continue;
    const key = r.kind === 'hd' ? kisoKey('hd', r.code) : kisoKey('w', 'W');
    if (seen.has(key)) {
      // 同じ記号の行が2つ（15kN用 と 15kN用(2個使い) など）：使う行のほうを残す
      const prev = rows.find((x) => x.key === key);
      if (prev && prev.struck && !r.struck) Object.assign(prev, { name: r.spec, struck: false, legendRow: r });
      continue;
    }
    seen.add(key);
    rows.push({ key, kind: r.kind, text: r.kind === 'hd' ? r.code : 'W600', name: r.spec || (r.kind === 'w' ? '人通口' : ''), struck: r.struck, n: cnt(key), legendRow: r, def: r.struck ? 'none' : (r.kind === 'hd' ? 'red' : 'orange') });
  }
  if (!seen.has(kisoKey('w', 'W')) && cnt(kisoKey('w', 'W'))) rows.push({ key: kisoKey('w', 'W'), kind: 'w', text: 'W600', name: '人通口', struck: false, n: cnt(kisoKey('w', 'W')), def: 'orange' });
  // 図面にだけあるもの
  const extra = new Map();
  for (const m of marks) if (!rows.some((r) => r.key === m.key) && !extra.has(m.key)) extra.set(m.key, m);
  const order = { hd: 0, kaiko: 1, fg: 2, slab: 3, dok: 4 };
  const fgOf = (list?.panels || []);
  for (const m of [...extra.values()].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.code.localeCompare(b.code, 'ja', { numeric: true }))) {
    const def = m.kind === 'hd' ? 'red' : m.kind === 'kaiko' ? 'pink' : m.kind === 'fg' ? fgColor(m.code) : m.kind === 'slab' ? 'pink' : 'orange';
    const name = m.kind === 'hd' ? 'ホールダウン（凡例にない記号）'
      : m.kind === 'kaiko' ? `開口補強 ${m.code}`
      : m.kind === 'fg' ? `梁 ${m.code}`
      : m.kind === 'slab' ? `スラブ ${m.code}` : '独立基礎・独立柱';
    rows.push({ key: m.key, kind: m.kind, text: m.kind === 'fg' || m.kind === 'slab' ? m.code : m.kind === 'kaiko' ? `補強${m.code}` : m.kind === 'dok' ? '独立' : m.code, name, struck: false, n: cnt(m.key), def });
  }
  // 基礎リストにだけある梁符号・スラブ（図面に符号の字がない FG3・S200 など）
  for (const p of fgOf) {
    const isSlab = /^S\d{3}$/.test(p.code);
    if (!/^FG/.test(p.code) && !isSlab) continue;
    const code = isSlab ? p.code : baseFg(p.code);
    const key = kisoKey(isSlab ? 'slab' : 'fg', code);
    const has = rows.find((r) => r.key === key);
    if (has) { if (p.unused) has.name += '（基礎リストでは×）'; continue; }
    rows.push({ key, kind: isSlab ? 'slab' : 'fg', text: code, name: `${isSlab ? 'スラブ' : '梁'} ${code}（基礎リストのみ${p.unused ? '・×' : ''}）`, struck: p.unused, n: 0, def: p.unused ? 'none' : isSlab ? 'pink' : fgColor(code) });
  }
  return rows;
}

/** 「FG5(立上部)」「FG5・FG5A」などから梁符号だけ取り出す */
export const baseFg = (s) => (norm(s).match(/FG\d+[A-Z]?(-\d+)?/) || [''])[0];

/**
 * 基礎リスト（断面の一覧）を読む。
 * 見出し（FG1、FG5(立上部)、S200 など）ごとに、×が描かれていれば使わない断面。
 * 鉄筋の本数（2-D13 など）は、いちばん近い見出しの断面に属させる。
 * @returns { page, panels: [{ code, title, box(見出し), unused }], rebars: [{ s, box, cx, cy, panel }] } または null
 */
export function findKisoList(words, segs, page = 0) {
  if (!words.some((w) => /基礎(部材)?リスト/.test(w.s))) return null;
  const titles = words.filter((w) => /^(FG\d+[A-Z]?(-\d+)?(\(.*\))?|S\d{3})$/.test(norm(w.s)) && w.size >= 6.5);
  if (!titles.length) return null;
  const diag = segs.filter((s) => Math.abs(s[2] - s[0]) > 40 && Math.abs(s[3] - s[1]) > 40);
  const panels = titles.map((t) => {
    // 見出しの下の断面に、見出しの左右にまたがる長い斜線が2本（×）あれば使わない
    const cross = diag.filter((s) => Math.min(s[0], s[2]) < t.cx && Math.max(s[0], s[2]) > t.cx
      && Math.max(s[1], s[3]) > t.cy - 60 && Math.max(s[1], s[3]) < t.cy + 25 && Math.min(s[1], s[3]) < t.cy - 80);
    const unused = cross.filter((s) => (s[3] - s[1]) * (s[2] - s[0]) > 0).length > 0 && cross.filter((s) => (s[3] - s[1]) * (s[2] - s[0]) < 0).length > 0;
    return { code: norm(t.s).startsWith('S') ? norm(t.s) : baseFg(t.s), title: t.s, box: t.box, cx: t.cx, cy: t.cy, unused };
  });
  const rebars = [];
  for (const w of words) {
    if (!REBAR_RE.test(norm(w.s))) continue;
    // この字より上にある見出しのうち、横にいちばん近く、縦にも近いもの
    const cand = panels.filter((p) => p.cy > w.cy && p.cy - w.cy < 330).sort((a, b) => (Math.abs(a.cx - w.cx) + (a.cy - w.cy) * 0.3) - (Math.abs(b.cx - w.cx) + (b.cy - w.cy) * 0.3));
    const panel = cand[0] && Math.abs(cand[0].cx - w.cx) < 150 ? cand[0] : null;
    rebars.push({ s: w.s, box: w.box, cx: w.cx, cy: w.cy, panel });
  }
  return { page, panels, rebars };
}

/**
 * 塗るもの（core.js の buildPaint と同じ形）。
 * ホールダウンには番号（左上から右下の順）を付け、凡例の行にも同じ色を付ける。
 */
export function buildKisoPaint({ legend, marks, list }, colors, colorHex) {
  const out = [];
  const pad = 2.2;
  const rowsByKey = new Map();
  if (legend) {
    for (const r of legend.rows) {
      const key = r.kind === 'hd' ? kisoKey('hd', r.code) : r.kind === 'w' ? kisoKey('w', 'W') : null;
      if (!key || r.struck) continue;
      const hex = colorHex(colors[key]);
      if (!hex) continue;
      out.push({ kind: 'band', page: legend.page, hex, x0: legend.box.x0 + 1, x1: legend.box.x1 - 1, y0: r.y0 + 0.8, y1: r.y1 - 0.8 });
      rowsByKey.set(key, r);
    }
  }
  const struckHd = new Set((legend?.rows || []).filter((r) => r.kind === 'hd' && r.struck).map((r) => kisoKey('hd', r.code)));
  const usedHd = new Set((legend?.rows || []).filter((r) => r.kind === 'hd' && !r.struck).map((r) => kisoKey('hd', r.code)));
  const numbers = new Map();
  const sorted = [...marks].sort((a, b) => a.page - b.page || b.cy - a.cy || a.cx - b.cx);
  for (const m of sorted) {
    const hex = colorHex(colors[m.key]);
    const rx = (m.box.x1 - m.box.x0) / 2 + pad, ry = (m.box.y1 - m.box.y0) / 2 + pad;
    if (hex) out.push({ kind: 'mark', page: m.page, hex, cx: m.cx, cy: m.cy, rx: Math.max(rx, 4), ry: Math.max(ry, 4) });
    if (m.kind === 'hd') {
      // 凡例で斜線の金物が図面にある（または凡例にない）ときは赤い輪
      if (struckHd.has(m.key) && !usedHd.has(m.key)) out.push({ kind: 'warn', page: m.page, hex: '#E0001B', cx: m.cx, cy: m.cy, rx: rx + 3, ry: ry + 3 });
      if (hex) {
        const n = (numbers.get(m.key) || 0) + 1;
        numbers.set(m.key, n);
        out.push({ kind: 'label', page: m.page, hex: '#C8102E', x: m.box.x1 + 1.5, y: m.box.y1 + 0.5, text: String(n), size: 6 });
      }
    }
  }
  // 凡例の行に、図面で見つけた数
  for (const [key, r] of rowsByKey) {
    const n = marks.filter((m) => m.key === key).length;
    out.push({ kind: 'label', page: legend.page, hex: '#C8102E', x: legend.box.x1 - 6 - 5 * String(n).length - 6, y: r.y1 - 9, text: `\u00d7${n}`, size: 7 });
  }
  if (list) {
    for (const p of list.panels) {
      if (p.unused) continue;
      const key = p.code.startsWith('S') ? kisoKey('slab', p.code) : kisoKey('fg', p.code);
      const hex = key && colorHex(colors[key]);
      if (hex) out.push({ kind: 'mark', page: list.page, hex, cx: (p.box.x0 + p.box.x1) / 2, cy: (p.box.y0 + p.box.y1) / 2, rx: (p.box.x1 - p.box.x0) / 2 + 4, ry: (p.box.y1 - p.box.y0) / 2 + 2.5 });
    }
    const rebarHex = colorHex(colors[kisoKey('rebar', '')]);
    if (rebarHex) {
      for (const r of list.rebars) {
        if (r.panel?.unused) continue;
        out.push({ kind: 'ring', page: list.page, hex: rebarHex, cx: r.cx, cy: r.cy, rx: (r.box.x1 - r.box.x0) / 2 + 3, ry: (r.box.y1 - r.box.y0) / 2 + 3 });
      }
    }
  }
  return out;
}
