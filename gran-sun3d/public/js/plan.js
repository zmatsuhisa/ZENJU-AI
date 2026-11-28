// 配置図：敷地を真上から見た図に、建物の外周を手で描く。描いた線は直線・角・マス目にそろえる。
// 描いた形は localStorage（gos-sun-draw-<記号>）に残し、3Dのページが読んで日照の計算に入れる。
(() => {
const S = window.SunCalc3D, D = window.Draw;
const $ = id => document.getElementById(id);
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
const mm = m => Math.round(m * 1000).toLocaleString('ja-JP');
const YEAR = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 4);

// ---------- 設定 ----------
const SET = Object.assign({ straight: 1, strength: 12, step: 90, grid: .91, close: 30, setback: 1, contour: 1 }, store.get('gos-sun-draw-set') || {});
function syncSet() {
  document.querySelectorAll('[data-set]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.val === +SET[b.dataset.set])));
  const sl = { 0: '', 90: '直角に', 45: '45°ごとに' }[SET.step];
  $('hint').dataset.base = SET.straight ? `描いた線は${sl ? sl + 'そろえ、' : ''}${SET.grid ? mm(SET.grid) + 'のマス目に寄せます' : '直線にします'}` : '手描きのまま残します';
}
document.querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => { SET[b.dataset.set] = +b.dataset.val; store.set('gos-sun-draw-set', SET); syncSet(); draw(); }));
syncSet();

// ---------- 敷地 ----------
let SITE = '', SD = null, LOT = null, ANG = 0, ORG = [0, 0], OCC = [], lotArea = 0, setbackLine = [];
let DRAWN = { bldgs: [], win: null };   // bldgs: [{p:[[x,z]...], f:階数}]
let cur = null;                          // 描いている途中：{raw:[[x,z]...]}
let sel = -1, mode = 'draw';
let dimPick = null; // 寸法で選んでいるもの {k:'e'|'c', b:建物, i:辺か角, l:敷地の辺か角}
const hist = [], fut = [];
const saveKey = () => 'gos-sun-draw-' + SITE;
function snapshot() { hist.push(JSON.stringify({ DRAWN, cur })); if (hist.length > 60) hist.shift(); fut.length = 0; }
function save() { store.set(saveKey(), DRAWN); later(calc, 400); }

function lotAngle(P) {
  let best = 0, ang = 0;
  P.forEach((p, i) => { const q = P[(i + 1) % P.length], L = D.dist(p, q); if (L > best) { best = L; let a = Math.atan2(q[1] - p[1], q[0] - p[0]) / D.R; while (a > 45) a -= 90; while (a < -45) a += 90; ang = a; } });
  return Math.round(ang * 10) / 10;
}
// 直した高さの保存先。建物のデータ（地理院／PLATEAU）が変わると番号も変わるので分ける
const hKey = () => 'gos-sun-h-' + SITE + (SD && SD.src && SD.src !== '地理院' ? '-pl' : '');
// まわりの建物の高さ（3Dのページで直したものを使う）
function loadHeights() { const H = store.get(hKey()) || {}; OCC = SD.b.map((b, i) => { const h = H[i] != null ? H[i] : b.h; return S.occluder(b.p, b.r === 'g' ? h + b.o.W * .11 : h, b.y || 0); }); }
// 地形（地面の高さ・遠くの山・盛土）
const fillKey = () => 'gos-sun-fill-' + SITE;
function loadTerrain() { S.setEnv({ T: S.terrainFn(SD.terr), hor: SD.hor || null, fill: store.get(fillKey()) || 0 }); $('fillin').value = Math.round((S.env.fill || 0) * 1000); contourCache = null; }
$('fillin').addEventListener('change', e => { const v = +e.target.value; if (!isFinite(v)) return; store.set(fillKey(), v / 1000); S.setEnv({ fill: v / 1000 }); later(calc, 200); draw(); });
function loadSiteData(data, key) {
  SD = data; SITE = key; LOT = data.lot; ANG = lotAngle(LOT);
  loadTerrain();
  store.set('gos-sun-site', key);
  // マス目の原点：図面の向きで見た敷地の北西の角
  const uv = LOT.map(p => D.toUV(p, ANG)); ORG = D.toXZ([Math.min(...uv.map(q => q[0])), Math.min(...uv.map(q => q[1]))], ANG);
  loadHeights();
  lotArea = D.area(LOT); setbackLine = D.inset(LOT, .5);
  DRAWN = store.get(saveKey()) || { bldgs: [], win: null }; cur = null; sel = -1; hist.length = 0; fut.length = 0; closeDim();
  DRAWN.bldgs.forEach(b => (b.dims || []).forEach(d => { if (d.k === 'e' && d.d == null) { d.d = D.edgeGap(b.p, d.be, LOT, d.le); d.par = true; } if (d.k === 'c' && d.m !== 'a') { [d.d1, d.d2] = D.cornerAlong(b.p, d.bv, LOT, d.lv); d.m = 'a'; } }));
  $('sitename').textContent = (data.name || '敷地') + ' 配置図'; document.title = 'グランOS｜配置図 ' + (data.name || '');
  $('lotnote').textContent = (data.lotNote || '敷地の形は地図からの概算（測量図ではない）') + `。敷地 約${lotArea.toFixed(1)}㎡`;
  ['to3d', 'to3d2'].forEach(id => $(id).href = 'index.html?site=' + encodeURIComponent(key));
  if ($('load')) $('load').remove();
  fit(); setMode('draw'); calc();
}

// ---------- 画面の座標 ----------
const cv = $('cv'), g = cv.getContext('2d'), stage = $('stage');
let W = 0, Hh = 0, dpr = 1;
const view = { x: 0, z: 0, s: 10 }; // 画面のまん中の位置（m）と 1m あたりの画素
const toS = p => [(p[0] - view.x) * view.s + W / 2, (p[1] - view.z) * view.s + Hh / 2];
const toW = (sx, sy) => [(sx - W / 2) / view.s + view.x, (sy - Hh / 2) / view.s + view.z];
function size() { const r = stage.getBoundingClientRect(); dpr = Math.min(devicePixelRatio || 1, 2); W = r.width; Hh = r.height; cv.width = W * dpr; cv.height = Hh * dpr; cv.style.width = W + 'px'; cv.style.height = Hh + 'px'; draw(); }
new ResizeObserver(size).observe(stage);
function fit() {
  if (!LOT) return;
  const xs = LOT.map(p => p[0]), zs = LOT.map(p => p[1]);
  view.x = (Math.min(...xs) + Math.max(...xs)) / 2; view.z = (Math.min(...zs) + Math.max(...zs)) / 2;
  const top = W < 760 ? 76 : 150, bottom = W < 760 ? 100 : 150; // 上の数字と下の道具のぶん
  view.s = Math.min((W - 40) / (Math.max(...xs) - Math.min(...xs) + 8), (Hh - top - bottom) / (Math.max(...zs) - Math.min(...zs) + 6));
  view.z -= (top - bottom) / 2 / view.s;
  draw();
}
$('fit').addEventListener('click', fit);

