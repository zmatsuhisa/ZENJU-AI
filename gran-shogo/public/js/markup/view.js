// 画面：書き込みの洗い出し（#markup）
// 打合せで図面に手書きした修正指示を見つけ、打合せ後の図面に反映されたかを確かめる。
// 画像の処理はすべてこのブラウザの中（opencv.js）。資料は外に送らない。
import { loadCv, analyze } from './engine.js';

const JUDGE = {
  ok: ['反映あり', 'chip-green', '#2f9e44'],
  ng: ['未反映の疑い', 'chip-red', '#e03131'],
  wait: ['確認待ち', 'chip-orange', '#f08c00'],
  memo: ['メモ・確認印？', 'chip-gray', '#868e96'],
  other: ['指示外の変更', 'chip-orange', '#f76707'],
};
const st = { files: { scan: null, base: null, after: null }, result: null, page: 1, filter: 'all', hideDone: false, marks: {}, running: false };
let ctx; // app.js から渡される道具（pdfjs・見出し・トースト など）

export function showMarkup(c) {
  ctx = c;
  const { app, phead } = c;
  app.innerHTML = `
    ${phead('Markup', '書き込みの洗い出し', '打合せで図面に手書きした修正指示（スキャンしたPDF）を探し出し、打合せ後の図面に反映されたかを確かめます。画像の処理はこのブラウザの中だけで行い、資料を外へ送りません。')}
    <section class="card section no-print">
      <div class="section-h"><span class="t">図面を入れる</span><span class="prog">スキャンだけでも動きます</span></div>
      <div class="mode-body">
        <div class="mk-drops">
          ${drop('scan', 'SCAN', '手書きのスキャン', '必須：打合せで書き込んだ図面をスキャンしたPDF。打合せ何回分でもまとめて入れられます')}
          ${drop('base', 'BEFORE', '打合せ前の版', 'おすすめ：打合せで印刷した元のPDF（CAD出力）。どの版を印刷したか分からなければ候補を複数入れてください')}
          ${drop('after', 'AFTER', '打合せ後の版・最新の図面', '任意：修正したあとのPDF。最新の図面を入れると、これまでの指示が全部入っているかを確かめます')}
        </div>
        <p class="lead mk-lead">${modeNote()}</p>
        <div class="actions"><button class="btn-primary" id="mk-run" type="button" ${st.files.scan?.length && !st.running ? '' : 'disabled'}>書き込みを洗い出す</button>
          ${st.files.scan || st.files.base || st.files.after ? '<button class="btn btn-sm" id="mk-clear" type="button">入れ直す</button>' : ''}
          <span class="small muted" id="mk-msg"></span></div>
        <div class="mk-progress" id="mk-progress" hidden><i></i></div>
      </div>
    </section>
    <div id="mk-result"></div>`;
  for (const k of ['scan', 'base', 'after']) ctx.bindDrop(`#mk-drop-${k}`, `#mk-file-${k}`, files => { st.files[k] = k === 'after' ? files[0] : files; st.result = null; showMarkup(ctx); });
  app.querySelector('#mk-run').onclick = run;
  const clr = app.querySelector('#mk-clear');
  if (clr) clr.onclick = () => { st.files = { scan: null, base: null, after: null }; st.result = null; showMarkup(ctx); };
  if (st.result) renderResult();
}

function drop(k, en, label, sub) {
  const f = st.files[k], names = Array.isArray(f) ? f.map(x => x.name) : f ? [f.name] : [];
  return `<label class="drop ${names.length ? 'filled' : ''}" id="mk-drop-${k}">
    <input type="file" id="mk-file-${k}" accept=".pdf,application/pdf" ${k !== 'after' ? 'multiple' : ''}>
    <span class="k">${en}</span>
    ${names.length ? `<span class="fname">${names.map(n => ctx.h(n)).join('<br>')}</span><span>押すと選び直せます${k === 'base' && names.length > 1 ? '（ページごとに一番合う版を使います）' : ''}${k === 'scan' && names.length > 1 ? `（${names.length}回分をまとめて確かめます）` : ''}</span>` : `<b>${label}</b><span>${sub}</span>`}
  </label>`;
}

