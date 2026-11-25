// 本家（工程FC）と同じアイコン一式を public/ にコピーする。
// 使い方: npm run icons -- "G:\マイドライブ\その他\グランOS"
// （logo.svg・favicon-32.png・sw.js は同梱済み。PNG の大きいサイズだけ足りないので、ここで本家からコピーする）
import { cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2] || 'G:\\マイドライブ\\その他\\グランOS';
const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const files = ['logo.svg', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'sw.js'];
let n = 0;
for (const f of files) {
  const p = join(src, f);
  if (existsSync(p)) { cpSync(p, join(pub, f)); n++; } else console.warn('見つかりません:', p);
}
console.log(`${n}個のアイコンをコピーしました（manifest.webmanifest は資料照合用に書き換え済みのものを使います）`);
