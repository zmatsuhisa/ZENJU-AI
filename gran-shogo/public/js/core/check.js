// 資料間の照合（平面図 × 建具表、仕上表 × 見積、設備図 × 見積 など）
// 1) 各資料から「記号・品番」と、その寸法(W/H)・数量・名称を拾う
// 2) 同じ記号・品番どうしで値を比べ、食い違い・記載漏れ・品番違いの疑いを出す
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

// ---------- 拾い出し ----------

// 記号・品番の形：英字1〜4＋数字（ハイフン可）。例 AW1, SD-2, DL-1, AA-101, LGB-81512
const CODE_RE = /(?<![A-Za-z0-9])([A-Z]{1,4}-?\d{1,5}(?:-[A-Z0-9]{1,5})?[A-Z]?)(?![A-Za-z0-9])/g;
// 記号に見えるが記号ではないもの（寸法・階・高さ・用紙など）
const NOT_CODE = /^([WHD]\d{3,5}|[WHD]-\d{3,5}|\d+F|[A-B][0-4]|GL-?\d+|FL-?\d+|CH-?\d+|SL-?\d+|KG\d*|MM\d*|CM\d*|KW\d*|PH\d*|S\d{1,3}|P\d{1,3}|R\d{1,2}|NO\d+|[A-Z]\d{4,})$/; // 最後は工番（A1635 など）
const QTY_RE = /(\d+(?:\.\d+)?)\s*(台|個|枚|本|ヶ所|ケ所|箇所|カ所|か所|セット|組|式|灯|基|m2|㎡|m)(?![a-zA-Z])/;
const W_RE = /W\s*=?\s*(\d{3,5})/i;
const H_RE = /H\s*=?\s*(\d{3,5})/i;
const WXH_RE = /(?<![\d.])(\d{3,5})\s*x\s*(\d{3,5})(?![\d.])/;

export function findCodes(text) {
  const t = norm(text).toUpperCase();
  const out = [];
  for (const m of t.matchAll(CODE_RE)) {
    const code = m[1];
    if (NOT_CODE.test(code.replace(/-/g, '')) || NOT_CODE.test(code)) continue;
    if (!/\d/.test(code)) continue;
    out.push(code);
  }
  return out;
}

export function parseSize(text) {
  const t = norm(text);
  let w = null, h = null;
  const wm = t.match(W_RE), hm = t.match(H_RE), xm = t.match(WXH_RE);
  if (wm) w = Number(wm[1]);
  if (hm) h = Number(hm[1]);
  if (xm && w == null && h == null) { w = Number(xm[1]); h = Number(xm[2]); }
  return { w, h };
}

export function parseQty(text) {
  const m = norm(text).match(QTY_RE);
  return m ? { qty: Number(m[1]), unit: m[2] } : null;
}

