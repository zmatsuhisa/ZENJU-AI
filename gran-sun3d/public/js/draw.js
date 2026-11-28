// 配置図に手で描いた線を、きれいな直線・角にそろえる計算。画面（ブラウザ）とテスト（node）の両方で使う。
// 座標は 原点＝ピン位置、x=東、z=南、単位 m。angle は「図面の向き」（度・時計回り）で、角度とマス目はこの向きでそろえる。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Draw = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const R = Math.PI / 180;
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  // 図面の向きの座標（u=東西、v=南北）と行き来する
  const toUV = (p, angle) => { const a = angle * R, c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[1] * s, -p[0] * s + p[1] * c]; };
  const toXZ = (q, angle) => { const a = angle * R, c = Math.cos(a), s = Math.sin(a); return [q[0] * c - q[1] * s, q[0] * s + q[1] * c]; };

  // 線を間引く（Ramer–Douglas–Peucker）。eps より小さいブレは消える
  function simplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [i, j] = stack.pop(); let best = -1, bi = -1;
      const [ax, az] = pts[i], [bx, bz] = pts[j], L = Math.hypot(bx - ax, bz - az) || 1e-9;
      for (let k = i + 1; k < j; k++) { const d = Math.abs((bx - ax) * (az - pts[k][1]) - (ax - pts[k][0]) * (bz - az)) / L; if (d > best) { best = d; bi = k; } }
      if (best > eps) { keep[bi] = 1; stack.push([i, bi], [bi, j]); }
    }
    return pts.filter((_, k) => keep[k]);
  }

  // 近すぎる点をまとめる
  function dedupe(pts, minLen, closed) {
    const out = [];
    pts.forEach(p => { if (!out.length || dist(out[out.length - 1], p) >= minLen) out.push(p); });
    if (closed && out.length > 2 && dist(out[0], out[out.length - 1]) < minLen) out.pop();
    return out;
  }

  // 2本の直線（点 p・向き d）の交点。平行なら null
  function cross(p1, d1, p2, d2) {
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / den;
    return [p1[0] + d1[0] * t, p1[1] + d1[1] * t];
  }
  const project = (p, o, d) => { const t = (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1]; return [o[0] + d[0] * t, o[1] + d[1] * t]; };

  // マス目に寄せる（図面の向きで、origin を原点に grid m 間隔）
  function snapGrid(p, grid, angle, origin) {
    if (!grid) return p;
    const o = origin || [0, 0], q = toUV([p[0] - o[0], p[1] - o[1]], angle);
    const r = toXZ([Math.round(q[0] / grid) * grid, Math.round(q[1] / grid) * grid], angle);
    return [r[0] + o[0], r[1] + o[1]];
  }

  // 一直線に並んだ点を取り除く
  function dropCollinear(pts, closed, tol) {
    let out = pts.slice(), changed = true;
    while (changed && out.length > (closed ? 3 : 2)) {
      changed = false;
      for (let i = closed ? 0 : 1; i < (closed ? out.length : out.length - 1); i++) {
        const a = out[(i - 1 + out.length) % out.length], b = out[i], c = out[(i + 1) % out.length];
        const L = dist(a, c) || 1e-9, d = Math.abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])) / L;
        if (d < tol && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) > 0) { out.splice(i, 1); changed = true; break; }
      }
    }
    return out;
  }

  // 描いた点の並び → 直線の並び。
  // opt: {closed, step: 角度をそろえる刻み（度。0でそろえない）, angle: 図面の向き, grid: マス目 m（0で寄せない）, origin, minLen: これより短い辺はまとめる m}
  function straighten(raw, opt) {
    const o = Object.assign({ closed: false, step: 90, angle: 0, grid: 0, minLen: .3 }, opt);
    let pts = dedupe(raw, o.minLen, o.closed);
    if (pts.length < 2) return pts;
    let out;
    if (!o.step) out = pts.slice();
    else {
      // 辺ごとに向きをそろえ、まん中を通る直線にする
      const n = o.closed ? pts.length : pts.length - 1;
      let lines = [];
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length], L = dist(a, b);
        if (L < 1e-6) continue;
        let th = Math.atan2(b[1] - a[1], b[0] - a[0]) / R - o.angle;
        th = Math.round(th / o.step) * o.step + o.angle;
        lines.push({ m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d: [Math.cos(th * R), Math.sin(th * R)], L, k: ((Math.round((th - o.angle) / o.step) % (180 / o.step)) + 180 / o.step) % (180 / o.step) });
      }
      // 同じ向きが続く辺は1本にまとめる（長さで重みをつけて真ん中の位置を決める）
      const merged = [];
      lines.forEach(l => {
        const last = merged[merged.length - 1];
        if (last && last.k === l.k) { const w = last.L + l.L; last.m = [(last.m[0] * last.L + l.m[0] * l.L) / w, (last.m[1] * last.L + l.m[1] * l.L) / w]; last.L = w; }
        else merged.push(Object.assign({}, l));
      });
      if (o.closed && merged.length > 1 && merged[0].k === merged[merged.length - 1].k) {
        const a = merged.pop(), b = merged[0], w = a.L + b.L; b.m = [(a.m[0] * a.L + b.m[0] * b.L) / w, (a.m[1] * a.L + b.m[1] * b.L) / w]; b.L = w;
      }
      lines = merged;
      if (o.closed && lines.length < 3) return null;
      out = [];
      if (o.closed) {
        for (let i = 0; i < lines.length; i++) { const p = lines[(i - 1 + lines.length) % lines.length], q = lines[i]; const x = cross(p.m, p.d, q.m, q.d); if (x) out.push(x); }
      } else {
        out.push(project(pts[0], lines[0].m, lines[0].d));
        for (let i = 1; i < lines.length; i++) { const x = cross(lines[i - 1].m, lines[i - 1].d, lines[i].m, lines[i].d); if (x) out.push(x); }
        out.push(project(pts[pts.length - 1], lines[lines.length - 1].m, lines[lines.length - 1].d));
      }
    }
    if (o.grid) out = out.map(p => snapGrid(p, o.grid, o.angle, o.origin));
    out = dedupe(out, 1e-3, o.closed);
    out = dropCollinear(out, o.closed, 1e-3);
    if (o.closed && out.length < 3) return null;
    return out;
  }

  function area(P) { let s = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }
  function inPoly(x, z, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c; } return c; }
  // 点から線分へのいちばん近い点
  function nearestOnSeg(p, a, b) { const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1e-9; const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2)); return { q: [a[0] + dx * t, a[1] + dz * t], t }; }

  // 多角形を内側へ d m ずらした線（境界から50cmの線など）。辺の直線をずらして隣どうしの交点をとる
  function inset(P, d) {
    const n = P.length; if (n < 3) return [];
    const lines = P.map((a, i) => {
      const b = P[(i + 1) % n], L = dist(a, b) || 1e-9, dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
      let nrm = [-dir[1], dir[0]]; const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!inPoly(m[0] + nrm[0] * .01, m[1] + nrm[1] * .01, P)) nrm = [-nrm[0], -nrm[1]];
      return { m: [m[0] + nrm[0] * d, m[1] + nrm[1] * d], d: dir };
    });
    const out = [];
    for (let i = 0; i < n; i++) { const p = lines[(i - 1 + n) % n], q = lines[i]; out.push(cross(p.m, p.d, q.m, q.d) || q.m); }
    return out;
  }


  // ---------- 寸法で合わせる ----------
  // 多角形 P の i 番目の辺（P[i]→P[i+1]）の、内側を向いた長さ1の法線
  function inwardNormal(P, i) {
    const a = P[i], b = P[(i + 1) % P.length], L = dist(a, b) || 1e-9;
    let n = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]; const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!inPoly(m[0] + n[0] * .01, m[1] + n[1] * .01, P)) n = [-n[0], -n[1]];
    return n;
  }
  // 点 p の、直線（a を通り内向き法線 n）からの距離（内側が＋）
  const offsetFrom = (p, a, n) => (p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1];
  const move = (P, d) => P.map(p => [p[0] + d[0], p[1] + d[1]]);
  function rotate(P, c, deg) { const a = deg * R, cs = Math.cos(a), sn = Math.sin(a); return P.map(p => { const x = p[0] - c[0], z = p[1] - c[1]; return [c[0] + x * cs - z * sn, c[1] + x * sn + z * cs]; }); }
  // 建物 P の辺 be を、敷地 lot の辺 le と平行にする（回す角度がいちばん小さい向きで。辺のまん中を中心に回す）
  function alignEdge(P, be, lot, le) {
    const a = P[be], b = P[(be + 1) % P.length], la = lot[le], lb = lot[(le + 1) % lot.length];
    let d = Math.atan2(lb[1] - la[1], lb[0] - la[0]) / R - Math.atan2(b[1] - a[1], b[0] - a[0]) / R;
    while (d > 90) d -= 180; while (d < -90) d += 180;
    return { P: rotate(P, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d), deg: d };
  }
  // 今の「辺 be のまん中 ↔ 敷地の辺 le」の距離
  function edgeGap(P, be, lot, le) { const a = P[be], b = P[(be + 1) % P.length]; return offsetFrom([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], lot[le], inwardNormal(lot, le)); }
  // 辺 be を敷地の辺 le から d m 離す（建物ごと境界に直角に動かす）。動かした量も返す
  function placeEdge(P, be, lot, le, d) { const n = inwardNormal(lot, le), t = d - edgeGap(P, be, lot, le), m = [n[0] * t, n[1] * t]; return { P: move(P, m), move: m }; }
  // 敷地の角 lv に集まる2本の境界（手前の辺 lv-1 と、先の辺 lv）
  const cornerEdges = (lot, lv) => [(lv - 1 + lot.length) % lot.length, lv];
  // 建物の角 bv の、敷地の角 lv に集まる2本の境界からの距離
  function cornerGap(P, bv, lot, lv) { return cornerEdges(lot, lv).map(e => offsetFrom(P[bv], lot[e === lv ? lv : e], inwardNormal(lot, e))); }
  // 建物の角 bv を、2本の境界から d1・d2 m の所へ（建物ごと動かす）
  function placeCorner(P, bv, lot, lv, d1, d2) {
    const [e1, e2] = cornerEdges(lot, lv), n1 = inwardNormal(lot, e1), n2 = inwardNormal(lot, e2), c = lot[lv];
    const det = n1[0] * n2[1] - n1[1] * n2[0];
    if (Math.abs(det) < 1e-6) return null; // 2本の境界が一直線
    const q = [(d1 * n2[1] - d2 * n1[1]) / det, (n1[0] * d2 - n2[0] * d1) / det];
    const m = [c[0] + q[0] - P[bv][0], c[1] + q[1] - P[bv][1]];
    return { P: move(P, m), move: m };
  }

  // ---------- 決めた寸法を守る ----------
  // dims: [{k:'e', be:建物の辺, le:敷地の辺, d:距離 m, par:平行も守るか} | {k:'c', bv:建物の角, lv:敷地の角, d1, d2}]
  // 寸法の直線（敷地の辺 le を内側へ d ずらした線）
  function dimLine(lot, le, d) { const n = inwardNormal(lot, le), a = lot[le], b = lot[(le + 1) % lot.length], L = dist(a, b) || 1e-9; return { o: [a[0] + n[0] * d, a[1] + n[1] * d], dir: [(b[0] - a[0]) / L, (b[1] - a[1]) / L], n }; }
  const onLine = (p, l) => project(p, l.o, l.dir);
  function cornerPoint(lot, lv, d1, d2) { const [e1, e2] = cornerEdges(lot, lv), l1 = dimLine(lot, e1, d1), l2 = dimLine(lot, e2, d2); return cross(l1.o, l1.dir, l2.o, l2.dir); }
  // 形を直したあと、寸法の条件を満たすように角を合わせる（決めた角は元の所へ、決めた辺は寸法の線の上へ）
  function keepDims(P, dims, lot) {
    if (!dims || !dims.length) return P;
    const Q = P.map(p => p.slice()), n = Q.length;
    for (let pass = 0; pass < 3; pass++) {
      dims.forEach(dm => {
        if (dm.k !== 'e' || Q[dm.be] == null) return;
        const l = dimLine(lot, dm.le, dm.d), i = dm.be, j = (i + 1) % n;
        if (dm.par !== false) { Q[i] = onLine(Q[i], l); Q[j] = onLine(Q[j], l); }
        else { const m = [(Q[i][0] + Q[j][0]) / 2, (Q[i][1] + Q[j][1]) / 2], t = dm.d - offsetFrom(m, lot[dm.le], l.n); Q[i] = [Q[i][0] + l.n[0] * t, Q[i][1] + l.n[1] * t]; Q[j] = [Q[j][0] + l.n[0] * t, Q[j][1] + l.n[1] * t]; }
      });
      // 2本の決めた辺が集まる角は、2本の線が交わる所
      dims.forEach(a => dims.forEach(b => {
        if (a.k !== 'e' || b.k !== 'e' || a.par === false || b.par === false || (a.be + 1) % n !== b.be) return;
        const la = dimLine(lot, a.le, a.d), lb = dimLine(lot, b.le, b.d), x = cross(la.o, la.dir, lb.o, lb.dir); if (x) Q[b.be] = x;
      }));
      dims.forEach(dm => { if (dm.k === 'c' && Q[dm.bv] != null) { const x = cornerPoint(lot, dm.lv, dm.d1, dm.d2); if (x) Q[dm.bv] = x; } });
    }
    return Q;
  }
  // 建物ごと動かすとき：寸法で決まった向きの動きを取り除く（決まっていない向きにだけ動く）
  function allowedMove(t, dims, lot) {
    const N = [];
    (dims || []).forEach(dm => { if (dm.k === 'e') N.push(inwardNormal(lot, dm.le)); else cornerEdges(lot, dm.lv).forEach(e => N.push(inwardNormal(lot, e))); });
    if (!N.length) return t;
    const n1 = N[0];
    if (N.some(n => Math.abs(n1[0] * n[1] - n1[1] * n[0]) > 1e-3)) return [0, 0]; // 2つの向きが決まっている
    const k = t[0] * n1[0] + t[1] * n1[1];
    return [t[0] - n1[0] * k, t[1] - n1[1] * k];
  }
  // 角を足したとき（辺 e の途中に）・消したとき（角 v）に、寸法の番号を付け直す
  function dimsAfterInsert(dims, e) {
    const out = [];
    (dims || []).forEach(d => {
      const c = Object.assign({}, d);
      if (c.k === 'e') { if (c.be > e) c.be++; out.push(c); if (d.be === e) out.push(Object.assign({}, d, { be: e + 1 })); }
      else { if (c.bv > e) c.bv++; out.push(c); }
    });
    return out;
  }
  function dimsAfterDelete(dims, v, n) {
    const out = [];
    (dims || []).forEach(d => {
      const c = Object.assign({}, d);
      if (c.k === 'e') { if (c.be === v || c.be === (v - 1 + n) % n) return; if (c.be > v) c.be--; }
      else { if (c.bv === v) return; if (c.bv > v) c.bv--; }
      out.push(c);
    });
    return out;
  }

  return { dimLine, cornerPoint, keepDims, allowedMove, dimsAfterInsert, dimsAfterDelete, inwardNormal, offsetFrom, rotate, alignEdge, edgeGap, placeEdge, cornerEdges, cornerGap, placeCorner, R, dist, toUV, toXZ, simplify, straighten, snapGrid, area, inPoly, nearestOnSeg, inset };
});
