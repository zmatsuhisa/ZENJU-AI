// 日照3D の画面。three.js で街を組み立て、sun.js で太陽と影を計算する。
(() => {
const S = window.SunCalc3D, R = S.R;
const $ = id => document.getElementById(id);
const hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(Math.round(m % 60)).padStart(2, '0');
const hmJ = h => { const m = Math.round(h * 60); return m >= 60 ? Math.floor(m / 60) + '時間' + (m % 60 ? (m % 60) + '分' : '') : m + '分'; };
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
let rnd0 = 12345; const rand = () => (rnd0 = (rnd0 * 16807) % 2147483647) / 2147483647;
const DIRS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
const dirName = az => DIRS[Math.round(((az % 360) + 360) % 360 / 22.5) % 16];

let LAT = 35, LON = 137, SITE = '';
const sunAt = (ds, m) => S.sun(S.ms(ds, m), LAT, LON);
const vec = s => new THREE.Vector3(Math.sin(s.az * R) * Math.cos(s.alt * R), Math.sin(s.alt * R), -Math.cos(s.az * R) * Math.cos(s.alt * R));

// ---------- 描画の準備 ----------
const stage = $('stage');
const rnd = new THREE.WebGLRenderer({ antialias: true });
rnd.setPixelRatio(Math.min(devicePixelRatio, 2));
rnd.shadowMap.enabled = true; rnd.shadowMap.type = THREE.PCFSoftShadowMap;
rnd.toneMapping = THREE.ACESFilmicToneMapping; rnd.toneMappingExposure = .95; rnd.outputEncoding = THREE.sRGBEncoding;
stage.prepend(rnd.domElement);
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(38, 1, 1, 4000);
const orbit = new THREE.OrbitControls(cam, rnd.domElement); orbit.maxPolarAngle = Math.PI / 2 - .02; orbit.enableDamping = true; orbit.minDistance = 8; orbit.maxDistance = 1200;

// 空：太陽の高さで色が変わる
const skyU = { top: { value: new THREE.Color() }, hor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() } };
const sky = new THREE.Mesh(new THREE.SphereGeometry(2000, 32, 16), new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, fog: false, uniforms: skyU,
  vertexShader: 'varying vec3 vP;void main(){vP=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader: 'uniform vec3 top,hor,sunDir,sunCol;varying vec3 vP;void main(){float h=max(vP.y,0.);vec3 c=mix(hor,top,pow(h,.55));float s=max(dot(vP,sunDir),0.);c+=sunCol*(pow(s,600.)*1.5+pow(s,8.)*.25);gl_FragColor=vec4(c,1.);}' }));
scene.add(sky);
scene.fog = new THREE.Fog(0xcfdbe4, 520, 2200);
const hemi = new THREE.HemisphereLight(0xcfe2f3, 0x7a6b58, .7); scene.add(hemi);
const light = new THREE.DirectionalLight(0xfff1dc, 2.4); light.castShadow = true;
const big = rnd.capabilities.maxTextureSize >= 8192; light.shadow.mapSize.set(big ? 4096 : 2048, big ? 4096 : 2048);
Object.assign(light.shadow.camera, { left: -340, right: 340, top: 340, bottom: -340, near: 1, far: 1400 }); light.shadow.bias = -.0003; light.shadow.normalBias = .4;
scene.add(light, light.target);

// 模様（キャンバスで作る）
function canvasTex(w, h, draw, rep) { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (rep) t.repeat.set(...rep); t.encoding = THREE.sRGBEncoding; t.anisotropy = rnd.capabilities.getMaxAnisotropy(); return t; }
const noise = (g, w, h, base, amp, n) => { g.fillStyle = base; g.fillRect(0, 0, w, h); for (let i = 0; i < n; i++) { const v = (rand() - .5) * amp; g.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v)})`; g.fillRect(rand() * w, rand() * h, 1 + rand() * 2, 1 + rand() * 2); } };
const groundTex = canvasTex(512, 512, (g, w, h) => { noise(g, w, h, '#9c988c', .14, 26000); for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(${110 + rand() * 30 | 0},${120 + rand() * 30 | 0},${80 + rand() * 20 | 0},.18)`; g.beginPath(); g.arc(rand() * w, rand() * h, 10 + rand() * 40, 0, 7); g.fill(); } }, [90, 90]);
const asphaltTex = canvasTex(256, 256, (g, w, h) => noise(g, w, h, '#8a8c8d', .16, 14000), [1, 1]);
// 外壁：1マス=幅3m×高さ3m、窓1つ
const houseTex = canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(0,0,0,.05)'; for (let y = 0; y < h; y += 6) g.fillRect(0, y, w, 1); g.fillStyle = '#3b4350'; g.fillRect(36, 30, 56, 48); g.fillStyle = 'rgba(180,205,230,.35)'; g.fillRect(40, 34, 24, 40); g.fillStyle = '#e9e6e0'; g.fillRect(36, 78, 56, 4); }, [1 / 3, 1 / 3]);
const officeTex = canvasTex(128, 128, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = '#2f3946'; g.fillRect(0, 34, w, 52); g.fillStyle = 'rgba(170,200,230,.4)'; for (let x = 0; x < w; x += 32) g.fillRect(x + 3, 38, 26, 20); g.fillStyle = '#d9d6d0'; for (let x = 0; x < w; x += 32) g.fillRect(x, 34, 3, 52); }, [1 / 4, 1 / 3.5]);
const roofTex = canvasTex(64, 64, (g, w, h) => { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(0,0,0,.18)'; for (let x = 0; x < w; x += 8) g.fillRect(x, 0, 1, h); }, [2, 2]);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(2600, 2600), new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }));
groundTex.repeat.set(260, 260); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

// ---------- 形をつくる道具 ----------
function merge(list) { // 頂点を共有しない BufferGeometry をひとつにまとめる
  let n = 0; list.forEach(g => n += g.attributes.position.count);
  const out = new THREE.BufferGeometry();
  ['position', 'normal', 'uv', 'color'].forEach(k => { const sz = k === 'uv' ? 2 : 3; const arr = new Float32Array(n * sz); let o = 0; list.forEach(g => { const a = g.attributes[k]; if (a) arr.set(a.array, o); o += g.attributes.position.count * sz; }); out.setAttribute(k, new THREE.BufferAttribute(arr, sz)); });
  return out;
}
function sub(g, start, count) { const o = new THREE.BufferGeometry(); ['position', 'normal', 'uv'].forEach(k => { const a = g.attributes[k]; o.setAttribute(k, new THREE.BufferAttribute(a.array.slice(start * a.itemSize, (start + count) * a.itemSize), a.itemSize)); }); return o; }
function paint(g, hex, shade) { const c = new THREE.Color(hex); c.convertSRGBToLinear(); const p = g.attributes.position, a = new Float32Array(p.count * 3); for (let i = 0; i < p.count; i++) { const f = shade ? shade(p.getY(i)) : 1; a[i * 3] = c.r * f; a[i * 3 + 1] = c.g * f; a[i * 3 + 2] = c.b * f; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; }
const ao = y => .72 + .28 * Math.min(1, y / 2.5); // 足元を暗くして接地感を出す
// 地面の高さ（敷地の中央を 0 とした m）。地形のデータがなければ 0
let TF = () => 0, groundOff = 0; // groundOff：地形があるとき、道路などを少し浮かせる
// 線を step m ごとに区切る（地面の起伏に沿わせるため）
function densify(pts, step) { const out = [pts[0]]; for (let i = 1; i < pts.length; i++) { const [x1, z1] = pts[i - 1], [x2, z2] = pts[i], n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, z2 - z1) / step)); for (let k = 1; k <= n; k++) out.push([x1 + (x2 - x1) * k / n, z1 + (z2 - z1) * k / n]); } return out; }
function ribbon(pts, w, y) {
  const pos = [], nor = [], uv = []; let acc = 0;
  pts = densify(pts, 4);
  for (let i = 1; i < pts.length; i++) {
    const [x1, z1] = pts[i - 1], [x2, z2] = pts[i]; const L = Math.hypot(x2 - x1, z2 - z1); if (L < .01) continue; const nx = -(z2 - z1) / L * w / 2, nz = (x2 - x1) / L * w / 2;
    const q = [[x1 + nx, z1 + nz, acc], [x1 - nx, z1 - nz, acc], [x2 + nx, z2 + nz, acc + L], [x2 - nx, z2 - nz, acc + L]]; acc += L;
    [0, 1, 2, 2, 1, 3].forEach(k => { pos.push(q[k][0], y + groundOff + TF(q[k][0], q[k][1]), q[k][1]); nor.push(0, 1, 0); uv.push(k === 1 || k === 3 ? w / 8 : 0, q[k][2] / 8); });
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); return g;
}
const shapeOf = P => new THREE.Shape(P.map(([x, z]) => new THREE.Vector2(x, -z)));
function prism(P, h) { const g = new THREE.ExtrudeGeometry(shapeOf(P), { depth: h, bevelEnabled: false }); g.rotateX(-Math.PI / 2); return g; }
// 切妻屋根（4.5寸勾配・軒の出40cm）。o は棟の向きと大きさ
function gable(o, h, out) {
  const L = o.L / 2 + out, W = o.W / 2 + out, rh = o.W / 2 * .45, ux = o.ux, uz = o.uz, vx = -uz, vz = ux;
  const P = (u, v, y) => [o.cx + u * ux + v * vx, y, o.cz + u * uz + v * vz];
  const a = P(-L, -W, h), b = P(L, -W, h), c = P(L, W, h), d = P(-L, W, h), r1 = P(-L, 0, h + rh), r2 = P(L, 0, h + rh);
  const mk = arr => { const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(arr.flat(), 3)); gg.computeVertexNormals(); const uv = []; arr.forEach(p => uv.push(p[0] * ux + p[2] * uz, p[1] * 2)); gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); return gg; };
  return { roof: mk([a, b, r2, a, r2, r1, c, d, r1, c, r1, r2]), ends: mk([a, r1, d, b, c, r2]) };
}
// 地面に重ねるもの（道路・敷地など）を、地面の網より手前に描く
const onGround = m => Object.assign(m, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
const std = (map, rough) => new THREE.MeshStandardMaterial({ map, roughness: rough, vertexColors: true, side: THREE.DoubleSide });
function disposeTree(o) { o.traverse(c => { if (c.geometry) c.geometry.dispose(); if (c.material) [].concat(c.material).forEach(m => { if (m.map && ![groundTex, asphaltTex, houseTex, officeTex, roofTex].includes(m.map)) m.map.dispose(); m.dispose(); }); }); }
// 地面の起伏に沿った四角い板（box の範囲・1m 間隔）。uv は北が上
function drape(box, off) {
  const w = box.x1 - box.x0, h = box.z1 - box.z0, nx = Math.max(1, Math.ceil(w)), nz = Math.max(1, Math.ceil(h));
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) { const x = box.x0 + w * i / nx, z = box.z0 + h * j / nz; pos.push(x, S.lotGround(x, z) + off, z); uv.push(i / nx, 1 - j / nz); }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i; idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
// 敷地（盛土の高さに置く）と境界の線
let lotEdge = null;
function drawLot() {
  [lotMesh, lotEdge].forEach(m => { if (m) { siteG.remove(m); m.geometry.dispose(); if (m.material.map) m.material.map.dispose(); m.material.dispose(); } });
  const c = document.createElement('canvas'), k = 8, w = lotBox.x1 - lotBox.x0, h = lotBox.z1 - lotBox.z0; c.width = Math.ceil(w * k); c.height = Math.ceil(h * k);
  const g = c.getContext('2d'); g.fillStyle = '#5aa864'; g.beginPath(); LOT.forEach(([x, z], i) => { const X = (x - lotBox.x0) / w * c.width, Y = (z - lotBox.z0) / h * c.height; i ? g.lineTo(X, Y) : g.moveTo(X, Y); }); g.closePath(); g.fill();
  const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
  lotMesh = new THREE.Mesh(drape(lotBox, .1), onGround(new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity: .75, roughness: 1, alphaTest: .05 }))); lotMesh.receiveShadow = true; lotMesh.visible = !heat.visible; siteG.add(lotMesh);
  lotEdge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(densify(LOT.concat([LOT[0]]), 1).slice(0, -1).map(([x, z]) => new THREE.Vector3(x, S.lotGround(x, z) + .16, z))), new THREE.LineBasicMaterial({ color: 0xffffff })); siteG.add(lotEdge);
}
// 地面：地形のある範囲は起伏のある板、その外は平らな板（地形のいちばん低い所の高さ）
let terrMesh = null;
function buildGround() {
  if (terrMesh) { scene.remove(terrMesh); terrMesh.geometry.dispose(); terrMesh.material.map.dispose(); terrMesh.material.dispose(); terrMesh = null; }
  const t = D.terr; ground.position.y = 0;
  if (!t) return;
  const span = t.step * (t.nx - 1), g = new THREE.PlaneGeometry(span, span, t.nx - 1, t.nz - 1); g.rotateX(-Math.PI / 2); g.translate(t.x0 + span / 2, 0, t.z0 + span / 2);
  const p = g.attributes.position; for (let i = 0; i < p.count; i++) p.setY(i, TF(p.getX(i), p.getZ(i))); g.computeVertexNormals();
  const tex = groundTex.clone(); tex.needsUpdate = true; tex.repeat.set(span / 10, span / 10);
  terrMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: tex, roughness: 1 })); terrMesh.receiveShadow = true; scene.add(terrMesh);
  ground.position.y = Math.min(...t.hc) / 100 - .3;
}
// 地形のまとめ（ページ下の注記）
function terrainNote() {
  const t = D.terr; if (!t) { $('terrnote').hidden = true; return; } $('terrnote').hidden = false;
  const xs = LOT.map(p => p[0]), zs = LOT.map(p => p[1]), v = [];
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += .5) for (let z = Math.min(...zs); z <= Math.max(...zs); z += .5) if (S.inPoly(x, z, LOT)) v.push(TF(x, z));
  const ds = YEAR + '-12-22'; let lost = 0; for (let m = 300; m <= 1200; m++) { const s = sunAt(ds, m); if (s.alt > 0 && S.behindHill(s)) lost++; }
  const hmax = Math.max(...D.hor), az = D.hor.indexOf(hmax);
  $('terrnote').textContent = `地面の高さは国土地理院の5mメッシュ（航空レーザー測量）。敷地の中央は標高 ${t.e0.toFixed(2)}m、敷地の中の高低差は ${(Math.max(...v) - Math.min(...v)).toFixed(2)}m、まわり約700mでは ${(t.e0 + Math.min(...t.hc) / 100).toFixed(1)}〜${(t.e0 + Math.max(...t.hc) / 100).toFixed(1)}m。遠くの山はいちばん高い所で${dirName(az)}に ${hmax.toFixed(1)}°見え、冬至は山に隠れる時間が合わせて約${lost}分あります（その時間は日照に数えない）`;
}
function label(group, t, x, z, size, y) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128; const g = c.getContext('2d'); g.font = '900 64px "Zen Kaku Gothic New",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 12; g.strokeStyle = 'rgba(0,0,0,.55)'; g.strokeText(t, 256, 64); g.fillStyle = '#fff'; g.fillText(t, 256, 64);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false })); s.scale.set(size * 4, size, 1); s.position.set(x, y + TF(x, z), z); s.renderOrder = 9; group.add(s); return s;
}

