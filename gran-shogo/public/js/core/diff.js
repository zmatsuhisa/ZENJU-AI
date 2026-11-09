// 新旧比較（同じ資料の変更前と変更後）
//  - PDF：文字の記入を「位置つき」で突き合わせる。同じ場所で文字が変わったら「変更」、消えたら「削除」、増えたら「追加」
//  - Excel：記号・品番の列で行を合わせてからセルを比べる（行の挿入・削除で全部ずれて見えるのを防ぐ）
import { norm, keyOf, toNumber, editDistance } from './normalize.js';
import { findHeaderRow } from './readers.js';
import { blockShifts } from './shift.js';

const NEAR = 40; // PDF上で「同じ場所」とみなす距離（pt。A3図面で約14mm）

export function diffPdf(oldDoc, newDoc) {
  const out = [];
  const n = Math.max(oldDoc.pages.length, newDoc.pages.length);
  for (let i = 0; i < n; i++) {
    const a = oldDoc.pages[i], b = newDoc.pages[i];
    const page = i + 1;
    if (!a) { out.push({ type: 'added', page, before: '', after: `ページ ${page} が追加` }); continue; }
    if (!b) { out.push({ type: 'removed', page, before: `ページ ${page} が削除`, after: '' }); continue; }
    // 縮尺が違う図面でも位置を比べられるよう、ページの大きさで割った位置を使う
    const sa = 1, sb = a.width / b.width || 1;
    const A = a.chunks.map((c, k) => ({ ...c, k, X: c.x * sa, Y: c.y * sa, used: false }));
    const B = b.chunks.map((c, k) => ({ ...c, k, X: c.x * sb, Y: c.y * sb, used: false }));
    // 図がまとまって動いた分（平面図ごと下へ動いた、など）は「移動」に数えない
    const shifts = blockShifts(A.map(c => ({ text: c.text, x: c.X, y: c.Y })), B.map(c => ({ text: c.text, x: c.X, y: c.Y })));
    const dist = (p, q) => Math.min(...shifts.map(s => Math.hypot(q.X - s.dx - p.X, q.Y - s.dy - p.Y)));
    // 1) 同じ文字で一番近いもの同士を対応づける
    const byText = new Map();
    for (const c of B) { if (!byText.has(c.text)) byText.set(c.text, []); byText.get(c.text).push(c); }
    for (const c of A) {
      const cands = (byText.get(c.text) || []).filter(d => !d.used);
      if (!cands.length) continue;
      let best = cands[0], bd = dist(c, best);
      for (const d of cands) { const dd = dist(c, d); if (dd < bd) { best = d; bd = dd; } }
      c.used = best.used = true;
      if (bd > NEAR) out.push({ type: 'moved', page, before: c.text, after: c.text, x: best.x, y: best.y, from: { x: c.x, y: c.y } });
    }
    // 2) 残ったものは、近くにあれば「変更」
    const restA = A.filter(c => !c.used), restB = B.filter(c => !c.used);
    for (const c of restA) {
      let best = null, bd = Infinity;
      for (const d of restB) {
        if (d.used) continue;
        const dd = dist(c, d);
        if (dd < bd && dd <= NEAR && similar(c.text, d.text)) { best = d; bd = dd; }
      }
      if (best) {
        best.used = c.used = true;
        out.push({ type: 'changed', page, before: c.text, after: best.text, x: best.x, y: best.y, w: best.w, h: best.h });
      }
    }
    for (const c of restA) if (!c.used) out.push({ type: 'removed', page, before: c.text, after: '', x: c.x, y: c.y, w: c.w, h: c.h });
    for (const d of restB) if (!d.used) out.push({ type: 'added', page, before: '', after: d.text, x: d.x, y: d.y, w: d.w, h: d.h });
  }
  return out;
}

// 「W1600」と「W1650」、「AA-101」と「AA-102」のように、型が同じで中身が少し違うもの
function similar(a, b) {
  const sa = shape(a), sb = shape(b);
  if (sa === sb) return true;
  const ka = keyOf(a), kb = keyOf(b);
  return editDistance(ka, kb) <= Math.max(2, Math.floor(Math.min(ka.length, kb.length) / 3));
}
const shape = s => norm(s).replace(/\d+/g, '9').replace(/\s/g, '');

