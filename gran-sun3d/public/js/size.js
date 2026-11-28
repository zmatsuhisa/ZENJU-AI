// 計画の建物の大きさ（床面積・建ぺい率・外形・境界や隣家までの距離など）。画面とテストで共用。
// 座標は x=東、z=南、m。angle は図面の向き（度）で、間口・奥行や方角はこの向きで見る。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Size = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const R = Math.PI / 180, TSUBO = 3.305785; // 1坪 = 3.305785㎡
  const area = P => { let s = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
  const perim = P => P.reduce((s, a, i) => { const b = P[(i + 1) % P.length]; return s + Math.hypot(b[0] - a[0], b[1] - a[1]); }, 0);
  const inPoly = (x, z, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; };
  const toUV = (p, a) => { const c = Math.cos(a * R), s = Math.sin(a * R); return [p[0] * c + p[1] * s, -p[0] * s + p[1] * c]; };
  function segDist(p, a, b) { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1e-9; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2)); return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dz * t); }
  // 2つの多角形のいちばん近い距離（重なっていれば 0）
  function polyDist(P, Q) {
    if (P.some(p => inPoly(p[0], p[1], Q)) || Q.some(q => inPoly(q[0], q[1], P))) return 0;
    let d = Infinity;
    P.forEach(p => Q.forEach((a, i) => { d = Math.min(d, segDist(p, a, Q[(i + 1) % Q.length])); }));
    Q.forEach(q => P.forEach((a, i) => { d = Math.min(d, segDist(q, a, P[(i + 1) % P.length])); }));
    return d;
  }
  const DIR4 = ['北', '東', '南', '西'];
  // 図面の向きで見た方角（北・東・南・西）
  function dir4(v, angle) { const [u, w] = toUV(v, angle); return Math.abs(u) > Math.abs(w) ? (u > 0 ? '東' : '西') : (w > 0 ? '南' : '北'); }

  // bldgs: [{p, f:階数, eave:軒の高さ, top:いちばん高い所}], lot: 敷地の角, nb: まわりの建物 [{p, h:高さ}], angle: 図面の向き, noonAlt: 冬至の南中高度（度）
  function sizeInfo(bldgs, lot, nb, angle, noonAlt) {
    const lotA = area(lot);
    const a1 = bldgs.reduce((s, b) => s + area(b.p), 0);
    const a2 = bldgs.reduce((s, b) => s + (b.f >= 2 ? area(b.p) : 0), 0); // 総2階として
    const total = a1 + a2;
    const all = bldgs.flatMap(b => b.p), uv = all.map(p => toUV(p, angle));
    const w = uv.length ? Math.max(...uv.map(q => q[0])) - Math.min(...uv.map(q => q[0])) : 0;
    const d = uv.length ? Math.max(...uv.map(q => q[1])) - Math.min(...uv.map(q => q[1])) : 0;
    const per = bldgs.reduce((s, b) => s + perim(b.p), 0);
    const eave = Math.max(0, ...bldgs.map(b => b.eave || 0)), top = Math.max(0, ...bldgs.map(b => b.top || 0));
    const wall = bldgs.reduce((s, b) => s + perim(b.p) * (b.eave || 0), 0);
    // 屋根：軒の出 45cm を足した広さ × 4.5寸勾配の伸び（1.097）
    const roof = bldgs.reduce((s, b) => s + (area(b.p) + perim(b.p) * .45 + .45 * .45 * 4) * Math.sqrt(1 + .45 * .45), 0);
    // 境界までの距離：敷地の辺ごとに、建物の角からの直角の距離のいちばん短いもの（辺の範囲に足が落ちる角だけ）
    const gaps = {};
    lot.forEach((a, i) => {
      const b = lot[(i + 1) % lot.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < .5) return;
      const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L; let n = [-uz, ux]; const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!inPoly(m[0] + n[0] * .01, m[1] + n[1] * .01, lot)) n = [uz, -ux];
      let best = Infinity;
      all.forEach(p => { const t = (p[0] - a[0]) * ux + (p[1] - a[1]) * uz; if (t < -.01 || t > L + .01) return; best = Math.min(best, (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1]); });
      if (!isFinite(best)) return;
      const side = dir4([-n[0], -n[1]], angle);
      if (gaps[side] == null || best < gaps[side]) gaps[side] = best;
    });
    // 隣の家：方角ごとにいちばん近い建物（距離・高さ・冬至の正午の影の長さ）
    const neigh = {};
    if (all.length) {
      const c = [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length];
      (nb || []).forEach(o => {
        const oc = [o.p.reduce((s, p) => s + p[0], 0) / o.p.length, o.p.reduce((s, p) => s + p[1], 0) / o.p.length];
        if (Math.hypot(oc[0] - c[0], oc[1] - c[1]) > 60) return;
        const dist = Math.min(...bldgs.map(b => polyDist(b.p, o.p))), side = dir4([oc[0] - c[0], oc[1] - c[1]], angle);
        if (!neigh[side] || dist < neigh[side].d) neigh[side] = { d: dist, h: o.h, shadow: noonAlt > 0 ? o.h / Math.tan(noonAlt * R) : null };
      });
    }
    return {
      a1, a2, total, tsubo1: a1 / TSUBO, tsubo2: a2 / TSUBO, tsuboTotal: total / TSUBO, jo: total / 1.62,
      lot: lotA, coverage: lotA ? a1 / lotA : 0, far: lotA ? total / lotA : 0, free: lotA - a1,
      w, d, per, eave, top, wall, roof, gaps, neigh
    };
  }

  // 画面に出す形（配置図・3Dのページで共通）
  const n1 = v => v.toFixed(1), mm = m => Math.round(m * 1000).toLocaleString('ja-JP'), pct = v => (v * 100).toFixed(1) + '%';
  function html(s) {
    if (!s || !s.a1) return '<p class="tip">建物を置くと、ここに大きさが出ます。</p>';
    const row = (k, v, sub) => `<div class="sz"><span class="k">${k}</span><span class="v">${v}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
    const gaps = ['北', '東', '南', '西'].filter(k => s.gaps[k] != null).map(k => `<span class="chip ${s.gaps[k] < .5 ? 'chip-red' : 'chip-gray'}">${k}側 ${mm(Math.max(0, s.gaps[k]))}</span>`).join(' ');
    const nb = ['南', '東', '西', '北'].filter(k => s.neigh[k]).map(k => { const o = s.neigh[k]; return `<li><b>${k}</b>の家まで ${n1(o.d)}m・高さ ${n1(o.h)}m${k === '南' && o.shadow ? `<small>（冬至の正午、影は ${n1(o.shadow)}m 先まで${o.shadow > o.d ? '＝計画の建物にかかる' : '＝計画の建物までは届かない'}）</small>` : ''}</li>`; }).join('');
    return `<div class="sizegrid">
      ${row('1階の床面積', `${n1(s.a1)}㎡`, `${n1(s.tsubo1)}坪`)}
      ${row('2階の床面積', s.a2 ? `${n1(s.a2)}㎡` : '—', s.a2 ? `${n1(s.tsubo2)}坪（総2階として）` : '平屋')}
      ${row('延べ床面積', `${n1(s.total)}㎡`, `${n1(s.tsuboTotal)}坪・約${Math.round(s.jo)}帖`)}
      ${row('建ぺい率・容積率', `${pct(s.coverage)}`, `容積率 ${pct(s.far)}`)}
      ${row('間口 × 奥行', `${mm(s.w)} × ${mm(s.d)}`, '外形のいちばん外（mm）')}
      ${row('高さ', `軒 ${n1(s.eave)}m`, `いちばん高い所 ${n1(s.top)}m`)}
      ${row('敷地の残り', `${n1(s.free)}㎡`, `${n1(s.free / TSUBO)}坪（庭・駐車場・通路）`)}
      ${row('外周・外壁・屋根', `${n1(s.per)}m`, `外壁 約${Math.round(s.wall)}㎡・屋根 約${Math.round(s.roof)}㎡`)}
    </div>
    ${gaps ? `<p class="szline"><span class="k">境界まで</span>${gaps}</p>` : ''}
    ${nb ? `<ul class="sznb">${nb}</ul>` : ''}
    <p class="tip">2階は1階と同じ広さ（総2階）として出しています。外壁・屋根の面積は窓を引かない概算（屋根は軒の出45cm・4.5寸勾配）。境界までは建物の角から境界線へ直角に測ったいちばん短い所です。</p>`;
  }
  return { TSUBO, sizeInfo, polyDist, DIR4, html };
});
