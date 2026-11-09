// 図面の重ね合わせ（diff-pdf・MIIDEL・Bluebeam の「重ねて色分け」の考え方）
// 変更前だけにある線＝赤、変更後だけにある線＝青、両方にある線＝薄い灰色。
// 位置ずれ（スキャンや出力の違い）を少し補正してから比べ、変わった場所をオレンジの枠で囲む。

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
  return { canvas, scale };
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

/**
 * 2枚のページ画像を重ねる。返り値 { canvas, boxes:[{x,y,w,h}], shift }
 */
export function compose(canvasA, canvasB) {
  const A = gray(canvasA), B = gray(canvasB);
  const shift = findShift(A, B);
  const w = A.w, h = Math.max(A.h, B.h);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, h);
  const px = img.data;
  const cell = 16;
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const diff = new Uint16Array(gw * gh);
  const at = (X, x, y) => (x >= 0 && y >= 0 && x < X.w && y < X.h ? X.g[y * X.w + x] < DARK : false);
  // 1px のにじみは差分にしない（近くに相手の線があれば同じ線とみなす）
  const near = (X, x, y) => at(X, x, y) || at(X, x + 1, y) || at(X, x - 1, y) || at(X, x, y + 1) || at(X, x, y - 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = at(A, x, y), b = at(B, x + shift.dx, y + shift.dy);
      let r = 255, g = 255, bl = 255;
      if (a && b) { r = g = bl = 196; }
      else if (a && !near(B, x + shift.dx, y + shift.dy)) { r = 200; g = 55; bl = 45; diff[((y / cell) | 0) * gw + ((x / cell) | 0)]++; }
      else if (b && !near(A, x, y)) { r = 68; g = 107; bl = 235; diff[((y / cell) | 0) * gw + ((x / cell) | 0)]++; }
      else if (a || b) { r = g = bl = 196; }
      px[i] = r; px[i + 1] = g; px[i + 2] = bl; px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const boxes = regions(diff, gw, gh, cell, 6);
  ctx.strokeStyle = '#f7890a';
  ctx.lineWidth = Math.max(2, w / 600);
  for (const b of boxes) roundRect(ctx, b.x - 6, b.y - 6, b.w + 12, b.h + 12, 10);
  return { canvas: out, boxes, shift };
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
