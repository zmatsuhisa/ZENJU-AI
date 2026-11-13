// 壁（筋かい・面材）の記号を形で探す処理のテスト（架空の図形。お客様の図面は使わない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGlyph } from '../public/js/core.js';
import { findWallLegend, findWallMarks, clusterSegments, rasterize, similarity, excludeZones, countByKey } from '../public/js/walls.js';

const T = (str, x, y, size = 6) => ({ ...toGlyph({ str, transform: [size, 0, 0, size, x, y], width: size * [...str].length }), page: 0 });
const poly = (pts) => pts.map((p, i) => [...p, ...pts[(i + 1) % pts.length]]);
const tri = (cx, cy, w, h, rot = 0) => {
  // 直角三角形（片筋かい）。rot で 90 度ずつ回す
  let pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2]];
  for (let r = 0; r < rot; r++) pts = pts.map(([x, y]) => [-y, x]);
  return poly(pts.map(([x, y]) => [cx + x, cy + y]));
};
const bowtie = (cx, cy, w, h) => [...poly([[cx - w / 2, cy - h / 2], [cx, cy], [cx - w / 2, cy + h / 2]]), ...poly([[cx + w / 2, cy - h / 2], [cx, cy], [cx + w / 2, cy + h / 2]])];
const diamond = (cx, cy, w, h) => poly([[cx, cy - h / 2], [cx + w / 2, cy], [cx, cy + h / 2], [cx - w / 2, cy]]);
const filledDiamond = (cx, cy, w, h) => {
  const out = diamond(cx, cy, w, h);
  for (let k = 1; k < 12; k++) { const y = -h / 2 + (h * k) / 12; const half = (w / 2) * (1 - Math.abs(y) / (h / 2)); out.push([cx - half, cy + y, cx + half, cy + y]); }
  return out;
};

// 架空の1ページ：右に「軸組みの種類と壁倍率」の表、左に平面図の記号
function sample() {
  const X0 = 600, X1 = 780;
  const glyphs = [T('●軸組みの種類と壁倍率', X0, 520, 8), T('記号', X0 + 6, 500, 6.5), T('軸組みの種類', X0 + 60, 500, 6.5), T('壁倍率', X1 - 24, 500, 6.5)];
  const segs = [];
  const lines = [512, 492, 470, 448, 426, 404];
  for (const y of lines) segs.push([X0, y, X1, y]);
  segs.push([X0, 512, X0, 404], [X1, 512, X1, 404]);
  const rows = [['筋かい', '片筋かい', '2.0', tri(X0 + 12, 481, 9, 4.5)], ['筋かい', 'たすき掛', '4.0', bowtie(X0 + 12, 459, 9, 4.5)],
    ['面材', '構造用面材', '2.4', filledDiamond(X0 + 12, 437, 5, 10)], ['面材', '構造用合板', '2.5', diamond(X0 + 12, 415, 5, 10)]];
  rows.forEach(([a, b, rate, shape], i) => {
    const cy = (lines[i + 1] + lines[i + 2]) / 2 - 2;
    glyphs.push(T(a, X0 + 30, cy), T(b, X0 + 70, cy), T(rate, X1 - 20, cy));
    segs.push(...shape);
  });
  // 最後の行（構造用合板）に斜線
  segs.push([X0, 404, X1, 426]);
  // 平面図：向きの違う片筋かい・たすき掛・塗りつぶしのひし形・取り消しの合板
  segs.push(...tri(100, 100, 9, 4.5, 1), ...tri(150, 100, 9, 4.5, 2), ...tri(200, 100, 9, 4.5, 3));
  segs.push(...bowtie(100, 200, 4.5, 9).map(([a, b, c, d]) => [a, b, c, d]));
  segs.push(...filledDiamond(250, 200, 10, 5), ...diamond(300, 200, 5, 10));
  // 壁の長い線（塗らない）と、関係ない四角
  segs.push([50, 150, 400, 150], ...poly([[350, 100], [358, 100], [358, 108], [350, 108]]));
  return { glyphs, segs };
}

test('壁の表の行・壁倍率・記号の形・斜線を読む', () => {
  const { glyphs, segs } = sample();
  const wl = findWallLegend(glyphs, segs);
  assert.ok(wl);
  assert.equal(wl.rows.length, 4);
  assert.deepEqual(wl.rows.map((r) => r.rate), [2, 4, 2.4, 2.5]);
  assert.deepEqual(wl.rows.map((r) => r.struck), [false, false, false, true]);
  assert.equal(wl.rows[0].label, '筋かい 片筋かい');
  assert.equal(wl.rows[0].symbol.segs.length, 3);
});

test('向きが違っても同じ記号を見つけ、塗りつぶしと線だけを見分ける', () => {
  const { glyphs, segs } = sample();
  const wl = findWallLegend(glyphs, segs);
  const marks = findWallMarks([{ segs }], wl, { exclude: { 0: [wl.box] } });
  const c = countByKey(marks);
  assert.equal(c.get(wl.rows[0].key), 3); // 片筋かい 3 つ（回転）
  assert.equal(c.get(wl.rows[1].key), 1); // たすき掛（縦向き）
  assert.equal(c.get(wl.rows[2].key), 1); // 塗りつぶしのひし形（横向き）
  assert.equal(c.get(wl.rows[3].key), 1); // 線だけのひし形（斜線の行＝赤い輪の対象）
  assert.equal(marks.length, 6); // 四角や長い線は拾わない
});

test('線分のまとまり：離れた図形は別、重なる線は同じ', () => {
  const cl = clusterSegments([...tri(0, 0, 9, 4.5), ...tri(50, 0, 9, 4.5), [0, -20, 100, -20]], { maxLen: 30 });
  assert.equal(cl.length, 2);
});

test('同じ形は似ている度合いが高く、違う形は低い', () => {
  const a = tri(0, 0, 9, 4.5), b = diamond(0, 0, 9, 4.5);
  const box = (s) => ({ x0: Math.min(...s.flatMap((q) => [q[0], q[2]])), x1: Math.max(...s.flatMap((q) => [q[0], q[2]])), y0: Math.min(...s.flatMap((q) => [q[1], q[3]])), y1: Math.max(...s.flatMap((q) => [q[1], q[3]])) });
  assert.ok(similarity(rasterize(a, box(a)), rasterize(a, box(a))) > 0.99);
  assert.ok(similarity(rasterize(a, box(a)), rasterize(b, box(b))) < 0.8);
});

test('凡例の見出しから右下は探さない', () => {
  const ex = excludeZones([[T('●凡例', 900, 200, 8)]], [], [{ w: 1190 }]);
  assert.equal(ex[0].length, 1);
  assert.ok(ex[0][0].x0 < 900 && ex[0][0].x1 === 1190 && ex[0][0].y1 > 200);
});
