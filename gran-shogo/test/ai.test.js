// AI照合の「根拠の確かめ」部分のテスト（APIは呼ばない）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, docToText } from '../server/ai.js';

const docs = [
  { name: '仕様書.pdf', kind: 'pdf', pages: [{ page: 2, lines: ['サッシ ガラス', 'Low-E複層ガラス（アルゴンガス入り）'] }] },
  { name: '見積.xlsx', kind: 'excel', sheets: [{ name: '見積', rows: [{ n: 5, cells: ['AW1', 'アルミサッシ 単板ガラス', '2'] }] }] },
];

test('資料の文字を、場所つきでAIに渡す形にする', () => {
  assert.match(docToText(docs[0]), /\[p\.2\]/);
  assert.match(docToText(docs[1]), /5行: AW1 \| アルミサッシ 単板ガラス \| 2/);
});

test('根拠の文言が資料にあれば「確認済み」、無ければ要確認に落とす', () => {
  const out = verify([
    { category: '仕様', severity: 'ng', key: 'AW1', title: 'ガラス仕様が違う', message: '', evidence: [
      { doc: '仕様書.pdf', location: 'p.2', quote: 'Low-E複層ガラス' },
      { doc: '見積.xlsx', location: '見積!5行', quote: 'アルミサッシ　単板ガラス' }, // 全角空白でも一致
    ] },
    { category: '品番', severity: 'ng', key: 'X', title: '作り話', message: '', evidence: [
      { doc: '見積.xlsx', location: '見積!9行', quote: 'ZZ-999' },
    ] },
  ], docs);
  assert.equal(out[0].verified, true);
  assert.equal(out[0].severity, 'ng');
  assert.equal(out[1].verified, false);
  assert.equal(out[1].severity, 'check');
  assert.equal(out[1].obs[0].verified, false);
});
