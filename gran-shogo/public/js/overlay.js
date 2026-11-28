// 図面の重ね合わせ（diff-pdf・MIIDEL・Bluebeam の「重ねて色分け」の考え方）
// 変更前だけにある線＝赤、変更後だけにある線＝青、両方にある線＝薄い灰色。
// 位置ずれ（スキャンや出力の違い）を補正してから比べ、変わった場所をオレンジの枠で囲む。
// 図の一部だけが用紙の中で動いた場合（平面図だけ下へ、など）は、場所ごとに合うずれを選んで合わせる。
import { blockShifts } from './core/shift.js';

export async function renderPage(pdf, pageNo, width) {
  const page = await pdf.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = width / vp1.width;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  // 文字の位置（画像の座標）。図がまとまって動いたかを見るのに使う。スキャンには無い
  const words = [];
  try {
    const tc = await page.getTextContent();
    for (const it of tc.items) {
      const s = (it.str || '').trim();
      if (!s) continue;
      const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      // w・h：文字の幅と高さ（画像の px）。y は文字の下の線
      words.push({ text: s, x, y, w: (it.width || 0) * scale, h: Math.hypot(it.transform[2], it.transform[3]) * scale || 8 * scale });
    }
  } catch { /* 文字が取れなくても線の比較はできる */ }
  return { canvas, scale, words };
}

const DARK = 170;

function gray(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) | 0;
  return { g, w, h };
}

// 粗くした画像で、ずれ（dx, dy）を総当たりで探す
function findShift(A, B, range = 14, step = 4) {
  const sw = Math.floor(A.w / step), sh = Math.floor(Math.min(A.h, B.h) / step);
  const small = (X) => {
    const s = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) s[y * sw + x] = X.g[(y * step) * X.w + x * step] < DARK ? 1 : 0;
    return s;
  };
  const a = small(A), b = small(B);
  let best = { dx: 0, dy: 0, score: -1 };
  const r = Math.ceil(range / step) + 2;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    let score = 0;
    for (let y = Math.max(0, -dy); y < Math.min(sh, sh - dy); y += 1) {
      const ra = y * sw, rb = (y + dy) * sw;
      for (let x = Math.max(0, -dx); x < Math.min(sw, sw - dx); x++) if (a[ra + x] && b[rb + x + dx]) score++;
    }
    if (score > best.score) best = { dx, dy, score };
  }
  return { dx: best.dx * step, dy: best.dy * step };
}

// 候補のずれを ±r px の範囲で細かく合わせ直す（文字の位置と線の位置の小さな差を吸収する）
function refine(A, B, s, inkA, r = 3) {
  let best = s, bestScore = -1;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const sx = s.dx + dx, sy = s.dy + dy;
    let score = 0;
    for (let k = 0; k < inkA.length; k += 2) {
      const x = inkA[k] + sx, y = inkA[k + 1] + sy;
      if (x >= 0 && y >= 0 && x < B.w && y < B.h && B.g[y * B.w + x] < DARK) score++;
    }
    if (score > bestScore) { bestScore = score; best = { dx: sx, dy: sy }; }
  }
  return best;
}

// どのずれでも合わない、変更前の線の点
function residual(A, B, inkA, shifts) {
  const rest = [];
  for (let k = 0; k < inkA.length; k += 2) {
    const x = inkA[k], y = inkA[k + 1];
    let ok = false;
    for (const s of shifts) {
      const bx = x + s.dx, by = y + s.dy;
      for (let d = -1; d <= 1 && !ok; d++) for (let e = -1; e <= 1 && !ok; e++) {
        const xx = bx + e, yy = by + d;
        if (xx >= 0 && yy >= 0 && xx < B.w && yy < B.h && B.g[yy * B.w + xx] < DARK) ok = true;
      }
      if (ok) break;
    }
    if (!ok) rest.push(x, y);
  }
  return rest;
}

