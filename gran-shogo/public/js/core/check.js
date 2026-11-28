// 資料間の照合（平面図 × 建具表、仕上表 × 見積、設備図 × 見積 など）
//
// 1) 拾い出し：資料ごとに「記号・品番」が出てくる場所を1つずつ見て、何として書かれているかを分ける
//      instance  … 図面の上の記号（その場所に器具・建具が1つある）
//      legend    … 凡例の行（記号・名称・数量が横に並ぶ）
//      table     … 表の欄（建具表・器具表。PDF の表は、見出しの「記号・W・H・数量」の並びから読む）
//      reference … 注記の中で記号に触れているだけ（※AW1～AW3は防火設備 など。数に入れない）
//      ignore    … 記号ではない（通り芯 X1・Y2、図番 A-03 など）
// 2) 照合：同じ記号どうしで寸法・数量を比べ、食い違い・記載漏れ・品番違いの疑いを出す
// どこから拾ったか（資料名・ページ・セル）を必ず残す。
import { norm, keyOf, toNumber, editDistance } from './normalize.js';
import { sheetLayout, colLetter } from './diff.js';

export const ROLES = {
  drawing: '図面',
  table: '表・仕様書',
  estimate: '見積',
};

export function guessRole(name, kind) {
  const n = norm(name);
  if (/見積|御見積|estimate|mitsumori/i.test(n)) return 'estimate';
  if (/表|仕様|spec|リスト|list/i.test(n)) return 'table';
  if (/図|plan|立面|平面|配置|展開|設備|電気|dwg/i.test(n)) return 'drawing';
  return kind === 'pdf' ? 'drawing' : 'table';
}

// ---------- 文字から読む ----------

// 記号・品番の形：英字1〜4＋数字（ハイフン可）。例 AW1, SD-2, DL-1, AA-101, LGB-81512
const CODE_RE = /(?<![A-Za-z0-9])([A-Z]{1,4}-?\d{1,5}(?:-[A-Z0-9]{1,5})?[A-Z]?)(?![A-Za-z0-9])/g;
// 記号に見えるが記号ではないもの（寸法・階・高さ・用紙・通り芯など）
const NOT_CODE = /^([WHD]\d{3,5}|[WHD]-\d{3,5}|\d+F|[A-B][0-4]|GL-?\d{2,}|FL-?\d{2,}|CH-?\d{2,}|SL-?\d{2,}|KG\d*|MM\d*|CM\d*|KW\d*|PH\d*|S\d{1,3}|P\d{1,3}|R\d{1,2}|NO\d+|[XY]\d{1,2}[A-Z]?|[A-Z]\d{4,})$/; // 最後は工番（A1635 など）
// 図番・工番などの見出しの後ろにある記号は、品番ではない
const SHEET_LABEL = /(図番|図面番号|図面NO|工番|工事番号|DWG|SHEET|管理番号)\s*[.:：]?\s*$/i;
// 注記の中で記号に触れているだけ（数に入れない）
const REFERENCE = /※|[～〜~]|とする|こと|参照|による|同等|に変更|を設置|を使用/;
const UNIT = '台|個|枚|本|ヶ所|ケ所|箇所|カ所|か所|ヵ所|セット|組|式|灯|基|m2|㎡|m3|m';
const QTY_RE = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT})(?![a-zA-Z])`);
const AREA_UNIT = /^(m2|㎡|m3|m|式)$/;
const W_RE = /W\s*=?\s*(\d{1,2},\d{3}|\d{3,5})/i;
const H_RE = /H\s*=?\s*(\d{1,2},\d{3}|\d{3,5})/i;
const WXH_RE = /(?<![\d.,])(\d{1,2},\d{3}|\d{3,5})\s*x\s*(\d{1,2},\d{3}|\d{3,5})(?![\d.])/;
const num = s => Number(String(s).replace(/,/g, ''));

export function findCodes(text) {
  const t = norm(text).toUpperCase();
  const out = [];
  for (const m of t.matchAll(CODE_RE)) {
    const code = m[1];
    if (NOT_CODE.test(code.replace(/-/g, '')) || NOT_CODE.test(code)) continue;
    if (!/\d/.test(code)) continue;
    if (SHEET_LABEL.test(t.slice(0, m.index))) continue;
    out.push(code);
  }
  return out;
}

export function parseSize(text) {
  const t = norm(text);
  let w = null, h = null;
  const wm = t.match(W_RE), hm = t.match(H_RE), xm = t.match(WXH_RE);
  if (wm) w = num(wm[1]);
  if (hm) h = num(hm[1]);
  if (xm && w == null && h == null) { w = num(xm[1]); h = num(xm[2]); }
  return { w, h };
}

export function parseQty(text) {
  const m = norm(text).match(QTY_RE);
  return m ? { qty: Number(m[1]), unit: m[2] } : null;
}

// 表の欄の数量：「2」「2ヶ所」「2 台」どれでも読む
function cellQty(v) {
  const n = toNumber(v);
  if (n != null) return { qty: n, unit: '' };
  const t = norm(v);
  const m = t.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${UNIT})?$`));
  return m ? { qty: Number(m[1]), unit: m[2] || '' } : null;
}
// 表の欄の寸法：「1650」「1,650」
function cellMm(v) {
  const n = toNumber(v);
  return n != null && n >= 100 && n <= 20000 ? n : null;
}
// 文字が「記号だけ」か（AW1、ＡＷ－１、DL-1 など）
const codeOnly = (text, code) => keyOf(text) === keyOf(code);
const hasJa = t => /[぀-ヿ一-鿿]/.test(t);

