// 図がまとまって動いたときの新旧比較のテスト（文字の位置で、動いた図のずれを見つける）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockShifts } from '../public/js/core/shift.js';
import { diffPdf } from '../public/js/core/diff.js';

// 枠・表題（動かない）と、平面図（下へ 30pt 動く）の文字を作る
function sheet(dy, extra = []) {
  const frame = ['図面名称', '1階電気図', '縮尺1/50', '株式会社グランハウス', '凡例', 'ダウンライト', 'スイッチ', 'コンセント']
    .map((text, i) => ({ text, x: 1000 + (i % 2) * 60, y: 700 + i * 15, w: 40, h: 8 }));
  const plan = ['LDK', '洋室1', '洋室2', '浴室', '洗面所', 'トイレ', '玄関', 'WIC', 'パントリー', '2,730', '3,640', '1,820']
    .map((text, i) => ({ text, x: 100 + (i % 4) * 150, y: 100 + Math.floor(i / 4) * 120 + dy, w: 30, h: 8 }));
  return { kind: 'pdf', pages: [{ page: 1, width: 1191, height: 842, chunks: [...frame, ...plan, ...extra] }] };
}

test('動いた図のずれと、動いていない枠の両方を見つける', () => {
  const a = sheet(0).pages[0].chunks, b = sheet(30).pages[0].chunks;
  const s = blockShifts(a, b);
  assert.equal(s.length, 2);
  assert.ok(s.some(x => Math.abs(x.dx) < 1 && Math.abs(x.dy - 30) < 1 && x.n === 12));
  assert.ok(s.some(x => Math.abs(x.dx) < 1 && Math.abs(x.dy) < 1 && x.n === 8));
});

test('図が用紙の中で動いただけなら「移動」に出さず、本当の書き換えだけを出す', () => {
  const before = sheet(0, [{ text: 'W1600', x: 400, y: 330, w: 30, h: 8 }]);
  const after = sheet(30, [{ text: 'W1650', x: 400, y: 360, w: 30, h: 8 }]);
  const d = diffPdf(before, after);
  assert.equal(d.filter(x => x.type === 'moved').length, 0);
  assert.deepEqual(d.map(x => `${x.type}:${x.before}>${x.after}`), ['changed:W1600>W1650']);
});

test('数件だけ動いた文字は、図の移動とみなさず「移動」として出す', () => {
  const a = sheet(0).pages[0].chunks;
  const b = sheet(0).pages[0].chunks.map(c => (c.text === 'WIC' || c.text === 'トイレ' ? { ...c, x: c.x + 200 } : c));
  const d = diffPdf({ kind: 'pdf', pages: [{ page: 1, width: 1191, height: 842, chunks: a }] }, { kind: 'pdf', pages: [{ page: 1, width: 1191, height: 842, chunks: b }] });
  assert.deepEqual(d.filter(x => x.type === 'moved').map(x => x.before).sort(), ['WIC', 'トイレ'].sort());
});

test('ページの対応（pagematch の結果）があれば、その組どうしで文字をくらべ、増えた・なくなったページも出す', () => {
  const page = (n, chunks) => ({ page: n, width: 1191, height: 842, chunks });
  const plan = [{ text: '平面図', x: 1000, y: 800, w: 30, h: 8 }, ...['LDK', '洋室1', '洋室2', '浴室', '洗面所', 'トイレ', '玄関'].map((text, i) => ({ text, x: 100 + i * 50, y: 100, w: 20, h: 8 }))];
  const elev = [{ text: '立面図', x: 1000, y: 800, w: 30, h: 8 }, ...['南側', '北側', '東側', '西側', 'GL', '1FL', '軒高', '最高高さ'].map((text, i) => ({ text, x: 100 + i * 50, y: 300, w: 20, h: 8 }))];
  const before = { kind: 'pdf', pages: [page(1, plan), page(2, elev)] };
  const plan2 = plan.map(c => (c.text === '洋室2' ? { ...c, text: '洋室3' } : c));
  const after = { kind: 'pdf', pages: [page(1, elev), page(2, plan2), page(3, [{ text: '断面図', x: 1000, y: 800, w: 30, h: 8 }])] };
  const map = { pairs: [{ a: 1, b: 2, by: '図面名' }, { a: 2, b: 1, by: '図面名' }], added: [3], removed: [], titleB: { 3: '断面図' } };
  const d = diffPdf(before, after, map);
  assert.deepEqual(d.filter(x => !x.whole).map(x => `${x.type}:${x.before}>${x.after}@${x.pageA}→${x.page}`), ['changed:洋室2>洋室3@1→2']);
  assert.ok(d.some(x => x.whole && x.type === 'added' && x.page === 3 && /断面図/.test(x.title)));
});

test('スキャンを特徴点で組にしたページは、文字の比較をしない', () => {
  const words = ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7', 'H8'].map((text, i) => ({ text, x: 10 * i, y: 10, w: 5, h: 5 }));
  const before = { kind: 'pdf', pages: [{ page: 1, width: 1191, height: 842, chunks: words }] };
  const after = { kind: 'pdf', pages: [{ page: 1, width: 1191, height: 842, chunks: words.slice(0, 4) }] };
  assert.equal(diffPdf(before, after, { pairs: [{ a: 1, b: 1, by: '特徴点' }], added: [], removed: [] }).length, 0);
});
