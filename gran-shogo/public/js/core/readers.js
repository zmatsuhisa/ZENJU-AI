// PDF と Excel を「照合しやすい形」に読み込む。ブラウザでも Node（テスト）でも同じコードを使う。
// pdfjs と XLSX は呼び出し側から渡す（読み込み方が環境で違うため）。
import { norm } from './normalize.js';

/**
 * PDF → { kind:'pdf', pages:[{ page, width, height, chunks:[{text, x, y, w, h}] }] }
 * chunk は「同じ高さで近くに並んだ文字のまとまり」。図面では1つの記入（AW1、W1650 など）が1つの chunk になる。
 */
export async function readPdf(pdfjs, data, opts = {}) {
  const task = pdfjs.getDocument({ data, ...opts });
  const doc = await task.promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(it => it.str && it.str.trim())
      .map(it => {
        const [a, b, , d, e, f] = it.transform;
        const size = Math.hypot(a, b) || Math.abs(d) || 10;
        return { str: it.str, x: e, y: vp.height - f, w: it.width || size * it.str.length * 0.6, size };
      });
    pages.push({ page: p, width: vp.width, height: vp.height, chunks: groupChunks(items) });
    page.cleanup?.();
  }
  await doc.destroy?.();
  return { kind: 'pdf', pages };
}

function groupChunks(items) {
  // 上から順、同じ行は左から
  items.sort((p, q) => (Math.abs(p.y - q.y) < Math.min(p.size, q.size) * 0.5 ? p.x - q.x : p.y - q.y));
  const chunks = [];
  let cur = null;
  for (const it of items) {
    const sameRow = cur && Math.abs(cur.y - it.y) < Math.min(cur.size, it.size) * 0.5;
    const gap = cur ? it.x - (cur.x + cur.w) : 0;
    if (sameRow && gap < it.size * 2.5) {
      cur.text += (gap > it.size * 0.25 ? ' ' : '') + it.str;
      cur.w = it.x + it.w - cur.x;
    } else {
      if (cur) chunks.push(cur);
      cur = { text: it.str, x: it.x, y: it.y, w: it.w, h: it.size, size: it.size };
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map(c => ({ text: norm(c.text), x: round(c.x), y: round(c.y), w: round(c.w), h: round(c.h) }))
    .filter(c => c.text);
}

const round = v => Math.round(v * 10) / 10;

/** PDFのページを「行の文字列の並び」に（新旧比較のテキスト差分用） */
export function pdfPageLines(page) {
  return page.chunks.map(c => c.text);
}

/**
 * Excel → { kind:'excel', sheets:[{ name, rows:[[{ v, f, a }]] }] }
 * v=表示される値、f=数式（あれば）、a=セル番地（C5 など）
 */
export function readXlsx(XLSX, data) {
  const wb = XLSX.read(data, { type: 'array', cellFormula: true, cellNF: false, cellDates: true });
  const sheets = wb.SheetNames.map(name => {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) return { name, rows: [] };
    const range = XLSX.utils.decode_range(ws['!ref']);
    const rows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        const a = XLSX.utils.encode_cell({ r, c });
        const cell = ws[a];
        if (!cell) { row.push({ v: '', f: '', a }); continue; }
        let v = cell.w ?? cell.v;
        if (cell.v instanceof Date) v = cell.v.toISOString().slice(0, 10);
        row.push({ v: typeof cell.v === 'number' ? cell.v : norm(v), f: cell.f ? '=' + cell.f : '', a });
      }
      rows.push(row);
    }
    // 末尾の空行は落とす
    while (rows.length && rows[rows.length - 1].every(c => c.v === '' && !c.f)) rows.pop();
    return { name, rows };
  });
  return { kind: 'excel', sheets };
}

/** 表の見出し行を探す（最初の15行で、文字のセルが一番多い行） */
export function findHeaderRow(rows) {
  let best = -1, bestScore = 1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const texts = rows[i].filter(c => typeof c.v === 'string' && c.v && !/^\d/.test(c.v)).length;
    if (texts > bestScore) { best = i; bestScore = texts; }
  }
  return best;
}
