// 図面のページ対応づけ（新旧でページ構成が違っても、同じ図面どうしを組にする）
// 使い方：
//   const fa = await PageMatch.fingerprints(pdfA);   // pdf.js で開いた PDFDocumentProxy
//   const fb = await PageMatch.fingerprints(pdfB);
//   const m = PageMatch.match(fa, fb);
//   m.pairs   … [{ a: 3, b: 4, score: 0.93, title: '1階平面詳細図', by: '図面名' }]（ページ番号は1から）
//   m.added   … 新しい方にだけあるページ [5]
//   m.removed … 前の方にだけあるページ [8]
// 3つの手がかりで似ている度合いを出す：
//   1. 図面名（表題欄の「〇〇図」「〇〇表」）… 一致すれば強く、違えば弱くする
//   2. ページ全体の文字（記号・寸法・室名など）の重なり
//   3. 絵の形（ページを小さくして、線の濃さの分布をくらべる）
// 版2（2026-11-11）：
//   - 絵の形は、線のある範囲で切り取ってからくらべる（スキャンの余白・位置・縮尺の違いに強く）
//   - 少しのずれを許してくらべる。文字が読めないページ（スキャン）は、絵の形だけでくらべる
//   - 絵の形だけのときは、はっきり似ているとき（0.6以上・2番目より0.1以上高い）だけ組にする
//   - 使い方（fingerprints・match）は版1と同じ。版1をそのまま置きかえられる
//   - OpenCV.js を渡すと、スキャンのページも特徴点でさがせる（refine）。傾き・伸び縮みを直す変換 H も返す
//       let m = PageMatch.match(fa, fb);
//       if (PageMatch.hasScan(fa) || PageMatch.hasScan(fb)) m = await PageMatch.refine(cv, pdfA, pdfB, fa, fb, m);
// 図面のデータはブラウザの中だけで扱い、どこにも送らない。
(function (root) {
  const GRID_W = 48, GRID_H = 34;     // 絵の形をくらべる細かさ
  const MIN_SCORE = 0.42;             // これ未満は「同じ図面ではない」とみなす
  const SHAPE_PX = 600;               // 絵の形を取るときの大きさ（長い辺）
  const SHIFT = 2;                    // 絵の形をくらべるとき、マスいくつ分までのずれを許すか
  const FEW_WORDS = 8;                // 文字がこれ未満のページ（スキャンなど）は、絵の形だけでくらべる
  const MIN_SHAPE = 0.6;              // 絵の形だけでくらべるときは、これ以上で、しかも
  const MIN_LEAD = 0.1;               //   2番目に似ているページより、これだけ高いときだけ組にする（取り違えを防ぐ）

  const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '');

  // 表題欄の図面名を探す。「参照」を含むもの（右図参照など）は除く
  function findTitle(items, pageW, pageH) {
    const cands = [];
    const label = items.find((t) => norm(t.str).includes('図面名称'));
    for (const t of items) {
      const s = norm(t.str);
      if (s.length < 3 || s.length > 18) continue;
      if (!/(図|表)(<.+>|\(.+\)|（.+）)?$/.test(s)) continue;
      if (/参照|図面名称/.test(s)) continue;
      const x = t.transform[4], y = t.transform[5], h = Math.hypot(t.transform[2], t.transform[3]);
      let score = h;                                   // 大きい文字ほど図面名らしい
      if (x > pageW * 0.55 && y < pageH * 0.3) score *= 2;   // 右下（表題欄）にあれば強く
      if (label) score *= 1 + 1 / (1 + Math.hypot(x - label.transform[4], y - label.transform[5]) / 50);
      cands.push({ s, score });
    }
    cands.sort((p, q) => q.score - p.score);
    return cands[0]?.s || '';
  }


  // 線の濃さをマスに集める（線のある範囲で切り取り、ぼかして、平均0・長さ1にそろえる）
  function shapeGrid(d, w, h) {
    const ink = new Uint8Array(w * h);
    const colSum = new Float64Array(w), rowSum = new Float64Array(h);
    let total = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114 < 170) { ink[y * w + x] = 1; colSum[x]++; rowSum[y]++; total++; }
    }
    const range = (sum, n) => {
      if (!total) return [0, n];
      let acc = 0, lo = 0, hi = n - 1;
      for (let i = 0; i < n; i++) { acc += sum[i]; if (acc >= total * 0.01) { lo = i; break; } }
      acc = 0;
      for (let i = n - 1; i >= 0; i--) { acc += sum[i]; if (acc >= total * 0.01) { hi = i; break; } }
      return hi > lo ? [lo, hi + 1] : [0, n];
    };
    const [x0, x1] = range(colSum, w), [y0, y1] = range(rowSum, h);
    const g = new Float32Array(GRID_W * GRID_H);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      if (!ink[y * w + x]) continue;
      g[Math.min(GRID_H - 1, Math.floor(((y - y0) / (y1 - y0)) * GRID_H)) * GRID_W + Math.min(GRID_W - 1, Math.floor(((x - x0) / (x1 - x0)) * GRID_W))]++;
    }
    // 線の多い所だけで決まらないよう平方根でならし、となりのマスとまぜる
    for (let i = 0; i < g.length; i++) g[i] = Math.sqrt(g[i]);
    const b = new Float32Array(g.length);
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= GRID_H || xx >= GRID_W) continue;
        const wgt = dx || dy ? 1 : 2; s += g[yy * GRID_W + xx] * wgt; n += wgt;
      }
      b[y * GRID_W + x] = s / n;
    }
    let mean = 0; for (const v of b) mean += v; mean /= b.length;
    let len = 0; for (let i = 0; i < b.length; i++) { b[i] -= mean; len += b[i] * b[i]; }
    len = Math.sqrt(len) || 1; for (let i = 0; i < b.length; i++) b[i] /= len;
    return b;
  }

  // 絵の形の似ている度合い（少しのずれを許して、一番よく重なる所の値）
  function shapeScore(a, b) {
    let best = -1;
    for (let dy = -SHIFT; dy <= SHIFT; dy++) for (let dx = -SHIFT; dx <= SHIFT; dx++) {
      let dot = 0;
      for (let y = Math.max(0, -dy); y < Math.min(GRID_H, GRID_H - dy); y++) {
        const ra = y * GRID_W, rb = (y + dy) * GRID_W;
        for (let x = Math.max(0, -dx); x < Math.min(GRID_W, GRID_W - dx); x++) dot += a[ra + x] * b[rb + x + dx];
      }
      if (dot > best) best = dot;
    }
    return Math.max(0, best);
  }

  // 1ページ分の手がかり
  async function pageFingerprint(pdf, n) {
    const page = await pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const text = await page.getTextContent();
    const items = text.items.filter((t) => t.str && t.str.trim());
    const title = findTitle(items, vp1.width, vp1.height);
    const words = new Set(items.map((t) => norm(t.str)).filter((s) => s.length >= 2 && !/^\d{1,2}$/.test(s)));
    // 絵の形：小さく描いて、マスごとの線の濃さ。
    // スキャンは余白・位置・縮尺が少しずつ違うので、線のある範囲（端の1%ずつを除く）で切り取ってから比べる
    const scale = Math.min(SHAPE_PX / vp1.width, SHAPE_PX / vp1.height);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const grid = shapeGrid(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    return { page: n, title, words, grid, ratio: vp1.width / vp1.height };
  }

  async function fingerprints(pdf, onProgress) {
    const out = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      out.push(await pageFingerprint(pdf, n));
      if (onProgress) onProgress(n, pdf.numPages);
    }
    return out;
  }

  function similarity(a, b) {
    const shape = shapeScore(a.grid, b.grid);
    // 文字の重なり（Jaccard）。片方がスキャンなどで文字が読めないときは、絵の形だけでくらべる
    let score, by;
    if (a.words.size < FEW_WORDS || b.words.size < FEW_WORDS) {
      score = shape; by = '絵の形';
    } else {
      let inter = 0; for (const w of a.words) if (b.words.has(w)) inter++;
      const uni = a.words.size + b.words.size - inter;
      const text = uni ? inter / uni : 0;
      score = 0.55 * shape + 0.45 * text; by = '絵と文字';
    }
    if (a.title && b.title) {
      if (a.title === b.title) { score = 0.5 + 0.5 * score; by = '図面名'; }
      else score *= 0.6;
    }
    if (Math.abs(a.ratio - b.ratio) > 0.05) score *= 0.5;   // 用紙の向きや大きさが違う
    return { score, by };
  }

  // いちばん似ている組から順に決める（同じ点ならページの並びが近い方）
  function match(fa, fb) {
    const cand = [];
    const second = new Map(); // a ページごとの、1番目と2番目の点（絵の形だけのときの取り違え防止）
    for (const a of fa) {
      const scores = [];
      for (const b of fb) {
        const { score, by } = similarity(a, b);
        const order = Math.abs((a.page - 1) / Math.max(1, fa.length - 1) - (b.page - 1) / Math.max(1, fb.length - 1));
        cand.push({ a: a.page, b: b.page, score, rank: score - 0.03 * order, by, title: b.title || a.title });
        scores.push(score);
      }
      scores.sort((p, q) => q - p);
      second.set(a.page, scores[1] ?? 0);
    }
    cand.sort((p, q) => q.rank - p.rank);
    const usedA = new Set(), usedB = new Set(), pairs = [];
    for (const c of cand) {
      if (c.score < MIN_SCORE) break;
      if (usedA.has(c.a) || usedB.has(c.b)) continue;
      if (c.by === '絵の形' && (c.score < MIN_SHAPE || c.score - second.get(c.a) < MIN_LEAD)) continue;
      usedA.add(c.a); usedB.add(c.b);
      pairs.push({ a: c.a, b: c.b, score: Math.round(c.score * 100) / 100, by: c.by, title: c.title });
    }
    pairs.sort((p, q) => p.b - q.b);
    return {
      pairs,
      added: fb.map((f) => f.page).filter((n) => !usedB.has(n)),
      removed: fa.map((f) => f.page).filter((n) => !usedA.has(n)),
    };
  }


  // ---------- スキャンのページ（文字が読めない）を、特徴点でさがす（OpenCV.js があるときだけ） ----------
  // 図面の角・線の交わる所などの「特徴点」を両方のページで拾い、同じ点がいくつ見つかるかでくらべる。
  // 見つかった組には、前のページの点 → 新しいページの点 に写す変換（3×3、PDFの座標 pt）を付けて返す。
  // スキャンの傾き・伸び縮みを直して重ねるのに使える。
  const FEAT_PX = 910;        // 特徴点を取るときの大きさ（長い辺）
  const FEAT_N = 3000;        // 1ページで拾う特徴点の数
  const MIN_INLIERS = 60;     // これより一致点が少なければ「同じ図面ではない」

  async function pageFeatures(cv, pdf, n) {
    // 大きめ（2倍）に描いてから縮める方が、細い線がつぶれず特徴点がよく取れる
    const page = await pdf.getPage(n);
    const vp1 = page.getViewport({ scale: 1 });
    const s2 = (FEAT_PX * 2) / Math.max(vp1.width, vp1.height);
    const vp = page.getViewport({ scale: s2 });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const src = cv.imread(c), g = new cv.Mat(), sm = new cv.Mat();
    cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY);
    cv.resize(g, sm, new cv.Size(Math.round(c.width / 2), Math.round(c.height / 2)), 0, 0, cv.INTER_AREA);
    const s = s2 / 2;
    const orb = new cv.ORB(FEAT_N), kp = new cv.KeyPointVector(), des = new cv.Mat(), none = new cv.Mat();
    orb.detectAndCompute(sm, none, kp, des);
    const pts = [];
    for (let i = 0; i < kp.size(); i++) { const p = kp.get(i).pt; pts.push([p.x / s, p.y / s]); } // pt の座標で持つ
    src.delete(); g.delete(); sm.delete(); orb.delete(); kp.delete(); none.delete();
    c.width = c.height = 0;
    return { pts, des, s };
  }

  function featureMatch(cv, fa, fb) {
    if (!fa.des.rows || !fb.des.rows) return { inliers: 0, H: null };
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false), mm = new cv.DMatchVectorVector();
    bf.knnMatch(fa.des, fb.des, mm, 2);
    const src = [], dst = [];
    for (let i = 0; i < mm.size(); i++) {
      const v = mm.get(i);
      if (v.size() < 2) continue;
      const m = v.get(0), m2 = v.get(1);
      if (m.distance < 0.75 * m2.distance) { src.push(...fa.pts[m.queryIdx]); dst.push(...fb.pts[m.trainIdx]); }
    }
    bf.delete(); mm.delete();
    const n = src.length / 2;
    if (n < 25) return { inliers: 0, H: null };
    const A = cv.matFromArray(n, 1, cv.CV_32FC2, src), B = cv.matFromArray(n, 1, cv.CV_32FC2, dst), mask = new cv.Mat();
    const Hm = cv.findHomography(A, B, cv.USAC_MAGSAC ?? cv.RANSAC, 4 / Math.min(fa.s, fb.s), mask); // 特徴点の画像で4px分の誤差まで
    let inliers = 0;
    for (let i = 0; i < mask.rows; i++) if (mask.data[i]) inliers++;
    let H = Hm.rows === 3 ? Array.from(Hm.data64F) : null;
    A.delete(); B.delete(); mask.delete(); Hm.delete();
    if (H) { const det = H[0] * H[4] - H[1] * H[3]; if (!(det > 0.2 && det < 5)) { H = null; inliers = 0; } } // 裏返し・極端なゆがみは外す
    return { inliers, H };
  }

  /**
   * match の結果に、スキャンのページの組を足す。
   * 文字が読めないページのうち、まだ相手のないものだけを、相手のないページとくらべる。
   * @param cv OpenCV.js（cv.Mat が使える状態のもの）
   * @returns match と同じ形（足した組は by: '特徴点'、inliers・H 付き）
   */
  async function refine(cv, pdfA, pdfB, fa, fb, m, onProgress) {
    // スキャンの中には、読み取りソフトが少しだけ文字を入れたページもある。
    // ファイルの3割以上のページが文字なしなら、そのファイルは全部スキャンとみなす
    const scanSet = (fs) => {
      const few = fs.filter((f) => f.words.size < FEW_WORDS);
      return new Set((few.length >= fs.length * 0.3 ? fs : few).map((f) => f.page));
    };
    const scanA = scanSet(fa), scanB = scanSet(fb);
    // 絵の形だけで組にしたもの（スキャン）も、特徴点で確かめ直して変換 H を求める。合わなければ組を外す
    const shapeOnly = m.pairs.filter((p) => p.by === '絵の形');
    const keep = m.pairs.filter((p) => p.by !== '絵の形');
    const restA = [...m.removed, ...shapeOnly.map((p) => p.a)], restB = [...m.added, ...shapeOnly.map((p) => p.b)];
    const orig = m;
    m = { ...m, pairs: keep };
    const todo = [];
    for (const a of restA) for (const b of restB) if (scanA.has(a) || scanB.has(b)) todo.push([a, b]);
    if (!todo.length) return orig;
    const featA = new Map(), featB = new Map();
    const getA = async (n) => { if (!featA.has(n)) featA.set(n, await pageFeatures(cv, pdfA, n)); return featA.get(n); };
    const getB = async (n) => { if (!featB.has(n)) featB.set(n, await pageFeatures(cv, pdfB, n)); return featB.get(n); };
    const found = [];
    try {
      for (let i = 0; i < todo.length; i++) {
        const [a, b] = todo[i];
        if (onProgress) onProgress(i + 1, todo.length);
        const r = featureMatch(cv, await getA(a), await getB(b));
        if (r.H && r.inliers >= MIN_INLIERS) found.push({ a, b, ...r });
      }
    } finally {
      for (const f of [...featA.values(), ...featB.values()]) f.des.delete();
    }
    found.sort((p, q) => q.inliers - p.inliers);
    const usedA = new Set(), usedB = new Set(), pairs = [...m.pairs];
    for (const f of found) {
      if (usedA.has(f.a) || usedB.has(f.b)) continue;
      usedA.add(f.a); usedB.add(f.b);
      pairs.push({ a: f.a, b: f.b, score: Math.min(1, Math.round((f.inliers / 300) * 100) / 100), by: '特徴点', inliers: f.inliers, H: f.H, title: fb[f.b - 1].title || fa[f.a - 1].title });
    }
    pairs.sort((p, q) => p.b - q.b);
    return { pairs, added: restB.filter((n) => !usedB.has(n)), removed: restA.filter((n) => !usedA.has(n)) };
  }

  // 文字が読めないページ（スキャン）があるか。refine を使うかどうかの目安
  const hasScan = (fps) => fps.some((f) => f.words.size < FEW_WORDS);

  root.PageMatch = { fingerprints, match, refine, hasScan, similarity, findTitle, shapeScore };
})(typeof window !== 'undefined' ? window : globalThis);
