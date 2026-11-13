// pdf.js で PDF を読む（ブラウザでも Node でも同じに動く。pdf.js は呼ぶ側が渡す）
import { toGlyph, findLegend, findMarks } from './core.js';

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
      for (const o of ops) {
        if (o === OPS.moveTo) { cur = start = ap(nums[k], nums[k + 1]); k += 2; }
        else if (o === OPS.lineTo) { const p = ap(nums[k], nums[k + 1]); k += 2; if (cur) { const s = [...cur, ...p]; if (keep(s)) segs.push(s); } cur = p; }
        else if (o === OPS.curveTo) { cur = ap(nums[k + 4], nums[k + 5]); k += 6; }
        else if (o === OPS.curveTo2 || o === OPS.curveTo3) { cur = ap(nums[k + 2], nums[k + 3]); k += 4; }
        else if (o === OPS.rectangle) k += 4;
        else if (o === OPS.closePath) { if (cur && start) { const s = [...cur, ...start]; if (keep(s)) segs.push(s); } cur = start; }
      }
    }
  }
  return segs;
}

/** PDF を読んで、リスト・記号・ページの大きさまでまとめて返す */
export async function analyze(pdfjs, doc) {
  const pages = await readGlyphs(doc);
  // 斜線を見るのは、リストの候補があるページだけ（線の多い図面全部を読むと遅い）
  let legend = null;
  for (let i = 0; i < pages.length && !legend; i++) {
    const rough = findLegend(pages[i].glyphs);
    if (!rough) continue;
    const page = await doc.getPage(i + 1);
    const segs = await readSegments(pdfjs, page, rough.box);
    legend = findLegend(pages[i].glyphs, segs);
  }
  if (!legend) return { pages, legend: null, found: null };
  return { pages, legend, found: findMarks(pages, legend) };
}
