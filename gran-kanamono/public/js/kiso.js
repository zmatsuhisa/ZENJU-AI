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

/** 梁符号のはじめの色（現場の手書きに合わせる：FG1＝桃、FG2＝水色、FG3＝黄、FG4＝黄緑） */
export function fgColor(code) {
  const c = code.toUpperCase();
  if (/^FG1/.test(c)) return 'pink';
  if (/^FG2/.test(c)) return 'sky';
  if (/^FG3/.test(c)) return 'yellow';
  if (/^FG4/.test(c)) return 'lime';
  if (/^FG5/.test(c)) return 'blue';
  if (/^FG6/.test(c)) return 'gray';
  return 'gray';
}

/** ホールダウンのはじめの色（金物の色と合わせる：15kN＝緑、20kN＝黄、Hi＝桃、ほか＝赤） */
export function hdColor(code = '') {
  const c = code.normalize('NFKC').toUpperCase();
  if (/^15/.test(c)) return 'green';
  if (/^20/.test(c)) return 'yellow';
  if (/HI/.test(c)) return 'pink';
  return 'red';
}

/**
 * 画面に出す行（色を決める単位）と、はじめの色。
 * 凡例のホールダウンの行（斜線は「使わない」）、人通口、開口補強、図面にある梁符号・スラブ・独立基礎。
 */
