// まとめて保存（zip）と、「文字の位置だけ動いた」の見分けのテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, makeZip } from '../public/js/core/zip.js';
import { movedWords } from '../public/js/overlay.js';

test('zip：日本語の名前のファイルを入れて、ふつうの zip として読める', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const files = [{ name: '01_新しい版p1.jpg', data: new Uint8Array([1, 2, 3]) }, { name: '02_新しい版p2.jpg', data: new Uint8Array(1000).fill(7) }];
  const path = join(mkdtempSync(join(tmpdir(), 'zip-')), 'a.zip');
  writeFileSync(path, makeZip(files));
  const out = execFileSync('python3', ['-I', '-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print("|".join(f"{i.filename}:{i.file_size}" for i in z.infolist()))', path]).toString().trim();
  assert.equal(out, '01_新しい版p1.jpg:3|02_新しい版p2.jpg:1000');
});

test('同じ文字が少し動いたものだけを「位置だけ変わった文字」にする', () => {
  const a = [{ text: '室外機', x: 100, y: 100 }, { text: 'LDK', x: 300, y: 300 }, { text: '洋室', x: 500, y: 100 }, { text: '洋室', x: 600, y: 100 }, { text: '浴室', x: 50, y: 50 }];
  const b = [{ text: '室外機', x: 130, y: 100 }, { text: 'LDK', x: 300, y: 300 }, { text: '洋室', x: 520, y: 100 }, { text: '洋室', x: 610, y: 100 }, { text: '浴室', x: 900, y: 50 }];
  // 動かない LDK・2つある洋室・遠くへ動いた浴室は入れない
  assert.deepEqual(movedWords({ a, b }, 1800).map(([x]) => x.text), ['室外機']);
});
