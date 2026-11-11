// 図のまとまりごとの「ずれ」を見つける（ブラウザとテストで共通）
//
// CAD の版を出し直すと、図面の中身は同じでも「平面図だけ用紙の中で下へ動いた」「詳細図を左へ並べ替えた」
// ということがよくある。枠や凡例は動かないので、ページ全体を1つのずれで合わせると、動いた図が丸ごと
// 赤・青に出てしまう。そこで、両方の版に1回ずつしか出てこない文字（室名・寸法・注記など）の位置の差を数え、
// 同じ差が何件も集まったものを「まとまって動いた」とみなして、ずれの候補として返す。

/**
 * @param {{text:string,x:number,y:number}[]} A 変更前の文字と位置
 * @param {{text:string,x:number,y:number}[]} B 変更後の文字と位置（同じ単位）
 * @param {{q?:number,minVotes?:number,minFrac?:number,max?:number}} o
 *   q：差をまとめる幅、minVotes・minFrac：候補にする最低件数と割合、max：候補の最大数
 * @returns {{dx:number,dy:number,n:number}[]} 件数の多い順。動いていなければ [{dx:0,dy:0,n}]
 */
export function blockShifts(A, B, { q = 2, minVotes = 5, minFrac = 0.05, max = 6 } = {}) {
  const count = list => { const m = new Map(); for (const w of list) { const t = key(w.text); if (t) m.set(t, (m.get(t) || 0) + 1); } return m; };
  const ca = count(A), cb = count(B);
  const onlyB = new Map();
  for (const w of B) { const t = key(w.text); if (t && cb.get(t) === 1) onlyB.set(t, w); }
  const bins = new Map();
  let total = 0;
  for (const w of A) {
    const t = key(w.text);
    if (!t || ca.get(t) !== 1) continue;
    const o = onlyB.get(t);
    if (!o) continue;
    const dx = o.x - w.x, dy = o.y - w.y;
    const k = Math.round(dx / q) + ',' + Math.round(dy / q);
    const b = bins.get(k) || { i: Math.round(dx / q), j: Math.round(dy / q), n: 0, sx: 0, sy: 0 };
    b.n++; b.sx += dx; b.sy += dy; bins.set(k, b);
    total++;
  }
  // 隣り合うマス（四捨五入の境目で分かれたもの）は1つにまとめる
  const sorted = [...bins.values()].sort((a, b) => b.n - a.n);
  const used = new Set();
  const out = [];
  for (const b of sorted) {
    if (used.has(b)) continue;
    let n = 0, sx = 0, sy = 0;
    for (const c of sorted) {
      if (used.has(c) || Math.abs(c.i - b.i) > 1 || Math.abs(c.j - b.j) > 1) continue;
      used.add(c); n += c.n; sx += c.sx; sy += c.sy;
    }
    out.push({ dx: sx / n, dy: sy / n, n });
  }
  const keep = out.filter(s => s.n >= minVotes && s.n >= total * minFrac).sort((a, b) => b.n - a.n).slice(0, max);
  return keep.length ? keep : [{ dx: 0, dy: 0, n: 0 }];
}

// 数字1文字や記号だけの文字は、どこにでも出てくるので使わない
const key = t => {
  const s = String(t ?? '').replace(/\s+/g, '');
  return s.length >= 2 ? s : '';
};
