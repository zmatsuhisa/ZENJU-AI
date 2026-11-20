// 2階の耐力壁を1階の図面に落とすテスト（架空のデータ。お客様の図面は使わない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGlyph } from '../public/js/core.js';
import { floorPages, gridLabels, fitAxis, upperWalls } from '../public/js/upper.js';

const H = (str, x, y, size = 6) => toGlyph({ str, transform: [size, 0, 0, size, x - size * [...str].length * 0.3, y - size * 0.35], width: size * [...str].length * 0.6 });

test('ページ名から1階・2階の柱伏図を決める', () => {
  const pages = [{ glyphs: [H('基礎伏図', 0, 0)] }, { glyphs: [H('2階柱伏図 S:1/70', 0, 0)] }, { glyphs: [H('1階柱伏図 S:1/70', 0, 0)] }];
  assert.deepEqual(floorPages(pages), { first: 2, second: 1 });
});

test('通り芯の名前を読み、名前が同じ通り芯どうしで2階→1階の位置の式を求める（寸法の 910 は名前にしない）', () => {
  const grid1 = { xs: [100, 137, 174], ys: [200, 237] }, grid2 = { xs: [300, 337, 374], ys: [400, 437] };
  const lab = (grid, dy) => [...grid.xs.map((x, i) => H(['い', 'ろ', 'は'][i], x, 600 + dy)), ...grid.ys.map((y, i) => H(String(i + 1), 50, y)), H('910', 118.5, grid.ys[0])];
  const l1 = gridLabels(lab(grid1, 0), grid1), l2 = gridLabels(lab(grid2, 0), grid2);
  assert.deepEqual([...l1.x.keys()], ['い', 'ろ', 'は']);
  assert.deepEqual([...l1.y.keys()], ['1', '2']);
  const fx = fitAxis(l2.x, l1.x), fy = fitAxis(l2.y, l1.y);
  assert.ok(Math.abs(fx.a - 1) < 1e-9 && Math.abs(fx.b + 200) < 1e-9);
  assert.ok(Math.abs(fy.b + 200) < 1e-9);
  // 2階の壁の記号（い〜ろの間、1 の通りの壁の少し上）→ 1階の い〜ろ・1 の線
  const solid = [[300, 400, 374, 400]];
  const w = upperWalls([{ key: 'w:a', cx: 318, cy: 406 }], grid2, fx, fy, { solid });
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].points, [[100, 200], [137, 200]]);
});