// ---------- 敷地と街 ----------
let D = null, LOT = null, lotC = { x: 0, z: 0 }, lotBox = null, B = [], H = {}, OCC = [];
let siteG = null, cityG = null, selLine = null, planG = null, lotMesh = null;
const lotArea = P => Math.abs(P.reduce((s, p, i) => { const q = P[(i + 1) % P.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

// 直した高さの保存先。建物のデータ（地理院／PLATEAU）が変わると番号も変わるので分ける
const hKey = () => 'gos-sun-h-' + SITE + (D && D.src && D.src !== '地理院' ? '-pl' : '');
// 建物の種類と、階数⇔高さ
const KIND = { w: '木造', s: '鉄骨・RCなど', l: '大きい建物', n: '屋根だけ（車庫など）' };
const MAXF = { w: 3, s: 10, l: 6, n: 2 };
function floorsOf(b, h) { if (b.fl && Math.abs(h - b.h) < .05) return b.fl; if (b.k === 'w') return h < 4.5 ? 1 : h < 7.6 ? 2 : 3; if (b.k === 'n') return h < 4.5 ? 1 : 2; return Math.max(1, Math.round((h - .5) / 3.5)); }
function heightFor(b, f) { if (b.k === 'w') return [0, 3.3, 6.2, 9.1][f]; if (b.k === 'n') return 3 * f; return 3.5 * f + .5; }
const hOf = i => H[i] != null ? H[i] : B[i].h;
const occOf = (b, h) => S.occluder(b.p, b.r === 'g' ? h + b.o.W * .11 : h, b.y || 0);
const centroid = P => [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
function whereOf(i) { // 敷地から見た方角と距離
  const [x, z] = centroid(B[i].p); const dx = x - lotC.x, dz = z - lotC.z;
  let dmin = Infinity; B[i].p.forEach(([px, pz]) => LOT.forEach(([lx, lz]) => dmin = Math.min(dmin, Math.hypot(px - lx, pz - lz))));
  return dirName(Math.atan2(dx, -dz) / R) + '・' + Math.max(1, Math.round(dmin)) + 'm先';
}

function rebuildCity() {
  if (cityG) { siteG.remove(cityG); disposeTree(cityG); }
  cityG = new THREE.Group(); siteG.add(cityG);
  const lists = { h: { g: [], own: [] }, o: { g: [], own: [] }, cap: { g: [], own: [] }, roof: { g: [], own: [] } };
  const push = (k, g, i) => { lists[k].g.push(g); lists[k].own.push([i, g.attributes.position.count / 3]); };
  OCC = B.map((b, i) => {
    const h = hOf(i);
    const y0 = b.y || 0;
    const g = prism(b.p, h); const [g0, g1] = g.groups; const cap = sub(g, g0.start, g0.count), side = sub(g, g1.start, g1.count); g.dispose();
    push(b.r === 'g' || h < 4 ? 'h' : 'o', paint(side, b.wc, ao).translate(0, y0, 0), i);
    push('cap', paint(cap, b.r === 'g' ? b.wc : '#8e8c87').translate(0, y0, 0), i);
    if (b.r === 'g') { const r = gable(b.o, y0 + h, .4); push('roof', paint(r.roof, b.rc), i); push('h', paint(r.ends, b.wc), i); }
    return occOf(b, h);
  });
  [['h', houseTex, .85], ['o', officeTex, .6], ['cap', null, .95], ['roof', roofTex, .55]].forEach(([k, map, r]) => {
    const L = lists[k]; if (!L.g.length) return;
    const m = new THREE.Mesh(merge(L.g), std(map, r)); L.g.forEach(g => g.dispose());
    const own = []; L.own.forEach(([i, n]) => { for (let t = 0; t < n; t++) own.push(i); }); m.userData.owner = Int32Array.from(own);
    m.castShadow = m.receiveShadow = true; cityG.add(m);
  });
}

function buildSite(data, key) {
  D = data; SITE = key; LAT = D.lat; LON = D.lon; B = D.b;
  S.setEnv({ T: S.terrainFn(D.terr), hor: D.hor || null, fill: (store.get('gos-sun-fill-' + key) || 0) });
  TF = S.env.T || (() => 0); groundOff = D.terr ? .12 : 0;
  H = store.get(hKey()) || {};
  rnd0 = 12345;
  if (siteG) { scene.remove(siteG); disposeTree(siteG); cityG = null; selLine = null; planG = null; }
  siteG = new THREE.Group(); scene.add(siteG);
  LOT = D.lot; [lotC.x, lotC.z] = centroid(LOT);
  lotBox = { x0: Math.min(...LOT.map(p => p[0])), x1: Math.max(...LOT.map(p => p[0])), z0: Math.min(...LOT.map(p => p[1])), z1: Math.max(...LOT.map(p => p[1])) };
  light.target.position.set(lotC.x, 0, lotC.z);
  buildGround();
  gplane.constant = -S.lotGround(lotC.x, lotC.z);
  $('cnt').textContent = B.length; $('sitename').textContent = (D.name || '敷地') + ' 日照3D'; $('sitenote').textContent = D.note || '';
  $('lotnote').textContent = D.lotNote || '敷地の形は地図からの概算（測量図ではない）';
  const meas = B.some(b => b.m);
  $('srcl').innerHTML = `<i class="dot"></i>${meas ? '実測の高さ（PLATEAU）' : '地理院データ'}`;
  $('hnote').textContent = D.hNote || '高さは推定：木造2階6m前後＋切妻屋根、平屋3.3m、堅ろう建物9〜16m、大型建物6.5〜9m。直した高さはこの端末に残ります';
  $('shlead').textContent = meas ? '選んだ日に、敷地へ長く影を落としている建物です。高さは航空測量の実測です（PLATEAU）。建て替えなどで変わっていたら「選ぶ」から直せます（3Dで建物を押しても選べます）。' : '選んだ日に、敷地へ長く影を落としている建物です。高さは推定なので、実際の階数が分かったら「選ぶ」から直してください（3Dで建物を押しても選べます）。';
  $('freset').textContent = meas ? '実測に戻す' : '推定に戻す';
  document.title = 'グランOS｜日照3D ' + (D.name || '');
  // 道路・縁石・水路
  const roads = merge(D.r.map(r => paint(ribbon(r.p, r.w, .03), '#ffffff')));
  const roadM = new THREE.Mesh(roads, onGround(new THREE.MeshStandardMaterial({ map: asphaltTex, roughness: .92, vertexColors: true, side: THREE.DoubleSide }))); roadM.receiveShadow = true; siteG.add(roadM);
  const cl = D.r.filter(r => r.w >= 8).map(r => paint(ribbon(r.p, .15, .05), '#f2f0e8'));
  if (cl.length) { const m = new THREE.Mesh(merge(cl), onGround(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .8, side: THREE.DoubleSide }))); m.receiveShadow = true; siteG.add(m); }
  if (D.e.length) { const cm = new THREE.Mesh(merge(D.e.map(p => paint(ribbon(p, .35, .08), '#c9c6be'))), onGround(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .9, side: THREE.DoubleSide }))); cm.receiveShadow = true; siteG.add(cm); }
  D.w.forEach(P => { const m = new THREE.Mesh(new THREE.ShapeGeometry(shapeOf(P)), new THREE.MeshStandardMaterial({ color: 0x4f7f97, roughness: .15, metalness: .1 })); m.rotation.x = -Math.PI / 2; m.position.y = .04; siteG.add(m); });
  rebuildCity();
  // 木（雰囲気用・計算には入れない）
  const near = (x, z) => D.r.some(r => r.p.some((p, i) => { if (!i) return false; const [x1, z1] = r.p[i - 1], [x2, z2] = p, dx = x2 - x1, dz = z2 - z1, L2 = dx * dx + dz * dz || 1; let t = ((x - x1) * dx + (z - z1) * dz) / L2; t = Math.max(0, Math.min(1, t)); return Math.hypot(x - x1 - t * dx, z - z1 - t * dz) < r.w / 2 + 1.2; }));
  const inB = (x, z) => OCC.some(o => x > o.x0 - 1 && x < o.x1 + 1 && z > o.z0 - 1 && z < o.z1 + 1 && S.inPoly(x, z, o.p));
  const trees = []; let tries = 0;
  while (trees.length < 420 && tries < 9000) { tries++; const a = rand() * 7, r = Math.sqrt(rand()) * 320, x = lotC.x + Math.cos(a) * r, z = lotC.z + Math.sin(a) * r; if (S.inPoly(x, z, LOT) || inB(x, z) || near(x, z)) continue; trees.push([x, z, 2 + rand() * 2.2]); }
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Sc = new THREE.Vector3(), T = new THREE.Vector3(), C = new THREE.Color();
  if (trees.length) {
    const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: .95, flatShading: true }), trees.length);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(.15, .22, 1, 6), new THREE.MeshStandardMaterial({ color: 0x5a4634, roughness: 1 }), trees.length);
    trees.forEach(([x, z, s], i) => { const ty = TF(x, z); M.compose(T.set(x, ty + s * 1.1 + 1.2, z), Q, Sc.set(s, s * 1.15, s)); crown.setMatrixAt(i, M); C.setHSL(.24 + rand() * .07, .32 + rand() * .18, .13 + rand() * .07); crown.setColorAt(i, C); M.compose(T.set(x, ty + (s * 1.1 + 1.2) / 2, z), Q, Sc.set(1, s * 1.1 + 1.2, 1)); trunk.setMatrixAt(i, M); });
    crown.castShadow = crown.receiveShadow = trunk.castShadow = true; siteG.add(crown, trunk);
  }
  // 車（雰囲気用）
  const cars = [];
  D.r.filter(r => r.w >= 8).forEach(r => { for (let i = 1; i < r.p.length; i++) { const [x1, z1] = r.p[i - 1], [x2, z2] = r.p[i], L = Math.hypot(x2 - x1, z2 - z1); for (let t = 6 + rand() * 20; t < L; t += 14 + rand() * 30) { const ux = (x2 - x1) / L, uz = (z2 - z1) / L, side = rand() < .5 ? 1 : -1; cars.push([x1 + ux * t - uz * side * r.w * .25, z1 + uz * t + ux * side * r.w * .25, Math.atan2(ux, uz)]); } } });
  if (cars.length) {
    const body = new THREE.InstancedMesh(new THREE.BoxGeometry(1.75, .8, 4.4), new THREE.MeshStandardMaterial({ roughness: .3, metalness: .4 }), cars.length);
    const cabin = new THREE.InstancedMesh(new THREE.BoxGeometry(1.6, .6, 2.3), new THREE.MeshStandardMaterial({ color: 0x22272e, roughness: .15, metalness: .6 }), cars.length);
    const pal = ['#f4f4f2', '#e9e9e7', '#1f2226', '#9da3a8', '#b23a32', '#2f4f7a', '#c9c4b8'];
    cars.forEach(([x, z, a], i) => { Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a); const ty = TF(x, z); M.compose(T.set(x, ty + .65, z), Q, Sc.set(1, 1, 1)); body.setMatrixAt(i, M); C.set(pal[i % pal.length]); C.convertSRGBToLinear(); body.setColorAt(i, C); M.compose(T.set(x, ty + 1.35, z), Q, Sc.set(1, 1, 1)); cabin.setMatrixAt(i, M); });
    body.castShadow = cabin.castShadow = true; siteG.add(body, cabin);
  }
  // 敷地
  drawLot();
  label(siteG, '敷地', lotC.x, lotC.z, 9, 16); label(siteG, 'N ↑', lotC.x, -150 + lotC.z, 14, 8);
  (D.labels || []).forEach(l => label(siteG, l.t, l.x, l.z, l.size || 12, l.y || 6));
  terrainNote();
  // 日照マップ用の板
  heat.geometry.dispose(); heat.geometry = drape(lotBox, .14); heat.rotation.set(0, 0, 0); heat.position.set(0, 0, 0);
  heat.visible = false; $('heat').setAttribute('aria-pressed', false); $('legend').style.display = 'none';
  select(-1); initPlan(); fixedNote();
  if ($('load')) $('load').remove();
  setView('town'); newDay();
}