// ---------- PDF の表（建具表・器具表）----------
// 見出しの「記号」と、同じ行（または同じ列）に並ぶ「W・H・数量・名称」を探し、その並びに沿って値を読む。
// 行が記号の表（ふつうの表）と、列が記号の表（建具表に多い、縦横が逆の表）の両方に対応する。

const LABEL = {
  code: /^(記号|符号|品番|型番|型式|建具番号|番号)$/,
  name: /^(名称|品名|器具名|種類|形式|形状|建具名)$/,
  w: /^(W|幅|巾|W寸法|W\(MM\)|幅W|間口)$/i,
  h: /^(H|高さ|H寸法|H\(MM\)|高さH)$/i,
  size: /^(寸法|サイズ|WXH|寸法\(WXH\)|W\.H)$/i,
  qty: /^(数量|箇所数|台数|個数|員数|枚数|本数|か所|箇所|ヶ所数)$/,
};
const labelOf = text => {
  const t = norm(text).replace(/\s/g, '').toUpperCase();
  for (const [k, re] of Object.entries(LABEL)) if (re.test(t)) return k;
  return null;
};
const cx = c => c.x + c.w / 2;
const sameRow = (a, b) => Math.abs(a.y - b.y) < Math.min(a.h, b.h) * 0.7;

