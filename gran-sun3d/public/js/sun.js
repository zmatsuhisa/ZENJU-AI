// 日照3D の計算部分（太陽の位置・影の判定・日照時間）。画面（ブラウザ）とテスト（node）の両方で使う。
// 座標は 原点＝ピン位置、x=東、z=南、単位 m。時刻は日本時間。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SunCalc3D = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const R = Math.PI / 180;

  // 太陽の高さ（alt）と方位（az：北=0・東=90・南=180）。ms は UTC のミリ秒
  function sun(ms, lat, lon) {
    const d = ms / 86400000 + 2440587.5 - 2451545;
    const g = ((357.529 + 0.98560028 * d) % 360) * R, q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * R, e = (23.439 - 0.00000036 * d) * R;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
    const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
    const H = (gmst * 15 + lon) * R - ra, la = lat * R;
    const alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
    const az = Math.atan2(-Math.cos(dec) * Math.sin(H), Math.sin(dec) * Math.cos(la) - Math.cos(dec) * Math.cos(H) * Math.sin(la)) / R;
    return { alt: alt / R, az: (az + 360) % 360 };
  }

  // 'YYYY-MM-DD' と 0時からの分（日本時間）→ UTC ミリ秒
  const ms = (ds, min) => { const [y, m, dd] = ds.split('-').map(Number); return Date.UTC(y, m - 1, dd, 0, min) - 9 * 3600000; };

  function inPoly(x, z, P) {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const [xi, zi] = P[i], [xj, zj] = P[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
    }
    return c;
  }

  // 影を落とすもの：{p:[[x,z]...], h:高さ m}。範囲（x0..z1）を足して返す
  function occluder(p, h) {
    return { p, h, x0: Math.min(...p.map(q => q[0])), x1: Math.max(...p.map(q => q[0])), z0: Math.min(...p.map(q => q[1])), z1: Math.max(...p.map(q => q[1])) };
  }

  // 点 (px, 高さ y0, pz) から太陽の方へ伸ばした線が、どれかの建物にさえぎられるか
  function blocked(px, pz, s, occ, y0) {
    y0 = y0 || 0;
    if (s.alt <= 0) return true;
    const ta = Math.tan(s.alt * R), dx = Math.sin(s.az * R), dz = -Math.cos(s.az * R);
    for (const o of occ) {
      if (o.h <= y0) continue;
      const reach = (o.h - y0) / ta;
      if (o.x1 < px - reach || o.x0 > px + reach || o.z1 < pz - reach || o.z0 > pz + reach) continue;
      const P = o.p;
      if (inPoly(px, pz, P)) return true; // 建物の中の点
      const ex = px + dx * reach, ez = pz + dz * reach, rx = ex - px, rz = ez - pz;
      let tmin = Infinity;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const [ax, az] = P[j], [bx, bz] = P[i];
        const sx = bx - ax, sz = bz - az, den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((ax - px) * sz - (az - pz) * sx) / den, u = ((ax - px) * rz - (az - pz) * rx) / den;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < tmin) tmin = t;
      }
      if (tmin <= 1 && tmin * reach * ta < o.h - y0) return true;
    }
    return false;
  }

  // 1日の直射日照時間（時間）。pts は [x, z] か [x, z, 高さ]。10分刻み
  function sunHours(ds, pts, occ, lat, lon, step) {
    step = step || 10;
    const out = pts.map(() => 0);
    for (let m = 240; m <= 1200; m += step) {
      const s = sun(ms(ds, m), lat, lon);
      if (s.alt <= 0) continue;
      pts.forEach((p, i) => { if (!blocked(p[0], p[1], s, occ, p[2])) out[i] += step; });
    }
    return out.map(x => x / 60);
  }

  // 日の出・日の入（分）と南中高度
  function dayInfo(ds, lat, lon) {
    let rise = null, set = null, noon = -90;
    for (let m = 180; m <= 1320; m++) {
      const a = sun(ms(ds, m), lat, lon).alt;
      if (a > noon) noon = a;
      if (rise === null && a > -.833) rise = m;
      if (rise !== null && a > -.833) set = m;
    }
    return { rise, set, noon };
  }

  // 長方形（中心 cx,cz・東西 w・南北 d・angle 度 時計回り）の4つの角
  function rect(cx, cz, w, d, angle) {
    const a = (angle || 0) * R, c = Math.cos(a), s = Math.sin(a);
    return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => [cx + x * c - z * s, cz + x * s + z * c]);
  }

  // 計画の建物の高さ（軒の高さ＋屋根の半分）。平屋 3.3m・2階 6.2m に切妻 4.5寸
  const PLAN_EAVE = { 1: 3.3, 2: 6.2 };
  function planHeight(floors, d) { return (PLAN_EAVE[floors] || 6.2) + d / 2 * 0.45 / 2; }

  // 描いた形の建物の高さ（軒の高さ＋屋根の平均）。屋根の形が分からないので、軒の上に平均 1.0m を足す
  function drawHeight(floors) { return (PLAN_EAVE[floors] || 6.2) + 1.0; }

  // 線分 a-b と線分 c-d が交わるか
  function segHit(a, b, c, d) {
    const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
    if (Math.abs(den) < 1e-12) return false;
    const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den, u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }

  // LDK の窓の位置（決めていなければ、いちばん大きい建物の南を向いた辺のうち長いもののまん中）。面から 30cm 外
  function autoWindow(bldgs, angle) {
    const a = (angle || 0) * R, south = [-Math.sin(a), Math.cos(a)];
    let best = null;
    const main = bldgs.slice().sort((x, y) => polyArea(y.p) - polyArea(x.p))[0];
    if (!main) return null;
    const P = main.p;
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]); if (L < .5) continue;
      let n = [(q[1] - p[1]) / L, -(q[0] - p[0]) / L]; const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      if (inPoly(m[0] + n[0] * .05, m[1] + n[1] * .05, P)) n = [-n[0], -n[1]];
      const face = n[0] * south[0] + n[1] * south[1];
      const score = face > .6 ? L * face : -1;
      if (!best || score > best.score) best = { score, pt: [m[0] + n[0] * .3, m[1] + n[1] * .3] };
    }
    return best && best.score > 0 ? best.pt : null;
  }
  function polyArea(P) { let s = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }

  // 計画の建物（いくつでも・どんな形でも）を置いたときの「南の庭」と「LDK の窓」の日照時間
  // bldgs: [{p:[[x,z]...], h:高さ m}], win: [x,z]（なければ自動）, angle: 図面の向き（南北をどちらに見るか）
  function polyStats(ds, bldgs, win, lot, occ, lat, lon, angle) {
    const all = occ.concat(bldgs.map(b => occluder(b.p, b.h)));
    const a = (angle || 0) * R, north = [Math.sin(a), -Math.cos(a)];
    // 南の庭：敷地のうち建物の外で、真北（図面の向き）を見ると 40m 以内に計画の建物がある所。1m 間隔
    const xs = lot.map(p => p[0]), zs = lot.map(p => p[1]);
    const garden = [];
    for (let x = Math.min(...xs) + .5; x < Math.max(...xs); x += 1) for (let z = Math.min(...zs) + .5; z < Math.max(...zs); z += 1) {
      if (!inPoly(x, z, lot) || bldgs.some(b => inPoly(x, z, b.p))) continue;
      const e = [x + north[0] * 40, z + north[1] * 40];
      if (bldgs.some(b => b.p.some((p, i) => segHit([x, z], e, p, b.p[(i + 1) % b.p.length])))) garden.push([x, z]);
    }
    const w = win || autoWindow(bldgs, angle);
    const gh = garden.length ? sunHours(ds, garden, all, lat, lon) : [];
    const ldk = w ? sunHours(ds, [[w[0], w[1], 1.2]], all, lat, lon)[0] : null;
    return { garden: gh.length ? gh.reduce((t, v) => t + v, 0) / gh.length : null, gardenArea: garden.length, ldk, win: w };
  }

  // 箱の形の計画の建物（plan: {cx, cz, w, d, angle, floors}）
  function planStats(ds, plan, lot, occ, lat, lon) {
    const box = rect(plan.cx, plan.cz, plan.w, plan.d, plan.angle);
    return polyStats(ds, [{ p: box, h: planHeight(plan.floors, plan.d) }], null, lot, occ, lat, lon, plan.angle);
  }

  return { R, sun, ms, inPoly, occluder, blocked, sunHours, dayInfo, rect, planHeight, planStats, drawHeight, polyStats, autoWindow, polyArea };
});
