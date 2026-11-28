// 資料間の照合の作り直し（2026-11）で足した見分け方のテスト。図面は使わず、文字の位置だけで作る。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossCheck, findCodes, pdfTables, extractPdf } from '../public/js/core/check.js';
import { diffPdf } from '../public/js/core/diff.js';
import { sheetLayout } from '../public/js/core/diff.js';

const C = (text, x, y, h = 10) => ({ text, x, y, w: text.length * h * 0.6, h });
const pdf = (...pages) => ({ kind: 'pdf', pages: pages.map((chunks, i) => ({ page: i + 1, width: 1190, height: 842, chunks })) });
const cell = v => ({ v, f: '' });
const xlsx = rows => ({ kind: 'excel', sheets: [{ name: 'S', rows: rows.map(r => r.map(v => cell(v ?? ''))) }] });

test('通り芯（X1・Y2）と図番（図番 A-03）は記号にしない。FL-1 は記号、FL-50 は高さ', () => {
  assert.deepEqual(findCodes('X1'), []);
  assert.deepEqual(findCodes('Y12'), []);
  assert.deepEqual(findCodes('図番 A-03'), []);
  assert.deepEqual(findCodes('FL-1'), ['FL-1']);
  assert.deepEqual(findCodes('FL-50'), []);
});

test('注記の中の記号（※AW1～AW3は…）は図面の数に入れない', () => {
  const d = pdf([C('AW1', 100, 100), C('AW1', 300, 100), C('※AW1～AW3は防火設備とする', 100, 600)]);
  const aw1 = extractPdf(d, '平面図.pdf', 'drawing').find(o => o.key === 'AW1');
  assert.equal(aw1.drawnCount, 2);
});

test('PDF の表：行が記号の表と、列が記号の表（縦横が逆）から寸法と数量を読む', () => {
  const rows = [C('記号', 60, 80), C('名称', 140, 80), C('W', 420, 80), C('H', 500, 80), C('数量', 580, 80),
    C('AW1', 60, 105), C('引違い窓', 140, 105), C('1,650', 420, 105), C('1100', 500, 105), C('2ヶ所', 580, 105)];
  assert.deepEqual(pdfTables(rows).get(5), { code: 'AW1', name: '引違い窓', w: 1650, h: 1100, qty: 2, unit: 'ヶ所' });
  const cols = [C('記号', 60, 80), C('W', 60, 106), C('H', 60, 132), C('数量', 60, 158),
    C('AW1', 150, 80), C('AW2', 290, 80), C('1,650', 150, 106), C('780', 290, 106), C('1,100', 150, 132), C('970', 290, 132), C('2', 150, 158), C('1', 290, 158)];
  const t = pdfTables(cols);
  assert.deepEqual([t.get(4), t.get(5)].map(r => [r.code, r.w, r.h, r.qty]), [['AW1', 1650, 1100, 2], ['AW2', 780, 970, 1]]);
});

test('Excel の2段の見出し（寸法の下に W・H）と、「3ヶ所」の文字の数量', () => {
  const sh = xlsx([['建具表'], [], ['符号', '品名', '寸法', null, '箇所数'], [null, null, 'W', 'H', null], ['AW1', '窓', 1650, 1100, '3ヶ所']]);
  const lay = sheetLayout(sh.sheets[0]);
  assert.equal(lay.start, 4);
  assert.deepEqual(lay.header.slice(0, 5), ['符号', '品名', 'W', 'H', '箇所数']);
  const plan = pdf([C('AW1', 100, 100), C('W1600xH1100', 96, 111, 8), C('AW1', 300, 100), C('AW1', 500, 100)]);
  const { findings } = crossCheck([{ name: '平面図.pdf', role: 'drawing', data: plan }, { name: '建具表.xlsx', role: 'table', data: sh }]);
  assert.deepEqual(findings.map(f => f.category), ['寸法']); // W1600 と W1650。数量は3と3で合う
});

test('1階・2階で図面が分かれていても、合わせた数が表と合えば数量の食い違いにしない。図面どうしの記載漏れも出さない', () => {
  const f1 = pdf([C('AW1', 100, 100), C('AW2', 300, 100)]);
  const f2 = pdf([C('AW1', 100, 100)]);
  const tbl = xlsx([['記号', '名称', '数量'], ['AW1', '窓', 2], ['AW2', '窓', 1]]);
  const { findings } = crossCheck([{ name: '1階.pdf', role: 'drawing', data: f1 }, { name: '2階.pdf', role: 'drawing', data: f2 }, { name: '建具表.xlsx', role: 'table', data: tbl }]);
  assert.deepEqual(findings, []);
});

test('図面と表の両方から見える見積の漏れは1件にまとめる', () => {
  const plan = pdf([C('AW1', 100, 100), C('AW2', 300, 100)]);
  const tbl = xlsx([['記号', '名称', '数量'], ['AW1', '窓', 1], ['AW2', '窓', 1]]);
  const est = xlsx([['品番', '品名', '数量'], ['AW1', '窓', 1]]);
  const { findings } = crossCheck([{ name: '平面図.pdf', role: 'drawing', data: plan }, { name: '建具表.xlsx', role: 'table', data: tbl }, { name: '見積.xlsx', role: 'estimate', data: est }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, '記載漏れ');
  assert.match(findings[0].message, /平面図\.pdf・建具表\.xlsx に記載あり/);
});

test('新旧比較：同じ場所で別の言葉に変わった（洋室2→書斎）ものは「書き換え」', () => {
  const pageOf = chunks => ({ kind: 'pdf', pages: [{ page: 1, width: 1190, height: 842, chunks }] });
  const d = diffPdf(pageOf([C('洋室2', 640, 280, 14), C('LDK', 100, 100, 14)]), pageOf([C('書斎', 640, 280, 14), C('LDK', 100, 100, 14)]));
  assert.deepEqual(d.map(x => [x.type, x.before, x.after]), [['changed', '洋室2', '書斎']]);
});