export function kisoRows(legend, marks, list = null, outer = null, spans = null) {
  const rows = [];
  if (outer?.length) rows.push({ key: kisoKey('outer', ''), kind: 'outer', text: '外周', name: `外周の基礎（外まわりの立上り・角 ${outer.reduce((a, o) => a + o.corners.length, 0)} か所）`, struck: false, n: outer.length, def: 'sky' });
  if (spans?.length) rows.push({ key: kisoKey('span', ''), kind: 'span', text: '寸法', name: '空きスパン（立上りと立上りの間の寸法・芯から芯）', struck: false, n: spans.length, def: 'red' });
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
    rows.push({ key, kind: r.kind, text: r.kind === 'hd' ? r.code : 'W600', name: r.spec || (r.kind === 'w' ? '人通口' : ''), struck: r.struck, n: cnt(key), legendRow: r, def: r.struck ? 'none' : (r.kind === 'hd' ? hdColor(r.code) : 'orange') });
  }
  if (!seen.has(kisoKey('w', 'W')) && cnt(kisoKey('w', 'W'))) rows.push({ key: kisoKey('w', 'W'), kind: 'w', text: 'W600', name: '人通口', struck: false, n: cnt(kisoKey('w', 'W')), def: 'orange' });
  // 図面にだけあるもの
  const extra = new Map();
  for (const m of marks) if (!rows.some((r) => r.key === m.key) && !extra.has(m.key)) extra.set(m.key, m);
  const order = { hd: 0, kaiko: 1, fg: 2, slab: 3, dok: 4 };
  const fgOf = (list?.panels || []);
  for (const m of [...extra.values()].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.code.localeCompare(b.code, 'ja', { numeric: true }))) {
    const def = m.kind === 'hd' ? hdColor(m.code) : m.kind === 'kaiko' ? 'purple' : m.kind === 'fg' ? fgColor(m.code) : m.kind === 'slab' ? 'brown' : 'orange';
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
    rows.push({ key, kind: isSlab ? 'slab' : 'fg', text: code, name: `${isSlab ? 'スラブ' : '梁'} ${code}（基礎リストのみ${p.unused ? '・×' : ''}）`, struck: p.unused, n: 0, def: p.unused ? 'none' : isSlab ? 'brown' : fgColor(code) });
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
export function buildKisoPaint({ legend, marks, list, outer, spans }, colors, colorHex) {
  const out = [];
  const spanHex = colorHex(colors[kisoKey('span', '')]);
  if (spanHex) out.push(...spanPaint(spans || [], spanHex));
  const outerHex = colorHex(colors[kisoKey('outer', '')]);
  // 外周：外の縁から壁の厚みの半分だけ内側の線を、壁の厚みの太さで引く
  if (outerHex) for (const o of outer || []) out.push({ kind: 'outline', page: o.page, hex: outerHex, points: o.path, width: o.thick || 6 });
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

/**
 * 基礎の壁の線だけを残す。壁（立上り）は「平行な2本の線」で描かれるので、
 * 縦か横の線のうち、2〜12pt 離れたところに重なる平行な線があるものを残す。柱の四角などの短い線（7pt 以下）も残す。
 * 斜めの線（引き出し線・耐力壁の三角）や、1本だけの線（寸法線）は除く。
 */
export function wallLines(segs, box) {
  const ax = segs.filter((s) => (Math.abs(s[1] - s[3]) < 0.05 || Math.abs(s[0] - s[2]) < 0.05) && len(s) > 0.3
    && Math.max(s[0], s[2]) >= box.x0 && Math.min(s[0], s[2]) <= box.x1 && Math.max(s[1], s[3]) >= box.y0 && Math.min(s[1], s[3]) <= box.y1);
  const H = [], V = [];
  for (const s of ax) {
    if (Math.abs(s[1] - s[3]) < 0.05) H.push({ s, c: s[1], a: Math.min(s[0], s[2]), b: Math.max(s[0], s[2]) });
    else V.push({ s, c: s[0], a: Math.min(s[1], s[3]), b: Math.max(s[1], s[3]) });
  }
  const keep = [];
  for (const list of [H, V]) {
    list.sort((p, q) => p.c - q.c);
    for (let i = 0; i < list.length; i++) {
      const L = list[i];
      if (L.b - L.a <= 7) { keep.push(L.s); continue; }
      let ok = false;
      // c（位置）で並べてあるので、2〜12pt 離れた範囲だけ見る
      for (const dir of [-1, 1]) {
        for (let j = i + dir; j >= 0 && j < list.length && Math.abs(list[j].c - L.c) <= 12 && !ok; j += dir) {
          const M = list[j], d = Math.abs(M.c - L.c);
          if (d < 2) continue;
          if (Math.min(L.b, M.b) - Math.max(L.a, M.a) >= 3) ok = true;
        }
      }
      if (ok) keep.push(L.s);
    }
  }
  return keep;
}

/**
 * 外周の基礎（外まわりの立上り）に沿った帯を求める。
 * 1) 実線（点線は除いたもの）をます目に描き、1ます太らせて小さなすき間をふさぐ
 * 2) 図面の記号（人通口・梁符号など）を囲む範囲を少し広げた枠から、線にぶつかるまで外側を塗りつぶす
 * 3) 塗れなかった部分のうち、記号の多いかたまり＝建物。細い出っ張り（幅 open ポイント未満）を削る
 * 4) 地縄寸法図と同じく、外周を角だけの多角形にする（corners＝外の縁の角、path＝外の縁から thick/2 内側の線）
 * @param segs 実線の線分（dropDashes 済み）
 * @param pts 図面の記号の位置 [[x, y], ...]（建物の中にあるもの）
 * @returns { corners: [[x, y]...], path: [[x, y]...] } または null
 */
export function findOuterBand(segs, pts, { cell = 0.75, thick = 6, margin = 70, open = 16, grid = { xs: [], ys: [] }, gridTol = 8 } = {}) {
  if (pts.length < 3) return null;
  // 建物が探す範囲の端に触れていたら（記号が建物の片側に寄っているとき）、範囲を広げてやり直す
  for (let m = margin, k = 0; k < 4; k++, m *= 1.8) {
    const r = outerBandOnce(segs, pts, cell, thick, m, open, grid, gridTol);
    if (r !== 'edge') return r;
  }
  return null;
}

function outerBandOnce(segs, pts, cell, thick, margin, open, grid, gridTol) {
  const bx0 = Math.min(...pts.map((p) => p[0])) - margin, bx1 = Math.max(...pts.map((p) => p[0])) + margin;
  const by0 = Math.min(...pts.map((p) => p[1])) - margin, by1 = Math.max(...pts.map((p) => p[1])) + margin;
  const nx = Math.ceil((bx1 - bx0) / cell) + 1, ny = Math.ceil((by1 - by0) / cell) + 1;
  const N = nx * ny;
  const line = new Uint8Array(N);
  const ix = (x) => Math.floor((x - bx0) / cell), iy = (y) => Math.floor((y - by0) / cell);
  for (const s of wallLines(segs, { x0: bx0, x1: bx1, y0: by0, y1: by1 })) {
    if (Math.max(s[0], s[2]) < bx0 || Math.min(s[0], s[2]) > bx1 || Math.max(s[1], s[3]) < by0 || Math.min(s[1], s[3]) > by1) continue;
    const n = Math.max(1, Math.ceil(Math.hypot(s[2] - s[0], s[3] - s[1]) / (cell * 0.5)));
    for (let k = 0; k <= n; k++) {
      const x = ix(s[0] + (s[2] - s[0]) * k / n), y = iy(s[1] + (s[3] - s[1]) * k / n);
      if (x >= 0 && y >= 0 && x < nx && y < ny) line[y * nx + x] = 1;
    }
  }
  const wall = line.slice();
  for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    if (!line[y * nx + x]) continue;
    wall[y * nx + x - 1] = wall[y * nx + x + 1] = wall[(y - 1) * nx + x] = wall[(y + 1) * nx + x] = 1;
  }
  // 外側の塗りつぶし（枠のふちから）
  const out = new Uint8Array(N);
  const q = new Int32Array(N);
  let qh = 0, qt = 0;
  const push = (i) => { if (!out[i] && !wall[i]) { out[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < nx; x++) { push(x); push((ny - 1) * nx + x); }
  for (let y = 0; y < ny; y++) { push(y * nx); push(y * nx + nx - 1); }
  while (qh < qt) {
    const i = q[qh++], x = i % nx, y = (i - x) / nx;
    if (x > 0) push(i - 1); if (x < nx - 1) push(i + 1);
    if (y > 0) push(i - nx); if (y < ny - 1) push(i + nx);
  }
  // 塗れなかったかたまりのうち、記号をいちばん多く含むもの＝建物
  const comp = new Int32Array(N).fill(-1);
  let best = -1, bestHits = 0, nc = 0;
  for (const [px, py] of pts) {
    const s0 = iy(py) * nx + ix(px);
    if (s0 < 0 || s0 >= N || out[s0] || comp[s0] >= 0) continue;
    const id = nc++;
    qh = 0; qt = 0; comp[s0] = id; q[qt++] = s0;
    while (qh < qt) {
      const i = q[qh++], x = i % nx, y = (i - x) / nx;
      for (const j of [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, y > 0 ? i - nx : -1, y < ny - 1 ? i + nx : -1]) {
        if (j >= 0 && !out[j] && comp[j] < 0) { comp[j] = id; q[qt++] = j; }
      }
    }
    const hits = pts.filter(([a, b]) => comp[iy(b) * nx + ix(a)] === id).length;
    if (hits > bestHits) { bestHits = hits; best = id; }
  }
  // 建物が見つからない＝範囲が建物の途中で切れて、外からの塗りつぶしが中に入った（範囲を広げてやり直す）
  if (best < 0 || bestHits < pts.length * 0.5) return 'edge';
  for (let x = 0; x < nx; x++) if (comp[x] === best || comp[(ny - 1) * nx + x] === best) return 'edge';
  for (let y = 0; y < ny; y++) if (comp[y * nx] === best || comp[y * nx + nx - 1] === best) return 'edge';
  // 地縄寸法図と同じく、外周を「角と辺」の多角形で表す。
  // 1) 建物のかたまりから、細い出っ張り（文字の枠・柱の小さな四角・壁の外の記号）を除く（幅 open ポイント未満を削る）
  // 2) 外の縁の多角形（角）と、帯の中心線（外の縁から thick/2 内側）を求める
  let mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (comp[i] === best) mask[i] = 1;
  const r = Math.max(1, Math.round(open / 2 / cell));
  mask = growMask(shrinkMask(mask, nx, ny, r), nx, ny, r);
  const face = traceOutline(mask, nx, ny, cell);
  if (!face) return null;
  const toPt = ([x, y]) => [bx0 + x * cell, by0 + y * cell];
  // 地縄寸法図と同じく「芯」で角を出す：外の縁の各辺を、壁の厚みの半分だけ内側へずらし、近くの通り芯（tol 以内）に合わせる
  const path = snapToGrid(face.map(toPt), grid, thick / 2, gridTol);
  if (!path) return null;
  return { corners: path, path };
}

/**
 * 角だけの多角形（左回り）の各辺を、内側へ inset ずらし、近くの通り芯に合わせる。
 * 合わせた結果、長さが 0 になった辺（通り芯に乗らない小さな凸凹）は消える。
 */
export function snapToGrid(poly, grid = { xs: [], ys: [] }, inset = 3, tol = 8) {
  const n = poly.length;
  if (n < 4) return null;
  const near = (v, list) => { let b = null; for (const g of list) if (Math.abs(g - v) <= tol && (b === null || Math.abs(g - v) < Math.abs(b - v))) b = g; return b; };
  // 辺ごとの位置（縦の辺は x、横の辺は y）
  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const vert = Math.abs(a[0] - b[0]) < 1e-6;
    const dir = vert ? Math.sign(b[1] - a[1]) : Math.sign(b[0] - a[0]);
    // 左回りなので、内側は進む向きの左
    let v = vert ? a[0] - dir * inset : a[1] + dir * inset;
    const g = near(v, vert ? grid.xs : grid.ys);
    if (g !== null) v = g;
    edges.push({ vert, v });
  }
  // 隣り合う辺の交点が角
  let pts = [];
  for (let i = 0; i < n; i++) {
    const p = edges[(i - 1 + n) % n], q = edges[i];
    if (p.vert === q.vert) continue;
    pts.push(p.vert ? [p.v, q.v] : [q.v, p.v]);
  }
  // 重なった点・一直線上の点を除く（くり返す）
  for (let changed = true; changed && pts.length > 4;) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const dup = Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
      const col = (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(b[0] - c[0]) < 1e-6) || (Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(b[1] - c[1]) < 1e-6);
      if (dup || col) { pts.splice(i, 1); changed = true; break; }
    }
  }
  return pts.length >= 4 ? pts : null;
}

