// 書き込みの洗い出し（手書きスキャン × 図面の版）
// 試作（research/proto_reflect.py）をブラウザ用に移したもの。有料APIは使わず、OpenCV（opencv.js）だけで動く。
//
// 1) PDFのページを画像にする（長い辺 LONG ピクセル）
// 2) スキャンの各ページに合う図面のページを探す（ORB の特徴点を照らし合わせ、一致点の多いページ）
// 3) 位置・傾き・縮尺を合わせる（射影変換 → ECC で微調整）
// 4) 手書き＝スキャンにあって図面の版にない線・色。近いものをまとめて1件の「書き込み」にする
// 5) 打合せ前と打合せ後の版がそろえば、書き込みの周りで図面が変わったか（反映）を見る
//    変わったのに書き込みがない場所は「指示外の変更」

export const LONG = 1820;           // A3 を 110dpi で描いたくらい
const PAIR_LONG = 910;              // ページ探しは半分の大きさで速く
const MIN_INLIERS = 60;             // 半分の大きさで、これより一致点が少なければ「合うページなし」

// ---------- opencv.js の読み込み ----------
// 注意：opencv.js の cv は then を持つので、await や Promise の値にしてはいけない（終わらなくなる）。
// cv.Mat ができるまで待ち、{ cv } に包んで返す
export function loadCv(src) {
  if (globalThis.cv?.Mat) return Promise.resolve({ cv: globalThis.cv });
  return new Promise((resolve, reject) => {
    if (!document.querySelector('script[data-opencv]')) {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.dataset.opencv = '1';
      s.onerror = () => reject(new Error('画像処理の部品（opencv.js）を読み込めませんでした'));
      document.head.append(s);
    }
    const t0 = Date.now();
    const tick = () => {
      if (globalThis.cv?.Mat) return resolve({ cv: globalThis.cv });
      if (Date.now() - t0 > 120000) return reject(new Error('画像処理の部品の準備が終わりませんでした'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

const pause = () => new Promise(r => setTimeout(r, 0));
// 処理時間の内訳（遅いところを探す用）
const prof = {};
function timed(k, fn) { const t = performance.now(); try { return fn(); } finally { prof[k] = (prof[k] || 0) + performance.now() - t; } }

// ---------- PDF → 画像・文字 ----------
export async function renderPdfPage(pdf, n, long = LONG) {
  const page = await pdf.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = long / Math.max(vp1.width, vp1.height);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  // 文字（CAD のPDFなら文字が入っている。スキャンは空）
  let words = [];
  try {
    const tc = await page.getTextContent();
    const T = vp.transform;
    words = tc.items.filter(it => it.str && it.str.trim()).map(it => {
      const [a, b, c, d, e, f] = it.transform;
      const x = T[0] * e + T[2] * f + T[4], y = T[1] * e + T[3] * f + T[5];
      const fh = Math.hypot(c, d) * scale, w = (it.width || 0) * scale;
      return { s: it.str.replace(/\s+/g, ''), cx: x + w / 2, cy: y - fh / 2, w: Math.max(w, 2), h: Math.max(fh, 2) };
    });
  } catch { /* 文字が取れなくても線は比べられる */ }
  return { canvas, words, page: n };
}

// ---------- 小物 ----------
function rgba(canvas) { return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data; }
function toMat(cv, arr, w, h) { const m = new cv.Mat(h, w, cv.CV_8UC1); m.data.set(arr); return m; }
function dilate(cv, arr, w, h, k) {
  if (k <= 1) return arr;
  const src = toMat(cv, arr, w, h), dst = new cv.Mat(), K = cv.Mat.ones(k, k, cv.CV_8U);
  cv.dilate(src, dst, K);
  const out = new Uint8Array(dst.data);
  src.delete(); dst.delete(); K.delete();
  return out;
}
function components(cv, arr, w, h) {
  const src = toMat(cv, arr, w, h), lab = new cv.Mat(), st = new cv.Mat(), ce = new cv.Mat();
  const n = cv.connectedComponentsWithStats(src, lab, st, ce, 8, cv.CV_32S);
  const stats = [];
  for (let k = 1; k < n; k++) {
    const o = k * 5;
    stats.push({ k, x: st.data32S[o], y: st.data32S[o + 1], w: st.data32S[o + 2], h: st.data32S[o + 3], area: st.data32S[o + 4] });
  }
  const labels = new Int32Array(lab.data32S);
  src.delete(); lab.delete(); st.delete(); ce.delete();
  return { stats, labels };
}
// RGBA → 灰色・彩度・明度・色相（OpenCV と同じ尺度：S,V は 0-255、H は 0-180）
function hsvg(px, n) {
  const G = new Uint8Array(n), S = new Uint8Array(n), V = new Uint8Array(n), H = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    G[j] = (r * 299 + g * 587 + b * 114) / 1000;
    V[j] = mx; S[j] = mx ? (d * 255 / mx) : 0;
    let hh = 0;
    if (d) hh = mx === r ? 60 * (g - b) / d : mx === g ? 120 + 60 * (b - r) / d : 240 + 60 * (r - g) / d;
    if (hh < 0) hh += 360;
    H[j] = hh / 2;
  }
  return { G, S, V, H };
}
function applyH(M, x, y) {
  const d = M[6] * x + M[7] * y + M[8];
  return [(M[0] * x + M[1] * y + M[2]) / d, (M[3] * x + M[4] * y + M[5]) / d];
}
function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);
}
const scaleH = (M, s) => { // 大きさ s 倍の画像どうしの変換に直す
  const S = [s, 0, 0, 0, s, 0, 0, 0, 1], Si = [1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1];
  return mul3(S, mul3(M, Si));
};
function mul3(a, b) {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

// ---------- 特徴点・位置合わせ ----------
function features(cv, canvas, long, n) {
  const s = long / Math.max(canvas.width, canvas.height);
  const src = cv.imread(canvas), g = new cv.Mat(), sm = new cv.Mat();
  cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
  if (Math.abs(s - 1) > 1e-3) cv.resize(g, sm, new cv.Size(Math.round(canvas.width * s), Math.round(canvas.height * s)), 0, 0, cv.INTER_AREA);
  else g.copyTo(sm);
  const orb = new cv.ORB(n), kp = new cv.KeyPointVector(), des = new cv.Mat(), none = new cv.Mat();
  orb.detectAndCompute(sm, none, kp, des);
  const pts = [];
  for (let i = 0; i < kp.size(); i++) { const p = kp.get(i).pt; pts.push([p.x / s, p.y / s]); }
  src.delete(); g.delete(); sm.delete(); orb.delete(); kp.delete(); none.delete();
  return { pts, des, s };
}
function freeF(f) { try { f?.des?.delete(); } catch { /* 済み */ } }

// a の点 → b の点 への射影変換（a,b はどちらも元の大きさの座標）
function homography(cv, fa, fb) {
  if (!fa.des.rows || !fb.des.rows) return { inliers: 0, H: null };
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false), mm = new cv.DMatchVectorVector();
  bf.knnMatch(fa.des, fb.des, mm, 2);
  const src = [], dst = [];
  for (let i = 0; i < mm.size(); i++) {
    const v = mm.get(i);
    if (v.size() < 2) continue;
    const m = v.get(0), n2 = v.get(1);
    if (m.distance < 0.75 * n2.distance) { src.push(...fa.pts[m.queryIdx]); dst.push(...fb.pts[m.trainIdx]); }
  }
  bf.delete(); mm.delete();
  const n = src.length / 2;
  if (n < 25) return { inliers: n, H: null };
  const A = cv.matFromArray(n, 1, cv.CV_32FC2, src), B = cv.matFromArray(n, 1, cv.CV_32FC2, dst), mask = new cv.Mat();
  const Hm = cv.findHomography(A, B, cv.RANSAC, 4 / Math.min(fa.s, fb.s), mask);
  let inliers = 0;
  for (let i = 0; i < mask.rows; i++) if (mask.data[i]) inliers++;
  const H = Hm.rows === 3 ? Array.from(Hm.data64F) : null;
  A.delete(); B.delete(); mask.delete(); Hm.delete();
  // 裏返し・極端なゆがみは外す
  if (H) {
    const det = H[0] * H[4] - H[1] * H[3];
    if (!(det > 0.2 && det < 5)) return { inliers: 0, H: null };
  }
  return { inliers, H };
}

// src（キャンバス）を H で写して、w×h のキャンバスにする
function warpCanvas(cv, canvas, H, w, h, inverse = false) {
  const src = cv.imread(canvas), dst = new cv.Mat(), M = cv.matFromArray(3, 3, cv.CV_64F, H);
  cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR | (inverse ? cv.WARP_INVERSE_MAP : 0), cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  cv.imshow(out, dst);
  src.delete(); dst.delete(); M.delete();
  return out;
}

// ECC で細かいずれを合わせる（半分の大きさで計算）。だめなら null
function refineEcc(cv, ref, mov) {
  const s = 0.5;
  const prep = c => {
    const a = cv.imread(c), g = new cv.Mat(), sm = new cv.Mat(), b = new cv.Mat();
    cv.cvtColor(a, g, cv.COLOR_RGBA2GRAY);
    cv.resize(g, sm, new cv.Size(Math.round(c.width * s), Math.round(c.height * s)), 0, 0, cv.INTER_AREA);
    cv.GaussianBlur(sm, b, new cv.Size(5, 5), 0);
    a.delete(); g.delete(); sm.delete();
    return b;
  };
  const A = prep(ref), B = prep(mov), W = cv.Mat.eye(3, 3, cv.CV_32F), none = new cv.Mat();
  let out = null;
  try {
    cv.findTransformECC(A, B, W, cv.MOTION_HOMOGRAPHY, new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 50, 1e-5), none, 5);
    const M = Array.from(W.data32F);
    // ずれの補正が大きすぎるときは信用しない
    const [dx, dy] = applyH(M, A.cols / 2, A.rows / 2);
    if (Math.hypot(dx - A.cols / 2, dy - A.rows / 2) < 30 && M.every(Number.isFinite)) out = scaleH(M, 1 / s);
  } catch { /* 収束しないときはそのまま */ }
  A.delete(); B.delete(); W.delete(); none.delete();
  return out;
}

// ---------- 文字の差（CAD どうし）：900→910 のような書き換えを拾う ----------
function textDiffMask(wb, wa, HaToB, w, h) {
  const m = new Uint8Array(w * h);
  m.words = [];
  const A = wa.map(t => { const [x, y] = HaToB ? applyH(HaToB, t.cx, t.cy) : [t.cx, t.cy]; return { ...t, cx: x, cy: y }; });
  const unmatched = (P, Q) => P.filter(p => !Q.some(q => q.s === p.s && Math.abs(q.cx - p.cx) < 8 && Math.abs(q.cy - p.cy) < 8));
  for (const t of [...unmatched(wb, A), ...unmatched(A, wb)]) {
    m.words.push(t);
    const x0 = Math.max(0, Math.floor(t.cx - t.w / 2)), x1 = Math.min(w, Math.ceil(t.cx + t.w / 2));
    const y0 = Math.max(0, Math.floor(t.cy - t.h / 2)), y1 = Math.min(h, Math.ceil(t.cy + t.h / 2));
    for (let y = y0; y < y1; y++) m.fill(255, y * w + x0, y * w + x1);
  }
  return m;
}

const sumBox = (arr, w, x0, y0, x1, y1) => { let c = 0; for (let y = y0; y < y1; y++) for (let x = x0, i = y * w + x0; x < x1; x++, i++) if (arr[i]) c++; return c; };

// ---------- 1ページ分 ----------
// scan: 位置合わせ済みのスキャン（ref と同じ大きさ）、ref: 手書きを見分ける基準の版、
// base/after: 打合せ前・後（反映を見る。ref の座標にそろえ済み）、tdiff: 文字の差
function analyzePage(cv, { scan, ref, refIsBase, base, after, tdiff }) {
  const w = ref.width, h = ref.height, n = w * h;
  const S = hsvg(rgba(scan), n), R = hsvg(rgba(ref), n);
  // 手書き
  const colS = new Uint8Array(n), refAny = new Uint8Array(n), refCol = new Uint8Array(n), darkS = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    colS[i] = S.S[i] > 70 && S.V[i] > 60 ? 255 : 0;
    darkS[i] = S.G[i] < 110 ? 255 : 0;
    refAny[i] = R.G[i] < 235 ? 255 : 0;
    refCol[i] = R.S[i] > 40 || R.G[i] < 235 ? 255 : 0;
  }
  const refCol9 = dilate(cv, refCol, w, h, 9);
  // 黒ペンは「打合せ前の版」があるときだけ（後の版だけだと、消えた線を手書きと取り違える）
  const refAny15 = refIsBase ? dilate(cv, refAny, w, h, 15) : null;
  let hand = new Uint8Array(n);
  const B = 25;
  for (let y = B; y < h - B; y++) for (let x = B, i = y * w + B; x < w - B; x++, i++) {
    if ((colS[i] && !refCol9[i]) || (refAny15 && darkS[i] && !refAny15[i])) hand[i] = 255;
  }
  { // 2×2 の「開く」：1〜2点のゴミを消す
    const src = toMat(cv, hand, w, h), dst = new cv.Mat(), K = cv.Mat.ones(2, 2, cv.CV_8U);
    cv.morphologyEx(src, dst, cv.MORPH_OPEN, K); hand = new Uint8Array(dst.data);
    src.delete(); dst.delete(); K.delete();
  }
  // 近い書き込みをまとめる。大きすぎるまとまりは、もう少し細かく分ける
  const g41 = components(cv, dilate(cv, hand, w, h, 41), w, h);
  let groups = g41.stats;
  const big = groups.filter(g => g.w * g.h > 0.06 * n);
  if (big.length) {
    const g21 = components(cv, dilate(cv, hand, w, h, 21), w, h).stats;
    groups = groups.filter(g => !big.includes(g)).concat(g21.filter(s => big.some(b => s.x >= b.x && s.y >= b.y && s.x + s.w <= b.x + b.w && s.y + s.h <= b.y + b.h)));
  }

  // 反映（打合せ前→後の変化）
  let diff = null, diffMain = null, diffColor = null;
  if (base && after) {
    const Bp = hsvg(rgba(base), n), Ap = hsvg(rgba(after), n);
    const pb = new Uint8Array(n), pa = new Uint8Array(n);
    for (let i = 0; i < n; i++) { pb[i] = Bp.G[i] < 225 ? 255 : 0; pa[i] = Ap.G[i] < 225 ? 255 : 0; }
    const pb5 = dilate(cv, pb, w, h, 5), pa5 = dilate(cv, pa, w, h, 5);
    diff = new Uint8Array(n);
    for (let i = 0; i < n; i++) if ((pb[i] && !pa5[i]) || (pa[i] && !pb5[i]) || (tdiff && tdiff[i])) diff[i] = 255;
    const cc = components(cv, diff, w, h); // 孤立した数ピクセルの点は消す
    const keep = new Uint8Array(cc.stats.length + 1);
    for (const s of cc.stats) keep[s.k] = s.area >= 4 ? 1 : 0;
    diffMain = new Uint8Array(n); diffColor = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!diff[i]) continue;
      if (!keep[cc.labels[i]]) { diff[i] = 0; continue; }
      const colored = (Bp.S[i] > 60 || Ap.S[i] > 60) && !(Bp.G[i] < 120 || Ap.G[i] < 120);
      if (colored && !(tdiff && tdiff[i])) diffColor[i] = 255; else diffMain[i] = 255;
    }
  } else if (after) {
    // 打合せ前の版がないとき：スキャンに印刷された線（手書き以外）と、後の版の線を比べる（参考）
    const Ap = hsvg(rgba(after), n);
    const ps = new Uint8Array(n), pa = new Uint8Array(n);
    const hand7 = dilate(cv, hand, w, h, 7);
    for (let i = 0; i < n; i++) { ps[i] = S.G[i] < 150 && S.S[i] < 90 && !hand7[i] ? 255 : 0; pa[i] = Ap.G[i] < 150 && Ap.S[i] < 90 ? 255 : 0; }
    const ps7 = dilate(cv, ps, w, h, 7), pa7 = dilate(cv, pa, w, h, 7);
    diffMain = new Uint8Array(n);
    for (let i = 0; i < n; i++) if ((ps[i] && !pa7[i]) || (pa[i] && !ps7[i] && !hand7[i])) diffMain[i] = 255;
  }

  // 書き込み1件ずつ
  const items = [], covered = new Uint8Array(n);
  // スキャンどうしの比べ（前の版なし）のときは、書き込みのない所の「普段の差」を基準にする
  let noiseRate = 0;
  if (diffMain && !diff) {
    const T = 140; const rates = [];
    const g = dilate(cv, hand, w, h, 41);
    for (let ty = 0; ty + T < h; ty += T) for (let tx = 0; tx + T < w; tx += T) {
      if (sumBox(g, w, tx, ty, tx + T, ty + T)) continue;
      rates.push(sumBox(diffMain, w, tx, ty, tx + T, ty + T) / (T * T));
    }
    rates.sort((a, b) => a - b);
    noiseRate = rates.length ? rates[Math.floor(rates.length * 0.75)] : 0.002;
  }
  for (const gr of groups) {
    const { x, y } = gr, bw = gr.w, bh = gr.h;
    let ink = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, mark = 0;
    for (let yy = y; yy < y + bh; yy++) for (let xx = x, i = yy * w + x; xx < x + bw; xx++, i++) {
      if (!hand[i]) continue;
      ink++; if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
      if (S.H[i] >= 20 && S.H[i] <= 50 && S.S[i] > 60 && S.V[i] > 170) mark++;
    }
    if (ink < (globalThis.__mkInk ?? 100)) continue;
    if (maxY - minY < 8 || maxX - minX < 8) continue; // まっすぐな細い線だけ（印刷のずれ）
    const p = globalThis.__mkPad ?? 60;
    const x0 = Math.max(0, x - p), y0 = Math.max(0, y - p), x1 = Math.min(w, x + bw + p), y1 = Math.min(h, y + bh + p);
    const isMarker = mark > 0.3 * ink;
    // 周りに図面が描かれていない（余白）なら、確認印・メモの可能性
    const around = sumBox(refAny, w, x0, y0, x1, y1) / ((x1 - x0) * (y1 - y0));
    const cx = (x + bw / 2) / w, cy = (y + bh / 2) / h;
    const corner = (cx < 0.12 || cx > 0.88) && (cy < 0.15 || cy > 0.85) && bw < 0.15 * w && bh < 0.2 * h;
    const memo = around < 0.012 || corner;
    let judge = 'wait', change = 0;
    if (diff) {
      change = sumBox(diffMain, w, x0, y0, x1, y1) + (isMarker ? sumBox(diffColor, w, x0, y0, x1, y1) : 0);
      judge = change > 40 ? 'ok' : 'ng';
    } else if (diffMain) {
      change = sumBox(diffMain, w, x0, y0, x1, y1);
      const expect = noiseRate * (x1 - x0) * (y1 - y0);
      judge = change > Math.max(40, expect * 2.2) ? 'ok' : 'ng';
    }
    if (memo) judge = judge === 'ok' ? 'ok' : 'memo';
    for (let yy = y0; yy < y1; yy++) covered.fill(1, yy * w + x0, yy * w + x1);
    items.push({ box: [x0, y0, x1 - x0, y1 - y0], ink, change, judge, marker: isMarker, memo });
  }
  // 上から下、左から右の順に番号
  items.sort((a, b) => (Math.floor(a.box[1] / 200) - Math.floor(b.box[1] / 200)) || (a.box[0] - b.box[0]));
  items.forEach((it, i) => { it.no = i + 1; });

  // 指示外の変更
  const others = [];
  if (diff) {
    const d31 = dilate(cv, diff, w, h, 31);
    for (let i = 0; i < n; i++) if (covered[i]) d31[i] = 0;
    // 図面枠の日付（2026/10/26 → 2026/11/03）が変わっただけのところは数えない
    const dates = (tdiff?.words || []).filter(t => /^\d{2,4}[/.年]\d{1,2}[/.月]\d{1,2}日?$/.test(t.s));
    const onDate = (x, y) => dates.some(t => Math.abs(x - t.cx) < t.w / 2 + 6 && Math.abs(y - t.cy) < t.h / 2 + 6);
    for (const s of components(cv, d31, w, h).stats) {
      let px = 0, notDate = 0;
      for (let yy = s.y; yy < s.y + s.h; yy++) for (let xx = s.x, i = yy * w + s.x; xx < s.x + s.w; xx++, i++) {
        if (!diff[i]) continue;
        px++; if (!dates.length || !onDate(xx, yy)) notDate++;
      }
      if (px >= 150 && notDate >= 60) others.push({ box: [s.x, s.y, s.w, s.h], change: px });
    }
  }
  return { items, others, hand };
}

