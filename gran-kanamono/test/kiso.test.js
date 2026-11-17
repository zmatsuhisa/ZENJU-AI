// 基礎図面（基礎伏図・基礎リスト）の着色のテスト（架空のデータ。お客様の図面は使わない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGlyph } from '../public/js/core.js';
import { mergeWords, findKisoLegend, findKisoMarks, findKisoList, kisoRows, buildKisoPaint, kisoKey, fgColor, defaultSlab } from '../public/js/kiso.js';

// 横書きの字（1行分）
const H = (str, x, y, size = 6) => toGlyph({ str, transform: [size, 0, 0, size, x, y], width: size * [...str].length * 0.6 });
// 縦書きの字（1字ずつ、下から上へ）
const V = (str, x, y, size = 4.8) => [...str].map((ch, i) => toGlyph({ str: ch, transform: [0, size, -size, 0, x, y + i * size], width: size }));
const hex = (id) => ({ red: '#f00', orange: '#f90', pink: '#f9c', sky: '#3cf', green: '#4c5', lime: '#bf3', purple: '#b7f' }[id] || null);

test('1字ずつの縦書き（開口補強b・W600）を単語にまとめる', () => {
  const words = mergeWords([...V('開口補強b', 100, 200), ...V('W600', 80, 200), H('W600', 300, 300)]);
  const s = words.map((w) => w.s).sort();
  assert.deepEqual(s, ['W600', 'W600', '開口補強b']);
  const v = words.find((w) => w.s === '開口補強b');
  assert.ok(v.vertical && v.box.y1 - v.box.y0 > v.box.x1 - v.box.x0);
});

// 架空の凡例：符号・仕様の表（横線で行を分ける）。20kN の行に斜線、下に「●備考」の表
function legendPage() {
  const X0 = 900, X1 = 1100;
  const g = [H('●凡例', X0, 800, 8), H('符号', X0 + 30, 780, 8), H('仕様', X0 + 120, 780, 8)];
  const segs = [];
  const ys = [790, 770, 750, 730, 710, 690, 650, 630, 610];
  for (const y of ys) segs.push([X0, y, X1, y]);
  const rows = [['', 'アンカーボルトM12'], ['15kN', 'ホールダウン15kN用'], ['20kN', 'ホールダウン20kN用'], ['Hi-28', '高耐力ホールダウンHi'], ['W600', '人通口']];
  rows.forEach(([sym, spec], i) => {
    const cy = (ys[i + 1] + ys[i + 2]) / 2 - 2;
    if (sym) g.push(H(sym, X0 + 32, cy, 6));
    g.push(H(spec, X0 + 110, cy, 8));
  });
  segs.push([X0 + 5, 711, X1 - 5, 729]); // 20kN の行の斜線（ys[3]〜ys[4] の間）
  g.push(H('●備考', X0, 640, 8));
  // 図面の斜めのハッチ線（表の外。斜線と間違えないこと）
  segs.push([100, 700, 300, 760]);
  return { g, segs };
}

test('凡例の表：ホールダウン・人通口の行と、斜線（使わない）を読む。●備考で終わる', () => {
  const { g, segs } = legendPage();
  const lg = findKisoLegend(g, segs, 0);
  assert.ok(lg);
  const kinds = lg.rows.map((r) => `${r.kind}:${r.code}:${r.struck ? 'x' : 'o'}`);
  assert.deepEqual(kinds, ['other::o', 'hd:15kN:o', 'hd:20kN:x', 'hd:Hi28:o', 'w:W:o']);
});

