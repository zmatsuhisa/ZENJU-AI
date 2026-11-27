const test = require('node:test');
const assert = require('node:assert');
const D = require('../public/js/draw.js');
const S = require('../public/js/sun.js');

// 手のブレをまねた線：直線に ±amp のゆれを足す
let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function wobbly(pts, amp, step) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]], L = D.dist(a, b), n = Math.max(2, Math.round(L / step));
    for (let k = 0; k < n; k++) { const t = k / n; out.push([a[0] + (b[0] - a[0]) * t + (rnd() - .5) * amp, a[1] + (b[1] - a[1]) * t + (rnd() - .5) * amp]); }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
const near = (a, b, tol) => assert.ok(D.dist(a, b) <= tol, `${a} と ${b} が ${tol}m より離れている`);

test('手で描いた四角：ブレが消えて、角が4つの長方形になる', () => {
  const sq = [[0, 0], [9.1, 0], [9.1, 7.28], [0, 7.28], [0, 0]];
  const raw = D.simplify(wobbly(sq, .4, .2), .35);
  const P = D.straighten(raw, { closed: true, step: 90, angle: 0, grid: .91 });
  assert.equal(P.length, 4);
  [[0, 0], [9.1, 0], [9.1, 7.28], [0, 7.28]].forEach(c => assert.ok(P.some(p => D.dist(p, c) < 1e-6), `角 ${c} がない: ${JSON.stringify(P)}`));
});

test('L字の外周：6つの角になり、面積が合う', () => {
  const L = [[0, 0], [10.92, 0], [10.92, 5.46], [5.46, 5.46], [5.46, 9.1], [0, 9.1], [0, 0]];
  const P = D.straighten(D.simplify(wobbly(L, .3, .2), .3), { closed: true, step: 90, angle: 0, grid: .91 });
  assert.equal(P.length, 6);
  assert.ok(Math.abs(D.area(P) - (10.92 * 5.46 + 5.46 * 3.64)) < 1e-6);
});

test('図面の向きが傾いていても、その向きにそろう', () => {
  const ang = 10;
  const sq = [[0, 0], [8, 0], [8, 6], [0, 6], [0, 0]].map(p => D.toXZ(p, ang));
  const P = D.straighten(D.simplify(wobbly(sq, .3, .2), .3), { closed: true, step: 90, angle: ang, grid: 0 });
  assert.equal(P.length, 4);
  for (let i = 0; i < 4; i++) {
    const a = P[i], b = P[(i + 1) % 4], th = Math.atan2(b[1] - a[1], b[0] - a[0]) / D.R - ang;
    assert.ok(Math.abs(((th % 90) + 90) % 90) < 1e-6 || Math.abs((((th % 90) + 90) % 90) - 90) < 1e-6, `辺 ${i} の角度 ${th}`);
  }
});

test('角度をそろえない設定：斜めの線は斜めのまま残る', () => {
  const P = D.straighten([[0, 0], [5, 2]], { step: 0 });
  near(P[1], [5, 2], 1e-9);
  const Q = D.straighten([[0, 0], [5, 2]], { step: 90 });
  assert.ok(Math.abs(Q[1][1] - Q[0][1]) < 1e-9, '90度ごとなら水平になる');
  const T = D.straighten([[0, 0], [5, 4.6]], { step: 45 });
  assert.ok(Math.abs(Math.abs(T[1][0] - T[0][0]) - Math.abs(T[1][1] - T[0][1])) < 1e-9, '45度ごとなら斜め45度になる');
});

test('マス目に寄せる：910 の倍数になる', () => {
  const p = D.snapGrid([2.0, 3.0], .91, 0, [0, 0]);
  near(p, [1.82, 2.73], 1e-9);
});

test('境界から50cmの線：長方形は各辺 0.5m 内側になる', () => {
  const I = D.inset([[0, 0], [10, 0], [10, 6], [0, 6]], .5);
  [[.5, .5], [9.5, .5], [9.5, 5.5], [.5, 5.5]].forEach(c => assert.ok(I.some(p => D.dist(p, c) < 1e-9)));
});

test('描いた形の日照：L字の建物でも南の庭と窓を数えられる', () => {
  const lot = S.rect(0, 0, 20, 30, 0);
  const L = [[-6, -12], [6, -12], [6, -6], [0, -6], [0, -2], [-6, -2]];
  const st = S.polyStats('2026-12-22', [{ p: L, h: S.drawHeight(2) }], null, lot, [], 35, 135, 0);
  assert.ok(st.gardenArea > 50);
  assert.ok(st.win && st.win[1] > -6, '窓は南を向いた辺にある');
  assert.ok(st.ldk > 7);
});