/** 点線の線分から通り芯の位置を求める（同じ縦・横の位置に点線が合計 len 以上並ぶもの） */
export function gridLines(dashes, len = 150) {
  const xs = new Map(), ys = new Map();
  for (const s of dashes) {
    const L = Math.hypot(s[2] - s[0], s[3] - s[1]);
    if (Math.abs(s[0] - s[2]) < 0.05) { const k = Math.round(s[0] * 2) / 2; xs.set(k, (xs.get(k) || 0) + L); }
    else if (Math.abs(s[1] - s[3]) < 0.05) { const k = Math.round(s[1] * 2) / 2; ys.set(k, (ys.get(k) || 0) + L); }
  }
  const pick = (m) => [...m.entries()].filter(([, v]) => v >= len).map(([k]) => k).sort((a, b) => a - b);
  return { xs: pick(xs), ys: pick(ys) };
}

/** 8方向の距離で r ます内側まで削る（四角い角はそのまま残る） */
function shrinkMask(m, nx, ny, r) {
  const d = new Int16Array(nx * ny).fill(-1);
  const q = new Int32Array(nx * ny);
  let h = 0, t = 0;
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    const x = i % nx, y = (i - x) / nx;
    if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) { d[i] = 1; q[t++] = i; continue; }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!m[i + dy * nx + dx]) { if (d[i] < 0) { d[i] = 1; q[t++] = i; } }
  }
  while (h < t) {
    const i = q[h++], x = i % nx, y = (i - x) / nx;
    if (d[i] > r) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = x + dx, b = y + dy;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const j = b * nx + a;
      if (m[j] && d[j] < 0) { d[j] = d[i] + 1; q[t++] = j; }
    }
  }
  const o = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) if (m[i] && (d[i] < 0 || d[i] > r)) o[i] = 1;
  return o;
}