test('図面の記号：ホールダウン・人通口・開口補強・梁符号・スラブ（S200 以外）・独立基礎を拾い、凡例の中は拾わない', () => {
  const { g, segs } = legendPage();
  const plan = [H('15kN', 200, 500, 4.7), H('15kN', 260, 400, 4.7), H('20kN', 300, 300, 4.7), H('W600', 220, 450, 5.4), ...V('W600', 150, 300),
    ...V('開口補強b', 180, 320), H('FG1', 400, 600, 5.4), H('FG5', 420, 500, 5.4), H('FG3', 430, 520, 5.4), H('S200', 500, 400, 5.4), H('S150', 520, 380, 5.4),
    H('独立柱所のみGL+280', 600, 300, 7), H('※特記なき基礎はFG3、スラブはS200とする。', 300, 80, 6.5)];
  const words = mergeWords([...g, ...plan]);
  assert.equal(defaultSlab(words), 'S200');
  const lg = findKisoLegend(g, segs, 0);
  const marks = findKisoMarks(words, lg);
  const count = (key) => marks.filter((m) => m.key === key).length;
  assert.equal(count(kisoKey('hd', '15kN')), 2);
  assert.equal(count(kisoKey('hd', '20kN')), 1);
  assert.equal(count(kisoKey('w', 'W')), 2);
  assert.equal(count(kisoKey('kaiko', 'b')), 1);
  assert.equal(count(kisoKey('fg', 'FG1')), 1);
  assert.equal(count(kisoKey('slab', 'S150')), 1);
  assert.equal(count(kisoKey('slab', 'S200')), 0); // ふつうのスラブは塗らない
  assert.equal(count(kisoKey('dok', 'F')), 1);
  assert.ok(marks.every((m) => m.cx < 900)); // 凡例の中の 15kN・W600 は拾わない

  const rows = kisoRows(lg, marks, null);
  const r15 = rows.find((r) => r.key === kisoKey('hd', '15kN'));
  assert.equal(r15.n, 2); assert.equal(r15.def, 'red');
  assert.equal(rows.find((r) => r.key === kisoKey('hd', '20kN')).struck, true);
  assert.equal(rows.find((r) => r.key === kisoKey('fg', 'FG3')).def, 'none');

  const colors = Object.fromEntries(rows.map((r) => [r.key, r.struck ? 'none' : r.def]));
  const paint = buildKisoPaint({ legend: lg, marks, list: null }, colors, hex);
  // ホールダウンに番号 1・2、凡例の行に ×2（15kN）・×0（Hi-28：凡例では使うのに図面にない）・×2（人通口）
  const labels = paint.filter((p) => p.kind === 'label').map((p) => p.text).sort();
  assert.deepEqual(labels, ['1', '2', '×0', '×2', '×2']);
  // 斜線の 20kN が図面にある → 赤い輪
  assert.equal(paint.filter((p) => p.kind === 'warn').length, 1);
});

test('梁符号のはじめの色（FG1 水色・FG4 だいだい・FG5 桃・FG3 塗らない）', () => {
  assert.equal(fgColor('FG1'), 'sky');
  assert.equal(fgColor('FG1A'), 'sky');
  assert.equal(fgColor('FG4A'), 'orange');
  assert.equal(fgColor('FG5'), 'pink');
  assert.equal(fgColor('FG3'), 'none');
});

test('基礎リスト：×が描かれた断面は使わない。鉄筋の本数はいちばん近い見出しの断面に属させる', () => {
  const g = [H('基礎部材リスト', 50, 800, 8), H('FG1', 150, 780, 8), H('FG2', 450, 780, 8), H('S200', 150, 480, 8),
    H('FG1:2-D13', 120, 700, 5), H('FG2：2-D13', 430, 700, 5), H('2-D16', 140, 600, 5)];
  const segs = [[380, 770, 560, 520], [560, 770, 380, 520]]; // FG2 の断面に×
  const list = findKisoList(mergeWords(g), segs, 0);
  assert.ok(list);
  assert.deepEqual(list.panels.map((p) => `${p.code}${p.unused ? '×' : ''}`).sort(), ['FG1', 'FG2×', 'S200']);
  const rb = Object.fromEntries(list.rebars.map((r) => [r.s, r.panel?.code]));
  assert.equal(rb['FG1:2-D13'], 'FG1');
  assert.equal(rb['FG2：2-D13'], 'FG2');
  assert.equal(rb['2-D16'], 'FG1');
  const rows = kisoRows(null, [], list);
  assert.equal(rows.find((r) => r.key === kisoKey('fg', 'FG2')).struck, true);
  const colors = { [kisoKey('fg', 'FG1')]: 'sky', [kisoKey('fg', 'FG2')]: 'green', [kisoKey('slab', 'S200')]: 'pink', [kisoKey('rebar', '')]: 'red' };
  const paint = buildKisoPaint({ legend: null, marks: [], list }, colors, hex);
  assert.equal(paint.filter((p) => p.kind === 'mark').length, 2); // FG1・S200（×の FG2 は塗らない）
  assert.equal(paint.filter((p) => p.kind === 'ring').length, 2); // ×の断面の鉄筋は輪を付けない
});