// 残った点が一番多く重なるずれを、±range px の範囲で探す（4px 刻み → 合わせ直しは refine）
function searchWide(A, B, pts, range) {
  const step = 4, n = Math.min(pts.length / 2, 4000), every = Math.max(1, Math.floor(pts.length / 2 / n));
  // B の線を 4px のマスに縮めておく（マスの中に線があれば 1）
  const bw = Math.ceil(B.w / step), bh = Math.ceil(B.h / step);
  const grid = new Uint8Array(bw * bh);
  for (let y = 0; y < B.h; y++) for (let x = 0; x < B.w; x++) if (B.g[y * B.w + x] < DARK) grid[((y / step) | 0) * bw + ((x / step) | 0)] = 1;
  const r = Math.ceil(range / step);
  let best = { dx: 0, dy: 0 }, bestScore = -1;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    let score = 0;
    for (let k = 0; k < pts.length; k += 2 * every) {
      const gx = ((pts[k] / step) | 0) + dx, gy = ((pts[k + 1] / step) | 0) + dy;
      if (gx >= 0 && gy >= 0 && gx < bw && gy < bh && grid[gy * bw + gx]) score++;
    }
    if (score > bestScore) { bestScore = score; best = { dx: dx * step, dy: dy * step }; }
  }
  return best;
}

const TILE = 48;

/**
 * 2枚のページ画像を重ねる。返り値 { canvas, boxes:[{x,y,w,h,bx,by,textOnly}], shift, moved }
 * boxes の x,y は重ね合わせ（変更前の位置）、bx,by は変更後の図面での位置。
 * textOnly：その場所の違いが「同じ文字が少し動いただけ」（説明の文字の位置調整など）
 * words：{ a, b }（renderPage の words）。あれば、図がまとまって動いた分を場所ごとに合わせる。
 * moved：ページ全体と違うずれで合わせた範囲（図が動いた場所）の数
 * scan：片方がスキャン（にじみ・線の太さの違いを大目に見る）
 */