function modeNote() {
  const { after } = st.files, base = st.files.base?.length;
  if ((st.files.scan?.length || 0) > 1 && after) return `スキャン${st.files.scan.length}回分をまとめて、指示が「${after.name}」に入っているかを確かめます。後の打合せで同じ場所にまた書き込みがあるものには印を付けます。`;
  if (base && after) return '3つそろっています：手書きを見つけ、その場所で図面が変わったか（反映）と、書き込みのない所の変更（指示外の変更）まで確かめます。';
  if (after) return '打合せ後の版だけのとき：色ペンの書き込みを見つけ、スキャンと新しい版の切り抜きを並べます。反映の自動判定には打合せ前の版が必要です（どの版を印刷したか分からなければ、古い版をまとめて候補に入れてください）。';
  if (base) return '打合せ前の版だけのとき：色ペン・黒ペンの書き込みを見つけます。反映の判定には打合せ後の版を入れてください。';
  return 'スキャンだけのとき：色ペンの書き込みを探します。図面にもともと色がある所（電気図の赤線など）と見分けるには、打合せ前の版を入れてください。';
}

async function run() {
  const { pdfjs, PDF_OPTS, toast } = ctx;
  const btn = document.querySelector('#mk-run'), msg = document.querySelector('#mk-msg'), bar = document.querySelector('#mk-progress');
  st.running = true; btn.disabled = true; bar.hidden = false;
  const say = (t, r) => { if (globalThis.__mkDebug) console.log('view', t); msg.textContent = t; if (r != null) bar.firstElementChild.style.width = `${Math.round(r * 100)}%`; };
  try {
    say('画像処理の部品を準備しています（初回は 10MB ほど読み込みます）', 0.02);
    const { cv } = await loadCv(ctx.cvSrc);
    const open = f => (f ? pdfjs.getDocument({ data: new Uint8Array(f.buf.slice(0)), ...PDF_OPTS }).promise : null);
    const baseFiles = st.files.base || [], scanFiles = st.files.scan || [];
    const [afterPdf, ...basePdf] = await Promise.all([open(st.files.after), ...baseFiles.map(open)]);
    const t0 = performance.now();
    // 打合せ何回分でも、1回分ずつ洗い出してつなげる
    const result = { pages: [], mode: null };
    for (const [k, f] of scanFiles.entries()) {
      const scanPdf = await open(f);
      const pre = scanFiles.length > 1 ? `${k + 1}/${scanFiles.length}回目（${f.name}）：` : '';
      const r = await analyze(cv, { scanPdf, basePdf, afterPdf, onProgress: (t, x) => say(pre + t, x == null ? null : (k + x) / scanFiles.length) });
      result.mode = r.mode; result.prof = r.prof;
      for (const p of r.pages) { p.scanIdx = k; p.scanName = f.name; p.key = `${k}_${p.scanPage}`; result.pages.push(p); }
    }
    result.pages.forEach((p, i) => { p.seq = i + 1; });
    markLater(result.pages, scanFiles.length);
    result.names = { scan: scanFiles.map(f => f.name).join('・'), scans: scanFiles.map(f => f.name), base: baseFiles.map(f => f.name).join('・') || null, bases: baseFiles.map(f => f.name), after: st.files.after?.name };
    result.sec = Math.round((performance.now() - t0) / 1000);
    st.result = result; st.filter = 'all';
    globalThis.__mkResult = result; // 動作確認用（中身はこのブラウザの中だけ）
    st.marks = loadMarks();
    const firstWith = result.pages.find(p => p.items.length || p.others.length);
    st.page = firstWith ? firstWith.seq : 1;
    say(`${result.sec}秒で終わりました`, 1);
    renderResult();
    document.querySelector('#mk-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    console.error(e);
    say('');
    toast(e.message || '処理できませんでした');
  } finally {
    st.running = false; btn.disabled = !st.files.scan?.length; bar.hidden = true;
  }
}

// ---------- 確認済み・指示ではない（このブラウザに残す） ----------
const markKey = () => 'gran-shogo:markup:' + (st.result?.names.scan || '');
function loadMarks() { try { return JSON.parse(localStorage.getItem(markKey()) || '{}'); } catch { return {}; } }
function saveMarks() { try { localStorage.setItem(markKey(), JSON.stringify(st.marks)); } catch { /* 残せなくても動く */ } }
const idOf = (p, it, kind = 'i') => `${p.key}-${kind}${it.no ?? it.box.join('_')}`;
const plabel = p => (st.result.names.scans.length > 1 ? `${p.scanIdx + 1}回目 p.${p.scanPage}` : `p.${p.scanPage}`);

// 後の打合せで同じ場所にまた書き込みがある指示（前の指示が上書きされた可能性）に印を付ける
function markLater(pages, n) {
  if (n < 2) return;
  const tgt = p => p.afterPage ?? p.refPage;
  for (const a of pages) for (const it of a.items) {
    const hit = pages.find(b => b.scanIdx > a.scanIdx && tgt(b) && tgt(b) === tgt(a) && b.items.some(j => overlap(it.box, j.box) > 0.25));
    if (hit) it.later = hit.scanIdx;
  }
}
function overlap([ax, ay, aw, ah], [bx, by, bw, bh]) {
  const w = Math.min(ax + aw, bx + bw) - Math.max(ax, bx), h = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  return w > 0 && h > 0 ? (w * h) / Math.min(aw * ah, bw * bh) : 0;
}

// ---------- 結果 ----------
function allEntries() {
  const out = [];
  for (const p of st.result.pages) {
    for (const it of p.items) out.push({ p, it, id: idOf(p, it), judge: it.judge });
    p.others.forEach((o, i) => { o.no = o.no ?? `+${i + 1}`; out.push({ p, it: o, id: idOf(p, o, 'o'), judge: 'other' }); });
  }
  return out;
}
const markOf = e => st.marks[e.id] || '';

function counts() {
  const c = { all: 0, ok: 0, ng: 0, wait: 0, memo: 0, other: 0, done: 0 };
  for (const e of allEntries()) {
    if (markOf(e) === 'notinst') continue;
    if (e.judge !== 'other') c.all++;
    c[e.judge]++;
    if (markOf(e) === 'done') c.done++;
  }
  return c;
}

function renderResult() {
  const el = document.querySelector('#mk-result');
  if (!el || !st.result) return;
  const { h } = ctx, r = st.result, c = counts();
  const trio = r.mode === 'trio', after = r.mode === 'after';
  const nomatch = r.pages.filter(p => p.status === 'nomatch').map(plabel);
  el.innerHTML = `
    <section class="summary mk-summary" aria-label="集計">
      ${stat('all', '書き込み', c.all, '件', `確認済み ${c.done}件`, 'accent')}
      ${trio ? stat('ng', '未反映の疑い', c.ng, '件', '周りの図面が変わっていない', c.ng ? 'alert' : '') : stat('wait', '確認待ち', c.wait, '件', after ? 'スキャンと最新図面を見比べる' : '打合せ後の版で確かめる')}
      ${trio ? stat('ok', '反映あり', c.ok, '件', '周りの図面が変わった') : stat('memo', 'メモ・確認印？', c.memo, '件', '余白の書き込み')}
      ${trio ? stat('other', '指示外の変更', c.other, 'か所', '書き込みのない所の変更') : stat('done', '確認済み', c.done, '件', `全${c.all}件のうち`)}
    </section>
    <p class="small muted mk-files">スキャン：${h(r.names.scan)}${r.names.base ? `　／　打合せ前：${h(r.names.base)}` : ''}${r.names.after ? `　／　打合せ後：${h(r.names.after)}` : ''}　（${r.sec}秒）
      ${nomatch.length ? `<br>合う図面のページがなかったページ：${nomatch.join('・')}（表紙・仕様書・カタログなど）` : ''}</p>
    ${mismatchNote(r)}
    <div class="tools no-print">
      <button class="btn btn-sm" id="mk-copy" type="button">一覧をコピー</button>
      <label class="opt mk-opt"><input type="checkbox" id="mk-hide" ${st.hideDone ? 'checked' : ''}><span>確認済み・指示ではないものを隠す</span></label>
    </div>
    <section class="card section">
      <div class="section-h"><span class="t">ページ</span><span class="prog" id="mk-pinfo"></span></div>
      <div class="pager no-print">
        <button class="pg-arrow" type="button" data-go="-1" aria-label="前のページ">‹</button>
        <div class="pg-strip" id="mk-strip" role="group" aria-label="ページ"></div>
        <button class="pg-arrow" type="button" data-go="1" aria-label="次のページ">›</button>
      </div>
      <div class="pad legend no-print">
        <span><i style="background:#198c3c"></i>見つけた手書き</span>
        <span><i style="border:2px solid ${JUDGE.ok[2]}"></i>反映あり</span><span><i style="border:2px solid ${JUDGE.ng[2]}"></i>未反映の疑い</span>
        <span><i style="border:2px solid ${JUDGE.wait[2]}"></i>確認待ち</span><span><i style="border:2px solid ${JUDGE.memo[2]}"></i>メモ・確認印？</span>
        ${trio ? `<span><i style="border:2px dashed ${JUDGE.other[2]}"></i>指示外の変更</span>` : ''}
      </div>
      <div class="overlay-wrap mk-view" id="mk-view"></div>
    </section>
    <div id="mk-list"></div>`;
  el.querySelectorAll('.summary .stat').forEach(b => b.onclick = () => { st.filter = st.filter === b.dataset.f ? 'all' : b.dataset.f; renderResult(); });
  el.querySelectorAll('.summary .stat').forEach(b => b.classList.toggle('on', b.dataset.f === st.filter && st.filter !== 'all'));
  el.querySelector('#mk-hide').onchange = e => { st.hideDone = e.target.checked; renderPage(); };
  el.querySelector('#mk-copy').onclick = copyList;
  el.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(st.page + Number(b.dataset.go)));
  el.querySelector('#mk-strip').onclick = e => { const b = e.target.closest('[data-p]'); if (b) go(Number(b.dataset.p)); };
  renderPage();
}