// ---------- 日照の計算 ----------
const occAll = () => plan.f === 3 ? OCC.concat(drawnBldgs().map(b => S.occluder(b.p, b.h, S.planBase(b.p)))) : plan.f ? OCC.concat([planOcc()]) : OCC;
const ramp = [[32, 48, 94], [61, 111, 176], [95, 179, 161], [243, 211, 74], [240, 132, 30]];
const col = t => { t = Math.max(0, Math.min(1, t)) * (ramp.length - 1); const i = Math.min(ramp.length - 2, Math.floor(t)), f = t - i; return ramp[i].map((a, k) => Math.round(a + (ramp[i + 1][k] - a) * f)); };
const cv = document.createElement('canvas'); const heatTex = new THREE.CanvasTexture(cv); heatTex.magFilter = THREE.NearestFilter; heatTex.encoding = THREE.sRGBEncoding;
const heat = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), Object.assign(new THREE.MeshBasicMaterial({ map: heatTex, transparent: true, opacity: .92, toneMapped: false }), { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -12 })); heat.rotation.x = -Math.PI / 2; heat.visible = false; scene.add(heat);
let heatFor = '';
function drawHeat(ds) {
  if (heatFor === ds || !LOT) return; heatFor = ds;
  const GX = Math.ceil(lotBox.x1 - lotBox.x0), GZ = Math.ceil(lotBox.z1 - lotBox.z0); cv.width = GX; cv.height = GZ; const pts = [];
  for (let j = 0; j < GZ; j++) for (let i = 0; i < GX; i++) pts.push([lotBox.x0 + (i + .5) * (lotBox.x1 - lotBox.x0) / GX, lotBox.z0 + (j + .5) * (lotBox.z1 - lotBox.z0) / GZ]);
  const boxes = plan.f === 3 ? drawnBldgs().map(b => b.p) : plan.f ? [planBox()] : [];
  const ins = pts.map(p => S.inPoly(p[0], p[1], LOT) && !boxes.some(b => S.inPoly(p[0], p[1], b))), h = S.sunHours(ds, pts, occAll(), LAT, LON), hi = h.filter((v, k) => ins[k]);
  const mn = Math.min(...hi), mx = Math.max(...hi), g = cv.getContext('2d'), img = g.createImageData(GX, GZ);
  h.forEach((v, k) => img.data.set([...col(mx > mn ? (v - mn) / (mx - mn) : 1), ins[k] ? 255 : 0], k * 4)); g.putImageData(img, 0, 0); heatTex.dispose(); heatTex.image = cv; heatTex.needsUpdate = true;
  $('lmin').textContent = mn.toFixed(1) + 'h'; $('lmax').textContent = mx.toFixed(1) + 'h';
}