// ---------- 描く ----------
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#272727';
function path(P, close) { P.forEach((p, i) => { const [x, y] = toS(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); if (close) g.closePath(); }
function label(t, p, opt) {
  const o = Object.assign({ size: 12, color: '#272727', bg: 'rgba(255,255,255,.85)', weight: 700 }, opt);
  g.font = `${o.weight} ${o.size}px Poppins,"Zen Kaku Gothic New",sans-serif`; const w = g.measureText(t).width;
  const [x, y] = toS(p); g.fillStyle = o.bg; g.beginPath(); g.roundRect ? g.roundRect(x - w / 2 - 5, y - o.size / 2 - 4, w + 10, o.size + 8, 6) : g.rect(x - w / 2 - 5, y - o.size / 2 - 4, w + 10, o.size + 8); g.fill();
  g.fillStyle = o.color; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t, x, y + .5);
}
function edgeLabels(P, closed, color) {
  if (view.s < 6) return;
  const n = closed ? P.length : P.length - 1;
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % P.length], L = D.dist(a, b); if (L * view.s < 34) continue;
    let nx = (b[1] - a[1]) / L, nz = -(b[0] - a[0]) / L; const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (closed && D.inPoly(m[0] + nx * .05, m[1] + nz * .05, P)) { nx = -nx; nz = -nz; }
    label(mm(L), [m[0] + nx * 14 / view.s, m[1] + nz * 14 / view.s], { size: 11, color });
  }
}
let stroke = null;
function draw() {
  if (!W) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = '#eeece6'; g.fillRect(0, 0, W, Hh);
  if (!SD) return;
  // 道路・水路
  g.lineCap = 'round'; g.lineJoin = 'round';
  SD.r.forEach(r => { g.strokeStyle = '#c9c7c0'; g.lineWidth = r.w * view.s; g.beginPath(); path(r.p); g.stroke(); });
  SD.w.forEach(P => { g.fillStyle = '#b9d3df'; g.beginPath(); path(P, true); g.fill(); });
  // マス目（図面の向き）
  if (SET.grid && view.s * SET.grid >= 6) {
    const c = [toW(0, 0), toW(W, 0), toW(W, Hh), toW(0, Hh)].map(p => D.toUV([p[0] - ORG[0], p[1] - ORG[1]], ANG));
    const u0 = Math.min(...c.map(q => q[0])), u1 = Math.max(...c.map(q => q[0])), v0 = Math.min(...c.map(q => q[1])), v1 = Math.max(...c.map(q => q[1]));
    const line = (a, b, major) => { g.strokeStyle = major ? 'rgba(39,39,39,.16)' : 'rgba(39,39,39,.07)'; g.lineWidth = 1; g.beginPath(); const p = D.toXZ(a, ANG), q = D.toXZ(b, ANG); const [x1, y1] = toS([p[0] + ORG[0], p[1] + ORG[1]]), [x2, y2] = toS([q[0] + ORG[0], q[1] + ORG[1]]); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
    for (let k = Math.floor(u0 / SET.grid); k <= u1 / SET.grid; k++) line([k * SET.grid, v0], [k * SET.grid, v1], k % 4 === 0);
    for (let k = Math.floor(v0 / SET.grid); k <= v1 / SET.grid; k++) line([u0, k * SET.grid], [u1, k * SET.grid], k % 4 === 0);
  }
  if (shadeOn) drawShadows();
  // まわりの建物
  SD.b.forEach((b, i) => { const o = OCC[i]; g.fillStyle = o.h > 8 ? '#a9a6a0' : '#c3c0b9'; g.strokeStyle = '#8d8a84'; g.lineWidth = 1; g.beginPath(); path(b.p, true); g.fill(); g.stroke(); });
  if (view.s > 9) SD.b.forEach((b, i) => { const o = OCC[i]; const c = [(o.x0 + o.x1) / 2, (o.z0 + o.z1) / 2]; if (Math.hypot(c[0] - view.x, c[1] - view.z) * view.s < Math.max(W, Hh)) label(`${o.h.toFixed(0)}m`, c, { size: 10, color: '#555', bg: 'rgba(255,255,255,.6)', weight: 600 }); });
  // 敷地
  g.fillStyle = 'rgba(90,168,100,.18)'; g.strokeStyle = '#3f8f4c'; g.lineWidth = 2; g.beginPath(); path(LOT, true); g.fill(); g.stroke();
  if (SET.setback && setbackLine.length) { g.setLineDash([6, 5]); g.strokeStyle = 'rgba(63,143,76,.8)'; g.lineWidth = 1.2; g.beginPath(); path(setbackLine, true); g.stroke(); g.setLineDash([]); }
  if (SET.contour && SD.terr) drawContours();
  edgeLabels(LOT, true, '#2f6e3a');
  // 描いた建物
  DRAWN.bldgs.forEach((b, i) => {
    const on = i === sel;
    const out = outside(b.p);
    g.fillStyle = out ? 'rgba(200,55,45,.22)' : b.f === 1 ? 'rgba(249,193,60,.38)' : 'rgba(247,137,10,.32)'; g.strokeStyle = out ? '#c8372d' : on ? '#272727' : '#f7890a'; g.lineWidth = on ? 3 : 2.2;
    g.beginPath(); path(b.p, true); g.fill(); g.stroke();
    const c = centroid(b.p), a = D.area(b.p);
    label(`${b.f === 1 ? '平屋' : '2階'}  ${a.toFixed(1)}㎡`, c, { size: 12, color: '#272727' });
    if (on || mode === 'edit') { edgeLabels(b.p, true, '#b06a00'); b.p.forEach(p => dot(p, on ? '#272727' : '#f7890a', 5)); }
  });
  drawDims();
  // LDK の窓
  const w = DRAWN.win || (DRAWN.bldgs.length ? S.autoWindow(DRAWN.bldgs.map(b => ({ p: b.p })), ANG) : null);
  if (w) { dot(w, '#f7890a', 7, '#fff'); label(DRAWN.win ? 'LDKの窓' : 'LDKの窓（自動）', [w[0], w[1] + 22 / view.s], { size: 11, color: '#b06a00' }); }
  // 描いている途中
  if (cur) {
    const P = shape(cur.raw, false);
    g.strokeStyle = '#f7890a'; g.lineWidth = 3; g.beginPath(); path(P); g.stroke();
    edgeLabels(P, false, '#b06a00'); P.forEach(p => dot(p, '#f7890a', 4));
    dot(P[0], '#272727', 7, '#fff');
    if (SET.close) { const [x, y] = toS(P[0]); g.strokeStyle = 'rgba(39,39,39,.35)'; g.setLineDash([4, 4]); g.beginPath(); g.arc(x, y, SET.close, 0, 7); g.stroke(); g.setLineDash([]); }
  }
  if (stroke && stroke.length > 1) {
    g.strokeStyle = 'rgba(39,39,39,.35)'; g.lineWidth = 2; g.beginPath(); path(stroke); g.stroke();
    if (SET.straight && stroke.length > 2) { const simp = D.simplify(stroke, SET.strength / view.s), raw = cur ? cur.raw.concat(simp) : simp, P = shape(raw, false); g.setLineDash([7, 5]); g.strokeStyle = '#f7890a'; g.lineWidth = 2.5; g.beginPath(); path(P.slice(cur ? Math.max(0, shape(cur.raw, false).length - 1) : 0)); g.stroke(); g.setLineDash([]); }
  }
  // 方位と縮尺
  const nx = W - 34, ny = Hh - 190 < 120 ? 120 : 150;
  g.save(); g.translate(nx, ny); g.fillStyle = '#272727'; g.beginPath(); g.moveTo(0, -18); g.lineTo(7, 8); g.lineTo(0, 3); g.lineTo(-7, 8); g.closePath(); g.fill(); g.font = '700 12px Poppins,sans-serif'; g.textAlign = 'center'; g.fillText('N', 0, -24); g.restore();
  const bar = [1, 2, 5, 10, 20, 50].find(m => m * view.s >= 60) || 50, bx = 16, by = ny + 14;
  g.fillStyle = '#272727'; g.fillRect(bx, by, bar * view.s, 3); g.font = '600 11px Poppins,sans-serif'; g.textAlign = 'left'; g.fillText(bar + 'm', bx, by - 6);
}
// 寸法線（決めた寸法。今の値を出す）
const BLUE = '#446beb';
function dimLine(a, b, text) {
  const [x1, y1] = toS(a), [x2, y2] = toS(b);
  g.strokeStyle = BLUE; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  const L = Math.hypot(x2 - x1, y2 - y1) || 1, tx = -(y2 - y1) / L * 5, ty = (x2 - x1) / L * 5;
  [[x1, y1], [x2, y2]].forEach(([x, y]) => { g.beginPath(); g.moveTo(x - tx, y - ty); g.lineTo(x + tx, y + ty); g.stroke(); });
  // 数字は寸法線の横（線が短いときは少し離して）に置き、ほかの数字と重なりにくくする
  const off = (L < 50 ? 22 : 13) / view.s, ux = -(b[1] - a[1]) / (D.dist(a, b) || 1), uz = (b[0] - a[0]) / (D.dist(a, b) || 1);
  // 数字は敷地の中央から遠い側に置く（境界の外へ）
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], cc = centroid(LOT), sg = (mid[0] - cc[0]) * ux + (mid[1] - cc[1]) * uz < 0 ? -1 : 1;
  label(text, [(a[0] + b[0]) / 2 + ux * off * sg, (a[1] + b[1]) / 2 + uz * off * sg], { size: 11, color: BLUE });
}
function drawDims() {
  DRAWN.bldgs.forEach(b => (b.dims || []).forEach(dm => {
    const P = b.p;
    if (dm.k === 'e' && P[dm.be] && LOT[dm.le]) {
      const a = P[dm.be], c = P[(dm.be + 1) % P.length], m = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2], n = D.inwardNormal(LOT, dm.le), t = D.edgeGap(P, dm.be, LOT, dm.le);
      dimLine([m[0] - n[0] * t, m[1] - n[1] * t], m, mm(t));
    }
    if (dm.k === 'c' && P[dm.bv] && LOT[dm.lv]) {
      const p = P[dm.bv], c = LOT[dm.lv];
      if (dm.m === 'a') {
        // 境界線に沿って：角から境界の上を測り（境界の少し外に寸法線）、そこから建物の角へ点線
        const ts = D.cornerAlong(P, dm.bv, LOT, dm.lv), us = D.cornerDirs(LOT, dm.lv);
        D.cornerEdges(LOT, dm.lv).forEach((e, j) => {
          const n = D.inwardNormal(LOT, e), o = 16 / view.s, u = us[j], f = [c[0] + u[0] * ts[j], c[1] + u[1] * ts[j]];
          dimLine([c[0] - n[0] * o, c[1] - n[1] * o], [f[0] - n[0] * o, f[1] - n[1] * o], mm(ts[j]));
          const [x1, y1] = toS(f), [x2, y2] = toS(p); g.setLineDash([4, 4]); g.strokeStyle = BLUE; g.lineWidth = 1; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.setLineDash([]);
          dot(f, BLUE, 3);
        });
      } else {
        const gs = D.cornerGap(P, dm.bv, LOT, dm.lv);
        D.cornerEdges(LOT, dm.lv).forEach((e, j) => { const n = D.inwardNormal(LOT, e); dimLine([p[0] - n[0] * gs[j], p[1] - n[1] * gs[j]], p, mm(gs[j])); });
      }
    }
  }));
  if (mode !== 'dim' || !dimPick) return;
  const st = dimPick.step, k = dimPick.k, hv = dimHover, soft = 'rgba(68,107,235,.35)';
  const line = (a, b, col, w) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); path([a, b]); g.stroke(); };
  if (st <= 2) {
    // 押せる所：建物の辺（辺を選ぶとき）・建物の角（角を選ぶとき）
    DRAWN.bldgs.forEach(b => b.p.forEach((p, i) => {
      if (k !== 'c') line(p, b.p[(i + 1) % b.p.length], soft, 6);
      if (k !== 'e') dot(p, BLUE, 5, '#fff');
    }));
    if (hv && hv.b != null) { const P = DRAWN.bldgs[hv.b].p; if (hv.e != null) line(P[hv.e], P[(hv.e + 1) % P.length], BLUE, 7); if (hv.v != null) dot(P[hv.v], BLUE, 9, '#fff'); }
  } else {
    const P = DRAWN.bldgs[dimPick.b].p;
    if (k === 'e') line(P[dimPick.i], P[(dimPick.i + 1) % P.length], BLUE, 7); else dot(P[dimPick.i], BLUE, 9, '#fff');
    if (st === 3) {
      LOT.forEach((p, i) => { if (k === 'e') line(p, LOT[(i + 1) % LOT.length], soft, 8); else dot(p, BLUE, 7, '#fff'); });
      if (hv && hv.l != null) { if (k === 'e') line(LOT[hv.l], LOT[(hv.l + 1) % LOT.length], BLUE, 8); else dot(LOT[hv.l], BLUE, 11, '#fff'); }
    } else if (dimPick.l != null) {
      if (k === 'e') line(LOT[dimPick.l], LOT[(dimPick.l + 1) % LOT.length], BLUE, 6); else dot(LOT[dimPick.l], BLUE, 10, '#fff');
    }
    // 入れた長さで動いたあとの形（点線）
    if (dimPick.preview) { g.setLineDash([8, 5]); g.strokeStyle = '#f7890a'; g.lineWidth = 2.5; g.beginPath(); path(dimPick.preview, true); g.stroke(); g.setLineDash([]); }
  }
}
// 境界の呼び名（内向きの法線と反対の方角）
const DIR8 = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
function sideName(e) { const n = D.inwardNormal(LOT, e), az = Math.atan2(-n[0], n[1]) / D.R; return DIR8[Math.round(((az % 360) + 360) % 360 / 45) % 8] + '側の境界'; }
// 等高線：敷地のまわり（±12m）を 0.5m 間隔で読み、高さの幅に合わせた間隔で引く（数字は標高 m）
let contourCache = null;
function drawContours() {
  if (!contourCache) {
    const xs = LOT.map(p => p[0]), zs = LOT.map(p => p[1]), m = 12, st = .5;
    const x0 = Math.min(...xs) - m, z0 = Math.min(...zs) - m, nx = Math.ceil((Math.max(...xs) + m - x0) / st), nz = Math.ceil((Math.max(...zs) + m - z0) / st);
    const v = []; for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) v.push(S.ground(x0 + i * st, z0 + j * st));
    const lo = Math.min(...v), hi = Math.max(...v), iv = [.05, .1, .2, .25, .5, 1, 2].find(d => (hi - lo) / d <= 14) || 2;
    const segs = [], at = (i, j) => v[j * (nx + 1) + i];
    for (let lv = Math.ceil(lo / iv) * iv; lv <= hi; lv += iv) {
      const list = [];
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const c = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]], val = c.map(([a, b]) => at(a, b)), pts = [];
        for (let k = 0; k < 4; k++) { const a = val[k], b = val[(k + 1) % 4]; if ((a < lv) !== (b < lv)) { const t = (lv - a) / (b - a), [i1, j1] = c[k], [i2, j2] = c[(k + 1) % 4]; pts.push([x0 + (i1 + (i2 - i1) * t) * st, z0 + (j1 + (j2 - j1) * t) * st]); } }
        if (pts.length >= 2) list.push([pts[0], pts[1]]); if (pts.length === 4) list.push([pts[2], pts[3]]);
      }
      if (list.length) segs.push({ lv, list });
    }
    contourCache = { segs, iv };
  }
  const e0 = SD.terr.e0;
  contourCache.segs.forEach(({ lv, list }, n) => {
    const major = Math.abs(Math.round(lv / (contourCache.iv * 5)) * contourCache.iv * 5 - lv) < 1e-6;
    g.strokeStyle = major ? 'rgba(150,90,30,.75)' : 'rgba(150,90,30,.45)'; g.lineWidth = major ? 1.6 : 1; g.beginPath();
    list.forEach(([a, b]) => { const [x1, y1] = toS(a), [x2, y2] = toS(b); g.moveTo(x1, y1); g.lineTo(x2, y2); }); g.stroke();
    // 数字：敷地にいちばん近い所に1つ
    let best = null; list.forEach(([a, b]) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d = D.dist(m, centroid(LOT)); if (!best || d < best.d) best = { d, m }; });
    if (best && view.s > 6) label((e0 + lv).toFixed(contourCache.iv < .1 ? 2 : 1), best.m, { size: 10, color: '#8a5a1e', bg: 'rgba(255,255,255,.75)', weight: 600 });
  });
  // 敷地の角と中央の標高
  if (view.s > 8) {
    LOT.forEach(p => { const c = centroid(LOT), d = D.dist(p, c) || 1, q = [p[0] + (p[0] - c[0]) / d * 26 / view.s, p[1] + (p[1] - c[1]) / d * 26 / view.s]; label((e0 + S.ground(p[0], p[1])).toFixed(2), q, { size: 10, color: '#8a5a1e', bg: 'rgba(255,248,236,.9)' }); });
    const c = centroid(LOT); label(`中央 ${(e0 + S.ground(c[0], c[1])).toFixed(2)}${S.env.fill ? `（盛土 +${Math.round(S.env.fill * 1000)}）` : ''}`, [c[0], c[1] - 30 / view.s], { size: 10, color: '#8a5a1e', bg: 'rgba(255,248,236,.9)' });
  }
}
// 敷地からはみ出しているか（角が敷地の外、または辺が境界をまたぐ）
function outside(P) {
  if (P.some(p => !D.inPoly(p[0], p[1], LOT) && D.dist(nearLot(p), p) > .02)) return true;
  return P.some((p, i) => { const q = P[(i + 1) % P.length], m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; return !D.inPoly(m[0], m[1], LOT) && D.dist(nearLot(m), m) > .02; });
}
function nearLot(p) { let best = null; LOT.forEach((a, i) => { const { q } = D.nearestOnSeg(p, a, LOT[(i + 1) % LOT.length]); if (!best || D.dist(q, p) < D.dist(best, p)) best = q; }); return best; }
const centroid = P => [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
function dot(p, color, r, ring) { const [x, y] = toS(p); g.fillStyle = ring || color; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); if (ring) { g.strokeStyle = color; g.lineWidth = 3; g.stroke(); } }
const opts = closed => ({ closed, step: SET.straight ? SET.step : 0, angle: ANG, grid: SET.straight ? SET.grid : 0, origin: ORG, minLen: SET.straight ? Math.max(.3, SET.grid / 2 || .3) : .05 });
const shape = (raw, closed) => SET.straight ? (D.straighten(raw, opts(closed)) || raw) : raw;