// 未反映の疑いが多いときの案内（打合せ前の版の取り違えがいちばん多い原因）
function mismatchNote(r) {
  if (r.mode !== 'trio') return '';
  const items = r.pages.flatMap(p => p.items).filter(i => i.judge === 'ok' || i.judge === 'ng');
  const ng = items.filter(i => i.judge === 'ng').length;
  if (items.length < 4 || ng / items.length < 0.5) return '';
  return `<div class="card mk-warn"><b>未反映の疑いが多めです。「打合せ前の版」は、打合せで印刷した版ですか？</b>
    スキャンの図面枠の日付と、打合せ前の版の日付を見比べてください。打合せ前の版がすでに修正を含んでいると、直した指示も「未反映の疑い」に出ます。
    どの版を印刷したか分からないときは、古い版（OLDフォルダなど）をまとめて「打合せ前の版」に入れてください。ページごとに一番合う版を自動で選びます。</div>`;
}

function stat(f, k, n, u, l, cls = '') {
  return `<button type="button" class="card stat ${cls}" data-f="${f}"><span class="k">${k}</span><span class="n">${n}<span class="u">${u}</span></span><span class="l">${l}</span></button>`;
}

function shown(e) {
  const m = markOf(e);
  if (st.hideDone && m) return false;
  if (st.filter === 'all') return true;
  if (st.filter === 'done') return m === 'done';
  return e.judge === st.filter && m !== 'notinst';
}