// ---------- 画面の操作 ----------
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const YEAR = today.slice(0, 4);
$('date').value = YEAR + '-12-22';
// 日付・時刻は配置図のページと共有する（gos-sun-time）
const TK = 'gos-sun-time';
function applyTime() { const t = store.get(TK); if (!t) return false; if (t.md) $('date').value = YEAR + '-' + t.md; if (t.m) $('time').value = t.m; document.querySelectorAll('[data-d]').forEach(x => x.classList.toggle('on', $('date').value.slice(5) === x.dataset.d)); return true; }
applyTime();
let lastT = '';
function saveTime() { const v = JSON.stringify({ md: curDay().slice(5), m: +$('time').value }); if (v !== lastT) { lastT = v; store.set(TK, JSON.parse(v)); } }
const curDay = () => $('date').value || today;
let DAY = null;
const DN = { '12-22': '冬至', '03-20': '春分', '06-21': '夏至', '09-23': '秋分' };
function dayInfo(ds) {
  const { rise, set, noon } = S.dayInfo(ds, LAT, LON);
  $('rise').textContent = rise ? hm(rise) : '-'; $('set').textContent = set ? hm(set) : '-'; $('noon').textContent = noon.toFixed(1) + '°';
  DAY = { rise, set, noon, ds }; drawArc();
  if (rise) { $('time').style.setProperty('--r', ((rise - 300) / 960 * 100) + '%'); $('time').style.setProperty('--s', ((set - 300) / 960 * 100) + '%'); }
  centerHours();
}
// 左上の「敷地の日照」：計画の建物がなければ敷地の中央、あれば南の庭の平均
function centerHours() {
  if (!LOT) return; const ds = curDay();
  let v, k1, k2;
  if (plan.f) { const st = plan.f === 3 ? drawnStats(ds) : S.planStats(ds, planArgs(), LOT, OCC, LAT, LON); v = st.garden; k1 = '南の庭の日照'; k2 = '南の庭の日照（平均）'; }
  else { v = S.sunHours(ds, [[lotC.x, lotC.z]], OCC, LAT, LON)[0]; k1 = '敷地の日照'; k2 = '敷地中央の日照'; }
  const t = v == null ? '-' : v.toFixed(1);
  $('centerk').textContent = k1; $('center2k').textContent = k2;
  $('center').innerHTML = t + '<small>時間</small>'; $('center2').innerHTML = t + '<span class="u">時間</span>';
}
function drawArc() {
  if (!DAY || !DAY.rise) return; const pts = [];
  for (let m = DAY.rise; m <= DAY.set; m += 10) { const a = Math.max(0, sunAt(DAY.ds, m).alt); pts.push([6 + (m - DAY.rise) / (DAY.set - DAY.rise) * 138, 40 - a / Math.max(DAY.noon, 1) * 32]); }
  $('arc').innerHTML = `<line x1="2" y1="40.5" x2="148" y2="40.5" stroke="#d9d9d9"/><path d="M${pts.map(p => p.map(v => v.toFixed(1)).join(' ')).join(' L')}" fill="none" stroke="#f7890a" stroke-width="2" stroke-dasharray="3 3"/><circle id="sdot" r="5" fill="#f7890a" stroke="#fff" stroke-width="2"/>`; moveDot();
}
function moveDot() { const d = document.getElementById('sdot'); if (!d || !DAY) return; const m = +$('time').value, a = sunAt(DAY.ds, m).alt; const x = 6 + Math.max(0, Math.min(1, (m - DAY.rise) / (DAY.set - DAY.rise))) * 138, y = 40 - Math.max(0, a) / Math.max(DAY.noon, 1) * 32; d.setAttribute('cx', x); d.setAttribute('cy', y); d.setAttribute('opacity', a > 0 ? 1 : .3); }
function update() {
  later('time', saveTime, 300);
  const ds = curDay(), m = +$('time').value, s = sunAt(ds, m), v = vec(s);
  $('tout').textContent = hm(m); $('time').style.setProperty('--p', ((m - 300) / 960 * 100) + '%');
  $('sunk').textContent = s.alt > 0 ? '太陽 ' + dirName(s.az) : '太陽'; $('sunv').innerHTML = s.alt > 0 ? s.alt.toFixed(1) + '°<small>の高さ</small>' : '日没中';
  { const md = ds.slice(5); $('cdate').textContent = +md.slice(0, 2) + '/' + (+md.slice(3)) + (DN[md] ? ' ' + DN[md] : ''); } moveDot();
  const hill = s.alt > 0 && S.behindHill(s);
  if (hill) $('sunv').innerHTML = '山の陰<small>（' + s.alt.toFixed(1) + '°）</small>';
  const k = Math.max(0, Math.min(1, s.alt / 25)), night = s.alt <= 0;
  light.color.setHSL(.08 + .05 * k, .9 - .5 * k, .6 + .2 * k); light.intensity = night || hill ? 0 : 2.6 * Math.min(1, s.alt / 6 + .15);
  hemi.intensity = night ? .18 : .45 + .35 * k;
  light.position.copy(v.clone().multiplyScalar(700).add(light.target.position));
  skyU.top.value.setHSL(.6, .55, night ? .08 : .28 + .22 * k); skyU.hor.value.setHSL(night ? .62 : .07 + .48 * k, night ? .3 : .55 - .25 * k, night ? .15 : .62 + .15 * k);
  skyU.sunDir.value.copy(v); skyU.sunCol.value.setHSL(.09, 1, night ? 0 : .55);
  scene.fog.color.copy(skyU.hor.value);
  if (heat.visible) drawHeat(ds);
}
// 日付・建物・計画が変わったとき
function newDay() { heatFor = ''; if (LOT) { dayInfo(curDay()); later('shades', shadeList, 250); } update(); }
const timers = {};
function later(k, fn, ms) { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms); }