// ---------- 数字 ----------
// 建物の大きさ（下のカード）
function updateSize() {
  if (!SD) return;
  const bl = DRAWN.bldgs.map(b => ({ p: b.p, f: b.f, eave: S.drawHeight(b.f) - 1, top: S.drawHeight(b.f) }));
  const nb = OCC.map(o => ({ p: o.p, h: o.h - (o.base || 0) }));
  $('sizebox').innerHTML = window.Size.html(bl.length ? window.Size.sizeInfo(bl, LOT, nb, ANG, S.dayInfo(YEAR + '-12-22', SD.lat, SD.lon).noon) : null);
}
function hud() {
  updateSize(); renderDimList();
  const a = DRAWN.bldgs.reduce((s, b) => s + D.area(b.p), 0);
  $('barea').innerHTML = a ? `${a.toFixed(1)}<small>㎡（${(a * .3025).toFixed(1)}坪）</small>` : '-';
  $('bratio').innerHTML = a ? `${(a / lotArea * 100).toFixed(1)}<small>％</small>` : '-';
  const s = sel >= 0 ? DRAWN.bldgs[sel] : null;
  $('selrow').hidden = !s && !cur;
  const outs = DRAWN.bldgs.filter(b => outside(b.p)).length;
  if (outs) { $('selrow').hidden = false; }
  if (s && outside(s.p)) { $('selk').innerHTML = `<span style="color:var(--red)">敷地からはみ出しています</span><small>「直す」で敷地の中に入れてください</small>`; $('fval').textContent = s.f === 1 ? '平屋' : '2階'; $('fdown').parentElement.hidden = false; }
  else if (s) { $('selk').innerHTML = `選んだ建物<small>${D.area(s.p).toFixed(1)}㎡・延べ ${(D.area(s.p) * s.f).toFixed(1)}㎡（概算）</small>`; $('fval').textContent = s.f === 1 ? '平屋' : '2階'; $('fdown').disabled = s.f <= 1; $('fup').disabled = s.f >= 2; $('fdown').parentElement.hidden = false; }
  else if (cur) { $('selk').innerHTML = `描いている途中<small>描き始めの点に戻すか「閉じる」</small>`; $('fdown').parentElement.hidden = true; }
  else if (outs) { $('selk').innerHTML = `<span style="color:var(--red)">敷地からはみ出している建物が ${outs}棟あります</span><small>「直す」で敷地の中に入れてください</small>`; $('fdown').parentElement.hidden = true; }
  if (!$('dimrow').hidden) $('selrow').hidden = true;
  $('close').hidden = !cur; $('undo').disabled = !hist.length; $('redo').disabled = !fut.length;
}
let calcT = 0; function later(fn, ms) { clearTimeout(calcT); calcT = setTimeout(fn, ms); }
let calcRun = 0;
function calc() {
  hud(); draw();
  if (!SD) return;
  if (!DRAWN.bldgs.length) { $('cmp').hidden = true; $('cmptip').textContent = '建物を描くと、ここに出ます。'; return; }
  const run = ++calcRun; $('cmp').hidden = false; $('cmpb').innerHTML = '<tr><td colspan="4" class="busy">計算しています…</td></tr>';
  const days = [['冬至', YEAR + '-12-22'], ['春分', YEAR + '-03-20'], ['夏至', YEAR + '-06-21']];
  const bl = DRAWN.bldgs.map(b => ({ p: b.p, h: S.drawHeight(b.f) }));
  const res = []; let i = 0;
  const step = () => {
    if (run !== calcRun) return;
    if (i < days.length) { res.push(S.polyStats(days[i][1], bl, DRAWN.win, LOT, OCC, SD.lat, SD.lon, ANG)); i++; setTimeout(step, 0); return; }
    const td = v => v == null ? '<td>-</td>' : `<td>${v.toFixed(1)}h</td>`;
    $('cmpb').innerHTML = `<tr><td>南の庭（平均）</td>${res.map(r => td(r.garden)).join('')}</tr><tr><td>1階LDKの窓</td>${res.map(r => td(r.ldk)).join('')}</tr>`;
    const r = res[0];
    $('cmptip').textContent = r.garden == null ? '建物の南に庭がありません。' : `冬至は、南の庭（約${r.gardenArea}㎡）に平均 ${r.garden.toFixed(1)}時間、LDKの窓に ${r.ldk == null ? '-' : r.ldk.toFixed(1)}時間 日が当たります。`;
  };
  setTimeout(step, 0);
}

