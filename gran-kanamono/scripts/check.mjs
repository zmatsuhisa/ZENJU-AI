// 実物の図面で、見つけたリスト・記号の数を表示し、色をつけた PDF を書き出す（画面を使わない確認用）
// 使い方: node scripts/check.mjs <図面.pdf> [書き出し先.pdf]
// 図面はリポジトリに入れないこと（DATA などリポジトリの外のフォルダに置く）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as PDFLib from 'pdf-lib';
import { analyze } from '../public/js/pdfread.js';
import { countBySymbol, defaultColors, buildPaint, colorHex, WALL_ORDER } from '../public/js/core.js';
import { countByKey, buildWallPaint } from '../public/js/walls.js';
import { paintPdf } from '../public/js/paint.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [src, out] = process.argv.slice(2);
if (!src) { console.error('使い方: node scripts/check.mjs <図面.pdf> [書き出し先.pdf]'); process.exit(1); }
const bytes = readFileSync(src);
const doc = await pdfjs.getDocument({
  data: new Uint8Array(bytes), cMapUrl: join(root, 'node_modules/pdfjs-dist/cmaps/'), cMapPacked: true,
  standardFontDataUrl: join(root, 'node_modules/pdfjs-dist/standard_fonts/'), verbosity: 0,
}).promise;
const { legend, found, walls } = await analyze(pdfjs, doc);
if (!legend && !walls) { console.log('金物リストも壁の表も見つかりません'); process.exit(2); }
if (legend) {
  const cnt = countBySymbol(found.marks);
  console.log(`金物リスト: ${legend.page + 1}ページ「${legend.title}」 ${legend.rows.length}行`);
  for (const r of legend.rows) console.log(`  ${r.no.padStart(2)} ${r.s} ${r.struck ? '[斜線]' : '      '} ${String(r.kn ?? '').padStart(6)}  図面に ${cnt.get(r.s) || 0}  ${r.name}`);
  console.log(`  記号の字の大きさ ${found.size} / 塗る ${found.marks.length} / 大きさが違うので除いた ${found.otherSize} / リストにない記号 ${found.unknown.length}${found.unknown.length ? '（' + found.unknown.map((g) => g.s).join('') + '）' : ''}`);
}
if (walls) {
  const cnt = countByKey(walls.marks);
  console.log(`壁の表: ${walls.legend.page + 1}ページ「${walls.legend.title}」 ${walls.legend.rows.length}行`);
  for (const r of walls.legend.rows) console.log(`  ${r.struck ? '[斜線]' : '      '} ${String(r.rate ?? '').padStart(5)}  図面に ${cnt.get(r.key) || 0}  ${r.label}`);
}
const byPage = {};
for (const g of found?.marks || []) byPage[g.page + 1] = (byPage[g.page + 1] || '') + 'k';
for (const m of walls?.marks || []) byPage[m.page + 1] = (byPage[m.page + 1] || '') + 'w';
console.log('ページごと（金物/壁）', Object.fromEntries(Object.entries(byPage).map(([p, s]) => [p, `${(s.match(/k/g) || []).length}/${(s.match(/w/g) || []).length}`])));
if (out) {
  const colors = { ...(legend ? defaultColors(legend.rows) : {}), ...(walls ? defaultColors(walls.legend.rows, {}, WALL_ORDER) : {}) };
  const paint = [...(legend ? buildPaint(legend, found.marks, colors) : []), ...(walls ? buildWallPaint(walls.legend, walls.marks, colors, colorHex) : [])];
  writeFileSync(out, await paintPdf(PDFLib, bytes, paint));
  console.log('書き出し:', out);
}