document.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('[data-d]').forEach(x => x.classList.toggle('on', x === b)); $('date').value = YEAR + '-' + b.dataset.d; newDay(); }));
$('date').addEventListener('change', () => { document.querySelectorAll('[data-d]').forEach(x => x.classList.toggle('on', $('date').value.slice(5) === x.dataset.d)); newDay(); });
$('time').addEventListener('input', update);
$('heat').addEventListener('click', e => { if (!LOT) return; const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', on); heat.visible = on; lotMesh.visible = !on; $('legend').style.display = on ? 'block' : 'none'; update(); });
let playing = false, last = 0;
$('play').addEventListener('click', e => { playing = !playing; e.currentTarget.setAttribute('aria-pressed', playing); e.currentTarget.textContent = playing ? '❚❚' : '▶'; e.currentTarget.setAttribute('aria-label', playing ? '停止' : '1日を再生'); });
let curView = 'town';
function setView(k) {
  const c = lotC; cam.up.set(0, 1, 0);
  const f = cam.aspect < 1 ? 1.25 : 1;
  if (k === 'town') cam.position.set(c.x - 260 * f, 230 * f, c.z + 330 * f);
  if (k === 'bird') cam.position.set(c.x - 55 * f, 45 * f, c.z + 70 * f);
  if (k === 'top') { cam.position.set(c.x, 520, c.z + .01); cam.up.set(0, 0, -1); }
  if (k === 'eye') cam.position.set(c.x - 20, S.lotGround(c.x, c.z) + 1.6, c.z + 8);
  orbit.target.set(c.x, S.lotGround(c.x, c.z) + (k === 'eye' ? 2 : 0), c.z); orbit.update(); curView = k; $('viewl').textContent = { town: '街全体', bird: '敷地', top: '真上', eye: '目線' }[k];
  document.querySelectorAll('.nav [data-v]').forEach(x => { x.classList.toggle('active', x.dataset.v === k); x.toggleAttribute('aria-current', x.dataset.v === k); });
}
$('viewb').addEventListener('click', () => { const L = ['town', 'bird', 'top', 'eye']; setView(L[(L.indexOf(curView) + 1) % 4]); });
document.querySelectorAll('.nav [data-v]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); setView(b.dataset.v); }));
function size() { const w = stage.clientWidth, h = stage.clientHeight; rnd.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
new ResizeObserver(size).observe(stage);
const coarse = matchMedia('(pointer: coarse)').matches;
const MAXI = $('full').innerHTML, XI = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
let full = false;
function setFull(on) {
  full = on; $('full').innerHTML = on ? XI : MAXI; $('stagecard').classList.toggle('full', on); document.body.classList.toggle('noscroll', on); $('full').setAttribute('aria-pressed', on); $('full').setAttribute('aria-label', on ? '拡大を閉じる' : '3Dを拡大');
  // 1本の指で回す・2本の指で寄る／ずらす（拡大していなくても）。ページのスクロールは3Dの外側で
  orbit.enabled = true; rnd.domElement.style.touchAction = 'none'; setTimeout(size, 30);
}
$('full').addEventListener('click', () => setFull(!full));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && full) setFull(false); });
setFull(false);

const UIM = ['通常', '透明', '隠す']; let uim = +(store.get('gos-sun-ui') || 0);
function setUI(i) { uim = i % 3; stage.classList.toggle('ui-clear', uim === 1); stage.classList.toggle('ui-hide', uim === 2); $('uib').setAttribute('aria-label', 'パネル：' + UIM[uim]); $('uib').title = 'パネル：' + UIM[uim]; $('uib').setAttribute('aria-pressed', uim > 0); store.set('gos-sun-ui', uim); }
$('uib').addEventListener('click', () => setUI(uim + 1)); setUI(uim);

// ---------- 建物を選んで高さを直す ----------
let sel = -1;
function select(i) {
  sel = i;
  if (selLine) { scene.remove(selLine); selLine.geometry.dispose(); selLine = null; }
  $('selrow').hidden = i < 0;
  if (i < 0) return;
  const b = B[i], h = hOf(i), f = floorsOf(b, h);
  const g = prism(b.p, h + (b.r === 'g' ? b.o.W / 2 * .45 : 0)); g.translate(0, b.y || 0, 0); selLine = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0xf7890a, depthTest: false })); g.dispose();
  selLine.renderOrder = 10; scene.add(selLine);
  const fixed = H[i] != null;
  const base = b.m ? `実測 ${b.mt.toFixed(1)}m` : `推定 ${b.h.toFixed(1)}m`;
  $('selk').innerHTML = `${whereOf(i)}の${KIND[b.k] || '建物'}<small>${fixed ? `直した高さ ${h.toFixed(1)}m（${base}）` : base + (b.m && b.fl ? `・${b.fl}階` : '')}</small>`;
  $('fval').textContent = f + '階'; $('fdown').disabled = f <= 1; $('fup').disabled = f >= (MAXF[b.k] || 6);
  $('freset').hidden = !fixed;
}
function setHeight(i, h) {
  if (h == null || Math.abs(h - B[i].h) < .05) delete H[i]; else H[i] = Math.round(h * 10) / 10;
  store.set(hKey(), H); rebuildCity(); select(i); newDay(); later('cmp', comparePlans, 300); fixedNote();
}
$('fdown').addEventListener('click', () => { if (sel >= 0) setHeight(sel, heightFor(B[sel], floorsOf(B[sel], hOf(sel)) - 1)); });
$('fup').addEventListener('click', () => { if (sel >= 0) setHeight(sel, heightFor(B[sel], floorsOf(B[sel], hOf(sel)) + 1)); });
$('freset').addEventListener('click', () => { if (sel >= 0) setHeight(sel, null); });
$('selx').addEventListener('click', () => select(-1));
function fixedNote() {
  const ks = Object.keys(H);
  $('fixed').innerHTML = ks.length ? `高さを直した建物：${ks.length}棟。<button type="button" class="btn btn-sm" id="fixall">すべて元の高さに戻す</button>` : '';
  if (ks.length) $('fixall').addEventListener('click', () => { H = {}; store.set(hKey(), H); rebuildCity(); select(-1); newDay(); later('cmp', comparePlans, 300); fixedNote(); });
}

