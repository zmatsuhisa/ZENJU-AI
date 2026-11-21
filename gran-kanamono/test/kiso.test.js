// 基礎図面（基礎伏図・基礎リスト）の着色のテスト（架空のデータ。お客様の図面は使わない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGlyph } from '../public/js/core.js';
import { mergeWords, findKisoLegend, findKisoMarks, findKisoList, kisoRows, buildKisoPaint, kisoKey, fgColor, hdColor, defaultSlab } from '../public/js/kiso.js';

// 横書きの字（1行分）
const H = (str, x, y, size = 6) => toGlyph({ str, transform: [size, 0, 0, size, x, y], width: size * [...str].length * 0.6 });
// 縦書きの字（1字ずつ、下から上へ）
const V = (str, x, y, size = 4.8) => [...str].map((ch, i) => toGlyph({ str: ch, transform: [0, size, -size, 0, x, y + i * size], width: size }));
const hex = (id) => ({ yellow: '#ff0', brown: '#c85', blue: '#47f', red: '#f00', orange: '#f90', pink: '#f9c', sky: '#3cf', green: '#4c5', lime: '#bf3', purple: '#b7f' }[id] || null);

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
  assert.equal(r15.n, 2); assert.equal(r15.def, 'green');
  assert.equal(rows.find((r) => r.key === kisoKey('hd', '20kN')).struck, true);
  assert.equal(rows.find((r) => r.key === kisoKey('fg', 'FG3')).def, 'yellow');

  const colors = Object.fromEntries(rows.map((r) => [r.key, r.struck ? 'none' : r.def]));
  const paint = buildKisoPaint({ legend: lg, marks, list: null }, colors, hex);
  // ホールダウンに番号 1・2、凡例の行に ×2（15kN）・×0（Hi-28：凡例では使うのに図面にない）・×2（人通口）
  const labels = paint.filter((p) => p.kind === 'label').map((p) => p.text).sort();
  assert.deepEqual(labels, ['1', '2', '×0', '×2', '×2']);
  // 斜線の 20kN が図面にある → 赤い輪
  assert.equal(paint.filter((p) => p.kind === 'warn').length, 1);
});

