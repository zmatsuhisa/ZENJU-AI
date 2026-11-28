// 図面の「線データ」で比べる（AutoCAD の図面比較と同じ考え方）。
// CAD から出した PDF には「(x1,y1) から (x2,y2) への線」が入っているので、画像にせずに座標で比べる。
// ・TOL 以内のずれは同じ線とみなす（CAD の出し直しの小さなずれを変更にしない）
// ・描くときは新しい版をそのまま描くので、線も文字もくっきり出る
// スキャン（線データがない）や、傾きを直したページは、これまでの画像の比較（overlay.js）を使う。
import { blockShifts } from './core/shift.js';
export const TOL = 2.83;        // 同じ線とみなすずれ（pt）。1mm（用紙の上で）
const STEP = 2;          // 線の上の点を何 pt おきに調べるか
const CELL = 12;         // 線を探すためのマス（pt）
const MIN_SEGS = 50;     // これより線が少ないページは線データなしとみなす

const mul = (m1, m2) => [m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1], m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3], m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]];

/** ページの線を取り出す。座標は用紙の左上が原点の pt。返り値 Float32Array [x1,y1,x2,y2, …] */
export async function pageSegments(OPS, page) {
  const vp = page.getViewport({ scale: 1 });
  const { fnArray, argsArray } = await page.getOperatorList();
  let ctm = vp.transform.slice();
  const stack = [], out = [];
  let pending = [], cx = 0, cy = 0, sx = 0, sy = 0;
  const P = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  const seg = (x1, y1, x2, y2) => { const [a, b] = P(x1, y1), [c, d] = P(x2, y2); if (Math.abs(c - a) + Math.abs(d - b) > 0.05) pending.push(a, b, c, d); };
  const bez = (x0, y0, x1, y1, x2, y2, x3, y3) => {
    let px = x0, py = y0;
    for (let k = 1; k <= 6; k++) {
      const t = k / 6, u = 1 - t;
      const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
      const y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
      seg(px, py, x, y); px = x; py = y;
    }
  };
  // 線を引く・塗る命令で確定、クリップだけ（endPath）なら捨てる
  const DRAW = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], a = argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm.slice()); if (Array.isArray(a?.[0]) || ArrayBuffer.isView(a?.[0])) ctm = mul(ctm, Array.from(a[0])); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (DRAW.has(fn)) { for (const v of pending) out.push(v); pending = []; }
    else if (fn === OPS.endPath) pending = [];
    else if (fn === OPS.constructPath) {
      const ops = a[0], args = a[1];
      let j = 0;
      for (const op of ops) {
        switch (op) {
          case OPS.rectangle: { const x = args[j++], y = args[j++], w = args[j++], h = args[j++]; seg(x, y, x + w, y); seg(x + w, y, x + w, y + h); seg(x + w, y + h, x, y + h); seg(x, y + h, x, y); cx = sx = x; cy = sy = y; break; }
          case OPS.moveTo: cx = sx = args[j++]; cy = sy = args[j++]; break;
          case OPS.lineTo: { const x = args[j++], y = args[j++]; seg(cx, cy, x, y); cx = x; cy = y; break; }
          case OPS.curveTo: bez(cx, cy, args[j], args[j + 1], args[j + 2], args[j + 3], args[j + 4], args[j + 5]); cx = args[j + 4]; cy = args[j + 5]; j += 6; break;
          case OPS.curveTo2: bez(cx, cy, cx, cy, args[j], args[j + 1], args[j + 2], args[j + 3]); cx = args[j + 2]; cy = args[j + 3]; j += 4; break;
          case OPS.curveTo3: bez(cx, cy, args[j], args[j + 1], args[j + 2], args[j + 3], args[j + 2], args[j + 3]); cx = args[j + 2]; cy = args[j + 3]; j += 4; break;
          case OPS.closePath: seg(cx, cy, sx, sy); cx = sx; cy = sy; break;
        }
      }
    }
  }
  return new Float32Array(out);
}

// 線をマスに入れておき、点の近くの線をすぐ探せるようにする
function buildIndex(s) {
  const idx = new Map();
  for (let i = 0; i < s.length; i += 4) {
    const x1 = s[i], y1 = s[i + 1], x2 = s[i + 2], y2 = s[i + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (CELL / 2)));
    let last = '';
    for (let k = 0; k <= n; k++) {
      const key = Math.floor((x1 + (x2 - x1) * k / n) / CELL) + ',' + Math.floor((y1 + (y2 - y1) * k / n) / CELL);
      if (key === last) continue;
      last = key;
      let a = idx.get(key); if (!a) idx.set(key, (a = [])); if (a[a.length - 1] !== i) a.push(i);
    }
  }
  return idx;
}
function distSeg(px, py, s, i) {
  const x1 = s[i], y1 = s[i + 1], dx = s[i + 2] - x1, dy = s[i + 3] - y1;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - x1 - t * dx, py - y1 - t * dy);
}
function near(idx, s, px, py, tol) {
  const cx = Math.floor(px / CELL), cy = Math.floor(py / CELL);
  for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
    const a = idx.get(x + ',' + y);
    if (a) for (const i of a) if (distSeg(px, py, s, i) <= tol) return true;
  }
  return false;
}