// 敷地に影を落とす建物（選んだ日・敷地を2m間隔で見て、建物ごとに影になる時間の平均）
function shadeList() {
  if (!LOT) return; const ds = curDay();
  const pts = []; for (let x = lotBox.x0 + 1; x < lotBox.x1; x += 2) for (let z = lotBox.z0 + 1; z < lotBox.z1; z += 2) if (S.inPoly(x, z, LOT)) pts.push([x, z]);
  if (!pts.length) pts.push([lotC.x, lotC.z]);
  const mins = new Float64Array(B.length);
  for (let m = 240; m <= 1200; m += 10) {
    const s = sunAt(ds, m); if (s.alt <= 0 || S.behindHill(s)) continue;
    const reachMax = 20 / Math.tan(Math.max(s.alt, .5) * R);
    OCC.forEach((o, i) => {
      if (o.x1 < lotBox.x0 - reachMax || o.x0 > lotBox.x1 + reachMax || o.z1 < lotBox.z0 - reachMax || o.z0 > lotBox.z1 + reachMax) return;
      let n = 0; pts.forEach(p => { if (S.blocked(p[0], p[1], s, [o], S.lotGround(p[0], p[1]))) n++; }); mins[i] += n * 10 / pts.length;
    });
  }
  const top = [...mins.keys()].filter(i => mins[i] >= 10).sort((a, b) => mins[b] - mins[a]).slice(0, 5);
  $('shades').innerHTML = top.length ? top.map(i => { const b = B[i], h = hOf(i); return `<li><span class="who">${whereOf(i)}の${KIND[b.k] || '建物'}${H[i] != null ? '<span class="chip chip-green">直した</span>' : ''}<small>${H[i] != null ? `${floorsOf(b, h)}階・${h.toFixed(1)}m` : b.m ? `実測 ${b.mt.toFixed(1)}m${b.fl ? '・' + b.fl + '階' : ''}` : `推定 ${floorsOf(b, h)}階・${h.toFixed(1)}m`}</small></span><span class="t">${hmJ(mins[i] / 60)}</span><button type="button" class="btn btn-sm" data-pick="${i}">選ぶ</button></li>`; }).join('')
    : '<li class="busy">この日は、まわりの建物の影はほとんどかかりません。</li>';
  $('shades').querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { select(+b.dataset.pick); if (!full) $('stagecard').scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
}

// ---------- 計画の建物 ----------
// 向き angle（敷地のいちばん長い辺に合わせる）で見た座標：u=東西、v=南北（南が＋）
const plan = { f: 0, angle: 0, u: 0, n: 0, size: { 1: { w: 12.7, d: 9.1 }, 2: { w: 9.1, d: 7.3 } } };
let frame = null;
const toUV = (x, z) => { const a = plan.angle * R, c = Math.cos(a), s = Math.sin(a); return [x * c + z * s, -x * s + z * c]; };
const toXZ = (u, v) => { const a = plan.angle * R, c = Math.cos(a), s = Math.sin(a); return [u * c - v * s, u * s + v * c]; };
// 配置図で描いた建物（plan.html が localStorage に残したもの）
let DRAWN = { bldgs: [], win: null };
const drawnBldgs = () => DRAWN.bldgs.map(b => ({ p: b.p, h: S.drawHeight(b.f), f: b.f }));
const drawnStats = ds => S.polyStats(ds, drawnBldgs(), DRAWN.win, LOT, OCC, LAT, LON, plan.angle);
function loadDrawn() {
  DRAWN = store.get('gos-sun-draw-' + SITE) || { bldgs: [], win: null };
  const n = DRAWN.bldgs.length;
  $('drawnote').textContent = n ? `配置図に描いた建物：${n}棟（建築面積 ${DRAWN.bldgs.reduce((s, b) => s + S.polyArea(b.p), 0).toFixed(1)}㎡）` : '配置図にはまだ建物が描かれていません。';
  document.querySelector('[data-pf="3"]').disabled = !n;
  if (!n && plan.f === 3) plan.f = 0;
}
// f の大きさで敷地からはみ出さない位置にした中心（plan の値は変えない）
function planArgs(f) {
  f = (f && f < 3) ? f : (plan.f && plan.f < 3 ? plan.f : 2); const { w, d } = plan.size[f];
  const u = Math.max(frame.u0 + w / 2, Math.min(frame.u1 - w / 2, plan.u)), n = Math.max(frame.v0, Math.min(frame.v1 - d, plan.n));
  const [cx, cz] = toXZ(u, n + d / 2);
  return { cx, cz, w, d, angle: plan.angle, floors: f };
}
const planBox = f => { const a = planArgs(f); return S.rect(a.cx, a.cz, a.w, a.d, a.angle); };
const planOcc = () => { const a = planArgs(), box = planBox(); return S.occluder(box, S.planHeight(a.floors, a.d), S.planBase(box)); };
function initPlan() {
  // 敷地のいちばん長い辺の向き（-45〜45度）
  let best = 0, ang = 0;
  LOT.forEach((p, i) => { const q = LOT[(i + 1) % LOT.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]); if (L > best) { best = L; let a = Math.atan2(q[1] - p[1], q[0] - p[0]) / R; while (a > 45) a -= 90; while (a < -45) a += 90; ang = a; } });
  plan.angle = Math.round(ang * 10) / 10;
  const uv = LOT.map(p => toUV(p[0], p[1])); frame = { u0: Math.min(...uv.map(p => p[0])), u1: Math.max(...uv.map(p => p[0])), v0: Math.min(...uv.map(p => p[1])), v1: Math.max(...uv.map(p => p[1])) };
  const W = frame.u1 - frame.u0, Dp = frame.v1 - frame.v0;
  plan.size = { 1: { w: Math.min(12.7, W - 2), d: Math.min(9.1, Dp - 4) }, 2: { w: Math.min(9.1, W - 2), d: Math.min(7.3, Dp - 4) } };
  plan.u = (frame.u0 + frame.u1) / 2; plan.n = frame.v0 + 1; plan.f = 0;
  const saved = store.get('gos-sun-plan-' + SITE);
  if (saved && saved.size) Object.assign(plan, { f: saved.f, u: saved.u, n: saved.n, size: saved.size });
  loadDrawn();
  // 配置図から戻ってきて形が変わっていたら、「配置図の形」で見せる
  if (DRAWN.bldgs.length && (!saved || saved.sig !== JSON.stringify(DRAWN.bldgs))) plan.f = 3;
  $('pu').min = frame.u0.toFixed(1); $('pu').max = frame.u1.toFixed(1);
  $('pn').min = 0; $('pn').max = Math.max(1, Dp - 3).toFixed(1);
  syncPlanUI(); drawPlan(); later('cmp', comparePlans, 400);
}
function clampPlan() {
  const { w, d } = plan.size[plan.f === 1 ? 1 : 2];
  plan.u = Math.max(frame.u0 + w / 2, Math.min(frame.u1 - w / 2, plan.u));
  plan.n = Math.max(frame.v0, Math.min(frame.v1 - d, plan.n));
}
function syncPlanUI() {
  document.querySelectorAll('[data-pf]').forEach(b => b.setAttribute('aria-pressed', +b.dataset.pf === plan.f));
  $('planb').setAttribute('aria-pressed', plan.f > 0);
  $('psl').setAttribute('aria-disabled', plan.f === 0 || plan.f === 3);
  const sz = plan.size[plan.f === 1 ? 1 : 2];
  $('pw').value = sz.w; $('pd').value = sz.d; $('pu').value = plan.u; $('pn').value = plan.n - frame.v0;
  $('pwo').textContent = sz.w.toFixed(1) + 'm'; $('pdo').textContent = sz.d.toFixed(1) + 'm';
  const off = plan.u - (frame.u0 + frame.u1) / 2;
  $('puo').textContent = Math.abs(off) < .05 ? 'まん中' : (off > 0 ? '東 ' : '西 ') + Math.abs(off).toFixed(1) + 'm';
  $('pno').textContent = (plan.n - frame.v0).toFixed(1) + 'm';
}
function drawPlan() {
  if (planG) { siteG.remove(planG); disposeTree(planG); planG = null; }
  if (!plan.f) return;
  planG = new THREE.Group(); siteG.add(planG);
  if (plan.f === 3) { drawDrawn(); return; }
  const a = planArgs(), eave = S.planHeight(a.floors, a.d) - a.d / 2 * .45 / 2;
  const box = planBox(), y0 = S.planBase(box);
  const walls = prism(box, eave); walls.translate(0, y0, 0); const wm = new THREE.Mesh(walls, new THREE.MeshStandardMaterial({ color: 0xfbf7f0, roughness: .8 })); wm.castShadow = wm.receiveShadow = true; wm.userData.plan = true; planG.add(wm);
  const ux = Math.cos(a.angle * R), uz = Math.sin(a.angle * R);
  const r = gable({ cx: a.cx, cz: a.cz, ux, uz, L: a.w, W: a.d }, y0 + eave, .45);
  const rm = new THREE.Mesh(r.roof, new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: .55, side: THREE.DoubleSide })); rm.castShadow = rm.receiveShadow = true; rm.userData.plan = true; planG.add(rm);
  const em = new THREE.Mesh(r.ends, new THREE.MeshStandardMaterial({ color: 0xfbf7f0, roughness: .8, side: THREE.DoubleSide })); em.castShadow = true; em.userData.plan = true; planG.add(em);
  const eg = new THREE.EdgesGeometry(walls); planG.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0xf7890a })));
  // LDK の窓の印
  const s = Math.sin(a.angle * R), c = Math.cos(a.angle * R);
  const win = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(3.6, a.w * .6), 2), new THREE.MeshBasicMaterial({ color: 0xf7890a, side: THREE.DoubleSide, toneMapped: false }));
  win.position.set(a.cx - s * (a.d / 2 + .05), y0 + 1.2, a.cz + c * (a.d / 2 + .05)); win.rotation.y = -a.angle * R; planG.add(win);
  label(planG, 'LDK', a.cx - s * (a.d / 2 + .6), a.cz + c * (a.d / 2 + .6), 2.2, 3);
}
// 描いた形：壁を軒まで、屋根は軒の上に平均1.0mの厚みで（計算と同じ高さ）
function drawDrawn() {
  drawnBldgs().forEach(b => {
    const eave = b.h - 1, y0 = S.planBase(b.p);
    const w = prism(b.p, eave); w.translate(0, y0, 0); const wm = new THREE.Mesh(w, new THREE.MeshStandardMaterial({ color: 0xfbf7f0, roughness: .8 })); wm.castShadow = wm.receiveShadow = true; planG.add(wm);
    planG.add(new THREE.LineSegments(new THREE.EdgesGeometry(w), new THREE.LineBasicMaterial({ color: 0xf7890a })));
    const r = prism(b.p, 1); r.translate(0, y0 + eave, 0); const rm = new THREE.Mesh(r, new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: .55 })); rm.castShadow = rm.receiveShadow = true; planG.add(rm);
  });
  const st = DRAWN.win || S.autoWindow(drawnBldgs(), plan.angle);
  if (st) { const m = new THREE.Mesh(new THREE.SphereGeometry(.35, 16, 8), new THREE.MeshBasicMaterial({ color: 0xf7890a, toneMapped: false })); m.position.set(st[0], S.lotGround(st[0], st[1]) + 1.2, st[1]); planG.add(m); label(planG, 'LDK', st[0], st[1], 2.2, 3); }
}
function planChanged(calc) {
  clampPlan(); syncPlanUI(); drawPlan(); heatFor = ''; if (heat.visible) drawHeat(curDay());
  store.set('gos-sun-plan-' + SITE, { f: plan.f, u: plan.u, n: plan.n, size: plan.size, sig: JSON.stringify(DRAWN.bldgs) });
  if (calc) { later('center', centerHours, 150); later('cmp', comparePlans, 400); later('shades', shadeList, 400); }
}
document.querySelectorAll('[data-pf]').forEach(b => b.addEventListener('click', () => { plan.f = +b.dataset.pf; planChanged(true); }));
$('planb').addEventListener('click', () => { plan.f = plan.f ? 0 : 2; planChanged(true); if (plan.f && curView === 'town') setView('bird'); });
[['pw', v => plan.size[plan.f === 1 ? 1 : 2].w = v], ['pd', v => plan.size[plan.f === 1 ? 1 : 2].d = v], ['pu', v => plan.u = v], ['pn', v => plan.n = frame.v0 + v]].forEach(([id, fn]) => {
  $(id).addEventListener('input', e => { fn(+e.target.value); planChanged(false); later('calc', () => planChanged(true), 250); });
});
// 平屋と2階建てを、同じ位置（北の境界からの距離・東西の位置）で比べる
let cmpRun = 0;
function comparePlans() {
  if (!LOT) return; const run = ++cmpRun;
  $('cmp').hidden = false;
  const days = [['冬至', YEAR + '-12-22'], ['春分', YEAR + '-03-20'], ['夏至', YEAR + '-06-21']];
  const rows = [[1, '平屋'], [2, '2階建て']].concat(DRAWN.bldgs.length ? [[3, '配置図の形']] : []);
  const res = {}; const jobs = []; rows.forEach(([f]) => days.forEach(([, ds]) => jobs.push([f, ds])));
  $('cmpb').innerHTML = '<tr><td colspan="4" class="busy">計算しています…</td></tr>';
  const step = () => {
    if (run !== cmpRun) return;
    const job = jobs.shift();
    if (job) { const [f, ds] = job; res[f + ds] = f === 3 ? drawnStats(ds) : S.planStats(ds, planArgs(f), LOT, OCC, LAT, LON); setTimeout(step, 0); return; }
    const td = v => v == null ? '<td>-</td>' : `<td>${v.toFixed(1)}h</td>`;
    const body = [['南の庭（平均）', 'garden'], ['1階LDKの窓', 'ldk']].map(([name, k]) => `<tr class="grp"><th colspan="4">${name}</th></tr>` + rows.map(([f, n]) => `<tr class="${plan.f === f ? 'on' : ''}"><td>${n}<span class="small muted">（${f === 3 ? DRAWN.bldgs.reduce((s, b) => s + S.polyArea(b.p), 0).toFixed(1) + '㎡' : plan.size[f].w.toFixed(1) + '×' + plan.size[f].d.toFixed(1) + 'm'}）</span></td>${days.map(([, ds]) => td(res[f + ds][k])).join('')}</tr>`).join('')).join('');
    $('cmpb').innerHTML = body;
    const g1 = res[1 + days[0][1]], g2 = res[2 + days[0][1]];
    $('cmptip').textContent = g1.garden != null && g2.garden != null
      ? `冬至の南の庭は、平屋 ${g1.garden.toFixed(1)}時間・2階建て ${g2.garden.toFixed(1)}時間（庭の広さ 平屋 約${g1.gardenArea}㎡・2階建て 約${g2.gardenArea}㎡）。LDKの窓は 平屋 ${g1.ldk.toFixed(1)}時間・2階建て ${g2.ldk.toFixed(1)}時間。`
      : '建物の南に庭がありません。北の境界に寄せるか、奥行を短くしてください。';
  };
  setTimeout(step, 0);
}

