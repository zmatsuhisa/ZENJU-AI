const test = require('node:test');
const assert = require('node:assert');
const S = require('../public/js/sun.js');

const LAT = 35.0, LON = 135.0; // 日本のまん中あたり（実際の敷地ではない）
const at = (ds, h) => S.sun(S.ms(ds, h * 60), LAT, LON);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} と ${b} の差が ${tol} より大きい`);

test('太陽の高さ：南中の高さが季節の理論値に合う', () => {
  const noon = ds => S.dayInfo(ds, LAT, LON).noon;
  near(noon('2026-03-20'), 90 - LAT, 1, '春分');
  near(noon('2026-06-21'), 90 - LAT + 23.44, 1, '夏至');
  near(noon('2026-12-22'), 90 - LAT - 23.44, 1, '冬至');
});

test('太陽の方位：朝は東より、昼は南、夕方は西より', () => {
  const ds = '2026-03-20';
  assert.ok(at(ds, 8).az > 90 && at(ds, 8).az < 135);
  near(at(ds, 11.9).az, 180, 6, '正午ごろ');
  assert.ok(at(ds, 16).az > 225 && at(ds, 16).az < 270);
});

test('日の出・日の入：春分はおよそ12時間', () => {
  const d = S.dayInfo('2026-03-20', LAT, LON);
  near((d.set - d.rise) / 60, 12.1, 0.3, '昼の長さ');
});

test('影の判定：南の壁は冬至にさえぎり、夏至にはさえぎらない', () => {
  const wall = [S.occluder(S.rect(0, 5, 20, 1, 0), 10)]; // 点の 4.5m 南に高さ 10m の壁
  assert.equal(S.blocked(0, 0, at('2026-12-22', 11.9), wall), true);
  assert.equal(S.blocked(0, 0, at('2026-06-21', 11.9), wall), false);
  assert.equal(S.blocked(0, 0, at('2026-12-22', 11.9), wall, 11), false, '壁より高い点は日が当たる');
  assert.equal(S.blocked(0, 5, at('2026-06-21', 11.9), wall), true, '建物の中の点は日が当たらない');
});

test('日照時間：何もなければ昼の長さとほぼ同じ', () => {
  const h = S.sunHours('2026-03-20', [[0, 0]], [], LAT, LON)[0];
  near(h, 12, 0.4, '春分の日照');
});

test('計画の建物：南の庭と窓の日照を数え、南の建物があると減る', () => {
  const lot = S.rect(0, 0, 20, 30, 0);
  const plan = { cx: 0, cz: -7, w: 10, d: 8, angle: 0 };
  const one = S.planStats('2026-12-22', { ...plan, floors: 1 }, lot, [], LAT, LON);
  const two = S.planStats('2026-12-22', { ...plan, floors: 2 }, lot, [], LAT, LON);
  assert.ok(one.gardenArea > 100, '南の庭が数えられている');
  near(one.ldk, two.ldk, 0.01, '南に何もなければ窓の日照は同じ');
  assert.ok(one.ldk > 8, '冬至でも 8 時間以上');
  const south = [S.occluder(S.rect(0, 12, 20, 6, 0), 9)]; // 南の隣地に 3階建て
  const shaded = S.planStats('2026-12-22', { ...plan, floors: 1 }, lot, south, LAT, LON);
  assert.ok(shaded.ldk < one.ldk, '南の建物で窓の日照が減る');
  assert.ok(shaded.garden < one.garden, '南の建物で庭の日照が減る');
});

test('長方形を回す：角度 90 度で東西と南北が入れ替わる', () => {
  const r = S.rect(0, 0, 10, 4, 90).map(p => p.map(v => Math.round(v * 10) / 10 + 0));
  const xs = r.map(p => p[0]), zs = r.map(p => p[1]);
  near(Math.max(...xs) - Math.min(...xs), 4, 1e-6, '東西の幅');
  near(Math.max(...zs) - Math.min(...zs), 10, 1e-6, '南北の幅');
});

test('地形：山の稜線より低い太陽は当たらない／高い所の建物は影が長い', () => {
  try {
    const free = S.sunHours('2026-12-22', [[0, 0]], [], LAT, LON)[0];
    const hor = new Array(360).fill(0); for (let a = 200; a < 300; a++) hor[a] = 5; // 西に 5°の山
    S.setEnv({ hor });
    const hill = S.sunHours('2026-12-22', [[0, 0]], [], LAT, LON)[0];
    assert.ok(hill < free - .2, `山があると日が早く沈む ${free} → ${hill}`);
    S.setEnv({ hor: null });
    // 南 8m に高さ 3m の塀。塀の足元が 0 なら冬至の正午は当たる（3/tan31° ≈ 5m）、足元が 2m 高いと当たらない
    const wall = base => [S.occluder(S.rect(0, 8, 20, .2, 0), 3, base)];
    const noon = S.sun(S.ms('2026-12-22', 718), LAT, LON);
    assert.equal(S.blocked(0, 0, noon, wall(0), 0), false);
    assert.equal(S.blocked(0, 0, noon, wall(2), 0), true);
    // 標高の網：4 点のまん中は平均
    const T = S.terrainFn({ x0: 0, z0: 0, step: 10, nx: 2, nz: 2, hc: [0, 100, 200, 300] });
    assert.ok(Math.abs(T(5, 5) - 1.5) < 1e-9);
    // 盛土 30cm で窓の高さも上がる（影に入りにくくなる）
    S.setEnv({ fill: .3 });
    assert.ok(Math.abs(S.lotGround(0, 0) - .3) < 1e-9);
  } finally { S.setEnv({ T: null, hor: null, fill: 0 }); }
});