// s の線の上の点のうち、相手（idx, t）に近い線がない所を、短い線のかけらにして返す
// map：s の座標 → 相手の座標 の候補（ずれ）。どれか1つで合えばよい
function unmatched(s, idx, t, maps, tol) {
  const out = [];
  for (let i = 0; i < s.length; i += 4) {
    const x1 = s[i], y1 = s[i + 1], x2 = s[i + 2], y2 = s[i + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / STEP));
    let start = -1;
    for (let k = 0; k <= n + 1; k++) {
      let miss = false;
      if (k <= n) {
        const px = x1 + (x2 - x1) * k / n, py = y1 + (y2 - y1) * k / n;
        miss = !maps.some(m => near(idx, t, px + m.dx, py + m.dy, tol));
      }
      if (miss && start < 0) start = k;
      if (!miss && start >= 0) {
        const a = Math.max(0, start - 0.5) / n, b = Math.min(n, k - 0.5) / n;
        out.push(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a, x1 + (x2 - x1) * b, y1 + (y2 - y1) * b);
        start = -1;
      }
    }
  }
  return out;
}

/**
 * 前の版のページ pa と新しい版のページ pb を、線データで比べて重ね合わせの絵を作る。
 * cb：新しい版を描いたキャンバス（scale px/pt）、wa・wb：文字（renderPage の words。px）
 * 返り値は compose と同じ形（絵は新しい版の位置で描くので、boxes の x と bx は同じ）。線データがなければ null
 */
