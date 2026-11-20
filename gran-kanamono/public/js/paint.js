// 色をつけた PDF を作る（pdf-lib。元の線や文字はそのまま、上に半透明の色を「乗算」で重ねる）
import { ALPHA } from './core.js';

const rgbOf = (lib, hex) => {
  const n = parseInt(hex.slice(1), 16);
  return lib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

/**
 * @param lib pdf-lib のモジュール
 * @param bytes 元の PDF（ArrayBuffer / Uint8Array）
 * @param paint buildPaint の結果
 * @returns 色をつけた PDF の Uint8Array
 */
export async function paintPdf(lib, bytes, paint) {
  const doc = await lib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = doc.getPages();
  const order = { band: 0, outer: 0, outline: 0, legend: 1, mark: 2, ring: 3, warn: 3, dim: 4, label: 4 };
  let font = null;
  for (const p of [...paint].sort((a, b) => order[a.kind] - order[b.kind])) {
    const page = pages[p.page];
    if (!page) continue;
    const color = rgbOf(lib, p.hex);
    if (p.kind === 'label') {
      // 番号・数（数字と「×」だけ。標準の書体で書ける字に限る）
      font ??= await doc.embedFont(lib.StandardFonts.HelveticaBold);
      page.drawText(p.text, { x: p.x, y: p.y, size: p.size || 6, font, color });
    } else if (p.kind === 'outline') {
      // 外周の線（角だけの多角形）。SVG の向き（下向きが正）に合わせて y を反転して渡す
      const d = p.points.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(2)} ${(-y).toFixed(2)}`).join(' ') + (p.open ? '' : ' Z');
      page.drawSvgPath(d, { x: 0, y: 0, borderColor: color, borderWidth: p.width, borderOpacity: ALPHA.outline, borderLineCap: lib.LineCapStyle.Projecting, blendMode: lib.BlendMode.Multiply });
    } else if (p.kind === 'dim') {
      // 寸法の線（はしを閉じない線）
      const d = p.points.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(2)} ${(-y).toFixed(2)}`).join(' ');
      page.drawSvgPath(d, { x: 0, y: 0, borderColor: color, borderWidth: p.width });
    } else if (p.kind === 'ring') {
      page.drawEllipse({ x: p.cx, y: p.cy, xScale: p.rx ?? p.r, yScale: p.ry ?? p.r, borderColor: color, borderWidth: 0.8, borderOpacity: ALPHA.ring });
    } else if (p.kind === 'band' || p.kind === 'outer') {
      page.drawRectangle({ x: p.x0, y: p.y0, width: p.x1 - p.x0, height: p.y1 - p.y0, color, opacity: ALPHA[p.kind], blendMode: lib.BlendMode.Multiply });
    } else if (p.kind === 'warn') {
      page.drawEllipse({ x: p.cx, y: p.cy, xScale: p.rx ?? p.r, yScale: p.ry ?? p.r, borderColor: color, borderWidth: 0.9, borderOpacity: ALPHA.warn });
    } else {
      page.drawEllipse({ x: p.cx, y: p.cy, xScale: p.rx ?? p.r, yScale: p.ry ?? p.r, color, opacity: ALPHA[p.kind], blendMode: lib.BlendMode.Multiply });
    }
  }
  return doc.save();
}
