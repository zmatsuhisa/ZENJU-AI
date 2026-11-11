// ホーム画面アプリとして入れるためだけの最小のService Worker。
// 中身はキャッシュせず素通し（データは常に最新を取りに行く）
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