// ---------- 操作 ----------
const HINT = { draw: () => cur ? '続けて次の線を描いてください。描き始めの点（白い丸）に戻ると閉じます' : '外周を1本ずつ描いてください。' + $('hint').dataset.base, edit: () => '角の点・辺・建物を引っぱって直します。建物を押すと階数を変えられます', win: () => 'LDKの窓を置く辺を押してください', dim: () => '下の手順に沿って、決めるもの → 建物 → 敷地 → 長さ の順に選んでください', pan: () => '1本の指で図をずらします' };
let hintT = 0;
function showHint(t) { $('hint').textContent = t || HINT[mode](); $('hint').hidden = false; clearTimeout(hintT); hintT = setTimeout(() => $('hint').hidden = true, 3500); }
function setMode(m) { if (m !== 'dim' || mode !== 'dim') closeDim(); mode = m; if (m === 'dim') startDim(); document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m)); if (m !== 'draw' && cur) closeCur(); showHint(); hud(); draw(); }
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

function closeCur() {
  if (!cur) return;
  const P = cur.raw.length >= 3 ? (SET.straight ? D.straighten(cur.raw, opts(true)) : cur.raw) : null;
  snapshot();
  if (P && P.length >= 3 && D.area(P) > 1) { DRAWN.bldgs.push({ p: P, f: 2 }); sel = DRAWN.bldgs.length - 1; showHint('外周を閉じました。「直す」で形や階数を直せます'); }
  else showHint('線が短くて建物になりませんでした。もう一度描いてください');
  cur = null; save(); hud(); draw();
}
$('close').addEventListener('click', closeCur);
function restore(from, to, none) { const s = from.pop(); if (!s) return showHint(none); to.push(JSON.stringify({ DRAWN, cur })); const o = JSON.parse(s); DRAWN = o.DRAWN; cur = o.cur; if (sel >= DRAWN.bldgs.length) sel = -1; closeDim(); save(); hud(); draw(); }
$('undo').addEventListener('click', () => restore(hist, fut, '戻せるものがありません'));
$('redo').addEventListener('click', () => restore(fut, hist, 'やり直せるものがありません'));
$('del').addEventListener('click', () => { snapshot(); if (cur) cur = null; else if (sel >= 0) { DRAWN.bldgs.splice(sel, 1); sel = -1; if (!DRAWN.bldgs.length) DRAWN.win = null; } save(); hud(); draw(); });
$('fdown').addEventListener('click', () => { if (sel < 0) return; snapshot(); DRAWN.bldgs[sel].f = 1; save(); hud(); draw(); });
$('fup').addEventListener('click', () => { if (sel < 0) return; snapshot(); DRAWN.bldgs[sel].f = 2; save(); hud(); draw(); });