/** 返り値：Map(chunk の番号 → { code, w, h, qty, unit, name }) */
export function pdfTables(chunks) {
  const cells = new Map();
  const labels = chunks.map((c, i) => ({ c, i, k: labelOf(c.text) })).filter(x => x.k);
  for (const L of labels.filter(x => x.k === 'code')) {
    // 行が記号の表：見出しが横に並ぶ
    const rowHeads = labels.filter(x => x !== L && x.k !== 'code' && sameRow(x.c, L.c) && x.c.x > L.c.x);
    // 列が記号の表：見出しが縦に並ぶ
    const colHeads = labels.filter(x => x !== L && x.k !== 'code' && Math.abs(x.c.x - L.c.x) < L.c.h * 1.5 && x.c.y > L.c.y);
    if (rowHeads.length >= colHeads.length && rowHeads.some(x => ['w', 'h', 'qty', 'size'].includes(x.k))) {
      const cols = [{ k: 'code', x: cx(L.c) }, ...rowHeads.map(x => ({ k: x.k, x: cx(x.c) }))].sort((a, b) => a.x - b.x);
      const lo = Math.min(L.c.x, ...rowHeads.map(x => x.c.x)) - L.c.h * 3;
      const hi = Math.max(...rowHeads.map(x => x.c.x + x.c.w)) + L.c.h * 6;
      const codeCol = cols.find(c => c.k === 'code');
      chunks.forEach((c, i) => {
        if (c.y <= L.c.y || cells.has(i)) return;
        const code = findCodes(c.text)[0];
        if (!code || !codeOnly(c.text, code) || nearestCol(cols, cx(c)) !== codeCol) return;
        const row = chunks.map((d, j) => ({ d, j })).filter(({ d }) => sameRow(d, c) && d.x >= lo && d.x <= hi);
        const rec = { code };
        for (const { d, j } of row) if (j !== i) put(rec, nearestCol(cols, cx(d)).k, d.text);
        cells.set(i, rec);
      });
    } else if (colHeads.some(x => ['w', 'h', 'qty', 'size'].includes(x.k))) {
      const codesInRow = chunks.map((c, i) => ({ c, i })).filter(({ c }) => c.x > L.c.x && sameRow(c, L.c))
        .map(x => ({ ...x, code: findCodes(x.c.text)[0] })).filter(x => x.code && codeOnly(x.c.text, x.code));
      if (!codesInRow.length) continue;
      const xs = codesInRow.map(x => cx(x.c));
      for (const x of codesInRow) {
        const rec = { code: x.code };
        for (const H of colHeads) {
          const cand = chunks.filter(d => sameRow(d, H.c) && d.x > L.c.x + L.c.w);
          const d = cand.find(d => nearestIdx(xs, cx(d)) === xs.indexOf(cx(x.c)));
          if (d) put(rec, H.k, d.text);
        }
        cells.set(x.i, rec);
      }
    }
  }
  return cells;
}
function nearestCol(cols, x) { let b = cols[0]; for (const c of cols) if (Math.abs(c.x - x) < Math.abs(b.x - x)) b = c; return b; }
function nearestIdx(xs, x) { let b = 0; xs.forEach((v, i) => { if (Math.abs(v - x) < Math.abs(xs[b] - x)) b = i; }); return b; }
function put(rec, k, text) {
  if (k === 'w' || k === 'h') { const v = cellMm(text); if (v != null) rec[k] ??= v; }
  else if (k === 'size') { const s = parseSize(text); rec.w ??= s.w; rec.h ??= s.h; }
  else if (k === 'qty') { const q = cellQty(text); if (q) { rec.qty ??= q.qty; rec.unit ||= q.unit; } }
  else if (k === 'name' && hasJa(text)) rec.name ||= text;
}

// ---------- 拾い出し ----------

// 隣どうしの寸法の記入がつながって1つになったとき（"W1690xH2030 W1650xH1370"）は、
// 文字の並びから位置を見積もって、記号の真下にある部分だけを使う
function pieceUnder(d, c) {
  const parts = d.text.split(' ');
  if (parts.length < 2) return d.text;
  const per = d.w / Math.max(1, d.text.length);
  let pos = 0, best = d.text, bd = Infinity;
  for (const p of parts) {
    const px = d.x + pos * per;
    const dist = Math.abs(px - c.x);
    if (dist < bd) { bd = dist; best = p; }
    pos += p.length + 1;
  }
  return best;
}

const newObs = (k, code, doc, role, kind) => ({ key: k, code, doc, role, kind, w: null, h: null, qty: null, unit: '', name: '', count: 0, drawn: 0, locs: [] });