/** 8方向の距離で r ます外へ広げる */
function growMask(m, nx, ny, r) {
  const d = new Int16Array(nx * ny).fill(-1);
  const q = new Int32Array(nx * ny);
  let h = 0, t = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) { d[i] = 0; q[t++] = i; }
  while (h < t) {
    const i = q[h++], x = i % nx, y = (i - x) / nx;
    if (d[i] >= r) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = x + dx, b = y + dy;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const j = b * nx + a;
      if (d[j] < 0) { d[j] = d[i] + 1; q[t++] = j; }
    }
  }
  const o = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) if (d[i] >= 0) o[i] = 1;
  return o;
}

/**
 * ますのかたまりの外まわりの線を、角だけの多角形にする（ますの角の座標）。いちばん長い輪を外の縁とする。
 * 同じ向きに続く辺はまとめ、1ます分の小さな段差はならす。
 */
function traceOutline(m, nx, ny, cellSize = 0.75) {
  const at = (x, y) => x >= 0 && y >= 0 && x < nx && y < ny && m[y * nx + x];
  const next = new Map(); // 辺の始点 → 終点（左回り）
  const key = (x, y) => x + ',' + y;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) next.set(key(x, y), [x + 1, y]);       // 下の辺
    if (!at(x + 1, y)) next.set(key(x + 1, y), [x + 1, y + 1]); // 右の辺
    if (!at(x, y + 1)) next.set(key(x + 1, y + 1), [x, y + 1]); // 上の辺
    if (!at(x - 1, y)) next.set(key(x, y + 1), [x, y]);       // 左の辺
  }
  const seen = new Set();
  let best = null;
  for (const k0 of next.keys()) {
    if (seen.has(k0)) continue;
    const loop = [];
    let k = k0, guard = 0;
    while (!seen.has(k) && guard++ < 2e6) {
      seen.add(k);
      const [x, y] = k.split(',').map(Number);
      loop.push([x, y]);
      const n = next.get(k);
      if (!n) break;
      k = key(n[0], n[1]);
    }
    if (!best || loop.length > best.length) best = loop;
  }
  if (!best || best.length < 4) return null;
  // 角と見なす辺は 5pt 以上（図面の最短の辺は半間 455mm。1/70 でも約 6.5pt）
  return cornersOf(best, Math.max(3, Math.round(5 / cellSize)));
}