// ---------- 全体 ----------
// scanPdf: 手書きスキャン、basePdf: 打合せ前の版（任意）、afterPdf: 打合せ後の版（任意）
export async function analyze(cv, { scanPdf, basePdf, afterPdf, onProgress = () => {} }) {
  const refPdf = basePdf || afterPdf;
  const say = (t, r) => { onProgress(t, r); if (globalThis.__mkDebug) console.log(Math.round(performance.now()), t, JSON.stringify(prof)); return pause(); };
  const pagesOf = async (pdf, label) => {
    const out = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      await say(`${label}の ${i}/${pdf.numPages} ページを読み込み中`, 0);
      const r = await renderPdfPage(pdf, i);
      r.f = timed('特徴点', () => features(cv, r.canvas, PAIR_LONG, 3000));
      out.push(r);
    }
    return out;
  };
  const refs = refPdf ? await pagesOf(refPdf, basePdf ? '打合せ前の版' : '打合せ後の版') : [];
  const afters = basePdf && afterPdf ? await pagesOf(afterPdf, '打合せ後の版') : null;
  const result = { pages: [], mode: basePdf && afterPdf ? 'trio' : afterPdf ? 'after' : basePdf ? 'base' : 'scan' };
  try {
    for (let si = 1; si <= scanPdf.numPages; si++) {
      await say(`スキャン ${si}/${scanPdf.numPages} ページ：合う図面のページを探しています`, (si - 1) / scanPdf.numPages);
      const t1 = performance.now(); const sc = await renderPdfPage(scanPdf, si); prof['PDF描画'] = (prof['PDF描画'] || 0) + performance.now() - t1;
      const page = { scanPage: si, items: [], others: [] };
      let ref = null, H = null, best = { inliers: 0 };
      if (refs.length) {
        const fs = timed('特徴点', () => features(cv, sc.canvas, PAIR_LONG, 3000));
        timed('ページ探し', () => refs.forEach((r, i) => { const m = homography(cv, fs, r.f); if (m.inliers > best.inliers) best = { ...m, i }; }));
        freeF(fs);
        page.inliers = best.inliers;
        if (best.H && best.inliers >= MIN_INLIERS) {
          ref = refs[best.i];
          // 元の大きさで合わせ直す
          await say(`スキャン ${si} ページ：位置を合わせています`, (si - 0.7) / scanPdf.numPages);
          ref.full ??= timed('特徴点', () => features(cv, ref.canvas, LONG, 6000));
          const fA = timed('特徴点', () => features(cv, sc.canvas, LONG, 6000));
          const fine = timed('位置合わせ', () => homography(cv, fA, ref.full));
          freeF(fA);
          H = fine.H && fine.inliers > best.inliers ? fine.H : best.H;
        }
      }
      if (refs.length && !ref) {
        page.status = 'nomatch';
        page.thumb = shrink(sc.canvas, 900);
        result.pages.push(page);
        continue;
      }
      let scanW, refC, baseC = null, afterC = null, tdiff = null;
      if (ref) {
        refC = ref.canvas;
        scanW = timed('位置合わせ', () => warpCanvas(cv, sc.canvas, H, refC.width, refC.height));
        const M = timed('ECC', () => refineEcc(cv, refC, scanW));
        if (M) scanW = warpCanvas(cv, scanW, M, refC.width, refC.height, true);
        page.refPage = ref.page;
        if (basePdf) baseC = refC; else afterC = refC;
        if (afters) {
          let ab = { inliers: 0 };
          ref.after ??= timed('ページ探し', () => { let ab = { inliers: 0 }; afters.forEach((a, i) => { const m = homography(cv, a.f, ref.f); if (m.inliers > ab.inliers) ab = { ...m, i }; }); return ab; });
          ab = ref.after;
          if (ab.H && ab.inliers >= MIN_INLIERS) {
            const a = afters[ab.i];
            afterC = warpCanvas(cv, a.canvas, ab.H, refC.width, refC.height);
            tdiff = timed('文字の差', () => textDiffMask(ref.words, a.words, ab.H, refC.width, refC.height));
            page.afterPage = a.page;
          }
        }
      } else {
        scanW = sc.canvas; refC = blankLike(sc.canvas);
      }
      await say(`スキャン ${si} ページ：書き込みを洗い出しています`, (si - 0.4) / scanPdf.numPages);
      const r = timed('洗い出し', () => analyzePage(cv, { scan: scanW, ref: refC, refIsBase: !!basePdf, base: baseC, after: afterC, tdiff }));
      page.status = 'ok';
      page.items = r.items.map(it => ({ ...it, crops: crops(it.box, scanW, baseC, afterC) }));
      page.others = r.others.map(o => ({ ...o, crops: crops(pad(o.box, 30, refC), scanW, baseC, afterC) }));
      page.view = timed('表示', () => pageView(scanW, r.hand, page.items, page.others));
      page.size = [refC.width, refC.height];
      result.pages.push(page);
    }
  } finally {
    refs.forEach(r => { freeF(r.f); freeF(r.full); }); afters?.forEach(r => freeF(r.f));
    result.prof = Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, Math.round(v)]));
    for (const k in prof) delete prof[k];
  }
  await say('完了', 1);
  return result;
}

