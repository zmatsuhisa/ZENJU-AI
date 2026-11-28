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

test('寸法：建物の辺を境界と平行にして、境界から 1,110mm 離す', () => {
  const lot = [[0, 0], [20, 3], [18, 25], [-1, 22]]; // 少しゆがんだ敷地
  let P = [[3, 4], [12, 4], [12, 11], [3, 11]];
  const r = D.alignEdge(P, 0, lot, 0); P = r.P;
  const a = P[0], b = P[1], th = Math.atan2(b[1] - a[1], b[0] - a[0]), tl = Math.atan2(3, 20);
  assert.ok(Math.abs(th - tl) < 1e-9, '北の辺が北の境界と平行');
  P = D.placeEdge(P, 0, lot, 0, 1.11).P;
  assert.ok(Math.abs(D.offsetFrom(P[0], lot[0], D.inwardNormal(lot, 0)) - 1.11) < 1e-9);
  assert.ok(Math.abs(D.offsetFrom(P[1], lot[0], D.inwardNormal(lot, 0)) - 1.11) < 1e-9, '辺の両端とも 1,110');
});

test('寸法：建物の角を、敷地の角から 北側1,100・西側1,500 に置く', () => {
  const lot = [[0, 0], [20, 0], [20, 25], [0, 25]];
  const P = [[5, 5], [14, 5], [14, 12], [5, 12]];
  const r = D.placeCorner(P, 0, lot, 0, 1.5, 1.1); // 角0：手前の辺＝西の境界、先の辺＝北の境界
  near(r.P[0], [1.5, 1.1], 1e-9);
  near(r.P[2], [10.5, 8.1], 1e-9);
  const g = D.cornerGap(r.P, 0, lot, 0);
  assert.ok(Math.abs(g[0] - 1.5) < 1e-9 && Math.abs(g[1] - 1.1) < 1e-9);
});

test('寸法を守る：北1,110を決めた建物は、建物ごと動かしても東西にだけ動く', () => {
  const lot = [[0, 0], [20, 0], [20, 25], [0, 25]];
  const dims = [{ k: 'e', be: 0, le: 0, d: 1.11 }];
  const t = D.allowedMove([2, 3], dims, lot);
  assert.ok(Math.abs(t[0] - 2) < 1e-9 && Math.abs(t[1]) < 1e-9);
  const dims2 = dims.concat([{ k: 'e', be: 3, le: 3, d: 1.5 }]);
  const t2 = D.allowedMove([2, 3], dims2, lot);
  assert.ok(Math.abs(t2[0]) < 1e-9 && Math.abs(t2[1]) < 1e-9, '北と西を決めたら動かない');
});

test('寸法を守る：決めた辺の角を引っぱっても、辺は境界から 1,110 のまま', () => {
  const lot = [[0, 0], [20, 3], [18, 25], [-1, 22]];
  let P = [[3, 4], [12, 4], [12, 11], [3, 11]];
  P = D.alignEdge(P, 0, lot, 0).P; P = D.placeEdge(P, 0, lot, 0, 1.11).P;
  const dims = [{ k: 'e', be: 0, le: 0, d: 1.11 }];
  P[1] = [P[1][0] + 1.5, P[1][1] - 2]; // 北東の角を引っぱる
  const Q = D.keepDims(P, dims, lot), n = D.inwardNormal(lot, 0);
  [Q[0], Q[1]].forEach(p => assert.ok(Math.abs(D.offsetFrom(p, lot[0], n) - 1.11) < 1e-9));
});

test('寸法を守る：角の寸法は、角を引っぱっても元の所に戻る。角を足しても寸法の番号が合う', () => {
  const lot = [[0, 0], [20, 0], [20, 25], [0, 25]];
  const dims = [{ k: 'c', bv: 0, lv: 0, d1: 1.5, d2: 1.1 }, { k: 'e', be: 1, le: 1, d: 2 }];
  const Q = D.keepDims([[4, 4], [12, 1], [12, 8], [1, 8]], dims, lot);
  near(Q[0], [1.5, 1.1], 1e-9);
  assert.ok(Math.abs(Q[1][0] - 18) < 1e-9 && Math.abs(Q[2][0] - 18) < 1e-9, '東側の辺は境界から 2,000');
  const ins = D.dimsAfterInsert(dims, 1);
  assert.deepEqual(ins.filter(d => d.k === 'e').map(d => d.be), [1, 2], '分けた辺の両方に寸法が残る');
  const del = D.dimsAfterDelete(dims, 3, 4);
  assert.equal(del.length, 2);
});

test('建物の大きさ：総2階 9.1×7.28 は 1階 約20坪・延べ 約40坪、境界と隣家までの距離', () => {
  const Z = require('../public/js/size.js');
  const lot = [[0, 0], [20, 0], [20, 25], [0, 25]];
  const P = [[2, 1.1], [11.1, 1.1], [11.1, 8.38], [2, 8.38]];
  const s = Z.sizeInfo([{ p: P, f: 2, eave: 6.2, top: 7.8 }], lot, [{ p: [[2, 28], [10, 28], [10, 36], [2, 36]], h: 6.4 }], 0, 31.3);
  assert.ok(Math.abs(s.a1 - 66.248) < .01 && Math.abs(s.tsubo1 - 20.04) < .01, `1階 ${s.a1}㎡ ${s.tsubo1}坪`);
  assert.ok(Math.abs(s.tsuboTotal - 40.08) < .02);
  assert.ok(Math.abs(s.w - 9.1) < 1e-9 && Math.abs(s.d - 7.28) < 1e-9, '間口と奥行');
  assert.ok(Math.abs(s.gaps['北'] - 1.1) < 1e-9 && Math.abs(s.gaps['西'] - 2) < 1e-9, '北側1.1m・西側2m');
  assert.ok(Math.abs(s.neigh['南'].d - (28 - 8.38)) < 1e-9, '南の家まで');
  assert.ok(Math.abs(s.neigh['南'].shadow - 6.4 / Math.tan(31.3 * Math.PI / 180)) < 1e-9, '冬至の正午の影の長さ');
});

test('寸法：角からは境界線に沿って測る（角が直角でない土地でも）', () => {
  const lot = [[0, 0], [20, 2], [19, 25], [-2, 22]]; // 北西の角がゆがんだ土地
  const P = [[4, 4], [12, 4], [12, 10], [4, 10]];
  // 北西の角 lot[0]：手前の辺は西の境界（lot[3]→lot[0]）、先の辺は北の境界（lot[0]→lot[1]）
  const r = D.placeCornerAlong(P, 0, lot, 0, 0.9, 1.0); // 西の境界に沿って 900、北の境界に沿って 1,000
  const g = D.cornerAlong(r.P, 0, lot, 0);
  assert.ok(Math.abs(g[0] - .9) < 1e-9 && Math.abs(g[1] - 1) < 1e-9, `沿った長さ ${g}`);
  // 北の境界の上、角から 1,000 の点から直角に下ろした線の上に建物の角がある
  const [u1, u2] = D.cornerDirs(lot, 0), f = [lot[0][0] + u2[0], lot[0][1] + u2[1]];
  assert.ok(Math.abs((r.P[0][0] - f[0]) * u2[0] + (r.P[0][1] - f[1]) * u2[1]) < 1e-9);
  // 守る：建物ごと動かそうとしても動かない
  const t = D.allowedMove([1, 1], [{ k: 'c', bv: 0, lv: 0, d1: .9, d2: 1, m: 'a' }], lot);
  assert.ok(Math.hypot(t[0], t[1]) < 1e-9);
});