function finishStroke(pts) {
  if (pts.length < 2) return;
  const len = pts.reduce((s, p, i) => i ? s + D.dist(p, pts[i - 1]) : 0, 0);
  if (len * view.s < 12) return; // 押しただけ
  const eps = (SET.straight ? SET.strength : 2) / view.s;
  const simp = D.simplify(pts, eps);
  snapshot();
  if (!cur) cur = { raw: simp };
  else { const last = cur.raw[cur.raw.length - 1]; cur.raw = cur.raw.concat(D.dist(simp[0], last) * view.s < 40 ? simp.slice(1) : simp); }
  // 描き始めの点に戻ったら閉じる
  const P = shape(cur.raw, false);
  if (SET.close && cur.raw.length >= 4 && D.dist(cur.raw[cur.raw.length - 1], cur.raw[0]) * view.s < SET.close) { cur.raw.pop(); closeCur(); return; }
  if (SET.close && P.length >= 4 && D.dist(P[P.length - 1], P[0]) * view.s < SET.close) { cur.raw.pop(); closeCur(); return; }
  showHint(); hud(); draw();
}

// 編集で触ったもの
function hitTest(p) {
  const tol = 16 / view.s;
  for (let i = DRAWN.bldgs.length - 1; i >= 0; i--) { const P = DRAWN.bldgs[i].p; for (let k = 0; k < P.length; k++) if (D.dist(P[k], p) < tol) return { b: i, v: k }; }
  for (let i = DRAWN.bldgs.length - 1; i >= 0; i--) { const P = DRAWN.bldgs[i].p; for (let k = 0; k < P.length; k++) { const { q } = D.nearestOnSeg(p, P[k], P[(k + 1) % P.length]); if (D.dist(q, p) < tol * .7) return { b: i, e: k }; } }
  for (let i = DRAWN.bldgs.length - 1; i >= 0; i--) if (D.inPoly(p[0], p[1], DRAWN.bldgs[i].p)) return { b: i, all: true };
  return null;
}
const snapP = p => SET.grid ? D.snapGrid(p, SET.grid, ANG, ORG) : p;
function snapDelta(d) { if (!SET.grid) return d; const q = D.toUV(d, ANG); return D.toXZ([Math.round(q[0] / SET.grid) * SET.grid, Math.round(q[1] / SET.grid) * SET.grid], ANG); }

const ptrs = new Map(); let gesture = null, act = null;
const pos = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
cv.addEventListener('pointerdown', e => {
  if (!SD) return;
  cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, pos(e));
  if (ptrs.size === 2) { stroke = null; act = null; const [a, b] = [...ptrs.values()]; gesture = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }; draw(); return; }
  if (ptrs.size > 2) return;
  const sp = pos(e), w = toW(...sp);
  if (mode === 'draw') { stroke = [w]; return; }
  if (mode === 'pan') { act = { pan: sp }; return; }
  if (mode === 'dim') { dimTap(w); return; }
  if (mode === 'win') {
    let best = null; DRAWN.bldgs.forEach(b => b.p.forEach((p, k) => { const { q } = D.nearestOnSeg(w, p, b.p[(k + 1) % b.p.length]); const d = D.dist(q, w); if (!best || d < best.d) best = { d, q, b, k }; }));
    if (best && best.d * view.s < 30) {
      const P = best.b.p, a = P[best.k], c = P[(best.k + 1) % P.length], L = D.dist(a, c); let n = [(c[1] - a[1]) / L, -(c[0] - a[0]) / L];
      if (D.inPoly(best.q[0] + n[0] * .05, best.q[1] + n[1] * .05, P)) n = [-n[0], -n[1]];
      snapshot(); DRAWN.win = [best.q[0] + n[0] * .3, best.q[1] + n[1] * .3]; save(); setMode('edit'); showHint('LDKの窓を置きました');
    } else showHint('建物の辺を押してください');
    return;
  }
  // 直す
  const h = hitTest(w);
  if (!h) { sel = -1; act = { pan: sp }; hud(); draw(); return; }
  const now = performance.now(), dbl = lastTap && now - lastTap.t < 380 && Math.hypot(sp[0] - lastTap.sp[0], sp[1] - lastTap.sp[1]) < 14; lastTap = { t: now, sp };
  if (dbl && (h.v != null || h.e != null)) { editVertex(h, w); lastTap = null; return; }
  lockT = 0; sel = h.b; act = Object.assign({ before: JSON.stringify({ DRAWN, cur }), start: w, orig: JSON.parse(JSON.stringify(DRAWN.bldgs[h.b].p)), moved: false, win: h.all && winOf(DRAWN.bldgs[h.b].p) ? DRAWN.win.slice() : null }, h); hud(); draw();
});
cv.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, pos(e));
  if (gesture && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const before = toW(...gesture.m); view.s = Math.max(2, Math.min(200, view.s * d / gesture.d)); const after = toW(...m);
    view.x += before[0] - after[0]; view.z += before[1] - after[1]; gesture = { d, m }; draw(); return;
  }
  const sp = pos(e), w = toW(...sp);
  if (stroke) { stroke.push(w); draw(); return; }
  if (!act) return;
  if (act.pan) { view.x -= (sp[0] - act.pan[0]) / view.s; view.z -= (sp[1] - act.pan[1]) / view.s; act.pan = sp; draw(); return; }
  const P = DRAWN.bldgs[act.b].p, d = [w[0] - act.start[0], w[1] - act.start[1]];
  if (!act.moved && act.before) { hist.push(act.before); if (hist.length > 60) hist.shift(); fut.length = 0; }
  const B = DRAWN.bldgs[act.b];
  if (act.v != null) { const want = magnetPoint(snapP([act.orig[act.v][0] + d[0], act.orig[act.v][1] + d[1]])); P[act.v] = want; B.p = D.keepDims(P, B.dims, LOT); if (D.dist(B.p[act.v], want) > .3) lockHint(); }
  else if (act.e != null) {
    const a = act.orig[act.e], c = act.orig[(act.e + 1) % P.length], L = D.dist(a, c), n = [(c[1] - a[1]) / L, -(c[0] - a[0]) / L];
    let t = d[0] * n[0] + d[1] * n[1]; if (SET.grid) t = Math.round(t / SET.grid) * SET.grid;
    t = magnetEdge(a, c, n, t);
    P[act.e] = [a[0] + n[0] * t, a[1] + n[1] * t]; P[(act.e + 1) % P.length] = [c[0] + n[0] * t, c[1] + n[1] * t];
    B.p = D.keepDims(P, B.dims, LOT); if (Math.abs(t) > .3 && D.dist(B.p[act.e], P[act.e]) > .3) lockHint();
  } else { const s0 = snapDelta(d), s = D.allowedMove(s0, B.dims, LOT); if (Math.hypot(s0[0] - s[0], s0[1] - s[1]) > .3) lockHint(); act.orig.forEach((p, k) => P[k] = [p[0] + s[0], p[1] + s[1]]); if (act.win) DRAWN.win = [act.win[0] + s[0], act.win[1] + s[1]]; }
  act.moved = true; hud(); draw();
});
function up(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (gesture) { if (ptrs.size < 2) gesture = null; return; }
  if (stroke) { const s = stroke; stroke = null; finishStroke(s); draw(); return; }
  if (act && act.b != null && act.moved) save();
  act = null; hud(); draw();
}
cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
cv.addEventListener('wheel', e => { e.preventDefault(); const sp = pos(e), before = toW(...sp); view.s = Math.max(2, Math.min(200, view.s * Math.exp(-e.deltaY * .0015))); const after = toW(...sp); view.x += before[0] - after[0]; view.z += before[1] - after[1]; draw(); }, { passive: false });
document.addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test((document.activeElement || {}).tagName || '')) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); $('redo').click(); return; }
  if (sel >= 0 && !cur && /^Arrow/.test(e.key)) { e.preventDefault(); const st = SET.grid || .1, u = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key]; const bb = DRAWN.bldgs[sel], m = D.allowedMove(D.toXZ(u, ANG), bb.dims, LOT); if (Math.hypot(m[0], m[1]) < 1e-6) { showHint('寸法で位置を決めてあるので、この向きには動きません'); return; } snapshot(); moveB(bb, m); save(); hud(); draw(); return; }
  if (sel >= 0 && !cur && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); $('del').click(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); $('undo').click(); } if (e.key === 'Enter' && cur) closeCur(); if (e.key === 'Escape' && cur) { snapshot(); cur = null; hud(); draw(); } });