function go(p) {
  const n = st.result.pages.length;
  if (p < 1 || p > n) return;
  st.page = p; renderPage();
}

function renderStrip() {
  const strip = document.querySelector('#mk-strip');
  const entries = allEntries();
  strip.innerHTML = st.result.pages.map(p => {
    const n = entries.filter(e => e.p === p && shown(e) && markOf(e) !== 'notinst').length;
    const on = p.seq === st.page;
    const lab = p.status === 'nomatch' ? '—' : n || '';
    return `<button type="button" class="pg ${on ? 'on' : ''} ${n ? 'has' : ''} ${p.status === 'nomatch' ? 'mk-nm' : ''}" data-p="${p.seq}" ${on ? 'aria-current="page"' : ''} title="${ctx.h(p.scanName)}"
      aria-label="${plabel(p)}${p.status === 'nomatch' ? '（合う図面なし）' : n ? `（${n}件）` : ''}">${plabel(p)}${lab !== '' ? `<i>${lab}</i>` : ''}</button>`;
  }).join('');
  const on = strip.querySelector('.pg.on');
  if (on) strip.scrollTo({ left: on.offsetLeft - strip.clientWidth / 2 + on.offsetWidth / 2, behavior: 'auto' });
  document.querySelectorAll('#mk-result [data-go]').forEach(b => { b.disabled = b.dataset.go === '-1' ? st.page <= 1 : st.page >= st.result.pages.length; });
}