// ---------------- Excel ----------------

const KEY_HEAD = /記号|符号|品番|型番|型式|コード|code|No\.?$|番号/i;

export function diffXlsx(oldDoc, newDoc) {
  const out = [];
  const names = new Set([...oldDoc.sheets.map(s => s.name), ...newDoc.sheets.map(s => s.name)]);
  for (const name of names) {
    const a = oldDoc.sheets.find(s => s.name === name);
    const b = newDoc.sheets.find(s => s.name === name);
    if (!a) { out.push({ type: 'added', sheet: name, cell: '', col: '', before: '', after: `シート「${name}」が追加` }); continue; }
    if (!b) { out.push({ type: 'removed', sheet: name, cell: '', col: '', before: `シート「${name}」が削除`, after: '' }); continue; }
    out.push(...diffSheet(a, b));
  }
  return out;
}

export function sheetLayout(sheet) {
  const h = findHeaderRow(sheet.rows);
  const header = h >= 0 ? sheet.rows[h].map(c => String(c.v || '')) : [];
  const body = sheet.rows.slice(h + 1);
  let key = header.findIndex(t => KEY_HEAD.test(t));
  if (key < 0) key = guessKeyColumn(body);
  return { h, header, key };
}

function guessKeyColumn(body) {
  if (!body.length) return -1;
  const cols = Math.max(...body.map(r => r.length));
  let best = -1, bestScore = 0.75;
  for (let c = 0; c < cols; c++) {
    const vals = body.map(r => r[c]?.v).filter(v => v !== '' && v != null && typeof v === 'string');
    if (vals.length < body.length * 0.6) continue;
    const uniq = new Set(vals.map(keyOf)).size / vals.length;
    if (uniq > bestScore) { best = c; bestScore = uniq; }
  }
  return best;
}

function diffSheet(a, b) {
  const out = [];
  const la = sheetLayout(a), lb = sheetLayout(b);
  const header = lb.header.length ? lb.header : la.header;
  const colName = c => header[c] || colLetter(c);
  const bodyA = a.rows.slice(la.h + 1).map((r, i) => ({ r, n: la.h + 2 + i }));
  const bodyB = b.rows.slice(lb.h + 1).map((r, i) => ({ r, n: lb.h + 2 + i }));
  const nonEmpty = x => x.r.some(c => c.v !== '' || c.f);

  let pairs; // [[rowA|null, rowB|null]]
  const ka = la.key, kb = lb.key;
  const keysA = bodyA.filter(nonEmpty).map(x => keyOf(x.r[ka]?.v));
  const usable = ka >= 0 && kb >= 0 && keysA.filter(Boolean).length >= 2 &&
    new Set(keysA.filter(Boolean)).size === keysA.filter(Boolean).length;
  if (usable) {
    pairs = alignByKey(bodyA.filter(nonEmpty), bodyB.filter(nonEmpty), ka, kb);
  } else {
    pairs = alignByLcs(bodyA.filter(nonEmpty), bodyB.filter(nonEmpty));
  }
  for (const [x, y] of pairs) {
    const label = rowLabel(y || x, usable ? (y ? kb : ka) : -1);
    if (!x) { out.push({ type: 'added', sheet: b.name, cell: `${y.n}行目`, row: label, col: '', before: '', after: rowText(y.r) }); continue; }
    if (!y) { out.push({ type: 'removed', sheet: a.name, cell: `${x.n}行目`, row: label, col: '', before: rowText(x.r), after: '' }); continue; }
    const cols = Math.max(x.r.length, y.r.length);
    for (let c = 0; c < cols; c++) {
      const p = x.r[c] || { v: '', f: '' }, q = y.r[c] || { v: '', f: '', a: colLetter(c) + y.n };
      const valueDiff = !sameValue(p.v, q.v);
      const formulaDiff = (p.f || '') !== (q.f || '') && relFormula(p.f, x.n) !== relFormula(q.f, y.n);
      if (!valueDiff && !formulaDiff) continue;
      out.push({
        type: 'changed', sheet: b.name, cell: q.a || colLetter(c) + y.n, oldCell: p.a, row: label, col: colName(c),
        before: fmt(p.v), after: fmt(q.v),
        formula: formulaDiff ? { before: p.f || '', after: q.f || '' } : null,
      });
    }
  }
  return out;
}