test('梁符号・ホールダウンのはじめの色（FG1 桃・FG2 水色・FG3 黄・FG4 黄緑、15kN 緑・20kN 黄・Hi 桃）', () => {
  assert.equal(fgColor('FG1'), 'pink');
  assert.equal(fgColor('FG1A'), 'pink');
  assert.equal(fgColor('FG2B'), 'sky');
  assert.equal(fgColor('FG3'), 'yellow');
  assert.equal(fgColor('FG4A'), 'lime');
  assert.equal(hdColor('15kN'), 'green');
  assert.equal(hdColor('20kN'), 'yellow');
  assert.equal(hdColor('Hi28'), 'pink');
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

test('外周の基礎：平行な2本の線の壁だけで建物の外まわりを求め、寸法線・三角の記号は含めない', async () => {
  const { findOuterBand, wallLines } = await import('../public/js/kiso.js');
  const segs = [];
  // L 字の建物：外の線と、7pt 内側の線（壁の厚み）。柱の四角で線がところどころ切れている
  const outer = [[100, 100], [400, 100], [400, 250], [250, 250], [250, 350], [100, 350]];
  const inner = [[107, 107], [393, 107], [393, 243], [243, 243], [243, 343], [107, 343]];
  for (const poly of [outer, inner]) for (let i = 0; i < poly.length; i++) {
    const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
    segs.push([...a, ...b]);
  }
  segs.push([420, 100, 420, 250]);              // 寸法線（1本だけ）
  segs.push([100, 180, 90, 175], [90, 175, 90, 185], [90, 185, 100, 180]); // 左の壁の外に付いた三角（耐力壁の印）
  const kept = wallLines(segs, { x0: 0, x1: 500, y0: 0, y1: 500 });
  assert.ok(!kept.some((s) => s[0] === 420), '寸法線は壁ではない');
  const pts = [[150, 150], [300, 200], [180, 300], [200, 120]];
  // 壁の外にくっついた小さな四角（文字の枠など。幅 7pt）は外周の角に入れない
  segs.push([250, 350, 250, 357], [250, 357, 265, 357], [265, 357, 265, 350]);
  const ol = findOuterBand(segs, pts, { thick: 6 });
  assert.ok(ol);
  // L 字の外周は角 6 つ（地縄寸法図と同じく角だけの多角形）
  assert.equal(ol.corners.length, 6);
  const xs = ol.corners.map((p) => p[0]), ys = ol.corners.map((p) => p[1]);
  assert.ok(Math.min(...xs) > 98 && Math.max(...xs) < 402, `角の x ${Math.min(...xs)}〜${Math.max(...xs)}`);
  assert.ok(Math.min(...ys) > 98 && Math.max(...ys) < 352, `角の y ${Math.min(...ys)}〜${Math.max(...ys)}`);
  // 帯の中心線は外の縁から 3pt 内側
  assert.equal(ol.path.length, 6);
  assert.ok(Math.abs(Math.min(...ol.path.map((p) => p[0])) - 103) < 1.6);
});

test('外周の角を通り芯に合わせる（地縄寸法図と同じく芯で角を出す）。通り芯に乗らない小さな凸凹は消える', async () => {
  const { snapToGrid, gridLines } = await import('../public/js/kiso.js');
  // 通り芯：x=100・400、y=100・300（点線）
  const dashes = [];
  for (const x of [100, 400]) for (let y = 50; y < 350; y += 4) dashes.push([x, y, x, y + 2]);
  for (const y of [100, 300]) for (let x = 50; x < 450; x += 4) dashes.push([x, y, x + 2, y]);
  const grid = gridLines(dashes);
  assert.deepEqual(grid.xs, [100, 400]);
  assert.deepEqual(grid.ys, [100, 300]);
  // 壁の外の縁（芯から 3pt 外）に、左の壁の外側へ 5pt の小さな凸凹がある（左回り）
  const face = [[97, 97], [403, 97], [403, 303], [97, 303], [97, 220], [92, 220], [92, 200], [97, 200]];
  const pts = snapToGrid(face, grid, 3, 8);
  assert.deepEqual(pts.map((p) => p.join(',')).sort(), ['100,100', '100,300', '400,100', '400,300']);
});

test('空きスパン：通り芯の上の立上りどうしの間を、寸法の数字（なければ縮尺）で mm にする', async () => {
  const { wallsOnGrid, findSpans, gridMm, mmPerPt } = await import('../public/js/kiso.js');
  // 通り芯 x=100・137・211、y=100・174（1pt＝24.6mm ほど。910・1820 の寸法の数字がある）
  const grid = { xs: [100, 137, 211], ys: [100, 174] };
  const words = mergeWords([H('910', 118.5 - 5.4, 60), H('1820', 174 - 7.2, 60), H('基礎伏図 S:1/70', 300, 40)]);
  const mp = mmPerPt(words);
  assert.ok(Math.abs(mp - 24.69) < 0.01);
  const pos = gridMm(grid, words, mp);
  assert.equal(pos.x.get(211), 2730);
  // 立上り（平行な2本の線、通り芯から ±3pt）：外まわりの4辺と、x=137 の縦の壁
  const segs = [];
  const wall = (x0, y0, x1, y1) => {
    if (y0 === y1) segs.push([x0, y0 - 3, x1, y0 - 3], [x0, y0 + 3, x1, y0 + 3]);
    else segs.push([x0 - 3, y0, x0 - 3, y1], [x0 + 3, y0, x0 + 3, y1]);
  };
  wall(100, 100, 211, 100); wall(100, 174, 211, 174); wall(100, 100, 100, 174); wall(211, 100, 211, 174); wall(137, 100, 137, 174);
  const w = wallsOnGrid(segs, grid, { x0: 97, x1: 214, y0: 97, y1: 177 });
  assert.equal(w.V.length, 3); assert.equal(w.H.length, 2);
  const sp = findSpans(w, mp, { pos });
  assert.deepEqual(sp.filter((s) => s.dir === 'x').map((s) => s.mm).sort((a, b) => a - b), [910, 1820]);
  assert.equal(sp.filter((s) => s.dir === 'x').length, 2); // 上と下の壁で同じスパンは1回だけ
});
