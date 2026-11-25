// npm install のあと、画面で使うライブラリを public/vendor にコピーする（外部CDNに頼らない＝社外に資料を出さない）
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'vendor');
mkdirSync(out, { recursive: true });
const files = [
  ['node_modules/pdfjs-dist/legacy/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['node_modules/xlsx/xlsx.mjs', 'xlsx.mjs'],
  // 書き込みの洗い出し（画像処理）。使うときだけ読み込む
  ['node_modules/@techstark/opencv-js/dist/opencv.js', 'opencv.js'],
];
for (const [src, dst] of files) {
  const p = join(root, src);
  if (!existsSync(p)) { console.warn('見つかりません:', src); continue; }
  cpSync(p, join(out, dst));
}
// 日本語PDFの文字を正しく読むための文字対応表
const cmaps = join(root, 'node_modules/pdfjs-dist/cmaps');
if (existsSync(cmaps)) cpSync(cmaps, join(out, 'cmaps'), { recursive: true });
const fonts = join(root, 'node_modules/pdfjs-dist/standard_fonts');
if (existsSync(fonts)) cpSync(fonts, join(out, 'standard_fonts'), { recursive: true });
console.log('vendor を用意しました');