/**
 * ますの縁をたどった点の列から、角だけの多角形を作る（地縄寸法図の「角」と同じ考え方）。
 * 同じ向きに続く辺を1本にまとめ、minLen ます未満の短い辺（角の欠け・段差）はならす。
 */
function cornersOf(loop, minLen) {
  const n = loop.length;
  let runs = [];
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const d = [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])];
    const L = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    const last = runs[runs.length - 1];
    if (last && last.d[0] === d[0] && last.d[1] === d[1]) last.len += L; else runs.push({ d, len: L });
  }
  const same = (p, q) => p.d[0] === q.d[0] && p.d[1] === q.d[1];
  const opp = (p, q) => p.d[0] === -q.d[0] && p.d[1] === -q.d[1];
  const tidy = () => {
    for (let changed = true; changed && runs.length > 4;) {
      changed = false;
      for (let i = 0; i < runs.length; i++) {
        const j = (i + 1) % runs.length, p = runs[i], q = runs[j];
        if (i === j) break;
        if (same(p, q)) { p.len += q.len; runs.splice(j, 1); changed = true; break; }
        if (opp(p, q)) {
          const dl = p.len - q.len;
          if (dl >= 0) { p.len = dl; runs.splice(j, 1); } else { q.len = -dl; runs.splice(i, 1); }
          runs = runs.filter((r) => r.len > 0); changed = true; break;
        }
      }
    }
  };
  tidy();
  for (let guard = 0; guard < 10000 && runs.length > 4; guard++) {
    let k = -1;
    for (let i = 0; i < runs.length; i++) if (runs[i].len < minLen && (k < 0 || runs[i].len < runs[k].len)) k = i;
    if (k < 0) break;
    runs.splice(k, 1);
    tidy();
  }
  // 短い辺を除いた分のずれを、同じ向きのいちばん長い辺で吸収する（斜めの辺を作らない）
  for (const axis of [0, 1]) {
    const res = runs.reduce((a, r) => a + r.d[axis] * r.len, 0);
    if (!res) continue;
    const cand = runs.filter((r) => r.d[axis] !== 0).sort((a, b) => b.len - a.len)[0];
    if (cand) cand.len -= res * cand.d[axis];
  }
  const pts = [];
  let x = loop[0][0], y = loop[0][1];
  for (const r of runs) { pts.push([x, y]); x += r.d[0] * r.len; y += r.d[1] * r.len; }
  return pts.length >= 4 ? pts : null;
}

/**
 * 図面の縮尺（「1/70」「S:1/70」などの文字）から、PDF の 1pt が実物の何 mm かを返す。見つからなければ null
 */
export function mmPerPt(words) {
  for (const w of words) {
    const m = norm(w.s).match(/(?:^|[^0-9])1\/([2-9]\d|1\d\d|200)(?![0-9])/);
    if (m) return (25.4 / 72) * Number(m[1]);
  }
  return null;
}

/**
 * 基礎の立上り（通り芯の上の壁）を通り芯ごとに求める。
 * 平行な2本の線の壁（wallLines）のうち、通り芯から tol 以内にあるものを集め、gap 以下の切れ目（人通口・柱の四角など）はつなぐ。
 * @param segs 実線の線分 @param grid { xs, ys }（通り芯） @param box 建物の範囲（外周の角の範囲）
 * @returns { H: [{ y, a, b }], V: [{ x, a, b }] }（H＝横の壁：y の通り芯で x が a〜b）
 */