/** PDF から記号ごとの観測を作る */
export function extractPdf(doc, docName, role) {
  const recs = new Map(); // key -> obs
  for (const pg of doc.pages) {
    const chunks = pg.chunks;
    const tables = pdfTables(chunks);
    chunks.forEach((c, i) => {
      const codes = findCodes(c.text);
      if (!codes.length) return;
      const tcell = tables.get(i);
      const isRef = !tcell && REFERENCE.test(c.text) && (hasJa(c.text) || codes.length > 1);
      for (const code of codes) {
        const k = keyOf(code);
        const o = recs.get(k) || newObs(k, code, docName, role, 'pdf');
        o.count++;
        const loc = { page: pg.page, x: c.x, y: c.y, text: c.text };
        o.locs.push(loc);
        recs.set(k, o);
        if (tcell && keyOf(tcell.code) === k) {
          loc.as = 'table';
          if (tcell.w != null && o.w == null) { o.w = tcell.w; o.wLoc = `p.${pg.page}（表）`; }
          if (tcell.h != null && o.h == null) { o.h = tcell.h; o.hLoc = `p.${pg.page}（表）`; }
          if (tcell.qty != null) { o.qty = (o.qty ?? 0) + tcell.qty; o.unit ||= tcell.unit; o.qtyLoc = `p.${pg.page}（表）`; o.declared = true; }
          if (tcell.name && !o.name) o.name = tcell.name;
          continue;
        }
        if (isRef) { loc.as = 'reference'; continue; }
        // 同じ行で右側にある数量・名称（凡例の1行）
        const row = chunks.filter(d => sameRow(d, c) && d.x >= c.x && d.x - c.x < 220);
        const rowText = row.map(d => d.text).join(' ').replace(code, '');
        const q = codes.length === 1 ? parseQty(rowText) : null;
        if (q) {
          loc.as = 'legend';
          o.qty = (o.qty ?? 0) + q.qty; o.unit = q.unit; o.qtyLoc = `p.${pg.page}（凡例）`; o.declared = true;
          const nm = row.map(d => d.text.replace(code, '').trim()).find(t => hasJa(t) && !QTY_RE.test(t));
          if (nm && !o.name) o.name = nm;
          continue;
        }
        // 図面の上の記号。寸法は同じ記入の中か、すぐ下（記号の幅の範囲）に書いてあるもの
        loc.as = 'instance';
        o.drawn++;
        const below = chunks.filter(d => d !== c && d.y > c.y && d.y - c.y < c.h * 3.2 && d.x < c.x + Math.max(c.w, 30) && d.x + d.w > c.x - 10 && !findCodes(d.text).length);
        const sz = parseSize([c.text.replace(code, ''), ...below.map(d => pieceUnder(d, c))].join(' '));
        if (sz.w && o.w == null) { o.w = sz.w; o.wLoc = `p.${pg.page}`; }
        if (sz.h && o.h == null) { o.h = sz.h; o.hLoc = `p.${pg.page}`; }
        if (!o.name) {
          const nm = row.map(d => d.text.replace(code, '').trim()).find(t => hasJa(t) && !QTY_RE.test(t) && !REFERENCE.test(t));
          if (nm) o.name = nm;
        }
      }
    });
  }
  for (const o of recs.values()) {
    o.drawnCount = role === 'drawing' ? o.drawn : 0; // 図面の上に記号が描かれている数＝その器具・建具の数
    if (!o.declared) o.qty = null;
  }
  return [...recs.values()];
}

