// 配置図：敷地を真上から見た図に、建物の外周を手で描く。描いた線は直線・角・マス目にそろえる。
// 描いた形は localStorage（gos-sun-draw-<記号>）に残し、3Dのページが読んで日照の計算に入れる。
(() => {
const S = window.SunCalc3D, D = window.Draw;
const $ = id => document.getElementById(id);
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
const mm = m => Math.round(m * 1000).toLocaleString('ja-JP');
const YEAR = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 4);

// ---------- 設定 ----------
const SET = Object.assign({ straight: 1, strength: 12, step: 90, grid: .91, close: 30, setback: 1 }, store.get('gos-sun-draw-set') || {});
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
const hist = [];
const saveKey = () => 'gos-sun-draw-' + SITE;
function snapshot() { hist.push(JSON.stringify({ DRAWN, cur })); if (hist.length > 60) hist.shift(); }
function save() { store.set(saveKey(), DRAWN); later(calc, 400); }

function lotAngle(P) {
  let best = 0, ang = 0;
  P.forEach((p, i) => { const q = P[(i + 1) % P.length], L = D.dist(p, q); if (L > best) { best = L; let a = Math.atan2(q[1] - p[1], q[0] - p[0]) / D.R; while (a > 45) a -= 90; while (a < -45) a += 90; ang = a; } });
  return Math.round(ang * 10) / 10;
}
function loadSiteData(data, key) {
  SD = data; SITE = key; LOT = data.lot; ANG = lotAngle(LOT);
  store.set('gos-sun-site', key);
  // マス目の原点：図面の向きで見た敷地の北西の角
  const uv = LOT.map(p => D.toUV(p, ANG)); ORG = D.toXZ([Math.min(...uv.map(q => q[0])), Math.min(...uv.map(q => q[1]))], ANG);
  const H = store.get('gos-sun-h-' + key) || {};
  OCC = data.b.map((b, i) => { const h = H[i] != null ? H[i] : b.h; return S.occluder(b.p, b.r === 'g' ? h + b.o.W * .11 : h); });
  lotArea = D.area(LOT); setbackLine = D.inset(LOT, .5);
  DRAWN = store.get(saveKey()) || { bldgs: [], win: null }; cur = null; sel = -1; hist.length = 0;
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
  const top = W < 760 ? 70 : 150, bottom = W < 760 ? 90 : 150; // 上の数字と下の道具のぶん
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
  // まわりの建物
  SD.b.forEach((b, i) => { const o = OCC[i]; g.fillStyle = o.h > 8 ? '#a9a6a0' : '#c3c0b9'; g.strokeStyle = '#8d8a84'; g.lineWidth = 1; g.beginPath(); path(b.p, true); g.fill(); g.stroke(); });
  if (view.s > 9) SD.b.forEach((b, i) => { const o = OCC[i]; const c = [(o.x0 + o.x1) / 2, (o.z0 + o.z1) / 2]; if (Math.hypot(c[0] - view.x, c[1] - view.z) * view.s < Math.max(W, Hh)) label(`${o.h.toFixed(0)}m`, c, { size: 10, color: '#555', bg: 'rgba(255,255,255,.6)', weight: 600 }); });
  // 敷地
  g.fillStyle = 'rgba(90,168,100,.18)'; g.strokeStyle = '#3f8f4c'; g.lineWidth = 2; g.beginPath(); path(LOT, true); g.fill(); g.stroke();
  if (SET.setback && setbackLine.length) { g.setLineDash([6, 5]); g.strokeStyle = 'rgba(63,143,76,.8)'; g.lineWidth = 1.2; g.beginPath(); path(setbackLine, true); g.stroke(); g.setLineDash([]); }
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
  if (stroke && stroke.length > 1) { g.strokeStyle = 'rgba(39,39,39,.55)'; g.lineWidth = 2; g.beginPath(); path(stroke); g.stroke(); }
  // 方位と縮尺
  const nx = W - 34, ny = Hh - 190 < 120 ? 120 : 150;
  g.save(); g.translate(nx, ny); g.fillStyle = '#272727'; g.beginPath(); g.moveTo(0, -18); g.lineTo(7, 8); g.lineTo(0, 3); g.lineTo(-7, 8); g.closePath(); g.fill(); g.font = '700 12px Poppins,sans-serif'; g.textAlign = 'center'; g.fillText('N', 0, -24); g.restore();
  const bar = [1, 2, 5, 10, 20, 50].find(m => m * view.s >= 60) || 50, bx = 16, by = ny + 14;
  g.fillStyle = '#272727'; g.fillRect(bx, by, bar * view.s, 3); g.font = '600 11px Poppins,sans-serif'; g.textAlign = 'left'; g.fillText(bar + 'm', bx, by - 6);
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
function hud() {
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
  $('close').disabled = !cur;
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
const HINT = { draw: () => cur ? '続けて次の線を描いてください。描き始めの点（白い丸）に戻ると閉じます' : '外周を1本ずつ描いてください。' + $('hint').dataset.base, edit: () => '角の点・辺・建物を引っぱって直します。建物を押すと階数を変えられます', win: () => 'LDKの窓を置く辺を押してください', pan: () => '1本の指で図をずらします' };
let hintT = 0;
function showHint(t) { $('hint').textContent = t || HINT[mode](); $('hint').hidden = false; clearTimeout(hintT); hintT = setTimeout(() => $('hint').hidden = true, 3500); }
function setMode(m) { mode = m; document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === m)); if (m !== 'draw' && cur) closeCur(); showHint(); hud(); draw(); }
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
$('undo').addEventListener('click', () => { const s = hist.pop(); if (!s) return showHint('戻せるものがありません'); const o = JSON.parse(s); DRAWN = o.DRAWN; cur = o.cur; sel = -1; save(); hud(); draw(); });
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
  snapshot(); sel = h.b; act = Object.assign({ start: w, orig: JSON.parse(JSON.stringify(DRAWN.bldgs[h.b].p)), moved: false }, h); hud(); draw();
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
  const P = DRAWN.bldgs[act.b].p, d = [w[0] - act.start[0], w[1] - act.start[1]]; act.moved = true;
  if (act.v != null) P[act.v] = snapP([act.orig[act.v][0] + d[0], act.orig[act.v][1] + d[1]]);
  else if (act.e != null) {
    const a = act.orig[act.e], c = act.orig[(act.e + 1) % P.length], L = D.dist(a, c), n = [(c[1] - a[1]) / L, -(c[0] - a[0]) / L];
    let t = d[0] * n[0] + d[1] * n[1]; if (SET.grid) t = Math.round(t / SET.grid) * SET.grid;
    P[act.e] = [a[0] + n[0] * t, a[1] + n[1] * t]; P[(act.e + 1) % P.length] = [c[0] + n[0] * t, c[1] + n[1] * t];
  } else { const s = snapDelta(d); act.orig.forEach((p, k) => P[k] = [p[0] + s[0], p[1] + s[1]]); }
  hud(); draw();
});
function up(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (gesture) { if (ptrs.size < 2) gesture = null; return; }
  if (stroke) { const s = stroke; stroke = null; finishStroke(s); draw(); return; }
  if (act && act.b != null) { if (act.moved) save(); else hist.pop(); }
  act = null; hud(); draw();
}
cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
cv.addEventListener('wheel', e => { e.preventDefault(); const sp = pos(e), before = toW(...sp); view.s = Math.max(2, Math.min(200, view.s * Math.exp(-e.deltaY * .0015))); const after = toW(...sp); view.x += before[0] - after[0]; view.z += before[1] - after[1]; draw(); }, { passive: false });
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); $('undo').click(); } if (e.key === 'Enter' && cur) closeCur(); if (e.key === 'Escape' && cur) { snapshot(); cur = null; hud(); draw(); } });

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
window.__plan = { get DRAWN() { return DRAWN; }, get cur() { return cur; }, view, finishStroke, toS, toW, setMode };
})();