function alignByKey(A, B, ka, kb) {
  const mapB = new Map();
  B.forEach((y, i) => { const k = keyOf(y.r[kb]?.v); if (k && !mapB.has(k)) mapB.set(k, i); });
  const usedB = new Set();
  const pairs = [];
  for (const x of A) {
    const k = keyOf(x.r[ka]?.v);
    const i = k ? mapB.get(k) : undefined;
    if (i != null && !usedB.has(i)) { usedB.add(i); pairs.push([x, B[i]]); }
    else pairs.push([x, null]);
  }
  B.forEach((y, i) => { if (!usedB.has(i)) pairs.push([null, y]); });
  // 合わなかった行どうしで、記号以外の中身が半分以上同じなら「記号・品番が変わった行」として対にする。
  // 記号が空の行（合計・小計など）は、空どうしを上から順に対にする。
  const onlyA = pairs.filter(p => !p[1]), onlyB = pairs.filter(p => !p[0]);
  const merged = new Set();
  for (const pa of onlyA) {
    const x = pa[0];
    const emptyKey = !keyOf(x.r[ka]?.v);
    let best = null, bestScore = 0;
    for (const pb of onlyB) {
      if (merged.has(pb)) continue;
      const y = pb[1];
      if (emptyKey !== !keyOf(y.r[kb]?.v)) continue;
      const score = emptyKey ? 1 : overlap(x.r, y.r, ka, kb);
      if (score > bestScore) { best = pb; bestScore = score; }
    }
    if (best && bestScore >= 0.5) { pa[1] = best[1]; merged.add(best); }
  }
  return pairs.filter(p => !merged.has(p));
}

function overlap(a, b, ka, kb) {
  const va = a.filter((_, i) => i !== ka).map(c => norm(String(c.v))).filter(Boolean);
  const vb = new Set(b.filter((_, i) => i !== kb).map(c => norm(String(c.v))).filter(Boolean));
  if (!va.length) return 0;
  return va.filter(v => vb.has(v)).length / va.length;
}

function alignByLcs(A, B) {
  const sa = A.map(x => rowText(x.r)), sb = B.map(x => rowText(x.r));
  const n = sa.length, m = sb.length;
  if (n * m > 4_000_000) return A.map((x, i) => [x, B[i] || null]).concat(B.slice(A.length).map(y => [null, y]));
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = sa[i] === sb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs = [];
  let i = 0, j = 0;
  const pendA = [], pendB = [];
  const flush = () => {
    // 消えた行と増えた行が同じ数並んでいたら「書き換え」とみなしてセル比較させる
    while (pendA.length && pendB.length) pairs.push([pendA.shift(), pendB.shift()]);
    pendA.splice(0).forEach(x => pairs.push([x, null]));
    pendB.splice(0).forEach(y => pairs.push([null, y]));
  };
  while (i < n && j < m) {
    if (sa[i] === sb[j]) { flush(); pairs.push([A[i], B[j]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) pendA.push(A[i++]);
    else pendB.push(B[j++]);
  }
  while (i < n) pendA.push(A[i++]);
  while (j < m) pendB.push(B[j++]);
  flush();
  return pairs;
}

function sameValue(p, q) {
  const a = toNumber(p), b = toNumber(q);
  if (a != null && b != null) return Math.abs(a - b) < 1e-6;
  return keyOf(p) === keyOf(q) && norm(p) === norm(q);
}
// 行がずれただけで数式の行番号が変わるのを差分にしない（=E5*F5 と =E6*F6 は同じ）
function relFormula(f, row) {
  if (!f) return '';
  return f.replace(/([A-Z]{1,3})\$?(\d+)/g, (_, c, r) => `${c}[${Number(r) - row}]`);
}
const fmt = v => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('ja-JP') : String(v)) : String(v ?? ''));
const rowText = r => r.map(c => fmt(c.v)).filter(Boolean).join(' / ');
const rowLabel = (x, k) => (k >= 0 && x.r[k]?.v !== '' ? fmt(x.r[k].v) : rowText(x.r).slice(0, 30));
export function colLetter(c) { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
