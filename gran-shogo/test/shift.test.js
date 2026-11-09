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