export function compose(canvasA, canvasB, words = null, { scan = false } = {}) {
  const A = gray(canvasA), B = gray(canvasB);
  const w = A.w, h = Math.max(A.h, B.h);
  // --- ずれの候補を集める ---
  const cand = [findShift(A, B)];
  if (words?.a?.length && words?.b?.length) {
    for (const s of blockShifts(words.a, words.b, { q: 4 })) cand.push({ dx: Math.round(s.dx), dy: Math.round(s.dy) });
  }
  // 変更前の線の点（間引いて）で、各候補を細かく合わせ直す
  const inkA = [];
  for (let y = 0; y < A.h; y += 3) for (let x = 0; x < A.w; x += 3) if (A.g[y * A.w + x] < DARK) inkA.push(x, y);
  const shifts = [];
  const add = c => {
    const s = refine(A, B, c, inkA);
    if (shifts.length >= 8 || shifts.some(o => Math.abs(o.dx - s.dx) <= 1 && Math.abs(o.dy - s.dy) <= 1)) return false;
    shifts.push(s); return true;
  };
  for (const c of cand) add(c);
  // 文字で見つからなかった動き（文字の少ない図・スキャン）は、まだ合っていない線だけで広く探す（2回まで）
  for (let round = 0; round < 2; round++) {
    const rest = residual(A, B, inkA, shifts);
    if (rest.length < inkA.length * 0.08 || rest.length < 400) break;
    if (!add(searchWide(A, B, rest, Math.round(w * 0.08)))) break;
  }
  // 両方の版に1つずつある同じ文字で、位置だけ少し変わったもの（説明の文字の位置調整など）の範囲
  const mA = new Uint8Array(A.w * A.h), mB = new Uint8Array(B.w * B.h);
  for (const [wa, wb] of movedWords(words, w)) { paint(mA, A, wa); paint(mB, B, wb); }
  const at = (X, x, y) => (x >= 0 && y >= 0 && x < X.w && y < X.h ? X.g[y * X.w + x] < DARK : false);
  // 1px のにじみは差分にしない（近くに相手の線があれば同じ線とみなす）
  // スキャンは線がにじみ・太さも違うので、2px まで離れていても同じ線とみなす
  const R = scan ? 2 : 1;
  const near = R === 1
    ? (X, x, y) => at(X, x, y) || at(X, x + 1, y) || at(X, x - 1, y) || at(X, x, y + 1) || at(X, x, y - 1)
    : (X, x, y) => { for (let d = -R; d <= R; d++) for (let e = -R; e <= R; e++) if (at(X, x + e, y + d)) return true; return false; };
  // --- 場所（48px のマス）ごとに、どのずれが一番よく合うかを選ぶ ---
  const tw = Math.ceil(w / TILE), th = Math.ceil(h / TILE), K = shifts.length;
  const score = new Float32Array(tw * th * K);
  if (K > 1) {
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      const x0 = tx * TILE, y0 = ty * TILE, x1 = Math.min(w, x0 + TILE), y1 = Math.min(h, y0 + TILE);
      for (let k = 0; k < K; k++) {
        const { dx, dy } = shifts[k];
        let sc = 0;
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
          const a = at(A, x, y), b = at(B, x + dx, y + dy);
          if (a) sc += near(B, x + dx, y + dy) ? 1 : -1;
          if (b) sc += near(A, x, y) ? 1 : -1;
        }
        score[(ty * tw + tx) * K + k] = sc;
      }
    }
  }
  // 周りのマスの点数も足して選ぶ（1マスだけ別のずれを選んで、本当の変更を消してしまわないように）
  const label = new Uint8Array(tw * th);
  const total = new Float64Array(K);
  for (let i = 0; i < tw * th; i++) for (let k = 0; k < K; k++) total[k] += score[i * K + k];
  const main = K > 1 ? total.indexOf(Math.max(...total)) : 0;
  if (K > 1) {
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      let best = main, bestSc = -Infinity;
      for (let k = 0; k < K; k++) {
        let sc = 0;
        for (let yy = Math.max(0, ty - 1); yy <= Math.min(th - 1, ty + 1); yy++)
          for (let xx = Math.max(0, tx - 1); xx <= Math.min(tw - 1, tx + 1); xx++)
            sc += score[(yy * tw + xx) * K + k] * (xx === tx && yy === ty ? 2 : 1);
        // 同点なら、ページ全体のずれを優先する
        if (sc > bestSc + (k === main ? -0.5 : 0.5)) { bestSc = sc; best = k; }
      }
      label[ty * tw + tx] = best;
    }
  } else label.fill(0);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const px = img.data;
  const cell = 16;
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const diff = new Uint16Array(gw * gh), diffT = new Uint16Array(gw * gh);
  // マスの境目で線が切れて赤・青に出ないよう、隣のマスのずれでも合えば同じ線とみなす
  const others = [];
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    const own = label[ty * tw + tx], set = [];
    for (let yy = Math.max(0, ty - 1); yy <= Math.min(th - 1, ty + 1); yy++)
      for (let xx = Math.max(0, tx - 1); xx <= Math.min(tw - 1, tx + 1); xx++) {
        const l = label[yy * tw + xx];
        if (l !== own && !set.includes(l)) set.push(l);
      }
    others.push(set.map(l => shifts[l]));
  }
  for (let y = 0; y < h; y++) {
    const trow = ((y / TILE) | 0) * tw;
    for (let x = 0; x < w; x++) {
      const ti = trow + ((x / TILE) | 0);
      const { dx, dy } = shifts[label[ti]];
      const i = (y * w + x) * 4;
      const a = at(A, x, y), b = at(B, x + dx, y + dy);
      let r, g, bl;
      if (a && !b && !near(B, x + dx, y + dy) && !others[ti].some(s => near(B, x + s.dx, y + s.dy))) { r = 200; g = 55; bl = 45; const ci = ((y / cell) | 0) * gw + ((x / cell) | 0); diff[ci]++; if (mA[y * w + x]) diffT[ci]++; }
      else if (b && !a && !near(A, x, y) && !others[ti].some(s => near(A, x + dx - s.dx, y + dy - s.dy))) { r = 68; g = 107; bl = 235; const ci = ((y / cell) | 0) * gw + ((x / cell) | 0); diff[ci]++; const bx = x + dx, by = y + dy; if (bx >= 0 && by >= 0 && bx < B.w && by < B.h && mB[by * B.w + bx]) diffT[ci]++; }
      else { r = g = bl = baseGray(A, B, x, y, dx, dy); }
      px[i] = r; px[i + 1] = g; px[i + 2] = bl; px[i + 3] = 255;
    }
  }
  // 線が数px動いただけの所（CAD の出し直しの小さなずれ）は、その場所だけ合わせ直して変更から外す
  const local = fitLocal(A, B, regions(diff, gw, gh, cell, scan ? 12 : 6), label, tw, th, shifts, at, near, px, diff, diffT, mA, mB, w, h, cell, gw);
  const shift = shifts[main];
  // ページ全体と違うずれで合わせたマスのかたまりの数（＝図が動いた場所）
  let moved = 0;
  if (K > 1) {
    const seen = new Uint8Array(tw * th);
    for (let i = 0; i < tw * th; i++) {
      if (seen[i] || label[i] === main) continue;
      moved++;
      const st = [i]; seen[i] = 1;
      while (st.length) {
        const k = st.pop(), x = k % tw, y = (k / tw) | 0;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          const n = ny * tw + nx;
          if (nx >= 0 && ny >= 0 && nx < tw && ny < th && !seen[n] && label[n] === label[k]) { seen[n] = 1; st.push(n); }
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const boxes = regions(diff, gw, gh, cell, scan ? 12 : 6);
  for (const b of boxes) {
    // 変更後の図面での位置（その場所で合わせたずれの分だけ動かす）
    const ti = Math.min(th - 1, ((b.y + b.h / 2) / TILE) | 0) * tw + Math.min(tw - 1, ((b.x + b.w / 2) / TILE) | 0);
    b.bx = b.x + shifts[label[ti]].dx; b.by = b.y + shifts[label[ti]].dy;
    // 違いの9割近くが「位置だけ変わった文字」の上なら、文字の位置調整だけとみなす
    let n = 0, t = 0;
    for (let cy = b.y / cell; cy < (b.y + b.h) / cell; cy++) for (let cx = b.x / cell; cx < (b.x + b.w) / cell; cx++) { n += diff[cy * gw + cx]; t += diffT[cy * gw + cx]; }
    b.textOnly = n > 0 && t >= n * 0.85;
  }
  ctx.strokeStyle = '#f7890a';
  ctx.lineWidth = Math.max(2, w / 600);
  for (const b of boxes) roundRect(ctx, b.x - 6, b.y - 6, b.w + 12, b.h + 12, 10);
  return { canvas: out, boxes, shift, moved, nudged: local };
}

// 両方の版にある線・文字は、元の濃さのまま少しだけ薄くして描く（白黒2値にすると細い文字がかすれるため）
function baseGray(A, B, x, y, dx, dy) {
  const ga = x < A.w && y < A.h ? A.g[y * A.w + x] : 255;
  const bx = x + dx, by = y + dy;
  const gb = bx >= 0 && by >= 0 && bx < B.w && by < B.h ? B.g[by * B.w + bx] : 255;
  const v = Math.min(ga, gb);
  return v >= 250 ? 255 : Math.round(255 - (255 - v) * 0.62);
}

// 変更のかたまりごとに、±NUDGE px の範囲でずらして合うか試す。
// 合えば、その場所の赤・青をずらした位置で塗り直す（本当に変わった線・文字はそれでも赤・青に残る）。
// 返り値：合わせ直したかたまりの数
const NUDGE = 8;
function fitLocal(A, B, boxes, label, tw, th, shifts, at, near, px, diff, diffT, mA, mB, w, h, cell, gw) {
  let fixed = 0;
  for (const b of boxes) {
    const ti = Math.min(th - 1, ((b.y + b.h / 2) / TILE) | 0) * tw + Math.min(tw - 1, ((b.x + b.w / 2) / TILE) | 0);
    const s = shifts[label[ti]];
    const x0 = b.x, y0 = b.y, x1 = Math.min(w, b.x + b.w), y1 = Math.min(h, b.y + b.h);
    // かたまりの中の線の点（多ければ間引く）
    const pa = [], pb = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (at(A, x, y)) pa.push(x, y);
      if (at(B, x + s.dx, y + s.dy)) pb.push(x, y);
    }
    const n = (pa.length + pb.length) / 2;
    if (!n) continue;
    const ka = Math.max(1, Math.floor(pa.length / 2 / 1500)) * 2, kb = Math.max(1, Math.floor(pb.length / 2 / 1500)) * 2;
    const miss = (ex, ey) => {
      let m = 0, c = 0;
      for (let k = 0; k < pa.length; k += ka) { c++; if (!near(B, pa[k] + s.dx + ex, pa[k + 1] + s.dy + ey)) m++; }
      for (let k = 0; k < pb.length; k += kb) { c++; if (!near(A, pb[k] - ex, pb[k + 1] - ey)) m++; }
      return c ? m / c : 0;
    };
    const m0 = miss(0, 0);
    let best = { ex: 0, ey: 0, m: m0 };
    for (let ey = -NUDGE; ey <= NUDGE; ey++) for (let ex = -NUDGE; ex <= NUDGE; ex++) {
      if (!ex && !ey) continue;
      const m = miss(ex, ey);
      if (m < best.m) best = { ex, ey, m };
    }
    // ずらしてもほとんど良くならない（本当の変更）なら、そのまま
    // ずらすとほぼ全部の線が重なるときだけ（＝線が動いただけ）。数字の書き換えなど本当の変更は、ずらしても重ならないので残る
    if ((!best.ex && !best.ey) || best.m > 0.06 || best.m > m0 * 0.3) continue;
    fixed++;
    const sx = s.dx + best.ex, sy = s.dy + best.ey;
    // このかたまりのマスの数え直し
    for (let cy = y0 / cell; cy < Math.ceil(y1 / cell); cy++) for (let cx = x0 / cell; cx < Math.ceil(x1 / cell); cx++) { diff[cy * gw + cx] = 0; diffT[cy * gw + cx] = 0; }
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4, ci = ((y / cell) | 0) * gw + ((x / cell) | 0);
      const a = at(A, x, y), bb = at(B, x + sx, y + sy);
      let r, g, bl;
      if (a && !near(B, x + sx, y + sy) && !near(B, x + s.dx, y + s.dy)) { r = 200; g = 55; bl = 45; diff[ci]++; if (mA[y * w + x]) diffT[ci]++; }
      else if (bb && !near(A, x, y) && !near(A, x + best.ex, y + best.ey)) { r = 68; g = 107; bl = 235; diff[ci]++; const X = x + sx, Y = y + sy; if (X >= 0 && Y >= 0 && X < B.w && Y < B.h && mB[Y * B.w + X]) diffT[ci]++; }
      else { r = g = bl = baseGray(A, B, x, y, s.dx, s.dy); } // 灰色はもとの合わせ方で描く（動いた線は灰色の二重線に見える）
      px[i] = r; px[i + 1] = g; px[i + 2] = bl;
    }
  }
  return fixed;
}

