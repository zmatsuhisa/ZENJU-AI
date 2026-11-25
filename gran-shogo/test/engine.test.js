// 照合エンジンのテスト。samples/ の架空資料（make_samples.py で作成）に仕込んだ食い違いを検出できるか。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as XLSX from 'xlsx';
import { readPdf, readXlsx } from '../public/js/core/readers.js';
import { diffPdf, diffXlsx } from '../public/js/core/diff.js';
import { crossCheck, guessRole, findCodes, parseSize, parseQty } from '../public/js/core/check.js';
import { norm, keyOf } from '../public/js/core/normalize.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = join(root, 'samples');
const NM = join(root, 'node_modules', 'pdfjs-dist') + '/';
const pdf = f => readPdf(pdfjs, new Uint8Array(readFileSync(join(S, f))), { cMapUrl: NM + 'cmaps/', cMapPacked: true, standardFontDataUrl: NM + 'standard_fonts/', verbosity: 0 });
const xl = f => readXlsx(XLSX, readFileSync(join(S, f)));

test('文字のゆれをそろえる', () => {
  assert.equal(norm('ＡＷ－１　Ｗ１６５０×Ｈ１１００'), 'AW-1 W1650xH1100');
  assert.equal(keyOf('aw-1'), keyOf('AW1'));
});

test('記号・寸法・数量の拾い出し', () => {
  assert.deepEqual(findCodes('AW1 W1650xH1100 1F S=1/100 A1635 DL-1'), ['AW1', 'DL-1']);
  assert.deepEqual(parseSize('W1650xH1100'), { w: 1650, h: 1100 });
  assert.deepEqual(parseSize('1650×2000'), { w: 1650, h: 2000 });
  assert.deepEqual(parseQty('ダウンライト 3台'), { qty: 3, unit: '台' });
});

test('資料の種類を名前から推定', () => {
  assert.equal(guessRole('御見積書_第2版.xlsx', 'excel'), 'estimate');
  assert.equal(guessRole('建具表.pdf', 'pdf'), 'table');
  assert.equal(guessRole('1F平面図.pdf', 'pdf'), 'drawing');
});

const ready = existsSync(join(S, '平面図_新.pdf'));

test('図面の新旧比較：同じ場所の文字の変更・追加を拾う', { skip: !ready }, async () => {
  const d = diffPdf(await pdf('平面図_旧.pdf'), await pdf('平面図_新.pdf'));
  const changed = d.filter(x => x.type === 'changed').map(x => `${x.before}>${x.after}`);
  assert.ok(changed.includes('W1600xH1100>W1650xH1100'));
  assert.ok(d.some(x => x.type === 'added' && x.after === '収納'));
  assert.ok(d.some(x => x.type === 'moved' && x.after === 'WD1'));
});

test('見積の新旧比較：品番が変わった行・数式・行の追加削除', { skip: !ready }, () => {
  const d = diffXlsx(xl('見積_旧.xlsx'), xl('見積_新.xlsx'));
  assert.ok(d.some(x => x.type === 'changed' && x.col === '品番' && x.before === 'AA-101' && x.after === 'AA-102'));
  assert.ok(d.some(x => x.type === 'changed' && x.col === '数量' && x.before === '45' && x.after === '48'));
  assert.ok(d.some(x => x.formula && x.formula.after.startsWith('=ROUNDDOWN')));
  assert.ok(d.some(x => x.type === 'removed' && x.row === 'CL-9'));
  assert.ok(d.some(x => x.type === 'added' && x.row === 'HB-1'));
  // 行がずれても、ずれただけの行は差分にしない
  assert.ok(!d.some(x => x.row === 'WD1'));
});

test('資料間の照合：調査メモの4つの例をすべて検出', { skip: !ready }, async () => {
  const docs = [['平面図_新.pdf', await pdf('平面図_新.pdf')], ['建具表.xlsx', xl('建具表.xlsx')], ['仕上表.xlsx', xl('仕上表.xlsx')], ['見積_新.xlsx', xl('見積_新.xlsx')]]
    .map(([name, data]) => ({ name, data, role: guessRole(name, data.kind) }));
  const { findings } = crossCheck(docs);
  const t = findings.map(f => `${f.category}:${f.key}:${f.message}`);
  assert.ok(t.some(s => s.startsWith('寸法:AW1') && s.includes('W1650') && s.includes('W1600')), '窓寸法');
  assert.ok(t.some(s => s.startsWith('品番:') && s.includes('AA-101') && s.includes('AA-102')), '床材品番');
  assert.ok(t.some(s => s.startsWith('記載漏れ:PL-1') && s.includes('見積')), '照明の見積漏れ');
  assert.ok(t.some(s => s.startsWith('数量:DL-1') && s.includes('3台') && s.includes('2台')), '設備数量');
  // 合っているものは出さない
  assert.ok(!t.some(s => s.includes('WD1')), '建具WD1は図面3か所・建具表3・見積3で一致');
  // どの指摘にも根拠（資料名と場所）がある
  for (const f of findings) for (const o of f.obs) assert.ok(o.doc && o.loc, f.title);
});