/** PDF から記号ごとの観測を作る */
export function extractPdf(doc, docName, role) {
  const recs = new Map(); // code -> obs
  for (const pg of doc.pages) {
    const chunks = pg.chunks;
    chunks.forEach((c, i) => {
      for (const code of findCodes(c.text)) {
        const k = keyOf(code);
        const o = recs.get(k) || { key: k, code, doc: docName, role, kind: 'pdf', w: null, h: null, qty: null, unit: '', name: '', count: 0, locs: [] };
        o.count++;
        o.locs.push({ page: pg.page, x: c.x, y: c.y, text: c.text });
        // 同じ記入の中、またはすぐ下の記入にある寸法
        const below = chunks.filter(d => d !== c && d.y > c.y && d.y - c.y < c.h * 2.6 && Math.abs(d.x - c.x) < 80);
        const near = [c.text.replace(code, ''), ...below.map(d => d.text)].join(' ');
        const sz = parseSize(near);
        if (sz.w && o.w == null) { o.w = sz.w; o.wLoc = `p.${pg.page}`; }
        if (sz.h && o.h == null) { o.h = sz.h; o.hLoc = `p.${pg.page}`; }
        // 同じ行で右側にある数量・名称（凡例や表の1行）
        const row = chunks.filter(d => Math.abs(d.y - c.y) < c.h * 0.6 && d.x >= c.x && d.x - c.x < 200);
        const rowText = row.map(d => d.text).join(' ');
        const q = parseQty(rowText.replace(code, ''));
        if (q) { o.qty = (o.qty ?? 0) + q.qty; o.unit = q.unit; o.qtyLoc = `p.${pg.page}`; o.legend = true; }
        if (!o.name) {
          const nm = row.map(d => d.text).find(t => /[぀-ヿ一-鿿]/.test(t) && !QTY_RE.test(t));
          if (nm) o.name = nm.replace(code, '').trim();
        }
        recs.set(k, o);
      }
    });
  }
  // 図面では、凡例以外に出てくる記号の数＝その器具・建具の数
  for (const o of recs.values()) {
    if (role === 'drawing') o.drawnCount = o.count - (o.legend ? 1 : 0);
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
    const { h, header } = sheetLayout(sh);
    if (h < 0) continue;
    const col = {};
    header.forEach((t, c) => {
      const s = norm(t);
      for (const [role2, re] of Object.entries(HEAD)) {
        if (re.test(s)) { (col[role2] ||= []).push(c); }
      }
    });
    if (!col.code && !col.name) continue;
    for (let r = h + 1; r < sh.rows.length; r++) {
      const row = sh.rows[r];
      const get = c => (c == null ? '' : row[c]?.v ?? '');
      const codeCells = (col.code || []).map(c => ({ c, v: get(c) })).filter(x => x.v !== '');
      // 名称欄に品番が書いてある見積にも対応
      const nameText = (col.name || []).map(get).join(' ');
      const codes = [];
      for (const x of codeCells) for (const code of findCodes(String(x.v))) codes.push({ code, a: colLetter(x.c) + (r + 1) });
      if (!codes.length) for (const code of findCodes(nameText)) codes.push({ code, a: colLetter(col.name[0]) + (r + 1) });
      if (!codes.length) continue;
      let w = toNumber(get(col.w?.[0])), hh = toNumber(get(col.h?.[0]));
      if ((w == null || hh == null) && col.size) {
        const sz = parseSize(String(get(col.size[0])));
        w ??= sz.w; hh ??= sz.h;
      }
      if (w == null && hh == null) {
        const sz = parseSize(nameText);
        w = sz.w; hh = sz.h;
      }
      const qty = toNumber(get(col.qty?.[0]));
      const unit = norm(get(col.unit?.[0]));
      for (const { code, a } of codes) {
        const k = keyOf(code);
        const loc = `${sh.name}!${a}`;
        const o = recs.get(k) || { key: k, code, doc: docName, role, kind: 'excel', w: null, h: null, qty: null, unit: '', name: '', count: 0, locs: [] };
        o.count++;
        o.locs.push({ cell: loc, sheet: sh.name, row: r + 1 });
        if (w != null && o.w == null) { o.w = w; o.wLoc = sh.name + '!' + colLetter(col.w?.[0] ?? col.size?.[0] ?? 0) + (r + 1); }
        if (hh != null && o.h == null) { o.h = hh; o.hLoc = sh.name + '!' + colLetter(col.h?.[0] ?? col.size?.[0] ?? 0) + (r + 1); }
        if (qty != null) { o.qty = (o.qty ?? 0) + qty; o.unit = unit || o.unit; o.qtyLoc = sh.name + '!' + colLetter(col.qty[0]) + (r + 1); }
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
 * 返り値: findings の配列
 */
export function crossCheck(docs) {
  const all = [];
  for (const d of docs) {
    const recs = d.data.kind === 'pdf' ? extractPdf(d.data, d.name, d.role) : extractXlsx(d.data, d.name, d.role);
    all.push(...recs);
  }
  const byKey = new Map();
  for (const o of all) { if (!byKey.has(o.key)) byKey.set(o.key, []); byKey.get(o.key).push(o); }

  const findings = [];
  let seq = 0;
  const add = f => findings.push({ id: 'r' + (++seq), source: 'rule', ...f });

  // 寸法・数量の食い違い
  for (const [key, obs] of byKey) {
    if (obs.length < 2) continue;
    const code = obs[0].code;
    const name = obs.find(o => o.name)?.name || '';
    for (const dim of ['w', 'h']) {
      const has = obs.filter(o => o[dim] != null);
      if (has.length < 2) continue;
      if (new Set(has.map(o => o[dim])).size > 1) {
        const label = dim === 'w' ? '幅 W' : '高さ H';
        add({
          kind: 'mismatch', category: '寸法', severity: 'ng', key: code, name,
          title: `${code} の${label}が違います`,
          message: has.map(o => `${o.doc} ${dim.toUpperCase()}${o[dim]}`).join(' ／ '),
          obs: has.map(o => ({ doc: o.doc, loc: o[dim + 'Loc'] || where(o), value: `${dim.toUpperCase()}${o[dim]}` })),
        });
      }
    }
    const qobs = obs.map(o => ({ o, q: qtyOf(o) })).filter(x => x.q != null && x.o.unit !== '式');
    if (qobs.length >= 2 && new Set(qobs.map(x => x.q)).size > 1) {
      add({
        kind: 'mismatch', category: '数量', severity: 'ng', key: code, name,
        title: `${code}${name ? '（' + name + '）' : ''} の数量が違います`,
        message: qobs.map(x => `${x.o.doc} ${x.q}${x.o.unit || unitGuess(x.o)}`).join(' ／ '),
        obs: qobs.map(x => ({ doc: x.o.doc, loc: x.o.qtyLoc && x.o.qty != null && !(x.o.role === 'drawing' && x.o.drawnCount > 0) ? x.o.qtyLoc : where(x.o), value: `${x.q}${x.o.unit || unitGuess(x.o)}` + (x.o.role === 'drawing' && x.o.drawnCount > 0 ? '（図面上の記号の数）' : '') })),
      });
    }
  }

  // 記載漏れ・品番違いの疑い
  const docNames = docs.map(d => d.name);
  const keysIn = new Map(docNames.map(n => [n, new Set(all.filter(o => o.doc === n).map(o => o.key))]));
  const familiesIn = new Map(docNames.map(n => [n, new Set([...keysIn.get(n)].map(family))]));
  const suspectDone = new Set();
  for (const d of docs) {
    const mine = all.filter(o => o.doc === d.name);
    for (const other of docs) {
      if (other === d) continue;
      // 見積はすべての記号を対象。表・図面は「同じ種類の記号を扱っている資料」だけを対象にする
      for (const o of mine) {
        if (keysIn.get(other.name).has(o.key)) continue;
        if (other.role !== 'estimate' && !familiesIn.get(other.name).has(family(o.key))) continue;
        if (d.role === 'estimate' && other.role !== 'estimate') continue; // 見積にだけある項目は対象外（諸経費など）
        // 相手側にだけある、1文字違いの記号を探す
        const cand = [...keysIn.get(other.name)].filter(k => !keysIn.get(d.name).has(k) && family(k) === family(o.key) && editDistance(k, o.key) === 1);
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
          add({
            kind: 'missing', category: '記載漏れ', severity: 'check', key: o.code, name: o.name,
            title: `${o.code}${o.name ? '（' + o.name + '）' : ''} が ${other.name} にありません`,
            message: `${d.name} に記載あり ／ ${other.name} に該当項目なし`,
            obs: [{ doc: d.name, loc: where(o), value: '記載あり' }, { doc: other.name, loc: '—', value: '該当なし' }],
          });
        }
      }
    }
  }
  return { findings, records: all };
}

function qtyOf(o) {
  if (o.role === 'drawing') return o.drawnCount > 0 ? o.drawnCount : o.qty;
  return o.qty;
}
const unitGuess = o => (o.role === 'drawing' ? 'か所' : '');
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
      title: kind === 'pdf'
        ? (c.type === 'changed' ? `「${c.before}」→「${c.after}」` : c.type === 'added' ? `「${c.after}」が追加` : c.type === 'removed' ? `「${c.before}」が削除` : `「${c.after}」の位置が移動`)
        : `${what || loc}${c.formula && c.before === c.after ? ' の数式' : ''}${c.type === 'changed' ? 'が変更' : c.type === 'added' ? 'が追加' : 'が削除'}`,
      message: `変更前 ${before || '—'} ／ 変更後 ${after || '—'}`,
      obs: [{ doc: oldName, loc: kind === 'pdf' ? loc : (c.oldCell ? `${c.sheet}!${c.oldCell}` : loc), value: before || '—' }, { doc: newName, loc, value: after || '—' }],
      at: kind === 'pdf' && c.x != null ? { page: c.page, x: c.x, y: c.y, w: c.w || 30, h: c.h || 10 } : null,
    };
  });
}