// 両方の版に1回ずつ出てくる同じ文字で、位置が少しだけ変わったものの組 [[変更前, 変更後], …]
// （図がまとまって動いた分は compose が合わせるので、ここでは「少し」の上限だけ見る）
export function movedWords(words, width) {
  if (!words?.a?.length || !words?.b?.length) return [];
  const key = t => String(t).replace(/\s+/g, '');
  const once = list => { const m = new Map(); for (const x of list) { const k = key(x.text); m.set(k, m.has(k) ? null : x); } return m; };
  const A = once(words.a), B = once(words.b), out = [];
  for (const [k, a] of A) {
    const b = B.get(k);
    if (!k || !a || !b) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > 2 && d < width * 0.12) out.push([a, b]);
  }
  return out;
}

function paint(mask, X, wd) {
  const pad = 3, hh = wd.h || 10;
  const x0 = Math.max(0, Math.floor(wd.x - pad)), x1 = Math.min(X.w - 1, Math.ceil(wd.x + (wd.w || hh) + pad));
  const y0 = Math.max(0, Math.floor(wd.y - hh - pad)), y1 = Math.min(X.h - 1, Math.ceil(wd.y + hh * 0.3 + pad));
  for (let y = y0; y <= y1; y++) mask.fill(1, y * X.w + x0, y * X.w + x1 + 1);
}

// 差分の多いマスをつなげて、変更箇所のかたまりにする
function regions(diff, gw, gh, cell, min) {
  const seen = new Uint8Array(gw * gh);
  const boxes = [];
  for (let i = 0; i < diff.length; i++) {
    if (seen[i] || diff[i] < min) continue;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
    const st = [i]; seen[i] = 1;
    while (st.length) {
      const k = st.pop();
      const x = k % gw, y = (k / gw) | 0;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const n = ny * gw + nx;
        if (!seen[n] && diff[n] >= min) { seen[n] = 1; st.push(n); }
      }
    }
    boxes.push({ x: x0 * cell, y: y0 * cell, w: (x1 - x0 + 1) * cell, h: (y1 - y0 + 1) * cell });
  }
  return boxes;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.stroke();
}
