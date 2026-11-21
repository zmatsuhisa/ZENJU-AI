// 金物着色の中心の処理のテスト（架空の図面データ。お客様の図面は使わない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGlyph, findLegend, findMarks, countBySymbol, defaultColors, buildPaint, NONE, PALETTE, ruleColor, omegaFeet, colorHex } from '../public/js/core.js';

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

test('同じ名前の金物は同じ色（半角・全角の違いは同じとみなす）。斜線の行は塗らない', () => {
  const rows = [{ s: 'ろ', name: 'フックコーナー' }, { s: 'は', name: 'フックコーナー' }, { s: 'に', name: 'ｼﾅｺｰﾅｰ' },
    { s: 'ほ', name: 'シナコーナー' }, { s: 'へ', name: 'ｼﾅｺｰﾅｰ' }, { s: 'と', name: 'ｵﾒｶﾞｺｰﾅｰ 15kN' }, { s: 'ち', name: 'ｵﾒｶﾞｺｰﾅｰ 20kN', struck: true }];
  const c = defaultColors(rows);
  assert.equal(c['ろ'], c['は']);
  assert.equal(c['に'], c['ほ']);
  assert.equal(c['に'], c['へ']);
  assert.equal(new Set([c['ろ'], c['に'], c['と']]).size, 3);
  assert.equal(c['ち'], NONE);
});

test('表のすぐ左にある図面の字は表に入れない（色の帯を図面の上まで伸ばさない）', () => {
  const page = samplePage();
  // 「ろ」の行と同じ高さ、表の左 30pt に図面の記号（金物記号の大きさ）
  page.push({ ...T('へ', 570, 432, 4.4), page: 0 }, { ...T('へ', 570, 424, 4.4), page: 0 });
  const lg = findLegend(page, segs);
  assert.ok(lg.box.x0 >= 585, `表の左端 ${lg.box.x0}`);
  const f = findMarks([{ glyphs: page }], lg);
  assert.equal(f.marks.filter((g) => g.x === 570).length, 0); // 「へ」はリストにないので塗らないが、表の字にもしない
  assert.equal(f.unknown.filter((g) => g.x === 570).length, 2);
});

test('現場で決めた色：フック青・シナだいだい・オメガ15緑・20黄・Hi-28桃、ハイパーハード濃い水色・EXハイパー水色', () => {
  const rows = [{ s: 'ろ', name: 'フックコーナー' }, { s: 'に', name: 'ｼﾅｺｰﾅｰ' }, { s: 'と', name: 'ｵﾒｶﾞｺｰﾅｰ 15kN' },
    { s: 'ち', name: 'ｵﾒｶﾞｺｰﾅｰ 20kN' }, { s: 'り', name: 'ﾋﾞｽ止めﾎｰﾙﾀﾞｳﾝ Hi-28' }, { s: 'ぬ', name: 'ﾋﾞｽ止めﾎｰﾙﾀﾞｳﾝ Hi-43' }];
  const c = defaultColors(rows);
  assert.deepEqual([c['ろ'], c['に'], c['と'], c['ち'], c['り']], ['blue', 'orange', 'green', 'yellow', 'pink']);
  assert.ok(!['blue', 'orange', 'green', 'yellow', 'pink'].includes(c['ぬ'])); // 決まっていない金物は残りの色
  assert.equal(ruleColor('面材 ﾀｲｶﾞｰﾊｲﾊﾟｰﾊｰﾄﾞT(入隅部)'), 'deepsky');
  assert.equal(ruleColor('面材 構造用面材 ﾀｲｶﾞｰEXﾊｲﾊﾟｰ'), 'sky');
  assert.equal(ruleColor('筋かい 45x90mm以上の木材 片筋かい'), 'purple');
  assert.equal(ruleColor('筋かい たすき掛 筋かい'), 'lime');
  assert.ok(colorHex('deepsky'));
});

test('1階の柱伏図：オメガの足元（柱の上下の記号の下側）は Hi-28 と同じ桃。2階や上側はそのまま', () => {
  const legend = { rows: [{ s: 'ろ', name: 'フックコーナー' }, { s: 'と', name: 'ｵﾒｶﾞｺｰﾅｰ 15kN' }, { s: 'り', name: 'ﾎｰﾙﾀﾞｳﾝ Hi-28', struck: true }], page: 0, box: { x0: 500, x1: 600 }, rowH: 8 };
  const m = (s, cx, cy, page) => ({ s, cx, cy, size: 4.4, page });
  const marks = [m('と', 100, 205, 0), m('と', 100, 200, 0), m('と', 300, 205, 1), m('と', 300, 200, 1), m('ろ', 200, 205, 0), m('ろ', 200, 200, 0)];
  const feet = omegaFeet(legend, marks, [0]);
  assert.deepEqual([...feet], [marks[1]]); // 1階（ページ0）の下側の「と」だけ
  const paint = buildPaint(legend, marks, defaultColors(legend.rows), { firstFloor: [0] }).filter((p) => p.kind === 'mark');
  const pink = colorHex('pink'), green = colorHex('green');
  assert.equal(paint.filter((p) => p.hex === pink).length, 1);
  assert.ok(paint.some((p) => p.hex === green));
});

test('横向きに置いて回したページ（/Rotate 90）も正しい向きの座標で読む。戻すと元の位置', async () => {
  const { uprightMatrix, invMatrix, applyMatrix, mulMatrix } = await import('../public/js/core.js');
  const M = uprightMatrix(90, [0, 0, 842, 1191]);
  // 正しい向きのページは横 1191・縦 842。PDF の (0,0) は 回すと左上
  const [x, y] = applyMatrix(M, 0, 0);
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y - 842) < 1e-9);
  const [u, v] = applyMatrix(invMatrix(M), ...applyMatrix(M, 300, 500));
  assert.ok(Math.abs(u - 300) < 1e-9 && Math.abs(v - 500) < 1e-9);
  // 回した字（縦向きに書かれた字）は、正しい向きでは横書きになる
  const t = mulMatrix(M, [0, 6, -6, 0, 100, 100]);
  assert.ok(Math.abs(t[1]) < 1e-9 && t[0] > 0);
  assert.deepEqual(uprightMatrix(0, [0, 0, 1191, 842]).map((v) => v + 0), [1, 0, 0, 1, 0, 0]); // 回していないページはそのまま
});

test('通り芯の名前の列（い・ろ・は…が横一列）は金物の記号に数えない。ほかのページの同じ表の中も数えない', () => {
  const page = samplePage();
  const lg = findLegend(page, segs);
  const labels = ['い', 'ろ', 'は', 'に', 'ほ', 'へ', 'と'].map((s, i) => ({ ...T(s, 50 + i * 40, 520, 4.4), page: 0 }));
  const p2 = [{ ...T('ろ', 700, 300, 4.4), page: 1 }, { ...T('ろ', 100, 100, 4.4), page: 1 }];
  const before = findMarks([{ glyphs: page }], lg).marks.length;
  const f = findMarks([{ glyphs: [...page, ...labels] }, { glyphs: p2 }], lg, { exclude: { 1: [{ x0: 690, x1: 720, y0: 290, y1: 310 }] } });
  assert.equal(f.marks.length, before + 1); // 2ページ目の表の外の「ろ」だけ増える
});