// ---------- 直すときの手助け ----------
let lastTap = null;
// 角を2回押す→角を消す（4つより多いとき）、辺を2回押す→押した所に角を足す。寸法は番号がずれるので消す
function editVertex(h, w) {
  const b = DRAWN.bldgs[h.b]; snapshot();
  if (h.v != null) {
    if (b.p.length <= 3) { hist.pop(); return showHint('角が3つより少なくなるので消せません'); }
    if ((b.dims || []).some(d => d.k === 'c' && d.bv === h.v)) { hist.pop(); return showHint('寸法を決めた角は消せません（寸法を外してから）'); }
    const before = (b.dims || []).length; b.dims = D.dimsAfterDelete(b.dims, h.v, b.p.length); b.p.splice(h.v, 1);
    showHint(b.dims.length < before ? '角を消しました。その角の辺に決めた寸法は外れました' : '角を消しました');
  }
  else { const { q } = D.nearestOnSeg(w, b.p[h.e], b.p[(h.e + 1) % b.p.length]); b.dims = D.dimsAfterInsert(b.dims, h.e); b.p.splice(h.e + 1, 0, snapP(q)); showHint('角を足しました。引っぱって形を変えられます'); }
  b.p = D.keepDims(b.p, b.dims, LOT);
  sel = h.b; save(); hud(); draw();
}
// 境界線と50cmの線（吸い付く先）
function magnetLines() { const L = []; const add = P => P.forEach((a, i) => L.push([a, P[(i + 1) % P.length]])); add(LOT); if (SET.setback && setbackLine.length) add(setbackLine); return L; }
// 角：線の近く（画面で10画素）なら線の上へ。2本の線の近くなら交わる所へ
function magnetPoint(p) {
  const tol = 10 / view.s, near = magnetLines().map(([a, b]) => ({ a, b, ...D.nearestOnSeg(p, a, b) })).filter(o => D.dist(o.q, p) < tol).sort((x, y) => D.dist(x.q, p) - D.dist(y.q, p));
  if (!near.length) return p;
  if (near.length > 1) { const [o1, o2] = near, d1 = [o1.b[0] - o1.a[0], o1.b[1] - o1.a[1]], d2 = [o2.b[0] - o2.a[0], o2.b[1] - o2.a[1]], den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) > 1e-6) { const t = ((o2.a[0] - o1.a[0]) * d2[1] - (o2.a[1] - o1.a[1]) * d2[0]) / den, x = [o1.a[0] + d1[0] * t, o1.a[1] + d1[1] * t]; if (D.dist(x, p) < tol * 1.5) return x; } }
  return near[0].q;
}
// 辺：ほぼ平行な線の近くなら、その線にぴったり重ねる
function magnetEdge(a, c, n, t) {
  const tol = 10 / view.s, dir = Math.atan2(c[1] - a[1], c[0] - a[0]);
  let best = null;
  magnetLines().forEach(([p, q]) => {
    let dd = Math.atan2(q[1] - p[1], q[0] - p[0]) - dir; dd = Math.abs(Math.atan2(Math.sin(dd), Math.cos(dd))); if (Math.min(dd, Math.PI - dd) > 2 * D.R) return;
    const m = [(a[0] + c[0]) / 2 + n[0] * t, (a[1] + c[1]) / 2 + n[1] * t], { q: f } = D.nearestOnSeg(m, p, q), gap = (f[0] - m[0]) * n[0] + (f[1] - m[1]) * n[1];
    if (Math.abs(gap) < tol && D.dist(f, m) < tol * 1.5 && (!best || Math.abs(gap) < Math.abs(best))) best = gap;
  });
  return best == null ? t : t + best;
}

// ---------- 影（3Dのページと同じ日付・時刻） ----------
let shadeOn = false;
const TK = 'gos-sun-time';
const shadeDay = () => { const t = store.get(TK) || {}; return { md: t.md || '12-22', m: t.m || 600 }; };
function syncShadeUI() { const t = shadeDay(); $('ptime').value = t.m; $('ptout').textContent = String(Math.floor(t.m / 60)).padStart(2, '0') + ':' + String(t.m % 60).padStart(2, '0'); document.querySelectorAll('#shaderow [data-d]').forEach(b => b.classList.toggle('on', b.dataset.d === t.md)); $('ptime').style.setProperty('--p', ((t.m - 300) / 960 * 100) + '%'); }
function setShadeDay(md, m) { const t = shadeDay(); store.set(TK, { md: md || t.md, m: m == null ? t.m : m }); syncShadeUI(); draw(); }
$('shadeb').addEventListener('click', () => { shadeOn = !shadeOn; $('shadeb').setAttribute('aria-pressed', shadeOn); $('shaderow').hidden = !shadeOn; syncShadeUI(); draw(); });
document.querySelectorAll('#shaderow [data-d]').forEach(b => b.addEventListener('click', () => setShadeDay(b.dataset.d)));
$('ptime').addEventListener('input', e => setShadeDay(null, +e.target.value));
const shadeCv = document.createElement('canvas'), sg = shadeCv.getContext('2d');
// 建物の影：建物の形と、太陽と反対へずらした形をつないだ範囲。重なっても濃くならないよう別の紙に描いてから重ねる
function drawShadows() {
  const t = shadeDay(), s = S.sun(S.ms(YEAR + '-' + t.md, t.m), SD.lat, SD.lon);
  if (s.alt <= 0) { label('日が沈んでいます', toW(W / 2, 60), { size: 12 }); return; }
  if (S.behindHill(s)) { label('太陽が遠くの山に隠れています', toW(W / 2, 60), { size: 12 }); return; }
  shadeCv.width = cv.width; shadeCv.height = cv.height; sg.setTransform(dpr, 0, 0, dpr, 0, 0); sg.fillStyle = '#1d2433';
  const k = 1 / Math.tan(s.alt * D.R), dx = -Math.sin(s.az * D.R) * k, dz = Math.cos(s.az * D.R) * k;
  const shapes = OCC.map(o => ({ p: o.p, h: o.h - (o.base || 0) })).concat(DRAWN.bldgs.map(b => ({ p: b.p, h: S.drawHeight(b.f) })));
  const vx0 = toW(0, 0), vx1 = toW(W, Hh);
  shapes.forEach(({ p, h }) => {
    const ox = dx * h, oz = dz * h;
    const xs = p.map(q => q[0]), zs = p.map(q => q[1]);
    if (Math.max(...xs) + Math.max(0, ox) < vx0[0] || Math.min(...xs) + Math.min(0, ox) > vx1[0] || Math.max(...zs) + Math.max(0, oz) < vx0[1] || Math.min(...zs) + Math.min(0, oz) > vx1[1]) return;
    const sp = q => toS(q), P2 = p.map(q => [q[0] + ox, q[1] + oz]);
    const poly = Q => { sg.beginPath(); Q.forEach((q, i) => { const [x, y] = sp(q); i ? sg.lineTo(x, y) : sg.moveTo(x, y); }); sg.closePath(); sg.fill(); };
    poly(P2); p.forEach((a, i) => { const b = p[(i + 1) % p.length]; poly([a, b, P2[(i + 1) % p.length], P2[i]]); });
  });
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = .28; g.drawImage(shadeCv, 0, 0); g.restore();
}
// 3Dのページで日付・時刻や隣家の高さを変えたら、こちらも合わせる
addEventListener('storage', e => {
  if (e.key === TK) { syncShadeUI(); draw(); }
  if (SD && e.key === hKey()) { loadHeights(); later(calc, 300); draw(); }
  if (SD && e.key === fillKey()) { loadTerrain(); later(calc, 300); draw(); }
  if (SD && e.key === saveKey()) { DRAWN = store.get(saveKey()) || { bldgs: [], win: null }; hud(); draw(); later(calc, 300); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && SD) { loadHeights(); syncShadeUI(); draw(); later(calc, 300); } });

