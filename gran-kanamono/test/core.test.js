// 金物着色の中心の処理のテスト（架空の図面データ。お客様の図面は使わない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGlyph, findLegend, findMarks, countBySymbol, defaultColors, buildPaint, NONE, PALETTE } from '../public/js/core.js';

// pdf.js の文字1つと同じ形を作る
const T = (str, x, y, size = 6, w = size * [...str].length) => toGlyph({ str, transform: [size, 0, 0, size, x, y], width: w });

// 架空の構造図1ページ：右に金物リスト、左に平面図の記号と通り芯の丸文字
function samplePage() {
  const g = [];
  const X = 600; // リストの左
  g.push(T('●柱脚柱頭金物リスト', X, 500, 8));
  g.push(T('番号', X + 2, 480, 6.5), T('記号', X + 22, 470, 6.5), T('名称', X + 80, 470, 6.5), T('引張', X + 130, 475, 6.5));
  const rows = [['1', '-', '短ほぞ差し', '0.00'], ['2', 'ろ', 'フックコーナー', '3.40'], ['3', 'は', 'フックコーナー', '5.30'],
    ['4', 'に', 'シナコーナー', '7.50'], ['5', 'ち', 'オメガコーナー20kN', '21.70']];
  rows.forEach(([no, s, name, kn], i) => {
    const y = 450 - i * 20;
    g.push(T(no, X + 4, y), T(s, X + 26, y), T(name, X + 60, y, 5), T(kn, X + 130, y, 5));
  });
  g.push(T('※金物については表記数値以上のものを使用する', X, 340, 4));
  g.push(T('●軸組みの種類と壁倍率', X, 320, 8));
  // 平面図：柱の上下に同じ記号（4.4）
  const plan = [['ろ', 100, 400], ['ろ', 100, 392], ['は', 200, 400], ['は', 200, 392], ['ろ', 300, 300], ['ろ', 300, 292], ['に', 120, 200], ['に', 120, 192]];
  for (const [s, x, y] of plan) g.push(T(s, x, y, 4.4));
  // リストの行と同じ高さにある平面図の記号（表の中と間違えないこと）
  g.push(T('は', 450, 430, 4.4), T('は', 450, 422, 4.4));
  // 通り芯の丸文字（大きい。塗らない）
  for (const [s, x] of [['ろ', 100], ['は', 200], ['に', 300]]) g.push(T(s, x, 560, 6.5));
  return g.map((o) => ({ ...o, page: 0 }));
}
// 「ち」の行に引いた斜線（左下→右上）と、表の横線
const segs = [[598, 362, 700, 382], [598, 370, 700, 370]];

test('金物リストの行・名前・引張・斜線を読む', () => {
  const lg = findLegend(samplePage(), segs);
  assert.ok(lg);
  assert.deepEqual(lg.rows.map((r) => r.s), ['ろ', 'は', 'に', 'ち']);
  assert.equal(lg.rows[0].name, 'フックコーナー');
  assert.equal(lg.rows[1].kn, 5.3);
  assert.deepEqual(lg.rows.map((r) => r.struck), [false, false, false, true]);
  assert.equal(lg.rows[0].no, '2');
});

test('表の右下の注記より下は表に入れない', () => {
  const lg = findLegend(samplePage(), segs);
  assert.ok(lg.box.y0 > 340);
});

test('図面の記号だけを拾い、通り芯の丸文字とリストの中の字は除く', () => {
  const pages = [{ glyphs: samplePage() }];
  const lg = findLegend(pages[0].glyphs, segs);
  const f = findMarks(pages, lg);
  assert.equal(f.marks.length, 10);
  assert.equal(f.otherSize, 3);
  const c = countBySymbol(f.marks);
  assert.equal(c.get('ろ'), 4);
  assert.equal(c.get('は'), 4);
  assert.equal(c.get('ち') || 0, 0);
});

test('リストにない記号を知らせる', () => {
  const page = samplePage();
  page.push({ ...T('を', 500, 100, 4.4), page: 0 });
  const lg = findLegend(page, segs);
  const f = findMarks([{ glyphs: page }], lg);
  assert.deepEqual(f.unknown.map((g) => g.s), ['を']);
});

test('リストがない PDF では null を返す', () => {
  assert.equal(findLegend([T('平面図', 10, 10), T('ろ', 50, 50, 4.4)]), null);
});

test('はじめの色：上から別々の色、斜線は塗らない、保存した色を優先', () => {
  const rows = [{ s: 'ろ' }, { s: 'は' }, { s: 'に' }, { s: 'ち', struck: true }];
  const c = defaultColors(rows);
  assert.equal(c['ろ'], PALETTE[0].id);
  assert.equal(new Set([c['ろ'], c['は'], c['に']]).size, 3);
  assert.equal(c['ち'], NONE);
  const c2 = defaultColors(rows, { 'は': 'yellow' });
  assert.equal(c2['は'], 'yellow');
  assert.notEqual(c2['ろ'], 'yellow');
});

test('塗るもの：斜線の金物が図面にあれば赤い輪をつける', () => {
  const page = samplePage();
  page.push({ ...T('ち', 400, 100, 4.4), page: 0 });
  const lg = findLegend(page, segs);
  const f = findMarks([{ glyphs: page }], lg);
  const paint = buildPaint(lg, f.marks, defaultColors(lg.rows));
  assert.equal(paint.filter((p) => p.kind === 'warn').length, 1);
  // 柱の上下に並ぶ同じ記号（5組）は1つの楕円にまとめる。「ち」は塗らない（輪だけ）
  assert.equal(paint.filter((p) => p.kind === 'mark').length, 5);
  assert.ok(paint.filter((p) => p.kind === 'mark').every((p) => p.ry > p.rx));
  assert.equal(paint.filter((p) => p.kind === 'band').length, 3);
});

test('字の中心：横書きと90度回した字', () => {
  const g = toGlyph({ str: 'ろ', transform: [10, 0, 0, 10, 100, 200], width: 10 });
  assert.ok(Math.abs(g.cx - 105) < 1e-9 && Math.abs(g.cy - 203.8) < 1e-9);
  const r = toGlyph({ str: 'ろ', transform: [0, 10, -10, 0, 100, 200], width: 10 });
  assert.ok(Math.abs(r.cx - 96.2) < 1e-9 && Math.abs(r.cy - 205) < 1e-9);
});