function renderPage() {
  const { h } = ctx;
  renderStrip();
  const p = st.result.pages[st.page - 1], view = document.querySelector('#mk-view'), list = document.querySelector('#mk-list');
  const info = document.querySelector('#mk-pinfo');
  if (p.status === 'nomatch') {
    info.textContent = `${plabel(p)}：合う図面のページがありません`;
    view.replaceChildren(p.thumb);
    list.innerHTML = `<div class="card empty"><b>このページに合う図面のページが見つかりませんでした</b>表紙・仕様書・カタログなど図面でないページか、入れた版にないページです。書き込みは目で確認してください。</div>`;
    return;
  }
  const bn = st.result.names.bases || [];
  info.textContent = `${plabel(p)}${p.refPage ? ` → ${bn.length ? `打合せ前${bn.length > 1 ? `（${bn[p.refFile]}）` : ''}` : '打合せ後'} p.${p.refPage}` : ''}${p.afterPage ? `／打合せ後 p.${p.afterPage}` : ''}`;
  const ae = p.alignErr?.scanToRef;
  if (ae != null) info.textContent += `　位置合わせのずれ ${ae}px`;
  view.replaceChildren(p.view.canvas);
  if (ae != null && ae > 3) view.insertAdjacentHTML('afterbegin', `<div class="mk-warn" style="margin:0;border-radius:0">このページは位置合わせが甘い可能性があります（ずれ ${ae}px）。スキャンの傾き・ゆがみが大きいと、判定がずれます。</div>`);
  p.view.canvas.onclick = ev => {
    const r = p.view.canvas.getBoundingClientRect(), k = p.view.canvas.width / r.width / p.view.scale;
    const x = (ev.clientX - r.left) * k, y = (ev.clientY - r.top) * k;
    const hit = [...p.items, ...p.others].find(it => x >= it.box[0] && x <= it.box[0] + it.box[2] && y >= it.box[1] && y <= it.box[1] + it.box[3]);
    if (hit) document.getElementById('mk-' + (p.items.includes(hit) ? idOf(p, hit) : idOf(p, hit, 'o')))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const entries = allEntries().filter(e => e.p === p && shown(e));
  if (!entries.length) {
    list.innerHTML = `<div class="card empty"><b>${p.items.length || p.others.length ? '条件に合う書き込みはありません' : 'このページに書き込みは見つかりませんでした'}</b>${p.items.length ? '絞り込み・「隠す」を外すと表示されます。' : '薄い鉛筆や、図面の線に重なった黒ペンは見落とすことがあります。'}</div>`;
    return;
  }
  const mode = st.result.mode;
  list.innerHTML = '<div class="mk-grid">' + entries.map(e => {
    const m = markOf(e), j = JUDGE[e.judge];
    const label = m === 'notinst' ? ['指示ではない', 'chip-gray'] : m === 'done' ? ['確認済み', 'chip-gray'] : j;
    return `<article class="card mk-item ${m ? 'done' : ''}" id="mk-${e.id}">
      <div class="row1"><span class="mk-no" style="background:${j[2]}">${h(String(e.it.no))}</span>
        <div class="who"><div class="pname">${plabel(p)}　${e.judge === 'other' ? '指示外の変更' : `書き込み ${h(String(e.it.no))}`}</div><div class="paddr">${h(reason(e, mode))}</div></div>
        <span class="chip ${label[1]}">${label[0]}</span></div>
      ${wordsLine(e.it.words)}
      ${e.it.later != null ? `<div class="note-pill">${e.it.later + 1}回目の打合せでも同じ場所に書き込みがあります。後の指示で変わっていないか確かめてください</div>` : ''}
      <div class="mk-crops" data-id="${e.id}"></div>
      <div class="mk-act no-print">
        <button class="btn btn-sm ${m === 'done' ? 'on' : ''}" type="button" data-act="done" data-id="${e.id}">${m === 'done' ? '✓ 確認済み' : '確認済みにする'}</button>
        ${e.judge !== 'other' ? `<button class="btn btn-sm ${m === 'notinst' ? 'on' : ''}" type="button" data-act="notinst" data-id="${e.id}">${m === 'notinst' ? '指示ではない（戻す）' : '指示ではない'}</button>` : ''}
      </div>
    </article>`;
  }).join('') + '</div>';
  for (const e of entries) {
    const box = list.querySelector(`.mk-crops[data-id="${e.id}"]`), cr = e.it.crops;
    const figs = [['スキャン', cr.scan], ['打合せ前', cr.base], ['打合せ後', cr.after]].filter(x => x[1]);
    for (const [t, c] of figs) {
      const f = document.createElement('figure'); const cap = document.createElement('figcaption'); cap.textContent = t;
      f.append(cap, c); box.append(f);
    }
    box.style.setProperty('--n', figs.length);
  }
  list.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    const id = b.dataset.id, a = b.dataset.act;
    st.marks[id] = st.marks[id] === a ? '' : a;
    if (!st.marks[id]) delete st.marks[id];
    saveMarks();
    const y = window.scrollY;
    renderResult();
    window.scrollTo(0, y);
  });
}

