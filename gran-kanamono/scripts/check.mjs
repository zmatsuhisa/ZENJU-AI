// 実物の図面で、見つけたリスト・記号の数を表示し、色をつけた PDF を書き出す（画面を使わない確認用）
// 使い方: node scripts/check.mjs <図面.pdf> [書き出し先.pdf]
// 図面はリポジトリに入れないこと（DATA などリポジトリの外のフォルダに置く）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as PDFLib from 'pdf-lib';
import { analyze } from '../public/js/pdfread.js';
import { countBySymbol, defaultColors, buildPaint } from '../public/js/core.js';
import { paintPdf } from '../public/js/paint.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [src, out] = process.argv.slice(2);
if (!src) { console.error('使い方: node scripts/check.mjs <図面.pdf> [書き出し先.pdf]'); process.exit(1); }
const bytes = readFileSync(src);
const doc = await pdfjs.getDocument({
  data: new Uint8Array(bytes), cMapUrl: join(root, 'node_modules/pdfjs-dist/cmaps/'), cMapPacked: true,
  standardFontDataUrl: join(root, 'node_modules/pdfjs-dist/standard_fonts/'), verbosity: 0,
}).promise;
const { legend, found } = await analyze(pdfjs, doc);
if (!legend) { console.log('金物リストが見つかりません'); process.exit(2); }
const cnt = countBySymbol(found.marks);
console.log(`リスト: ${legend.page + 1}ページ「${legend.title}」 ${legend.rows.length}行`);
for (const r of legend.rows) console.log(`  ${r.no.padStart(2)} ${r.s} ${r.struck ? '[斜線]' : '      '} ${String(r.kn ?? '').padStart(6)}  図面に ${cnt.get(r.s) || 0}  ${r.name}`);
console.log(`記号の字の大きさ ${found.size} / 塗る ${found.marks.length} / 大きさが違うので除いた ${found.otherSize} / リストにない記号 ${found.unknown.length}${found.unknown.length ? '（' + found.unknown.map((g) => g.s).join('') + '）' : ''}`);
const byPage = {};
for (const g of found.marks) byPage[g.page + 1] = (byPage[g.page + 1] || 0) + 1;
console.log('ページごと', byPage);
if (out) {
  const colors = defaultColors(legend.rows);
  writeFileSync(out, await paintPdf(PDFLib, bytes, buildPaint(legend, found.marks, colors)));
  console.log('書き出し:', out);
}
