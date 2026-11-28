// 架空ベンチ（make_bench.py で作った物件）で、資料間の照合と新旧比較を採点する。
//   node research/bench/score.mjs <ベンチのフォルダ> [-v]
// 照合：仕込んだ食い違いをいくつ見つけたか（見つけた数）と、仕込んでいない指摘をいくつ出したか（余計な指摘）
// 新旧比較：仕込んだ変更をいくつ拾ったか と 余計な変更
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as XLSX from 'xlsx';
import { readPdf, readXlsx } from '../../public/js/core/readers.js';
import { diffPdf, diffXlsx } from '../../public/js/core/diff.js';
import { crossCheck, guessRole } from '../../public/js/core/check.js';
import { norm, keyOf } from '../../public/js/core/normalize.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NM = join(root, 'node_modules', 'pdfjs-dist') + '/';
const OPTS = { cMapUrl: NM + 'cmaps/', cMapPacked: true, standardFontDataUrl: NM + 'standard_fonts/', verbosity: 0 };
const dir = process.argv[2];
const verbose = process.argv.includes('-v');
if (!dir) { console.error('使い方: node research/bench/score.mjs <ベンチのフォルダ> [-v]'); process.exit(1); }
const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8'));

const load = async p => (/\.pdf$/i.test(p) ? readPdf(pdfjs, new Uint8Array(readFileSync(p)), OPTS) : readXlsx(XLSX, readFileSync(p)));

const tot = { cross: { truth: 0, hit: 0, fp: 0, dup: 0 }, pdf: { truth: 0, hit: 0, fp: 0 }, xlsx: { truth: 0, hit: 0, fp: 0 } };
const byCat = {};
const missLog = [], fpLog = [];

for (const c of truth) {
  const p = join(dir, c.id);
  // ---- 資料間の照合 ----
  const docs = [];
  for (const name of c.docs) { const data = await load(join(p, name)); docs.push({ name, data, role: guessRole(name, data.kind) }); }
  const { findings } = crossCheck(docs);
  const matched = new Array(c.cross.length).fill(false);
  for (const f of findings) {
    const i = c.cross.findIndex(t => matchCross(t, f));
    if (i < 0) { tot.cross.fp++; fpLog.push(`${c.id} 照合 ${f.category} ${f.title} ／ ${f.message}`); continue; }
    if (matched[i]) { tot.cross.dup++; continue; }
    matched[i] = true;
  }
  c.cross.forEach((t, i) => {
    const b = (byCat[t.cat] ||= { truth: 0, hit: 0 });
    b.truth++; tot.cross.truth++;
    if (matched[i]) { b.hit++; tot.cross.hit++; } else missLog.push(`${c.id} 照合 見落とし ${t.cat} ${t.key}${t.missing ? '（' + t.missing + 'にない）' : ''}  [${c.style.tategu_fmt}/${c.style.size_style}${c.style.qty_text ? '/数量は文字' : ''}${c.style.est_code_in_name ? '/見積は品名に品番' : ''}]`);
  });

  // ---- 新旧比較（PDF）----
  const d = diffPdf(await load(join(p, '平面図_旧.pdf')), await load(join(p, '平面図_新.pdf')));
  scoreList(c.id, 'PDF', d, c.diffPdf, (t, x) => x.type === t.type && (t.type === 'added' ? norm(x.after) === norm(t.after) : t.type === 'removed' ? norm(x.before) === norm(t.before) : norm(x.before) === norm(t.before) && norm(x.after) === norm(t.after)), tot.pdf,
    x => `${x.type} 「${x.before}」→「${x.after}」`);

  // ---- 新旧比較（Excel）----
  const e = diffXlsx(await load(join(p, '見積_旧.xlsx')), await load(join(p, '見積_新.xlsx')));
  const rowHas = (x, k) => keyOf(x.row || '').includes(keyOf(k)) || keyOf(x.before || x.after || '').includes(keyOf(k));
  // 数量が変わった行の「金額」の変化は、同じ変更の続きとして数えない（余計にも数えない）
  const follow = x => x.type === 'changed' && c.diffXlsx.some(t => t.type === 'changed' && rowHas(x, t.key));
  scoreList(c.id, 'Excel', e.filter(x => !(follow(x) && !/数量/.test(x.col))), c.diffXlsx,
    (t, x) => x.type === t.type && rowHas(x, t.key) && (!t.col || (x.col || '').includes(t.col)), tot.xlsx,
    x => `${x.type} ${x.row || ''} ${x.col || ''} 「${x.before}」→「${x.after}」`);
}

function matchCross(t, f) {
  if (f.category !== t.cat) return false;
  if (t.cat === '品番') {
    const pair = f.obs.map(o => keyOf(o.value)).sort().join('|');
    return pair === t.key.split('|').map(keyOf).sort().join('|');
  }
  if (keyOf(f.key) !== keyOf(t.key)) return false;
  if (t.cat === '記載漏れ') return f.obs.some(o => o.value === '該当なし' && o.doc.includes(t.missing));
  return true;
}

function scoreList(id, label, got, want, eq, acc, show) {
  const used = new Array(want.length).fill(false);
  for (const x of got) {
    const i = want.findIndex((t, k) => !used[k] && eq(t, x));
    if (i < 0) { acc.fp++; fpLog.push(`${id} 新旧${label} 余計 ${show(x)}`); } else used[i] = true;
  }
  want.forEach((t, i) => { acc.truth++; if (used[i]) acc.hit++; else missLog.push(`${id} 新旧${label} 見落とし ${JSON.stringify(t)}`); });
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 100) + '%';
console.log(`物件 ${truth.length}`);
console.log(`資料間の照合：見つけた ${tot.cross.hit}/${tot.cross.truth}（${pct(tot.cross.hit, tot.cross.truth)}）・余計な指摘 ${tot.cross.fp}・同じ指摘の重複 ${tot.cross.dup}`);
for (const [k, b] of Object.entries(byCat)) console.log(`  ${k}：${b.hit}/${b.truth}`);
console.log(`新旧比較 PDF：拾った ${tot.pdf.hit}/${tot.pdf.truth}（${pct(tot.pdf.hit, tot.pdf.truth)}）・余計 ${tot.pdf.fp}`);
console.log(`新旧比較 Excel：拾った ${tot.xlsx.hit}/${tot.xlsx.truth}（${pct(tot.xlsx.hit, tot.xlsx.truth)}）・余計 ${tot.xlsx.fp}`);
if (verbose) { console.log('\n--- 見落とし ---'); missLog.forEach(s => console.log(s)); console.log('\n--- 余計 ---'); fpLog.forEach(s => console.log(s)); }
