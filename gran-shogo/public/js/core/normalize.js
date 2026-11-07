// 文字のゆれをそろえる。全角英数→半角、各種ハイフン→"-"、×→x、空白の連続→1つ。
// 図面と表で「ＡＷ－１」「AW-1」「AW1」のように書き方が違っても同じものとして扱うため。

const DASHES = /[‐‑‒–—―−－ｰ‒]/g;

export function norm(s) {
  if (s == null) return '';
  return String(s)
    .normalize('NFKC')
    .replace(DASHES, '-')
    .replace(/(\d)\s*[×xX＊*]\s*(?=[Hh]?\d)/g, '$1x')
    .replace(/[　\s]+/g, ' ')
    .trim();
}

// 記号・品番の比較用キー。大文字にして、ハイフン・空白・中黒を落とす（AW-1 と AW1 を同じにする）
export function keyOf(s) {
  return norm(s).toUpperCase().replace(/[-\s・.]/g, '');
}

// 数字として読めるなら数値に（"1,650" → 1650、"W1650" は対象外）
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = norm(v).replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

// 2つの記号がほぼ同じか（1文字違い）。品番の書き間違いの疑いを拾う
export function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
