// pdf.js で PDF を読む（ブラウザでも Node でも同じに動く。pdf.js は呼ぶ側が渡す）
import { toGlyph, findLegend, findMarks } from './core.js';
import { findWallLegend, findWallMarks, excludeZones } from './walls.js';
import { mergeWords, findKisoLegend, findKisoMarks, findKisoList, findOuterBand, gridLines } from './kiso.js';
import { dropDashes } from './walls.js';

/** ページごとの文字（toGlyph の形） */
export async function readGlyphs(doc) {
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const glyphs = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      glyphs.push(toGlyph(it, n - 1));
    }
    pages.push({ glyphs });
  }
  return pages;
}

/**
 * ページの線分を PDF の座標で取り出す（斜線の見分けに使う）。
 * pdf.js 4.x の operator list を読み、座標変換（cm・q/Q・フォーム）をたどる。
 */
export async function readSegments(pdfjs, page, box = null) {
  const { OPS } = pdfjs;
  const ol = await page.getOperatorList();
  const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const ap = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const segs = [];
  const keep = (s) => !box || (Math.max(s[0], s[2]) >= box.x0 - 10 && Math.min(s[0], s[2]) <= box.x1 + 10 && Math.max(s[1], s[3]) >= box.y0 - 10 && Math.min(s[1], s[3]) <= box.y1 + 10);
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === OPS.save) stack.push(m);
    else if (fn === OPS.restore) m = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) m = mul(m, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(m); if (Array.isArray(args?.[0]) && args[0].length === 6) m = mul(m, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) m = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.constructPath) {
      const [ops, nums] = args;
      let k = 0, cur = null, start = null;
      const line = (p) => { if (cur) { const s = [...cur, ...p]; if (keep(s)) segs.push(s); } cur = p; };
      // 曲線は短い線に分ける（円や弧の形を比べられるように）
      const bez = (p1, p2, p3) => {
        const p0 = cur || p3;
        for (let i = 1; i <= 6; i++) {
          const t = i / 6, u = 1 - t;
          line([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
        }
      };
      for (const o of ops) {
        if (o === OPS.moveTo) { cur = start = ap(nums[k], nums[k + 1]); k += 2; }
        else if (o === OPS.lineTo) { line(ap(nums[k], nums[k + 1])); k += 2; }
        else if (o === OPS.curveTo) { bez(ap(nums[k], nums[k + 1]), ap(nums[k + 2], nums[k + 3]), ap(nums[k + 4], nums[k + 5])); k += 6; }
        else if (o === OPS.curveTo2) { bez(cur || ap(nums[k], nums[k + 1]), ap(nums[k], nums[k + 1]), ap(nums[k + 2], nums[k + 3])); k += 4; }
        else if (o === OPS.curveTo3) { const p3 = ap(nums[k + 2], nums[k + 3]); bez(ap(nums[k], nums[k + 1]), p3, p3); k += 4; }
        else if (o === OPS.rectangle) {
          const [x, y, w, h] = nums.slice(k, k + 4); k += 4;
          cur = start = ap(x, y);
          line(ap(x + w, y)); line(ap(x + w, y + h)); line(ap(x, y + h)); line(start);
        }
        else if (o === OPS.closePath) { if (cur && start) line(start); cur = start; }
      }
    }
  }
  return segs;
}

/**
 * PDF を読んで、金物リスト・金物記号・壁の表・壁の記号までまとめて返す。
 * @returns { pages, legend, found, walls: { legend, marks } | null, kiso: { legend, marks, list, planPages } | null }
 */
export async function analyze(pdfjs, doc, onProgress = () => {}) {
  const pages = await readGlyphs(doc);
  const segs = [];
  const sizes = [];
  for (let n = 1; n <= doc.numPages; n++) {
    onProgress(n, doc.numPages);
    const page = await doc.getPage(n);
    const [x0, y0, x1, y1] = page.view;
    sizes.push({ w: x1 - x0, h: y1 - y0 });
    segs.push(await readSegments(pdfjs, page));
  }
  let legend = null;
  for (let i = 0; i < pages.length && !legend; i++) {
    if (findLegend(pages[i].glyphs)) legend = findLegend(pages[i].glyphs, segs[i]);
  }
  let wallLegend = null;
  for (let i = 0; i < pages.length && !wallLegend; i++) wallLegend = findWallLegend(pages[i].glyphs, segs[i], i);
  const found = legend ? findMarks(pages, legend) : null;
  // 壁の記号は伏図（平面）にしか出てこない。「伏図」とあるページだけで探す（詳細図の溶接の三角などを拾わないように）。
  // どのページにも当てはまらなければ全ページで探す
  // 基礎伏図には壁の記号も描かれているが、現場では塗らないので除く（柱伏図などで探す）
  const planPages = pages.map((p) => {
    const t = p.glyphs.map((g) => g.s.replace(/\s+/g, '')).join(' ');
    return /伏図/.test(t) && !/基礎伏図/.test(t);
  });
  const usePage = (i) => !planPages.some(Boolean) || planPages[i];
  const walls = wallLegend ? {
    legend: wallLegend,
    marks: findWallMarks(segs.map((s, i) => ({ segs: usePage(i) ? s : [] })), wallLegend, {
      exclude: excludeZones(pages.map((p) => p.glyphs), [wallLegend, legend], sizes),
    }),
  } : null;
  // 基礎図面：基礎伏図（「基礎伏図」とあるページ）の凡例と記号、基礎リスト（断面の一覧）
  let kiso = null;
  for (let i = 0; i < pages.length; i++) {
    const words = mergeWords(pages[i].glyphs);
    const isPlan = words.some((w) => /基礎伏図/.test(w.s.replace(/\s+/g, '')));
    const list = findKisoList(words, segs[i], i);
    if (!isPlan && !list) continue;
    kiso ??= { legend: null, marks: [], list: null, planPages: [] };
    if (isPlan) {
      const lg = findKisoLegend(pages[i].glyphs, segs[i], i);
      if (lg && !kiso.legend) kiso.legend = lg;
      const ex = excludeZones([pages[i].glyphs], [], [sizes[i]])[0] || [];
      const pm = findKisoMarks(words, lg, ex);
      kiso.marks.push(...pm);
      kiso.planPages.push(i);
      // 外周の基礎：図面の記号（人通口・梁符号など）を囲む建物の外まわりの壁に沿った帯
      const solid = dropDashes(segs[i]);
      const solidSet = new Set(solid);
      const grid = gridLines(segs[i].filter((x) => !solidSet.has(x)));
      const ol = findOuterBand(solid, pm.filter((m) => m.kind !== 'dok').map((m) => [m.cx, m.cy]), { grid });
      if (ol) (kiso.outer ??= []).push({ page: i, thick: 6, ...ol });
    }
    if (list && !kiso.list) kiso.list = list;
  }
  if (kiso && !kiso.legend && !kiso.marks.length && !kiso.list) kiso = null;
  return { pages, legend, found, walls, kiso };
}