// ---------- 3Dの上で押す・引っぱる ----------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), gplane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitP = new THREE.Vector3();
let down = null, drag = null;
function setRay(e) { const r = rnd.domElement.getBoundingClientRect(); ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(ndc, cam); }
rnd.domElement.addEventListener('pointerdown', e => {
  down = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (!planG || plan.f === 3) return;
  setRay(e); const hit = ray.intersectObjects(planG.children.filter(c => c.userData.plan))[0];
  if (hit && ray.ray.intersectPlane(gplane, hitP)) { const [u, v] = toUV(hitP.x, hitP.z); drag = { du: plan.u - u, dn: plan.n - v }; orbit.enabled = false; rnd.domElement.setPointerCapture(e.pointerId); }
});
rnd.domElement.addEventListener('pointermove', e => {
  if (!drag) return; setRay(e);
  if (ray.ray.intersectPlane(gplane, hitP)) { const [u, v] = toUV(hitP.x, hitP.z); plan.u = u + drag.du; plan.n = v + drag.dn; planChanged(false); }
});
rnd.domElement.addEventListener('pointerup', e => {
  if (drag) { drag = null; orbit.enabled = true; planChanged(true); down = null; return; }
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 600) { down = null; return; }
  down = null; if (!cityG) return;
  setRay(e); const hit = ray.intersectObjects(cityG.children)[0];
  select(hit && hit.object.userData.owner ? hit.object.userData.owner[hit.faceIndex] : -1);
});

