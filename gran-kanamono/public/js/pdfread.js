// pdf.js で PDF を読む（ブラウザでも Node でも同じに動く。pdf.js は呼ぶ側が渡す）
import { toGlyph, findLegend, findMarks } from './core.js';
import { findWallLegend, findWallMarks, excludeZones } from './walls.js';

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
 * @returns { pages, legend, found, walls: { legend, marks } | null }
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
  const walls = wallLegend ? {
    legend: wallLegend,
    marks: findWallMarks(segs.map((s) => ({ segs: s })), wallLegend, {
      exclude: excludeZones(pages.map((p) => p.glyphs), [wallLegend, legend], sizes),
    }),
  } : null;
  return { pages, legend, found, walls };
}
