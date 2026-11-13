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
  const order = { band: 0, legend: 1, mark: 2, warn: 3 };
  for (const p of [...paint].sort((a, b) => order[a.kind] - order[b.kind])) {
    const page = pages[p.page];
    if (!page) continue;
    const color = rgbOf(lib, p.hex);
    if (p.kind === 'band') {
      page.drawRectangle({ x: p.x0, y: p.y0, width: p.x1 - p.x0, height: p.y1 - p.y0, color, opacity: ALPHA.band, blendMode: lib.BlendMode.Multiply });
    } else if (p.kind === 'warn') {
      page.drawEllipse({ x: p.cx, y: p.cy, xScale: p.rx ?? p.r, yScale: p.ry ?? p.r, borderColor: color, borderWidth: 0.9, borderOpacity: ALPHA.warn });
    } else {
      page.drawEllipse({ x: p.cx, y: p.cy, xScale: p.rx ?? p.r, yScale: p.ry ?? p.r, color, opacity: ALPHA[p.kind], blendMode: lib.BlendMode.Multiply });
    }
  }
  return doc.save();
}