// ---------- 敷地の読み込み ----------
async function loadSite(key) {
  try {
    const r = await fetch('sites/' + encodeURIComponent(key) + '.json'); if (!r.ok) throw new Error(r.status);
    buildSite(await r.json(), key);
    store.set('gos-sun-site', key);
    ['toplan', 'toplan2'].forEach(id => $(id).href = 'plan.html?site=' + encodeURIComponent(key));
    try { const u = new URL(location.href); u.searchParams.set('site', key); history.replaceState(null, '', u); } catch (e) {}
  } catch (e) {
    console.error(e);
    const l = $('load') || stage.appendChild(Object.assign(document.createElement('div'), { id: 'load', className: 'load' }));
    l.textContent = '敷地のデータを読み込めませんでした。ページを再読み込みしてください。';
  }
}
(async () => {
  let list = [];
  try { list = await (await fetch('sites/index.json')).json(); } catch (e) {}
  let key = null; try { key = new URLSearchParams(location.search).get('site'); } catch (e) {}
  if (!key || !list.some(s => s.key === key)) key = store.get('gos-sun-site');
  if (!key || !list.some(s => s.key === key)) key = list.length ? list[0].key : key;
  if (list.length > 1) {
    const sel = $('sitesel'); sel.hidden = false; $('srcl').hidden = true;
    sel.innerHTML = list.map(s => `<option value="${s.key}">${s.name}</option>`).join(''); sel.value = key;
    sel.addEventListener('change', () => { $('stagecard').scrollIntoView({ block: 'start' }); loadSite(sel.value); });
  }
  if (!key) { $('load').textContent = '敷地のデータがありません（sites/index.json）。'; return; }
  loadSite(key);
})();
fixedNote();
// 配置図で描き直したら（別のタブや、戻ってきたとき）読み直す
// 配置図で描き直したら、自動で「配置図の形」にする
function drawnChanged() { if (!LOT) return; const before = JSON.stringify(DRAWN); loadDrawn(); if (JSON.stringify(DRAWN) !== before) { if (DRAWN.bldgs.length) plan.f = 3; syncPlanUI(); planChanged(true); } }
addEventListener('storage', e => { if (LOT && e.key === 'gos-sun-fill-' + SITE) { S.setEnv({ fill: store.get(e.key) || 0 }); drawLot(); drawPlan(); newDay(); later('cmp', comparePlans, 300); }
  if (e.key === 'gos-sun-draw-' + SITE) drawnChanged(); if (e.key === TK && applyTime()) { lastT = JSON.stringify(store.get(TK)); newDay(); } });
addEventListener('pageshow', drawnChanged);
document.addEventListener('visibilitychange', () => { if (!document.hidden) drawnChanged(); });

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
function loop(t) { requestAnimationFrame(loop); if (playing && t - last > (reduce ? 200 : 40)) { last = t; let m = +$('time').value + 5; if (m > 1260) m = 300; $('time').value = m; update(); } orbit.update(); sky.position.copy(cam.position); rnd.render(scene, cam); }
size(); update(); requestAnimationFrame(loop);
// 確認用（画面の操作には使わない）
window.__sun3d = { select, setHeight, plan, planChanged, comparePlans, get B() { return B; }, get H() { return H; } };
})();