function blankLike(c) { const b = document.createElement('canvas'); b.width = c.width; b.height = c.height; const x = b.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, b.width, b.height); return b; }
function pad(box, p, c) { const [x, y, w, h] = box; const x0 = Math.max(0, x - p), y0 = Math.max(0, y - p); return [x0, y0, Math.min(c.width, x + w + p) - x0, Math.min(c.height, y + h + p) - y0]; }
function shrink(c, W) {
  const s = Math.min(1, W / c.width), o = document.createElement('canvas');
  o.width = Math.round(c.width * s); o.height = Math.round(c.height * s);
  o.getContext('2d').drawImage(c, 0, 0, o.width, o.height);
  return o;
}
function cut(c, [x, y, w, h], max = 520) {
  const s = Math.min(1.4, max / Math.max(w, h)), o = document.createElement('canvas');
  o.width = Math.max(1, Math.round(w * s)); o.height = Math.max(1, Math.round(h * s));
  const ctx = o.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, x, y, w, h, 0, 0, o.width, o.height);
  return o;
}
function crops(box, scan, base, after) {
  return { scan: cut(scan, box), base: base ? cut(base, box) : null, after: after ? cut(after, box) : null };
}
// ページ全体の絵：スキャン（薄く）＋手書き（緑）＋枠と番号
const COLORS = { ok: '#2f9e44', ng: '#e03131', wait: '#f08c00', memo: '#868e96', other: '#f76707' };
function pageView(scan, hand, items, others) {
  const W = 1400, s = W / scan.width;
  const c = document.createElement('canvas'); c.width = W; c.height = Math.round(scan.height * s);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalAlpha = 0.5; ctx.drawImage(scan, 0, 0, c.width, c.height); ctx.globalAlpha = 1;
  // 手書きを緑で重ねる
  const m = document.createElement('canvas'); m.width = scan.width; m.height = scan.height;
  const mx = m.getContext('2d'), id = mx.createImageData(m.width, m.height);
  for (let i = 0, j = 0; i < hand.length; i++, j += 4) if (hand[i]) { id.data[j] = 25; id.data[j + 1] = 140; id.data[j + 2] = 60; id.data[j + 3] = 255; }
  mx.putImageData(id, 0, 0);
  ctx.drawImage(m, 0, 0, c.width, c.height);
  ctx.lineWidth = 3; ctx.font = '700 22px Poppins, sans-serif';
  for (const o of others) { const [x, y, w, h] = o.box.map(v => v * s); ctx.setLineDash([8, 6]); ctx.strokeStyle = COLORS.other; ctx.strokeRect(x, y, w, h); }
  ctx.setLineDash([]);
  for (const it of items) {
    const [x, y, w, h] = it.box.map(v => v * s), col = COLORS[it.judge];
    ctx.strokeStyle = col; ctx.strokeRect(x, y, w, h);
    const t = String(it.no), tw = ctx.measureText(t).width + 14;
    ctx.fillStyle = col; ctx.fillRect(x, y, tw, 28); ctx.fillStyle = '#fff'; ctx.fillText(t, x + 7, y + 22);
  }
  return { canvas: c, scale: s };
}