export function wallsOnGrid(segs, grid, box, { tol = 8, gap = 30, minLen = 20 } = {}) {
  const kept = wallLines(segs, { x0: box.x0 - tol, x1: box.x1 + tol, y0: box.y0 - tol, y1: box.y1 + tol });
  const pick = (coords, horiz) => {
    const out = [];
    for (const g of coords) {
      if (g < (horiz ? box.y0 : box.x0) - tol || g > (horiz ? box.y1 : box.x1) + tol) continue;
      const iv = [];
      for (const s of kept) {
        const isH = Math.abs(s[1] - s[3]) < 0.05;
        if (isH !== horiz) continue;
        const c = horiz ? s[1] : s[0];
        if (Math.abs(c - g) > tol) continue;
        // いちばん近い通り芯の壁とする（近くに通り芯が2本あるとき、両方に同じ壁を数えない）
        if (coords.some((o) => o !== g && Math.abs(c - o) < Math.abs(c - g))) continue;
        const a = horiz ? Math.min(s[0], s[2]) : Math.min(s[1], s[3]), b = horiz ? Math.max(s[0], s[2]) : Math.max(s[1], s[3]);
        if (b - a > 7) iv.push([a, b]);
      }
      iv.sort((p, q) => p[0] - q[0]);
      const merged = [];
      for (const [a, b] of iv) {
        const last = merged[merged.length - 1];
        if (last && a <= last[1] + gap) last[1] = Math.max(last[1], b); else merged.push([a, b]);
      }
      for (const [a, b] of merged) if (b - a >= minLen) out.push(horiz ? { y: g, a, b } : { x: g, a, b });
    }
    return out;
  };
  return { H: pick(grid.ys, true), V: pick(grid.xs, false) };
}

/**
 * 通り芯の位置を実物の mm にする（寸法線の数字を使う）。
 * となりの通り芯のちょうど真ん中にある数字（横の通り芯の間は横書き、縦は縦書き）をその間の寸法とし、
 * 数字のない間は図面の縮尺から求める。PDF の位置は 0.5pt ほどずれるので、縮尺だけで出すより正しい。
 * @returns { x: Map(通り芯の位置 → mm), y: Map }
 */
export function gridMm(grid, words, mmPt) {
  const nums = words.filter((w) => /^\d{2,5}$/.test(w.s));
  const chain = (coords, horiz) => {
    const pos = new Map();
    if (!coords.length) return pos;
    // 通り芯 i と j（4本先まで）のちょうど真ん中にある数字を、その間の寸法とする（寸法線は何本かの通り芯をまたぐこともある）
    const edges = [];
    for (let i = 0; i < coords.length; i++) for (let j = i + 1; j < coords.length && j <= i + 4; j++) {
      const a = coords[i], b = coords[j], mid = (a + b) / 2, est = (b - a) * (mmPt || 0);
      const cnt = new Map();
      for (const w of nums) {
        if (!!w.vertical === horiz) continue;
        if (Math.abs((horiz ? w.cx : w.cy) - mid) > 1.5) continue;
        const v = Number(w.s);
        if (mmPt && Math.abs(v - est) > Math.max(25, est * 0.04)) continue; // 縮尺と大きく違う数字（高さなど）は使わない
        cnt.set(v, (cnt.get(v) || 0) + 1);
      }
      const v = [...cnt].sort((p, q) => q[1] - p[1])[0]?.[0];
      if (v) edges.push([i, j, v]);
    }
    // 数字から縮尺を出し直す（数字でつながらない通り芯に使う）
    const r = edges.map(([i, j, v]) => v / (coords[j] - coords[i])).sort((p, q) => p - q);
    const k = r.length ? r[r.length >> 1] : mmPt || 0;
    const mm = new Array(coords.length).fill(null);
    for (let start = 0; start < coords.length; start++) {
      if (mm[start] != null) continue;
      // 前の通り芯から縮尺で置き、そこから数字でつながる通り芯をたどる
      const prev = start - 1;
      mm[start] = prev >= 0 ? mm[prev] + (coords[start] - coords[prev]) * k : 0;
      const queue = [start];
      while (queue.length) {
        const i = queue.shift();
        for (const [p, q, v] of edges) {
          if (p === i && mm[q] == null) { mm[q] = mm[i] + v; queue.push(q); }
          else if (q === i && mm[p] == null) { mm[p] = mm[i] - v; queue.push(p); }
        }
      }
    }
    coords.forEach((c, i) => pos.set(c, mm[i]));
    return pos;
  };
  return { x: chain(grid.xs, true), y: chain(grid.ys, false) };
}

