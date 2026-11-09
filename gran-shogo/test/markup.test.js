// 書き込みの洗い出し：画像を使わない部品のテスト（文字の差・行列）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __test } from '../public/js/markup/engine.js';

const { textDiffMask, wordsIn, applyH, invert3, mul3 } = __test;
const W = (s, cx, cy) => ({ s, cx, cy, w: 30, h: 10 });

test('文字の差：書き換え（900→910）は消えた文字と増えた文字になる', () => {
  const m = textDiffMask([W('900', 100, 100), W('洗面', 300, 100)], [W('910', 100, 100), W('洗面', 300, 100)], null, 400, 200);
  const r = wordsIn(m, 50, 50, 150, 150);
  assert.deepEqual(r.gone, ['900']);
  assert.deepEqual(r.came, ['910']);
  assert.equal(m[100 * 400 + 100], 255);   // 箱の中は差あり
  assert.equal(m[100 * 400 + 300], 0);     // 変わらない文字は差なし
});

test('文字の差：動いただけの文字は「動いた」に分ける', () => {
  const m = textDiffMask([W('散水栓', 100, 100)], [W('散水栓', 130, 60)], null, 400, 200);
  const r = wordsIn(m, 0, 0, 200, 200);
  assert.deepEqual(r.gone, []);
  assert.deepEqual(r.came, []);
  assert.deepEqual(r.moved, ['散水栓']);
});

test('文字の差：日付だけの変更は数えない', () => {
  const m = textDiffMask([W('2026/10/26', 100, 100)], [W('2026/11/03', 100, 100)], null, 400, 200);
  const r = wordsIn(m, 0, 0, 200, 200);
  assert.deepEqual([...r.gone, ...r.came], []);
});

test('射影変換：逆行列をかけると元に戻る', () => {
  const H = [1.02, 0.01, 5, -0.01, 0.98, -3, 0.00001, 0, 1];
  const [x, y] = applyH(H, 400, 300);
  const [bx, by] = applyH(invert3(H), x, y);
  assert.ok(Math.abs(bx - 400) < 1e-6 && Math.abs(by - 300) < 1e-6);
  const I = mul3(H, invert3(H));
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => assert.ok(Math.abs(I[i] - v) < 1e-9));
});
