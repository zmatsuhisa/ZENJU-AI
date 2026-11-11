// ブラウザで MARKUP を動かし、結果を JSON に書き出す（先に npm start でサーバーを起動しておく）
// 使い方: node mk-e2e.cjs <out.json> <shot.png> <scan[,scan2]> [base[,base2]|-] [after|-] [mobile]
// 環境変数: URL（既定 http://127.0.0.1:3985） EST=ransac で旧方式、KR/KA は打合せ前なしモードの閾値
const { chromium } = require('playwright');
(async () => {
  const [out, shot, scan, base, after, mobile] = process.argv.slice(2);
  const b = await chromium.launch();
  const p = await b.newPage(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 } : { viewport: { width: 1440, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto((process.env.URL || 'http://127.0.0.1:3985') + '/#markup');
  await p.waitForSelector('#mk-file-scan');
  for (const [k, f] of [['scan', scan], ['base', base], ['after', after]]) {
    if (!f || f === '-') continue;
    await p.setInputFiles('#mk-file-' + k, f.split(','));
    await p.waitForFunction(k => document.querySelector('#mk-drop-' + k)?.classList.contains('filled'), k);
  }
  const t0 = Date.now();
  await p.evaluate(e => { if (e.PAD) globalThis.__mkPad = Number(e.PAD); if (e.INK) globalThis.__mkInk = Number(e.INK); globalThis.__mkOpt = { est: e.EST, kr: e.KR ? Number(e.KR) : undefined, ka: e.KA ? Number(e.KA) : undefined }; }, { PAD: process.env.PAD, INK: process.env.INK, EST: process.env.EST, KR: process.env.KR, KA: process.env.KA });
  await p.click('#mk-run');
  let last = '';
  const iv = setInterval(async () => { try { const t = await p.textContent('#mk-msg'); if (t !== last) { last = t; console.log(Math.round((Date.now()-t0)/1000)+'s', t); } } catch {} }, 1000);
  await p.waitForSelector('#mk-result .summary', { timeout: 900000 });
  clearInterval(iv);
  const res = await p.evaluate(() => __mkResult.pages.map(pg => ({ p: pg.scanPage, si: pg.scanIdx, st: pg.status, rf: pg.refFile, ae: pg.alignErr, ref: pg.refPage, af: pg.afterPage, inl: pg.inliers,
    items: pg.items.map(i => ({ no: i.no, box: i.box, judge: i.judge, ink: i.ink, change: i.change, marker: i.marker, words: i.words, later: i.later, feat: i.feat })), others: pg.others.map(o => ({ box: o.box, change: o.change, words: o.words })) })));
  require('fs').writeFileSync(out, JSON.stringify(res));
  console.log('prof', JSON.stringify(await p.evaluate(() => __mkResult.prof)));
  console.log('sec', Math.round((Date.now() - t0) / 1000), 'errors', errs);
  for (const r of res) console.log(`${r.si ?? ''}:p.${r.p} ${r.st} ref${r.ref ?? '-'}/${r.rf ?? '-'} af${r.af ?? '-'} inl${r.inl ?? '-'} items ${r.items.length} [${r.items.map(i => i.judge).join(',')}] others ${r.others.length}`);
  await p.screenshot({ path: shot, fullPage: false });
  // スクロールして一覧も
  await p.evaluate(() => document.querySelector('#mk-list')?.scrollIntoView());
  await p.screenshot({ path: shot.replace('.png', '_list.png') });
  await b.close();
})();