/**
 * 空きスパン：基礎の立上りと立上りの間の寸法（芯から芯）。
 * 横の壁ごとに、その壁にぶつかる縦の壁の位置を並べ、となりどうしの間を1つのスパンとする（縦も同じ）。
 * 同じ2本の壁の間のスパンは1回だけ（建物のいちばん外側＝外周に近い壁の上に書く）。
 * @returns [{ dir: 'x'|'y', a, b, at, mm }]（dir 'x'＝横向きの寸法：x が a〜b、y＝at の壁の上）
 */
export function findSpans(walls, mmPt, { tol = 4, minMm = 300, pos = null } = {}) {
  const out = [], seen = new Map();
  const add = (dir, a, b, at, edge) => {
    const m = pos?.[dir];
    const raw = m?.has(a) && m?.has(b) ? Math.abs(m.get(b) - m.get(a)) : (b - a) * mmPt;
    const mm = Math.round(raw / 5) * 5;
    if (mm < minMm) return;
    const key = `${dir}:${Math.round(a)}:${Math.round(b)}`;
    const prev = seen.get(key);
    if (prev && prev.edge <= edge) return;
    const sp = { dir, a, b, at, mm, edge };
    if (prev) out[out.indexOf(prev)] = sp; else out.push(sp);
    seen.set(key, sp);
  };
  const xs = walls.V.map((v) => v.x), ys = walls.H.map((h) => h.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (const h of walls.H) {
    const cross = [...new Set(walls.V.filter((v) => v.x >= h.a - tol && v.x <= h.b + tol && h.y >= v.a - tol && h.y <= v.b + tol).map((v) => v.x))].sort((p, q) => p - q);
    for (let i = 1; i < cross.length; i++) add('x', cross[i - 1], cross[i], h.y, Math.min(h.y - minY, maxY - h.y));
  }
  for (const v of walls.V) {
    const cross = [...new Set(walls.H.filter((h) => h.y >= v.a - tol && h.y <= v.b + tol && v.x >= h.a - tol && v.x <= h.b + tol).map((h) => h.y))].sort((p, q) => p - q);
    for (let i = 1; i < cross.length; i++) add('y', cross[i - 1], cross[i], v.x, Math.min(v.x - minX, maxX - v.x));
  }
  return out.map(({ edge, ...s }) => s);
}

/**
 * 空きスパンの赤い寸法（線・両端の短い線・数字）。壁から off だけ部屋の内側（建物の真ん中の側）に引く
 */
export function spanPaint(spans, hex, { off = 7, tick = 2.5, size = 7.5 } = {}) {
  const out = [];
  const byPage = new Map();
  for (const s of spans) (byPage.get(s.page) || byPage.set(s.page, []).get(s.page)).push(s);
  for (const [page, list] of byPage) {
    const xs = list.filter((s) => s.dir === 'y').map((s) => s.at), ys = list.filter((s) => s.dir === 'x').map((s) => s.at);
    const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0, cy = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
    for (const s of list) {
      const t = String(s.mm);
      if (s.dir === 'x') {
        const y = s.at + (s.at > cy ? -off : off);
        out.push({ kind: 'dim', page, hex, width: 0.7, points: [[s.a, y], [s.b, y]] });
        for (const x of [s.a, s.b]) out.push({ kind: 'dim', page, hex, width: 0.7, points: [[x, y - tick], [x, y + tick]] });
        out.push({ kind: 'label', page, hex, x: (s.a + s.b) / 2 - t.length * size * 0.28, y: y + (s.at > cy ? -size - 0.8 : 1.2), text: t, size });
      } else {
        const x = s.at + (s.at > cx ? -off : off);
        out.push({ kind: 'dim', page, hex, width: 0.7, points: [[x, s.a], [x, s.b]] });
        for (const y of [s.a, s.b]) out.push({ kind: 'dim', page, hex, width: 0.7, points: [[x - tick, y], [x + tick, y]] });
        out.push({ kind: 'label', page, hex, x: s.at > cx ? x - t.length * size * 0.56 - 1.5 : x + 1.5, y: (s.a + s.b) / 2 - size * 0.35, text: t, size });
      }
    }
  }
  return out;
}