// ---------- 寸法で合わせる ----------
// LDK の窓がこの建物のものか（建物の外周から 60cm 以内）
function winOf(P) { const w = DRAWN.win; if (!w) return false; return P.some((p, k) => D.dist(D.nearestOnSeg(w, p, P[(k + 1) % P.length]).q, w) < .6); }
function moveB(b, m) { const own = winOf(b.p); b.p = b.p.map(p => [p[0] + m[0], p[1] + m[1]]); if (own) DRAWN.win = [DRAWN.win[0] + m[0], DRAWN.win[1] + m[1]]; }
// 手順：1 決めるもの → 2 建物の辺か角 → 3 敷地の境界線か角 → 4 長さ
let dimHover = null;
function startDim(k) { dimPick = { step: k ? 2 : 1, k: k || null }; dimHover = null; renderDim(); draw(); }
function closeDim() { if (dimPick && dimPick.before) { DRAWN = JSON.parse(dimPick.before); hist.pop(); save(); } dimPick = null; dimHover = null; $('dimrow').hidden = true; }
function cancelDim() { closeDim(); if (mode === 'dim') startDim(); hud(); draw(); }
function renderDim() {
  if (!dimPick) { $('dimrow').hidden = true; return; }
  const st = dimPick.step, k = dimPick.k;
  $('dimrow').hidden = false; $('selrow').hidden = true;
  document.querySelectorAll('#dsteps li').forEach(li => { const n = +li.dataset.st; li.classList.toggle('on', n === st); li.classList.toggle('done', n < st); });
  $('dchoice').hidden = st !== 1;
  ['dimin1', 'dimin2', 'dimok'].forEach(id => $(id).hidden = st !== 4);
  if (st !== 4) $('dimdel').hidden = true;
  $('dimx').textContent = st === 1 ? '閉じる' : 'やめる';
  if (st === 1) $('dimk').innerHTML = '何を決めますか？<small>建物の辺や角を、図の上で直接押して始めることもできます</small>';
  if (st === 2) $('dimk').innerHTML = k === 'c' ? '建物の角を押してください<small>青い丸のどれか</small>' : '建物の辺を押してください<small>青く光っている線のどれか</small>';
  if (st === 3) $('dimk').innerHTML = k === 'c' ? '敷地の角を押してください<small>青い丸のどれか。その角から境界線に沿って測ります</small>' : '合わせる敷地の境界線を押してください<small>押すと、建物の辺がその境界と平行になります</small>';
  if (st === 4) openDim();
  if (st >= 3) focusDim();
}
// 選んだ建物の辺や角が、下の手順の欄に隠れない所に来るよう図を寄せる
function focusDim() {
  const P = DRAWN.bldgs[dimPick.b].p, a = P[dimPick.i], c = dimPick.k === 'e' ? P[(dimPick.i + 1) % P.length] : a, pts = [a, c];
  if (dimPick.l != null) pts.push(LOT[dimPick.l]);
  const m = [pts.reduce((t, p) => t + p[0], 0) / pts.length, pts.reduce((t, p) => t + p[1], 0) / pts.length];
  const dock = document.querySelector('#stage .dock'), free = Hh - (dock ? dock.offsetHeight + 20 : 120);
  const [, y] = toS(m); if (y > 60 && y < free - 30) return; // 見えていれば動かさない
  view.x = m[0]; view.z = m[1] + (Hh / 2 - Math.max(80, free / 2)) / view.s; draw();
}
document.querySelectorAll('#dchoice [data-dk]').forEach(b => b.addEventListener('click', () => startDim(b.dataset.dk)));
$('dimx').addEventListener('click', () => { if (dimPick && dimPick.step === 1) setMode('edit'); else cancelDim(); });
// 押した所が、今の手順で選べるもの
function dimTarget(w) {
  const tol = 24 / view.s, st = dimPick.step, k = dimPick.k;
  if (st <= 2) {
    const h = hitTest(w); if (!h || h.all) return null;
    if (k === 'c' && h.v == null) { // 辺を押した：その辺の近いほうの角
      if (h.e == null) return null; const P = DRAWN.bldgs[h.b].p, a = h.e, c = (h.e + 1) % P.length; return { b: h.b, v: D.dist(P[a], w) < D.dist(P[c], w) ? a : c };
    }
    if (k === 'e' && h.e == null) return null;
    return h;
  }
  if (st === 3) {
    let best = null;
    if (k === 'e') LOT.forEach((a, i) => { const d = D.dist(D.nearestOnSeg(w, a, LOT[(i + 1) % LOT.length]).q, w); if (!best || d < best.d) best = { d, l: i }; });
    else LOT.forEach((p, i) => { const d = D.dist(p, w); if (!best || d < best.d) best = { d, l: i }; });
    return best && best.d < tol * (k === 'c' ? 1.4 : 1) ? best : null;
  }
  return null;
}
function dimTap(w) {
  if (!dimPick) startDim();
  if (dimPick.step === 4) { cancelDim(); } // 長さを入れている途中に図を押したら、選び直し
  const st = dimPick.step, t = dimTarget(w);
  if (st <= 2) {
    if (!t) { showHint(dimPick.k === 'c' ? '建物の角（青い丸）を押してください' : dimPick.k === 'e' ? '建物の辺（青く光っている線）を押してください' : '建物の辺か角を押してください'); return; }
    sel = t.b; Object.assign(dimPick, t.v != null ? { k: 'c', b: t.b, i: t.v } : { k: 'e', b: t.b, i: t.e }, { step: 3 });
    dimHover = null; renderDim(); hud(); draw(); return;
  }
  if (st === 3) {
    if (!t) { showHint(dimPick.k === 'c' ? '敷地の角（青い丸）を押してください' : '敷地の境界線（青く光っている線）を押してください'); return; }
    dimPick.l = t.l; dimPick.step = 4;
    if (dimPick.k === 'e') {
      // 辺を境界と平行にする（窓もいっしょに回す）。ほかの寸法があるときは回さず、辺のまん中で測る
      const b = DRAWN.bldgs[dimPick.b], others = (b.dims || []).filter(d => !(d.k === 'e' && d.be === dimPick.i && d.le === dimPick.l));
      const own = winOf(b.p), a = b.p[dimPick.i], c = b.p[(dimPick.i + 1) % b.p.length], r = D.alignEdge(b.p, dimPick.i, LOT, dimPick.l);
      dimPick.par = true;
      if (Math.abs(r.deg) > .05) {
        if (others.length) dimPick.par = false;
        else { dimPick.before = JSON.stringify(DRAWN); snapshot(); b.p = r.P; if (own) DRAWN.win = D.rotate([DRAWN.win], [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2], r.deg)[0]; }
      }
    }
    dimHover = null; renderDim(); hud(); draw();
  }
}
// マウスを近づけた所を光らせる
cv.addEventListener('pointermove', e => {
  if (mode !== 'dim' || !dimPick || ptrs.size || dimPick.step > 3) return;
  const t = dimTarget(toW(...pos(e))), key = JSON.stringify(t);
  if (key !== JSON.stringify(dimHover)) { dimHover = t; draw(); }
});
const toMM = m => Math.round(m * 100) * 10; // 10mm 単位
function existingDim() { const b = DRAWN.bldgs[dimPick.b]; return (b.dims || []).find(d => dimPick.k === 'e' ? d.k === 'e' && d.be === dimPick.i && d.le === dimPick.l : d.k === 'c' && d.bv === dimPick.i && d.lv === dimPick.l); }
function openDim() {
  const b = DRAWN.bldgs[dimPick.b], ex = existingDim();
  if (dimPick.k === 'e') {
    $('dimk').innerHTML = dimPick.par === false ? `${sideName(dimPick.l)}から、辺のまん中までの距離<small>ほかの寸法を決めてあるので、向きは変えません</small>` : `${sideName(dimPick.l)}から、辺までの距離<small>辺を境界と平行にしました。数字を入れると点線の位置に動きます</small>`;
    $('dl1').textContent = sideName(dimPick.l).replace('の境界', '') + 'から'; $('dv1').value = toMM(D.edgeGap(b.p, dimPick.i, LOT, dimPick.l)); $('dimin2').hidden = true;
  } else {
    const [e1, e2] = D.cornerEdges(LOT, dimPick.l), ts = D.cornerAlong(b.p, dimPick.i, LOT, dimPick.l);
    $('dimk').innerHTML = `敷地の角から、境界線に沿った長さ<small>数字を入れると点線の位置に動きます（角どうしはまっすぐ ${mm(D.dist(b.p[dimPick.i], LOT[dimPick.l]))}mm）</small>`;
    const nm = e => W < 760 ? sideName(e).replace('側の境界', '') + 'に沿って' : sideName(e).replace('の境界', '') + 'の境界に沿って';
    $('dl1').textContent = nm(e1); $('dv1').value = toMM(ts[0]);
    $('dl2').textContent = nm(e2); $('dv2').value = toMM(ts[1]); $('dimin2').hidden = false;
  }
  if (ex) { if (ex.k === 'e') $('dv1').value = toMM(ex.d); else { $('dv1').value = toMM(ex.d1); $('dv2').value = toMM(ex.d2); } }
  $('dimdel').hidden = !ex;
  dimPick.preview = null;
  setTimeout(() => { try { $('dv1').focus({ preventScroll: true }); $('dv1').select(); } catch (e) {} }, 50);
}
// 入れた長さで動かしたときの形（決めるまでは見本だけ）
function dimResult() {
  const b = DRAWN.bldgs[dimPick.b], t1 = $('dv1').value, t2 = $('dv2').value, v1 = +t1 / 1000, v2 = +t2 / 1000;
  if (t1 === '' || !isFinite(v1) || (dimPick.k === 'c' && (t2 === '' || !isFinite(v2)))) return null;
  const r = dimPick.k === 'e' ? D.placeEdge(b.p, dimPick.i, LOT, dimPick.l, v1) : D.placeCornerAlong(b.p, dimPick.i, LOT, dimPick.l, v1, v2);
  if (!r) return null;
  const pk = dimPick;
  const others = (b.dims || []).filter(d => pk.k === 'e' ? !(d.k === 'e' && (d.be === pk.i || d.le === pk.l)) : !(d.k === 'c' && (d.bv === pk.i || d.lv === pk.l)));
  const m = D.allowedMove(r.move, others, LOT);
  const dims = others.concat([pk.k === 'e' ? { k: 'e', be: pk.i, le: pk.l, d: v1, par: pk.par !== false } : { k: 'c', bv: pk.i, lv: pk.l, d1: v1, d2: v2, m: 'a' }]);
  return { m, dims, P: D.keepDims(b.p.map(p => [p[0] + m[0], p[1] + m[1]]), dims, LOT) };
}
['dv1', 'dv2'].forEach(id => $(id).addEventListener('input', () => { if (!dimPick || dimPick.step !== 4) return; const r = dimResult(); dimPick.preview = r ? r.P : null; draw(); }));
function applyDim() {
  if (!dimPick || dimPick.step !== 4) return;
  const r = dimResult();
  if (!r) { showHint('長さを mm の数字で入れてください'); return; }
  const b = DRAWN.bldgs[dimPick.b];
  if (!dimPick.before) snapshot();
  moveB(b, r.m); b.dims = r.dims; b.p = D.keepDims(b.p, b.dims, LOT);
  dimPick.before = null; save();
  showHint(outside(b.p) ? '動かしました。敷地からはみ出しています' : '寸法どおりに動かしました。この寸法は、あとで直しても守られます');
  startDim(); hud(); draw();
}
$('dimok').addEventListener('click', applyDim);
$('dimdel').addEventListener('click', () => { const ex = dimPick && existingDim(); if (!ex) return; if (dimPick.before) { DRAWN = JSON.parse(dimPick.before); hist.pop(); dimPick.before = null; } snapshot(); const b = DRAWN.bldgs[dimPick.b]; b.dims = (b.dims || []).filter(d => !(d.k === ex.k && d.be === ex.be && d.le === ex.le && d.bv === ex.bv && d.lv === ex.lv)); save(); startDim(); hud(); draw(); showHint('寸法を外しました。自由に動かせます'); });
['dv1', 'dv2'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyDim(); } }));
// 決めた寸法の一覧（下のカード）
function renderDimList() {
  const items = [];
  DRAWN.bldgs.forEach((b, bi) => (b.dims || []).forEach((d, di) => {
    const who = DRAWN.bldgs.length > 1 ? `建物${bi + 1}の` : '建物の';
    let t;
    if (d.k === 'e') t = `${who}辺 → ${sideName(d.le)}から <b>${mm(d.d)}</b>${d.par === false ? '（辺のまん中）' : '（平行）'}`;
    else { const [e1, e2] = D.cornerEdges(LOT, d.lv); t = `${who}角 → 敷地の角から ${sideName(e1)}に沿って <b>${mm(d.d1)}</b>・${sideName(e2)}に沿って <b>${mm(d.d2)}</b>`; }
    items.push(`<li><span class="t">${t}</span><button type="button" class="btn btn-sm" data-dedit="${bi},${di}">直す</button><button type="button" class="btn btn-sm" data-ddel="${bi},${di}">外す</button></li>`);
  }));
  $('dimlist').innerHTML = items.length ? items.join('') : '<li class="busy">まだありません。下の道具の「寸法」から決められます。</li>';
  $('dimlist').querySelectorAll('[data-dedit]').forEach(btn => btn.addEventListener('click', () => {
    const [bi, di] = btn.dataset.dedit.split(',').map(Number), d = DRAWN.bldgs[bi].dims[di];
    setMode('dim'); dimPick = { step: 4, k: d.k, b: bi, i: d.k === 'e' ? d.be : d.bv, l: d.k === 'e' ? d.le : d.lv, par: d.par }; sel = bi;
    renderDim(); draw(); $('stagecard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $('dimlist').querySelectorAll('[data-ddel]').forEach(btn => btn.addEventListener('click', () => {
    const [bi, di] = btn.dataset.ddel.split(',').map(Number); snapshot(); DRAWN.bldgs[bi].dims.splice(di, 1); save(); hud(); draw(); showHint('寸法を外しました');
  }));
}
let lockT = 0; function lockHint() { const now = performance.now(); if (now - lockT > 2500) { lockT = now; showHint('寸法で決めた所は動きません（寸法の道具で同じ所を押すと外せます）'); } }
['dv1', 'dv2'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyDim(); } }));
$('dimx').addEventListener('click', () => { closeDim(); hud(); draw(); });

