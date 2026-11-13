// npm install のあと、画面で使うライブラリを public/vendor にコピーする（外部の配信元に頼らない＝図面を社外に出さない）
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'vendor');
mkdirSync(out, { recursive: true });
const files = [
  ['node_modules/pdfjs-dist/legacy/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['node_modules/pdf-lib/dist/pdf-lib.esm.min.js', 'pdf-lib.esm.min.js'],
];
for (const [src, dst] of files) {
  const p = join(root, src);
  if (!existsSync(p)) { console.warn('見つかりません:', src); continue; }
  cpSync(p, join(out, dst));
}
// 日本語PDFの文字を正しく読むための文字対応表
for (const d of ['cmaps', 'standard_fonts']) {
  const p = join(root, 'node_modules/pdfjs-dist', d);
  if (existsSync(p)) cpSync(p, join(out, d), { recursive: true });
}
console.log('vendor を用意しました');