const HEAD = {
  code: /記号|符号|品番|型番|型式|コード|code/i,
  name: /品名|名称|項目|摘要|器具名|部位|室名|名前|内容|^仕上$/,
  w: /^W$|^W[(（]|幅|巾|W寸法|間口/i,
  h: /^H$|^H[(（]|高さ|H寸法/i,
  size: /寸法|サイズ|W.?x.?H|WxH/i,
  qty: /数量|台数|個数|枚数|箇所数|本数|員数|数$/,
  unit: /単位/,
};

/** Excel から記号ごとの観測を作る */
export function extractXlsx(doc, docName, role) {
  const recs = new Map();
  for (const sh of doc.sheets) {
    if (!sh.rows.length) continue;
    const { h, header, start } = sheetLayout(sh);
    if (h < 0) continue;
    const col = {};
    header.forEach((t, c) => {
      const s = norm(t);
      for (const [role2, re] of Object.entries(HEAD)) {
        if (re.test(s)) { (col[role2] ||= []).push(c); }
      }
    });
    // 「寸法」の下に W・H がある2段の見出しでは、W・H の欄を寸法の欄より先に使う
    if (col.size && col.w) col.size = col.size.filter(c => !col.w.includes(c) && !(col.h || []).includes(c));
    if (!col.code && !col.name) continue;
    for (let r = start; r < sh.rows.length; r++) {
      const row = sh.rows[r];
      const get = c => (c == null ? '' : row[c]?.v ?? '');
      const codeCells = (col.code || []).map(c => ({ c, v: get(c) })).filter(x => x.v !== '');
      // 名称欄に品番が書いてある見積にも対応
      const nameText = (col.name || []).map(get).join(' ');
      const codes = [];
      for (const x of codeCells) for (const code of findCodes(String(x.v))) codes.push({ code, a: colLetter(x.c) + (r + 1) });
      if (!codes.length && col.name) for (const code of findCodes(nameText)) codes.push({ code, a: colLetter(col.name[0]) + (r + 1) });
      if (!codes.length) continue;
      let w = cellMm(get(col.w?.[0])), hh = cellMm(get(col.h?.[0]));
      if ((w == null || hh == null) && col.size?.length) {
        const sz = parseSize(String(get(col.size[0])));
        w ??= sz.w; hh ??= sz.h;
      }
      if (w == null && hh == null) {
        const sz = parseSize(nameText);
        w = sz.w; hh = sz.h;
      }
      const q = cellQty(get(col.qty?.[0]));
      const unit = norm(get(col.unit?.[0])) || q?.unit || '';
      for (const { code, a } of codes) {
        const k = keyOf(code);
        const loc = `${sh.name}!${a}`;
        const o = recs.get(k) || newObs(k, code, docName, role, 'excel');
        o.count++;
        o.locs.push({ cell: loc, sheet: sh.name, row: r + 1 });
        if (w != null && o.w == null) { o.w = w; o.wLoc = sh.name + '!' + colLetter(col.w?.[0] ?? col.size?.[0] ?? 0) + (r + 1); }
        if (hh != null && o.h == null) { o.h = hh; o.hLoc = sh.name + '!' + colLetter(col.h?.[0] ?? col.size?.[0] ?? 0) + (r + 1); }
        if (q) { o.qty = (o.qty ?? 0) + q.qty; o.unit = unit || o.unit; o.qtyLoc = sh.name + '!' + colLetter(col.qty[0]) + (r + 1); }
        if (!o.name && nameText) o.name = nameText.replace(code, '').trim();
        recs.set(k, o);
      }
    }
  }
  return [...recs.values()];
}

// ---------- 照合 ----------

const where = o => (o.kind === 'pdf' ? o.locs.map(l => `p.${l.page}`).filter((v, i, a) => a.indexOf(v) === i).join(',') : o.locs.map(l => l.cell).slice(0, 3).join(', '));

/**
 * docs: [{ name, role, data }]（data は readers の結果）
 * 返り値: { findings, records }
 */
export function crossCheck(docs) {
  const all = [];
  for (const d of docs) {
    const recs = d.data.kind === 'pdf' ? extractPdf(d.data, d.name, d.role) : extractXlsx(d.data, d.name, d.role);
    // 注記で触れているだけの記号は、照合の相手にしない（その資料に「ある」ことにもしない）
    all.push(...recs.filter(o => o.locs.some(l => l.as !== 'reference')));
  }
  const byKey = new Map();
  for (const o of all) { if (!byKey.has(o.key)) byKey.set(o.key, []); byKey.get(o.key).push(o); }

  const findings = [];
  let seq = 0;
  const add = f => { const x = { id: 'r' + (++seq), source: 'rule', ...f }; findings.push(x); return x; };

  for (const [, obs] of byKey) {
    if (obs.length < 2) continue;
    const code = obs[0].code;
    const name = obs.find(o => o.name && o.role !== 'drawing')?.name || obs.find(o => o.name)?.name || '';
    // 寸法の食い違い
    for (const dim of ['w', 'h']) {
      const has = obs.filter(o => o[dim] != null);
      if (has.length < 2 || new Set(has.map(o => o[dim])).size < 2) continue;
      const label = dim === 'w' ? '幅 W' : '高さ H';
      add({
        kind: 'mismatch', category: '寸法', severity: 'ng', key: code, name,
        title: `${code} の${label}が違います`,
        message: has.map(o => `${o.doc} ${dim.toUpperCase()}${o[dim]}`).join(' ／ '),
        obs: has.map(o => ({ doc: o.doc, loc: o[dim + 'Loc'] || where(o), value: `${dim.toUpperCase()}${o[dim]}` })),
      });
    }
    // 数量の食い違い
    const q = qtyCompare(obs);
    if (q) {
      add({
        kind: 'mismatch', category: '数量', severity: 'ng', key: code, name,
        title: `${code}${name ? '（' + name + '）' : ''} の数量が違います`,
        message: q.map(x => `${x.o.doc} ${x.v}${x.unit}`).join(' ／ '),
        obs: q.map(x => ({ doc: x.o.doc, loc: x.loc, value: `${x.v}${x.unit}${x.note}` })),
      });
    }
  }

  // 記載漏れ・品番違いの疑い
  const docNames = docs.map(d => d.name);
  const keysIn = new Map(docNames.map(n => [n, new Set(all.filter(o => o.doc === n).map(o => o.key))]));
  const familiesIn = new Map(docNames.map(n => [n, new Set([...keysIn.get(n)].map(family))]));
  const drawings = docs.filter(d => d.role === 'drawing');
  const inAnyDrawing = k => drawings.some(d => keysIn.get(d.name).has(k));
  const familyInDrawings = f => drawings.some(d => familiesIn.get(d.name).has(f));
  const suspectDone = new Set();
  const missing = new Map(); // 記号|足りない資料 → finding（図面と表の両方から同じ漏れが見えても1件にする）
  for (const d of docs) {
    const mine = all.filter(o => o.doc === d.name);
    for (const other of docs) {
      if (other === d) continue;
      if (d.role === 'drawing' && other.role === 'drawing') continue; // 図面どうしは、描く範囲が違うので比べない
      if (d.role === 'estimate' && other.role !== 'estimate') continue; // 見積にだけある項目は対象外（諸経費など）
      const otherIsDrawing = other.role === 'drawing';
      for (const o of mine) {
        // 図面は何枚かに分かれていることがあるので、どれかの図面にあれば「図面にある」とする
        if (otherIsDrawing ? inAnyDrawing(o.key) : keysIn.get(other.name).has(o.key)) continue;
        // 見積はすべての記号を対象。表・図面は「同じ種類の記号を扱っている資料」だけを対象にする
        if (other.role !== 'estimate' && !(otherIsDrawing ? familyInDrawings(family(o.key)) : familiesIn.get(other.name).has(family(o.key)))) continue;
        // 相手側にだけある、1文字違いの記号を探す
        const cand = [...keysIn.get(other.name)].filter(k => !keysIn.get(d.name).has(k) && family(k) === family(o.key) && editDistance(k, o.key) === 1 && !byKey.get(k).some(x => x.doc !== other.name && x.role === d.role));
        if (cand.length === 1) {
          const pair = [o.key, cand[0]].sort().join('|') + [d.name, other.name].sort().join('|');
          if (suspectDone.has(pair)) continue;
          suspectDone.add(pair);
          const t = all.find(x => x.doc === other.name && x.key === cand[0]);
          add({
            kind: 'suspect', category: '品番', severity: 'ng', key: o.code, name: o.name || t.name,
            title: `品番・記号が違う可能性：${o.code} と ${t.code}`,
            message: `${d.name} は ${o.code}、${other.name} は ${t.code}`,
            obs: [{ doc: d.name, loc: where(o), value: o.code }, { doc: other.name, loc: where(t), value: t.code }],
          });
        } else if (!cand.length) {
          const target = otherIsDrawing ? '図面' : other.name;
          const mk = o.key + '|' + target;
          const prev = missing.get(mk);
          if (prev) {
            if (!prev.obs.some(x => x.doc === d.name)) prev.obs.splice(prev.obs.length - 1, 0, { doc: d.name, loc: where(o), value: '記載あり' });
            prev.message = `${prev.obs.filter(x => x.value === '記載あり').map(x => x.doc).join('・')} に記載あり ／ ${target} に該当項目なし`;
            if (!prev.name && o.name) prev.name = o.name;
            continue;
          }
          const nm = o.name || all.find(x => x.key === o.key && x.name)?.name || '';
          const f = {
            kind: 'missing', category: '記載漏れ', severity: 'check', key: o.code, name: nm,
            title: `${o.code}${nm ? '（' + nm + '）' : ''} が ${target} にありません`,
            message: `${d.name} に記載あり ／ ${target} に該当項目なし`,
            obs: [{ doc: d.name, loc: where(o), value: '記載あり' }, { doc: otherIsDrawing ? drawings.map(x => x.name).join('・') : other.name, loc: '—', value: '該当なし' }],
          };
          missing.set(mk, add(f));
        }
      }
    }
  }
  return { findings, records: all };
}

/**
 * 数量の比べ方
 * - 表・見積・凡例に書いた数どうしは、そのまま比べる
 * - 図面に描かれた記号の数は、図面ごとの数か、図面を合わせた数のどれかと合えばよい（1階・2階で分かれた図面のため）
 * - 図面どうしの数は比べない（平面図と立面図で同じ窓を描く、など）。ただし同じ図面の凡例の数とは比べる
 * - 「1式」と、面積・長さ（㎡・m）の数量は、記号の数と比べない
 */
function qtyCompare(obs) {
  const unitOf = o => o.unit || (o.role === 'drawing' ? 'か所' : '');
  const declared = obs.filter(o => o.qty != null && !(o.unit && AREA_UNIT.test(o.unit)));
  const drawn = obs.filter(o => o.role === 'drawing' && o.drawnCount > 0);
  if (obs.some(o => o.qty != null && o.unit && AREA_UNIT.test(o.unit)) && !declared.length) return null;
  const list = [];
  for (const o of declared) list.push({ o, v: o.qty, unit: unitOf(o), loc: o.qtyLoc || where(o), note: o.role === 'drawing' ? '（凡例）' : '' });
  const drawnList = drawn.map(o => ({ o, v: o.drawnCount, unit: 'か所', loc: where(o), note: '（図面上の記号の数）' }));
  const ok = new Set(drawn.map(o => o.drawnCount));
  if (drawn.length > 1) ok.add(drawn.reduce((s, o) => s + o.drawnCount, 0));
  const declaredVals = new Set(declared.map(o => o.qty));
  let bad = declaredVals.size > 1;
  if (drawn.length && declared.length && declared.some(o => !ok.has(o.qty))) bad = true;
  if (!bad) return null;
  if (list.length + drawnList.length < 2) return null;
  return [...drawnList, ...list];
}

const family = k => (k.match(/^[A-Z]+/) || [''])[0];

// ---------- 新旧比較の結果を、照合結果と同じ形に ----------

export function changesToFindings(changes, oldName, newName, kind) {
  const label = { added: '追加', removed: '削除', changed: '変更', moved: '移動' };
  return changes.map((c, i) => {
    const loc = kind === 'pdf' ? `p.${c.page}` : `${c.sheet}${c.cell ? '!' + c.cell : ''}`;
    const what = kind === 'pdf' ? '' : `${c.row ? c.row + ' ' : ''}${c.col ? '「' + c.col + '」' : ''}`;
    const before = c.formula ? `${c.before}（${c.formula.before || '数式なし'}）` : c.before;
    const after = c.formula ? `${c.after}（${c.formula.after || '数式なし'}）` : c.after;
    return {
      id: 'c' + (i + 1), source: 'diff', kind: 'change', category: label[c.type] || '変更',
      severity: c.type === 'moved' ? 'info' : 'change', key: what || (c.after || c.before),
      title: c.title || (kind === 'pdf'
        ? (c.type === 'changed' ? `「${c.before}」→「${c.after}」` : c.type === 'added' ? `「${c.after}」が追加` : c.type === 'removed' ? `「${c.before}」が削除` : `「${c.after}」の位置が移動`)
        : `${what || loc}${c.formula && c.before === c.after ? ' の数式' : ''}${c.type === 'changed' ? 'が変更' : c.type === 'added' ? 'が追加' : 'が削除'}`),
      message: `変更前 ${before || '—'} ／ 変更後 ${after || '—'}`,
      obs: [{ doc: oldName, loc: kind === 'pdf' ? (c.whole && c.type === 'added' ? '—' : `p.${c.pageA ?? c.page}`) : (c.oldCell ? `${c.sheet}!${c.oldCell}` : loc), value: before || '—' }, { doc: newName, loc: c.whole && c.type === 'removed' ? '—' : loc, value: after || '—' }],
      ...(c.whole ? { whole: c.type } : {}),
      at: kind === 'pdf' && c.x != null ? { page: c.page, x: c.x, y: c.y, w: c.w || 30, h: c.h || 10 } : null,
    };
  });
}