export async function composeVector(OPS, pageA, pageB, cb, scale, wa, wb, sa) {
  const [A0, B] = await Promise.all([pageSegments(OPS, pageA), pageSegments(OPS, pageB)]);
  if (A0.length / 4 < MIN_SEGS || B.length / 4 < MIN_SEGS) return null;
  const wA = pageA.getViewport({ scale: 1 }).width, wB = pageB.getViewport({ scale: 1 }).width;
  const k = wB / wA || 1; // 用紙の大きさが違うときは、新しい版にそろえる
  const A = A0.map(v => v * k);
  // 図がまとまって動いた分（文字の位置から）。動いていなければ 0
  const toPt = (ws, f) => ws.map(w => ({ text: w.text, x: w.x / f, y: w.y / f }));
  const wordsA = toPt(wa, sa / k), wordsB = toPt(wb, scale);
  const bs = blockShifts(wordsA, wordsB, { q: 1 });
  const shifts = bs.map(s => ({ dx: s.dx, dy: s.dy }));
  if (!shifts.some(s => !s.dx && !s.dy)) shifts.push({ dx: 0, dy: 0 });
  const iA = buildIndex(A), iB = buildIndex(B);
  const onlyA = unmatched(A, iB, B, shifts, TOL);                                   // 変更前だけ（赤）
  const onlyB = unmatched(B, iA, A, shifts.map(s => ({ dx: -s.dx, dy: -s.dy })), TOL); // 変更後だけ（青）
  const main = shifts[0];
  // 文字：同じ文字が近くにあるか
  const keyW = t => String(t).replace(/\s+/g, '');
  const wordHit = (w, list, sh) => list.some(o => keyW(o.text) === keyW(w.text) && sh.some(s => Math.hypot(o.x - w.x - s.dx, o.y - w.y - s.dy) <= TOL * 2));
  const ptA = wa.map(w => ({ ...w, X: w.x / (sa / k), Y: w.y / (sa / k) }));
  const ptB = wb.map(w => ({ ...w, X: w.x / scale, Y: w.y / scale }));
  const goneW = ptA.filter(w => !wordHit({ text: w.text, x: w.X, y: w.Y }, wordsB, shifts));
  const cameW = ptB.filter(w => !wordHit({ text: w.text, x: w.X, y: w.Y }, wordsA, shifts.map(s => ({ dx: -s.dx, dy: -s.dy }))));

  // --- 絵：新しい版を少し薄い灰色で（文字はそのままの形で）、その上に赤・青 ---
  const out = document.createElement('canvas');
  out.width = cb.width; out.height = cb.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(cb, 0, 0);
  const img = ctx.getImageData(0, 0, out.width, out.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    const v = g >= 250 ? 255 : Math.round(255 - (255 - g) * 0.62);
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  const lw = Math.max(2, scale * 1.1);
  const strokeAll = (segs, color, sh) => {
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.beginPath();
    for (let i = 0; i < segs.length; i += 4) { ctx.moveTo((segs[i] + sh.dx) * scale, (segs[i + 1] + sh.dy) * scale); ctx.lineTo((segs[i + 2] + sh.dx) * scale, (segs[i + 3] + sh.dy) * scale); }
    ctx.stroke();
  };
  strokeAll(onlyA, 'rgb(200,55,45)', main);
  strokeAll(onlyB, 'rgb(68,107,235)', { dx: 0, dy: 0 });
  // 変更後だけの文字は青い下地、変更前だけの文字は赤い字で書き足す
  ctx.fillStyle = 'rgba(68,107,235,.22)';
  for (const w of cameW) ctx.fillRect(w.x - 2, w.y - w.h - 2, w.w + 4, w.h * 1.25 + 4);
  ctx.fillStyle = 'rgb(200,55,45)'; ctx.textBaseline = 'alphabetic';
  // 同じ場所に新しい文字があるとき（W1600→W1650 など）は重ならないよう、すぐ上に取り消し線つきで出す
  for (const w of goneW) {
    const fs = Math.max(9, w.h / (sa / k) * scale * 0.95);
    let x = (w.X + main.dx) * scale, y = (w.Y + main.dy) * scale;
    ctx.font = `${fs}px sans-serif`;
    const tw = ctx.measureText(w.text).width;
    const hit = cameW.some(c => c.x < x + tw && x < c.x + c.w && Math.abs(c.y - y) < fs);
    if (hit) y -= fs * 1.15;
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(x - 1, y - fs, tw + 2, fs * 1.2);
    ctx.fillStyle = 'rgb(200,55,45)'; ctx.fillText(w.text, x, y);
    ctx.fillRect(x, y - fs * 0.35, tw, Math.max(1, fs / 12));
  }

  // --- 変わった場所のかたまり（16px のマスで数えてつなぐ） ---
  const cell = 16, gw = Math.ceil(out.width / cell), gh = Math.ceil(out.height / cell);
  const cnt = new Uint16Array(gw * gh);
  const put = (x, y, n = 1) => { const cx = Math.floor(x / cell), cy = Math.floor(y / cell); if (cx >= 0 && cy >= 0 && cx < gw && cy < gh) cnt[cy * gw + cx] += n; };
  const putSegs = (segs, sh) => {
    for (let i = 0; i < segs.length; i += 4) {
      const n = Math.max(1, Math.ceil(Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]) / STEP));
      for (let j = 0; j <= n; j++) put((segs[i] + (segs[i + 2] - segs[i]) * j / n + sh.dx) * scale, (segs[i + 1] + (segs[i + 3] - segs[i + 1]) * j / n + sh.dy) * scale);
    }
  };
  putSegs(onlyA, main); putSegs(onlyB, { dx: 0, dy: 0 });
  // 文字の違いは、文字の比較（四角い枠）で別に出すので、ここでは線だけを数える
  const boxes = [], seen = new Uint8Array(gw * gh);
  for (let i = 0; i < cnt.length; i++) {
    if (seen[i] || !cnt[i]) continue;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0, tot = 0;
    const st = [i]; seen[i] = 1;
    while (st.length) {
      const q = st.pop(), x = q % gw, y = (q / gw) | 0;
      tot += cnt[q]; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy, n = ny * gw + nx;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && !seen[n] && cnt[n]) { seen[n] = 1; st.push(n); }
      }
    }
    if (tot < 3) continue; // 1〜2点だけ（線の端のわずかな違い）は数えない
    const b = { x: x0 * cell, y: y0 * cell, w: (x1 - x0 + 1) * cell, h: (y1 - y0 + 1) * cell, textOnly: false };
    b.bx = b.x; b.by = b.y;
    boxes.push(b);
  }
  ctx.strokeStyle = '#f7890a'; ctx.lineWidth = Math.max(2, out.width / 600);
  for (const b of boxes) { ctx.beginPath(); ctx.roundRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12, 10); ctx.stroke(); }
  return {
    canvas: out, boxes, shift: { dx: Math.round(main.dx * scale), dy: Math.round(main.dy * scale) }, moved: Math.max(0, bs.length - 1),
    vector: true, segs: { a: A0.length / 4, b: B.length / 4 },
  };
}