// 周りで変わった文字（CAD の文字データから）
function wordsLine(w) {
  if (!w || (!w.gone.length && !w.came.length)) return '';
  const { h } = ctx;
  return `<div class="vals mk-words">変わった文字 ${w.gone.map(t => `<span class="del"><b>${h(t)}</b></span>`).join('')}${w.gone.length && w.came.length ? '<span>→</span>' : ''}${w.came.map(t => `<span class="hl"><b>${h(t)}</b></span>`).join('')}</div>`;
}

function reason(e, mode) {
  if (e.judge === 'other') return '書き込みのない所で図面が変わっています。意図した変更か確かめてください';
  if (e.judge === 'memo') return '余白の書き込みです（確認印・日付・メモの可能性）';
  if (e.judge === 'wait') return mode === 'base' || mode === 'scan' ? '打合せ後の版を入れると、反映されたかを判定します'
    : mode === 'after' ? '打合せ前の版がないため、反映は自動で判定しません。スキャンと最新図面を見比べてください' : '打合せ後の版に合うページがありません';
  if (e.judge === 'ok') return mode === 'trio' ? '書き込みの周りで図面が変わっています（反映済みと思われます）' : 'スキャンと打合せ後の版で、周りの線が変わっています（参考）';
  return mode === 'trio' ? '書き込みの周りで図面が変わっていません。反映漏れでないか確かめてください' : 'スキャンと打合せ後の版で、周りの線が変わっていません。反映漏れでないか確かめてください';
}

async function copyList() {
  const rows = [['スキャン', 'ページ', '番号', '判定', '状態', '変わった文字', '横位置(%)', '縦位置(%)']];
  for (const e of allEntries()) {
    const [x, y, w, hh] = e.it.box, [W, H] = e.p.size;
    const wd = e.it.words || { gone: [], came: [] };
    rows.push([e.p.scanName, `p.${e.p.scanPage}`, e.it.no, JUDGE[e.judge][0], { done: '確認済み', notinst: '指示ではない' }[markOf(e)] || '', [...wd.gone.map(t => "-" + t), ...wd.came.map(t => "+" + t)].join(' '), Math.round((x + w / 2) / W * 100), Math.round((y + hh / 2) / H * 100)]);
  }
  const tsv = rows.map(r => r.join('\t')).join('\n');
  try { await navigator.clipboard.writeText(tsv); ctx.toast('一覧をコピーしました（Excel に貼り付けられます）'); }
  catch {
    const t = document.createElement('textarea'); t.value = tsv; document.body.append(t); t.select();
    try { document.execCommand('copy'); ctx.toast('一覧をコピーしました'); } catch { ctx.toast('コピーできませんでした'); }
    t.remove();
  }
}

// ← → でページ送り（入力欄にいるときは除く）
document.addEventListener('keydown', e => {
  if (!st.result || !location.hash.startsWith('#markup') || e.target.closest?.('input,textarea,select')) return;
  if (e.key === 'ArrowLeft') go(st.page - 1);
  if (e.key === 'ArrowRight') go(st.page + 1);
});
