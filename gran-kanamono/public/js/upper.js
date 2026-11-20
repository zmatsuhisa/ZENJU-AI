// 2階の耐力壁の位置を、1階の柱伏図に落とし込む（2階建て）。
// 2階の柱伏図で見つけた壁の記号（筋かい・面材）を、通り芯の名前（い・ろ・は…、1・2・3…）で 1階の図面の位置に移す。

/** 通り芯の名前らしい字（ひらがな1〜2字・数字1〜2桁・それに a などが付いたもの。寸法の 910 などは除く） */
const LABEL_RE = /^([ぁ-ん]{1,2}|\d{1,2})(\.\d|[a-z])?$/;

/**
 * 図面のページ名（「1階柱伏図」「2階床伏図」など）から、1階・2階の伏図のページを決める。
 * @param pages readGlyphs の結果
 * @returns { first: ページ番号 | null, second: ページ番号 | null }
 */
export function floorPages(pages) {
  const find = (n) => {
    const hit = (re) => pages.findIndex((p) => p.glyphs.some((g) => re.test(g.s.normalize('NFKC').replace(/\s+/g, ''))));
    const i = hit(new RegExp(`${n}階柱伏図`));
    return i >= 0 ? i : (hit(new RegExp(`${n}階(床)?伏図`)) >= 0 ? hit(new RegExp(`${n}階(床)?伏図`)) : null);
  };
  return { first: find(1), second: find(2) };
}

/**
 * 通り芯の線の端にある名前を読む。
 * @param glyphs そのページの字 @param grid { xs, ys }（通り芯）
 * @returns { x: Map(名前 → x), y: Map(名前 → y) }
 */
export function gridLabels(glyphs, grid, tol = 1.5) {
  const out = { x: new Map(), y: new Map() };
  const words = glyphs.filter((g) => LABEL_RE.test(g.s.normalize('NFKC').trim()));
  for (const [axis, coords] of [['x', grid.xs], ['y', grid.ys]]) {
    for (const c of coords) {
      const near = words.filter((g) => Math.abs((axis === 'x' ? g.cx : g.cy) - c) <= tol);
      // 同じ名前が線の両端（上と下、左と右）にあることが多い。いちばん多い名前をとる
      const cnt = new Map();
      for (const g of near) { const s = g.s.normalize('NFKC').trim(); cnt.set(s, (cnt.get(s) || 0) + 1); }
      const best = [...cnt].sort((p, q) => q[1] - p[1])[0];
      if (best && !out[axis].has(best[0])) out[axis].set(best[0], c);
    }
  }
  return out;
}

/** 同じ名前の通り芯の組から、2階の位置 → 1階の位置の式（v1 = a·v2 + b）を求める。2組未満なら null */
export function fitAxis(from, to) {
  const pairs = [...from].filter(([k]) => to.has(k)).map(([k, v]) => [v, to.get(k)]);
  if (pairs.length < 2) return null;
  const n = pairs.length, sx = pairs.reduce((s, p) => s + p[0], 0), sy = pairs.reduce((s, p) => s + p[1], 0);
  const sxx = pairs.reduce((s, p) => s + p[0] * p[0], 0), sxy = pairs.reduce((s, p) => s + p[0] * p[1], 0);
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-9) return null;
  const a = (n * sxy - sx * sy) / d, b = (sy - a * sx) / n;
  // 合わない組（読み違えた名前）が多いときは使わない
  const err = Math.max(...pairs.map(([u, v]) => Math.abs(a * u + b - v)));
  return err > 6 ? null : { a, b, n };
}

/**
 * 2階の壁の記号を、壁の線（いちばん近い通り芯の上の、となりの通り芯から通り芯まで）にして 1階の位置に移す。
 * @param marks 2階のページの壁の記号（findWallMarks の結果のうち、そのページのもの）
 * @param grid2 2階の通り芯 @param fx, fy fitAxis の結果 @param solid 2階のページの実線（あれば壁の線に寄せる）
 * @returns [{ key, points: [[x, y], [x, y]] }]（1階の図面の座標）
 */
export function upperWalls(marks, grid2, fx, fy, { tol = 14, solid = null } = {}) {
  const out = [];
  const nearest = (cs, v) => cs.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best), Infinity);
  const around = (cs, v) => {
    const lo = cs.filter((c) => c <= v).pop(), hi = cs.find((c) => c > v);
    return lo != null && hi != null ? [lo, hi] : null;
  };
  const xs = [...grid2.xs].sort((p, q) => p - q), ys = [...grid2.ys].sort((p, q) => p - q);
  // 壁の線（実線の長い横・縦の線）。記号は壁の横に書かれるので、いちばん近い壁の線に寄せる
  const H = [], V = [];
  for (const s of solid || []) {
    if (Math.abs(s[1] - s[3]) < 0.05 && Math.abs(s[2] - s[0]) > 20) H.push({ c: s[1], a: Math.min(s[0], s[2]), b: Math.max(s[0], s[2]) });
    else if (Math.abs(s[0] - s[2]) < 0.05 && Math.abs(s[3] - s[1]) > 20) V.push({ c: s[0], a: Math.min(s[1], s[3]), b: Math.max(s[1], s[3]) });
  }
  const wallNear = (list, along, across) => {
    let best = null;
    for (const w of list) if (along >= w.a && along <= w.b && Math.abs(w.c - across) <= tol && (!best || Math.abs(w.c - across) < Math.abs(best.c - across))) best = w;
    return best;
  };
  for (const m of marks) {
    let seg = null;
    if (solid) {
      const h = wallNear(H, m.cx, m.cy), v = wallNear(V, m.cy, m.cx);
      const useH = h && (!v || Math.abs(h.c - m.cy) <= Math.abs(v.c - m.cx));
      if (useH) { const gy = nearest(ys, h.c), r = around(xs, m.cx); if (r && Math.abs(gy - h.c) < 5) seg = [[r[0], gy], [r[1], gy]]; }
      else if (v) { const gx = nearest(xs, v.c), r = around(ys, m.cy); if (r && Math.abs(gx - v.c) < 5) seg = [[gx, r[0]], [gx, r[1]]]; }
    } else {
      const gx = nearest(xs, m.cx), gy = nearest(ys, m.cy);
      const dx = Math.abs(gx - m.cx), dy = Math.abs(gy - m.cy);
      if (dy <= dx && dy <= tol) { const r = around(xs, m.cx); if (r) seg = [[r[0], gy], [r[1], gy]]; }
      else if (dx <= tol) { const r = around(ys, m.cy); if (r) seg = [[gx, r[0]], [gx, r[1]]]; }
    }
    if (!seg) continue;
    out.push({ key: m.key, points: seg.map(([x, y]) => [fx.a * x + fx.b, fy.a * y + fy.b]) });
  }
  // 同じ壁に記号が2つ（筋かいと面材など）あれば1本にする
  const seen = new Set();
  return out.filter((w) => { const k = w.points.flat().map((v) => Math.round(v)).join(','); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** 塗るもの：2階の耐力壁の線（太い半透明の線）と「2F」の字 */
export function upperPaint(upper, hex) {
  if (!upper || !hex) return [];
  const out = [];
  for (const w of upper.walls) {
    out.push({ kind: 'outline', open: true, page: upper.page, hex, points: w.points, width: 4 });
  }
  return out;
}