// ---------- 敷地の読み込み ----------
async function loadSite(key) {
  try { const r = await fetch('sites/' + encodeURIComponent(key) + '.json'); if (!r.ok) throw new Error(r.status); loadSiteData(await r.json(), key); try { const u = new URL(location.href); u.searchParams.set('site', key); history.replaceState(null, '', u); } catch (e) {} }
  catch (e) { console.error(e); ($('load') || stage.appendChild(Object.assign(document.createElement('div'), { id: 'load', className: 'load' }))).textContent = '敷地のデータを読み込めませんでした。ページを再読み込みしてください。'; }
}
(async () => {
  let list = []; try { list = await (await fetch('sites/index.json')).json(); } catch (e) {}
  let key = null; try { key = new URLSearchParams(location.search).get('site'); } catch (e) {}
  if (!key || !list.some(s => s.key === key)) key = store.get('gos-sun-site');
  if (!key || !list.some(s => s.key === key)) key = list.length ? list[0].key : null;
  if (list.length > 1) { const s = $('sitesel'); s.hidden = false; s.innerHTML = list.map(x => `<option value="${x.key}">${x.name}</option>`).join(''); s.value = key; s.addEventListener('change', () => loadSite(s.value)); }
  if (!key) { $('load').textContent = '敷地のデータがありません（sites/index.json）。'; return; }
  size(); loadSite(key);
})();
window.__plan = { get LOT() { return LOT; }, applyDim, get dimPick() { return dimPick; }, get DRAWN() { return DRAWN; }, get cur() { return cur; }, view, finishStroke, toS, toW, setMode };
})();
