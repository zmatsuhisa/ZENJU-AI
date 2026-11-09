// 資料照合の画面。#check（照合する）・#run-<id>（結果）・#item-<id>-<指摘>（詳細）・#history（記録）
// claude.ai の Artifact でも動くよう、画面の切り替えは「#英数字」だけで表す
import * as pdfjs from '../vendor/pdf.min.mjs';
import * as XLSX from '../vendor/xlsx.mjs';
import { readPdf, readXlsx } from './core/readers.js';
import { diffPdf, diffXlsx } from './core/diff.js';
import { crossCheck, guessRole, changesToFindings, ROLES } from './core/check.js';
import { escapeHtml as h } from './core/normalize.js';
import { renderPage, compose } from './overlay.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = { cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href, cMapPacked: true, standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href };

const $ = s => document.querySelector(s);
const app = $('#app');
const state = {
  config: { ai: false },
  pair: { old: null, new: null },     // 新旧比較の2ファイル { name, buf }
  multi: [],                          // 資料間の照合 [{ name, buf, kind, role }]
  useAi: false,
  session: {},                        // 今の画面で読み込んだ資料（重ね合わせ用。記録には残さない）
  run: null,                          // 表示中の照合結果
  view: load('view', 'card'), filter: 'all', q: '', sort: 'sev',
};

// ---------- 起動 ----------
// サーバー（server.js）があれば記録はサーバーへ。無ければ（claude.ai の Artifact など）このブラウザの中に残す
let LOCAL = false;
fetch('api/config')
  .then(r => (r.ok ? r.json() : Promise.reject(new Error('no server'))))
  .then(c => { if (!c || !c.version) throw new Error('no server'); state.config = c; })
  .catch(() => { LOCAL = true; state.config = { ai: false, local: true }; })
  .finally(route);
window.addEventListener('hashchange', route);

const api = {
  async list() {
    if (!LOCAL) return (await fetch('api/runs')).json();
    return localRuns().map(({ findings, ...r }) => ({ ...r, counts: countOf(findings, r.confirmed) }));
  },
  async get(id) {
    if (!LOCAL) { const r = await fetch('api/runs/' + id); if (!r.ok) throw new Error('記録が見つかりません'); return r.json(); }
    const r = localRuns().find(x => x.id === id);
    if (!r) throw new Error('記録が見つかりません（このブラウザに残っていません）');
    return structuredClone(r);
  },
  async save(run) {
    if (!LOCAL) {
      const r = await fetch('api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(run) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || '記録できませんでした'); return j.id;
    }
    const id = Math.random().toString(16).slice(2, 10);
    const runs = localRuns();
    runs.unshift({ id, at: new Date().toISOString(), ...run, confirmed: {} });
    localSave(runs.slice(0, 50));
    return id;
  },
  async patch(id, body) {
    if (!LOCAL) {
      const r = await fetch(`api/runs/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || '保存できませんでした'); return j.confirmed;
    }
    const runs = localRuns(); const r = runs.find(x => x.id === id);
    if (!r) throw new Error('記録が見つかりません');
    if (body.confirmed) r.confirmed[body.findingId] = { at: new Date().toISOString(), note: String(body.note || '').slice(0, 500) };
    else delete r.confirmed[body.findingId];
    localSave(runs);
    return r.confirmed;
  },
};
const memRuns = [];
function localRuns() { try { const s = localStorage.getItem('gran-shogo:runs'); if (s) return JSON.parse(s); } catch { /* 使えない環境ではメモリだけ */ } return memRuns; }
function localSave(runs) { memRuns.splice(0, memRuns.length, ...runs); try { localStorage.setItem('gran-shogo:runs', JSON.stringify(runs)); } catch { /* 容量オーバーなど。メモリには残る */ } }
function countOf(findings = [], confirmed = {}) {
  const c = { ng: 0, check: 0, change: 0, done: 0, total: findings.length };
  for (const f of findings) {
    if (confirmed[f.id]) c.done++; else if (f.severity === 'ng') c.ng++; else if (f.severity === 'check') c.check++; else c.change++;
  }
  return c;
}

function route() {
  // #check / #result / #history / #run-<記録> / #item-<記録>-<指摘>
  const hash = location.hash || '#check';
  const m = hash.match(/^#(\w+)(?:-(\w+))?(?:-(\w+))?/) || [];
  const page = m[1] === 'check' ? '' : (m[1] || '');
  document.querySelectorAll('.nav a').forEach(a => {
    const on = a.dataset.nav === ({ '': 'check', run: 'result', result: 'result', item: 'result', history: 'history' }[page]);
    a.classList.toggle('active', on);
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  });
  $('#menu-button').hidden = !['run', 'result', 'item'].includes(page);
  if (page === 'run' && m[2]) return showRun(m[2]);
  if (page === 'item' && m[2] && m[3]) return showItem(m[2], m[3]);
  if (page === 'result') return state.run ? (location.hash = `#run-${state.run.id}`) : showLatest();
  if (page === 'history') return showHistory();
  return showCheck();
}

// ---------- 照合する ----------
function showCheck() {
  const ai = state.config.ai;
  app.innerHTML = `
    ${phead('Check', '資料を照合する', '図面・仕様書（PDF）と建具表・見積（Excel）を読み込み、変更箇所と資料どうしの食い違いを探します。資料はこのPCの中で読み、外には送りません。')}
    <div class="modes">
      <section class="card section">
        <div class="section-h"><span class="t">新旧比較</span><span class="prog">同じ資料の変更前と変更後</span></div>
        <div class="mode-body">
          <p class="lead">平面図・仕様書・見積書などの「前の版」と「新しい版」を比べ、変わった文字・数量・金額・数式と、図面の線の違いを出します。</p>
          <div class="pair">
            ${dropBox('old', '変更前', state.pair.old)}
            <span class="arrow" aria-hidden="true">→</span>
            ${dropBox('new', '変更後', state.pair.new)}
          </div>
          <div class="actions"><button class="btn-primary" id="run-pair" type="button">変更箇所を探す</button><span class="small muted" id="pair-msg"></span></div>
        </div>
      </section>
      <section class="card section">
        <div class="section-h"><span class="t">資料間の照合</span><span class="prog">平面図 × 建具表、仕上表 × 見積 など</span></div>
        <div class="mode-body">
          <p class="lead">記号・品番（AW1、DL-1、AA-101 など）をそろえて、寸法・数量・品番の食い違いと、見積への記載漏れを探します。</p>
          <label class="drop" id="drop-multi">
            <input type="file" id="file-multi" multiple accept=".pdf,.xlsx,.xlsm,.xls,.xlsb,.csv">
            <b>資料をまとめて置く</b><span>PDF・Excel をここへドラッグ、または押して選ぶ</span>
          </label>
          <ul class="files" id="files">${state.multi.map(fileRow).join('')}</ul>
          <label class="opt"><input type="checkbox" id="use-ai" ${state.useAi && ai ? 'checked' : ''} ${ai ? '' : 'disabled'}>
            <span>AIでも照合する（仕様の反映漏れなど、記号だけでは分からない食い違い）
            <span class="muted">${ai ? '資料の文字を Anthropic社の Claude に送ります。施主名・金額を含む資料は社内の決まりを確認してから。1〜3分かかります。' : state.config.local ? 'AI照合は社内PCのサーバー版（start.bat）で使えます。この画面ではルール照合だけ動きます。' : 'AI照合は未設定です（サーバーの .env に ANTHROPIC_API_KEY を入れると使えます）。'}</span></span></label>
          <div class="actions"><button class="btn-primary" id="run-multi" type="button">食い違いを探す</button><span class="small muted" id="multi-msg"></span></div>
        </div>
      </section>
    </div>
    <p class="hint">はじめての方は <a href="#check" id="try-sample">架空のサンプル資料で試す</a>（平面図・建具表・仕上表・見積に、食い違いを4つ仕込んであります）</p>`;

  for (const side of ['old', 'new']) bindDrop(`#drop-${side}`, `#file-${side}`, files => { state.pair[side] = files[0]; showCheck(); });
  bindDrop('#drop-multi', '#file-multi', files => { addMulti(files); showCheck(); });
  $('#files').addEventListener('change', e => { const i = e.target.dataset.i; if (i != null) state.multi[i].role = e.target.value; });
  $('#files').addEventListener('click', e => { const i = e.target.closest('.x')?.dataset.i; if (i != null) { state.multi.splice(i, 1); showCheck(); } });
  $('#use-ai').addEventListener('change', e => { state.useAi = e.target.checked; });
  $('#run-pair').onclick = runPair;
  $('#run-multi').onclick = runMulti;
  $('#try-sample').onclick = e => { e.preventDefault(); loadSamples(); };
  setSync();
}

function dropBox(side, label, f) {
  return `<label class="drop ${f ? 'filled' : ''}" id="drop-${side}">
    <input type="file" id="file-${side}" accept=".pdf,.xlsx,.xlsm,.xls,.xlsb,.csv">
    <span class="k">${side === 'old' ? 'BEFORE' : 'AFTER'}</span>
    ${f ? `<span class="fname">${h(f.name)}</span><span>押すと選び直せます</span>` : `<b>${label}</b><span>PDF か Excel を置く</span>`}
  </label>`;
}

function fileRow(f, i) {
  const opts = Object.entries(ROLES).map(([v, t]) => `<option value="${v}" ${f.role === v ? 'selected' : ''}>${t}</option>`).join('');
  return `<li><span class="chip ${f.kind === 'pdf' ? 'chip-blue' : 'chip-green'}">${f.kind === 'pdf' ? 'PDF' : 'Excel'}</span>
    <span class="fn" title="${h(f.name)}">${h(f.name)}</span>
    <select data-i="${i}" aria-label="${h(f.name)} の種類">${opts}</select>
    <button class="x" type="button" data-i="${i}" aria-label="${h(f.name)} を外す">×</button></li>`;
}

function bindDrop(zoneSel, inputSel, onFiles) {
  const zone = $(zoneSel), input = $(inputSel);
  const take = async list => onFiles(await Promise.all([...list].map(async f => ({ name: f.name, buf: await f.arrayBuffer() }))));
  input.addEventListener('change', () => input.files.length && take(input.files));
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files.length) take(e.dataTransfer.files); });
}

const kindOf = name => (/\.pdf$/i.test(name) ? 'pdf' : 'excel');
function addMulti(files) {
  for (const f of files) {
    const kind = kindOf(f.name);
    const i = state.multi.findIndex(x => x.name === f.name);
    const item = { ...f, kind, role: guessRole(f.name, kind) };
    i >= 0 ? (state.multi[i] = item) : state.multi.push(item);
  }
}

// サンプル資料の配信名（どの環境でも通るよう英数字の名前で置く。server.js も同じ表を持つ）
const SAMPLES = {
  '平面図_旧.pdf': 'plan_old.pdf', '平面図_新.pdf': 'plan_new.pdf', '建具表.xlsx': 'tategu.xlsx',
  '仕上表.xlsx': 'shiage.xlsx', '見積_旧.xlsx': 'estimate_old.xlsx', '見積_新.xlsx': 'estimate_new.xlsx',
};

async function loadSamples() {
  const get = async n => {
    const r = await fetch('samples/' + SAMPLES[n]);
    if (!r.ok) throw new Error(n);
    return { name: n, buf: await r.arrayBuffer() };
  };
  try {
    const [o, n, t, s, e] = await Promise.all(['平面図_旧.pdf', '平面図_新.pdf', '建具表.xlsx', '仕上表.xlsx', '見積_新.xlsx'].map(get));
    state.pair = { old: o, new: n };
    state.multi = [];
    addMulti([n, t, s, e]);
    showCheck();
    toast('サンプル資料を置きました。「食い違いを探す」を押してください');
  } catch { toast('サンプル資料を読めませんでした'); }
}

async function parse(f) {
  const data = new Uint8Array(f.buf.slice(0));
  return kindOf(f.name) === 'pdf' ? readPdf(pdfjs, data, PDF_OPTS) : readXlsx(XLSX, data);
}

async function runPair() {
  const { old: a, new: b } = state.pair;
  const msg = $('#pair-msg');
  if (!a || !b) return (msg.textContent = '変更前と変更後の両方を置いてください');
  if (kindOf(a.name) !== kindOf(b.name)) return (msg.textContent = 'PDF どうし、Excel どうしで比べてください');
  const btn = $('#run-pair');
  busy(btn, true, '比べています');
  try {
    const [da, db] = await Promise.all([parse(a), parse(b)]);
    const kind = da.kind;
    const changes = kind === 'pdf' ? diffPdf(da, db) : diffXlsx(da, db);
    const findings = changesToFindings(changes, a.name, b.name, kind);
    state.session = { mode: 'pair', kind, old: a, new: b };
    await saveRun({ mode: 'pair', title: `${a.name} → ${b.name}`, docs: [{ name: a.name, role: 'old' }, { name: b.name, role: 'new' }], findings });
  } catch (e) {
    console.error(e); msg.textContent = '読み込めませんでした：' + (e.message || e);
  } finally { busy(btn, false, '変更箇所を探す'); }
}

async function runMulti() {
  const msg = $('#multi-msg');
  if (state.multi.length < 2) return (msg.textContent = '資料を2つ以上置いてください');
  const btn = $('#run-multi');
  busy(btn, true, '照合しています');
  try {
    const docs = [];
    for (const f of state.multi) { msg.textContent = `読み込み中：${f.name}`; docs.push({ name: f.name, role: f.role, data: await parse(f) }); }
    msg.textContent = '';
    const { findings } = crossCheck(docs);
    let ai = null;
    if (state.useAi && state.config.ai) {
      busy(btn, true, 'AIが照合しています（1〜3分）');
      try {
        const r = await fetch('api/ai-check', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ docs: docs.map(compact), ruleFindings: findings.map(f => ({ title: f.title, message: f.message })) }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'AI照合に失敗しました');
        findings.push(...j.findings);
        ai = { model: j.model, count: j.findings.length };
      } catch (e) {
        ai = { error: e.message };
        toast('AI照合はできませんでした（ルール照合の結果だけ出します）：' + e.message, 6000);
      }
    }
    state.session = { mode: 'multi', docs: state.multi.slice() };
    const names = state.multi.map(f => f.name);
    await saveRun({ mode: 'multi', title: names.length > 2 ? `${names[0]} ほか${names.length - 1}件` : names.join(' × '),
      docs: state.multi.map(f => ({ name: f.name, role: f.role })), findings, ai });
  } catch (e) {
    console.error(e); msg.textContent = '読み込めませんでした：' + (e.message || e);
  } finally { busy(btn, false, '食い違いを探す'); }
}

// AIへ送る形（文字だけ。位置や画像は送らない）
function compact(d) {
  const base = { name: d.name, roleLabel: ROLES[d.role] || d.role, kind: d.data.kind };
  if (d.data.kind === 'pdf') return { ...base, pages: d.data.pages.map(p => ({ page: p.page, lines: p.chunks.map(c => c.text) })) };
  return { ...base, sheets: d.data.sheets.map(s => ({ name: s.name, rows: s.rows.map((r, i) => ({ n: i + 1, cells: r.map(c => String(c.v ?? '')) })).filter(r => r.cells.some(Boolean)) })) };
}

async function saveRun(run) {
  const id = await api.save(run);
  state.session.runId = id;
  state.filter = 'all'; state.q = '';
  location.hash = `#run-${id}`;
}

// ---------- 照合結果 ----------
async function fetchRun(id) {
  if (state.run?.id === id) return state.run;
  state.run = await api.get(id);
  return state.run;
}

async function showLatest() {
  const list = await api.list();
  if (list.length) location.hash = `#run-${list[0].id}`;
  else { app.innerHTML = phead('Result', '照合結果', 'まだ照合していません。') + `<div class="card empty"><b>結果はまだありません</b><a href="#check">資料を照合する</a></div>`; setSync(); }
}

const SEV = { ng: 0, check: 1, change: 2, info: 3 };
function stateOf(f, run) {
  if (run.confirmed[f.id]) return 'done';
  return f.severity === 'ng' ? 'ng' : f.severity === 'check' ? 'check' : 'change';
}
const CHIP = {
  ng: ['不一致', 'chip-red'], check: ['要確認', 'chip-gray'], change: ['変更', 'chip-orange'], done: ['確認済み', 'chip-green'],
};

async function showRun(id) {
  let run;
  try { run = await fetchRun(id); } catch (e) { app.innerHTML = `<div class="card empty"><b>${h(e.message)}</b><a href="#history">記録を見る</a></div>`; return; }
  const c = { ng: 0, check: 0, change: 0, done: 0 };
  run.findings.forEach(f => c[stateOf(f, run)]++);
  const isPair = run.mode === 'pair';
  const when = fmtTime(run.at);
  const docs = run.docs.map(d => `${h(d.name)}${d.role && ROLES[d.role] ? `（${ROLES[d.role]}）` : ''}`).join('・');
  const aiNote = run.ai?.error ? `<span style="color:var(--red)">AI照合はできませんでした。</span>` : run.ai ? `AIの指摘 ${run.ai.count}件を含みます（青のラベル）。` : '';
  app.innerHTML = `
    ${phead('Result', '照合結果', `${h(run.title)}　<span class="num">${when}</span><br>${docs}。${aiNote} 最終判断は担当者が行ってください。`)}
    <section class="summary" aria-label="集計">
      ${stat('ng', '不一致', c.ng, '件', isPair ? '—' : '寸法・数量・品番の食い違い', c.ng > 0 ? 'alert' : '')}
      ${stat('check', '要確認', c.check, '件', '記載漏れ・根拠を確かめたいもの')}
      ${stat('change', '変更', c.change, '件', '新旧で変わったところ', 'accent')}
      ${stat('done', '確認済み', c.done, '件', `全${run.findings.length}件のうち`)}
    </section>
    <div class="tools no-print">
      <button class="btn btn-sm" id="csv" type="button">${LOCAL ? 'CSVをコピー' : 'CSVで書き出す'}</button>
      ${LOCAL ? '' : '<button class="btn btn-sm" id="print" type="button">報告書を印刷</button>'}
      <a class="btn btn-sm" href="#check">別の資料を照合する</a>
    </div>
    <div id="overlay-slot"></div>
    <div id="list"></div>`;
  app.querySelectorAll('.summary .stat').forEach(b => b.onclick = () => { state.filter = state.filter === b.dataset.f ? 'all' : b.dataset.f; syncSeg(); renderList(); markStats(); });
  $('#csv').onclick = () => downloadCsv(run);
  if ($('#print')) $('#print').onclick = () => window.print();
  markStats();
  renderList();
  setSync(run.at);
  if (isPair && state.session.runId === run.id && state.session.kind === 'pdf') showOverlay();
}

function stat(f, k, n, u, l, cls = '') {
  return `<button type="button" class="card stat ${cls}" data-f="${f}"><span class="k">${k}</span><span class="n">${n}<span class="u">${u}</span></span><span class="l">${l}</span></button>`;
}
function markStats() { app.querySelectorAll('.summary .stat').forEach(b => b.classList.toggle('on', b.dataset.f === state.filter)); }

function visible(run) {
  const q = state.q.trim().toLowerCase();
  let list = run.findings.filter(f => {
    const st = stateOf(f, run);
    if (state.filter === 'ai' && f.source !== 'ai') return false;
    if (!['all', 'ai'].includes(state.filter) && st !== state.filter) return false;
    if (q && !`${f.title} ${f.message} ${f.key} ${f.obs.map(o => o.doc + o.value).join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const by = {
    sev: (a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9) || (run.confirmed[a.id] ? 1 : 0) - (run.confirmed[b.id] ? 1 : 0),
    key: (a, b) => String(a.key).localeCompare(String(b.key), 'ja', { numeric: true }),
    doc: (a, b) => String(a.obs[0]?.doc).localeCompare(String(b.obs[0]?.doc), 'ja') || String(a.obs[0]?.loc).localeCompare(String(b.obs[0]?.loc), 'ja', { numeric: true }),
  }[state.sort];
  return list.slice().sort(by);
}

function renderList() {
  const run = state.run, el = $('#list');
  if (!el || !run) return;
  const list = visible(run);
  if (!run.findings.length) { el.innerHTML = `<div class="card empty"><b>食い違い・変更は見つかりませんでした</b>読み取れた文字の範囲での結果です。スキャンしたPDF（画像だけのPDF）は文字を読めません。</div>`; return; }
  if (!list.length) { el.innerHTML = `<div class="card empty"><b>条件に合う指摘はありません</b>表示設定の絞り込みを外してください。</div>`; return; }
  const link = f => `#item-${run.id}-${f.id}`;
  if (state.view === 'card') {
    el.innerHTML = '<div class="pgrid">' + list.map(f => {
      const st = stateOf(f, run);
      const chip = f.source === 'ai' && st !== 'done' ? ['AI・' + CHIP[st][0], 'chip-blue'] : CHIP[st];
      return `<a class="card pcard ${st === 'done' ? 'done' : ''}" href="${link(f)}">
        <div class="row1"><div class="who"><div class="pname">${h(f.title)}</div><div class="paddr">${h(f.category)}${f.key ? '　' + h(f.key) : ''}${f.name ? '　' + h(f.name) : ''}</div></div><span class="chip ${chip[1]}">${h(chip[0])}</span></div>
        <div class="vals">${f.obs.slice(0, 3).map((o, i) => `<span class="${i > 0 && f.kind !== 'missing' ? 'hl' : ''}">${h(short(o.doc))} <b>${h(clip(o.value, 26))}</b></span>`).join('')}</div>
        <div class="nowph">場所 <b>${h([...new Set(f.obs.map(o => o.loc).filter(l => l && l !== '—'))].slice(0, 2).join('　'))}</b></div>
        ${f.source === 'ai' && !f.verified ? '<div class="note-pill">根拠の文言が資料に見つかりません。原本で確認してください</div>' : ''}
        ${run.confirmed[f.id]?.note ? `<div class="note-pill">${h(run.confirmed[f.id].note)}</div>` : ''}
      </a>`;
    }).join('') + '</div>';
  } else {
    el.innerHTML = `<div class="card plist"><table><thead><tr><th>指摘</th><th>種類</th><th>資料と値</th><th>場所</th><th>状態</th></tr></thead><tbody>` + list.map(f => {
      const st = stateOf(f, run);
      return `<tr class="row" data-href="${link(f)}">
        <td><div class="pname"><a href="${link(f)}">${h(f.title)}</a></div><div class="paddr">${h(f.message)}</div></td>
        <td data-l="種類"><span>${h(f.category)}${f.source === 'ai' ? '（AI）' : ''}</span></td>
        <td data-l="値"><span>${f.obs.map(o => `${h(short(o.doc))} <b class="num">${h(clip(o.value, 30))}</b>`).join('<br>')}</span></td>
        <td data-l="場所"><span>${f.obs.map(o => h(o.loc)).join('<br>')}</span></td>
        <td data-l="状態"><span class="chip ${CHIP[st][1]}">${CHIP[st][0]}</span></td></tr>`;
    }).join('') + '</tbody></table></div>';
    el.querySelectorAll('tr.row').forEach(tr => tr.onclick = e => { if (!e.target.closest('a')) location.hash = tr.dataset.href; });
  }
}

// 図面の重ね合わせ（今この画面で読み込んだ新旧PDFがあるときだけ）
async function showOverlay(pageNo = 1) {
  const slot = $('#overlay-slot');
  if (!slot) return;
  slot.innerHTML = `<section class="card section"><div class="section-h"><span class="t">図面の重ね合わせ</span><span class="prog" id="ov-prog">描いています…</span></div>
    <div class="pad legend no-print"><span><i class="o"></i>変更前だけにある線・文字</span><span><i class="n"></i>変更後だけにある線・文字</span><span><i class="c"></i>変わった場所</span>
    <span class="seg" role="group" aria-label="重ね合わせの表示" style="margin-left:auto"><button type="button" class="on" data-ov="mix" aria-pressed="true">重ね</button><button type="button" data-ov="old" aria-pressed="false">変更前</button><button type="button" data-ov="new" aria-pressed="false">変更後</button></span></div>
    <div class="overlay-wrap" id="ov"></div></section>`;
  try {
    const [pa, pb] = await Promise.all([state.session.old, state.session.new].map(f => pdfjs.getDocument({ data: new Uint8Array(f.buf.slice(0)), ...PDF_OPTS }).promise));
    const width = 1800;
    const [{ canvas: ca }, { canvas: cb, scale }] = await Promise.all([renderPage(pa, pageNo, width), renderPage(pb, Math.min(pageNo, pb.numPages), width)]);
    const { canvas, boxes, shift } = compose(ca, cb);
    // 文字の差分で見つけた場所にも枠（小さな数字の書き換えは線の差だけでは目立たないため）
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#f7890a'; ctx.lineWidth = 3;
    const textBoxes = (state.run?.findings || []).filter(f => f.at && f.at.page === pageNo);
    for (const f of textBoxes) {
      const { x, y, w, h: hh } = f.at;
      ctx.strokeRect((x - 6) * scale, (y - hh - 6) * scale, (w + 12) * scale, (hh + 14) * scale);
    }
    const views = { mix: canvas, old: ca, new: cb };
    const ov = $('#ov');
    ov.replaceChildren(canvas);
    const pages = Math.max(pa.numPages, pb.numPages);
    const pick = pages > 1 ? ` <select class="pick" id="ov-page" aria-label="ページ">${Array.from({ length: pages }, (_, i) => `<option value="${i + 1}" ${i + 1 === pageNo ? 'selected' : ''}>p.${i + 1}</option>`).join('')}</select>` : '';
    $('#ov-prog').innerHTML = `p.${pageNo}　線の違い ${boxes.length}か所・文字の違い ${textBoxes.length}か所${shift.dx || shift.dy ? `（位置ずれ ${shift.dx}, ${shift.dy}px を補正）` : ''}${pick}`;
    $('#ov-page')?.addEventListener('change', e => showOverlay(Number(e.target.value)));
    slot.querySelectorAll('[data-ov]').forEach(b => b.onclick = () => {
      slot.querySelectorAll('[data-ov]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      ov.replaceChildren(views[b.dataset.ov]);
    });
  } catch (e) {
    console.error(e);
    $('#ov-prog').textContent = '重ね合わせを描けませんでした';
  }
}

// ---------- 指摘の詳細 ----------
async function showItem(runId, fid) {
  let run;
  try { run = await fetchRun(runId); } catch (e) { app.innerHTML = `<div class="card empty"><b>${h(e.message)}</b></div>`; return; }
  const f = run.findings.find(x => x.id === fid);
  if (!f) { app.innerHTML = `<a class="back" href="#run-${runId}">← 照合結果へ</a><div class="card empty"><b>指摘が見つかりません</b></div>`; return; }
  const st = stateOf(f, run);
  const conf = run.confirmed[f.id];
  app.innerHTML = `
    <a class="back" href="#run-${runId}">← 照合結果へ</a>
    <div class="card flowhead">
      <div class="row1"><h1>${h(f.title)}</h1><span class="chip ${f.source === 'ai' && st !== 'done' ? 'chip-blue' : CHIP[st][1]}" style="margin-left:auto">${f.source === 'ai' ? 'AI・' : ''}${CHIP[st][0]}</span></div>
      <div class="small muted">${h(f.category)}　${h(f.key || '')}${f.name ? '　' + h(f.name) : ''}　／　${{ rule: 'ルール照合', diff: '新旧比較', ai: 'AI照合' }[f.source] || ''}</div>
      <div class="dates" style="grid-template-columns:repeat(${Math.min(3, Math.max(2, f.obs.length))}, minmax(0,1fr))">
        ${f.obs.map((o, i) => `<div class="d ${i === f.obs.length - 1 && f.kind !== 'missing' && f.obs.length > 1 ? 'hand' : ''}"><span class="k">${h(o.doc)}　${h(o.loc)}</span><b>${h(o.value)}</b></div>`).join('')}
      </div>
    </div>
    <section class="card section">
      <div class="section-h"><span class="t">確認してほしいこと</span></div>
      <ul class="items">
        <li>${h(f.message)}</li>
        ${f.obs.map(o => `<li class="evi"><span>${h(o.doc)}　<span class="muted">${h(o.loc)}</span><br><span class="q">${h(o.value)}</span></span>${o.verified === true ? '<span class="ok">資料に記載あり</span>' : o.verified === false ? '<span class="ng">資料に見つからない</span>' : ''}</li>`).join('')}
      </ul>
    </section>
    <section class="card section">
      <div class="section-h"><span class="t">確認の記録</span>${conf ? `<span class="prog">${fmtTime(conf.at)} 確認</span>` : ''}</div>
      <div class="pad">
        <div class="field"><label for="note">メモ（直した内容・問い合わせ先など）</label><textarea class="input note" id="note">${h(conf?.note || '')}</textarea></div>
        <div class="actions">${conf
          ? `<button class="btn" id="unconfirm" type="button">確認済みを取り消す</button><button class="btn-primary" id="confirm" type="button">メモを保存</button>`
          : `<button class="btn-primary" id="confirm" type="button">確認済みにする</button>`}
          ${nextLink(run, f)}</div>
      </div>
    </section>`;
  $('#confirm').onclick = () => setConfirmed(run, f, true, $('#note').value);
  if ($('#unconfirm')) $('#unconfirm').onclick = () => setConfirmed(run, f, false);
  setSync(run.at);
}

function nextLink(run, f) {
  const list = visible(run);
  const i = list.findIndex(x => x.id === f.id);
  const next = list[i + 1];
  return next ? `<a class="btn" href="#item-${run.id}-${next.id}">次の指摘へ</a>` : '';
}

async function setConfirmed(run, f, confirmed, note = '') {
  try { run.confirmed = await api.patch(run.id, { findingId: f.id, confirmed, note }); } catch (e) { return toast(e.message); }
  toast(confirmed ? '確認済みにしました' : '確認済みを取り消しました');
  showItem(run.id, f.id);
}

// ---------- 記録 ----------
async function showHistory() {
  const list = await api.list().catch(() => []);
  const open = list.reduce((n, r) => n + r.counts.ng + r.counts.check, 0);
  app.innerHTML = `
    ${phead('History', '照合の記録', `照合した資料の名前と指摘、確認済みの印を${LOCAL ? 'このブラウザの中に' : ''}残しています。資料ファイル自体は保存していません。`)}
    <section class="summary" aria-label="集計">
      ${stat('x', '記録', list.length, '件', '照合した回数')}
      ${stat('x', '未確認', open, '件', '不一致と要確認のうち確認前', open > 0 ? 'alert' : '')}
    </section>
    ${list.length ? `<div class="card plist"><table><thead><tr><th>照合した資料</th><th>日時</th><th>方法</th><th>指摘</th></tr></thead><tbody>${list.map(r => `
      <tr class="row" data-href="#run-${r.id}"><td><div class="pname"><a href="#run-${r.id}">${h(r.title)}</a></div><div class="paddr">${h(r.docs.map(d => d.name).join('・'))}</div></td>
      <td data-l="日時"><b class="num">${fmtTime(r.at)}</b></td>
      <td data-l="方法"><span>${r.mode === 'pair' ? '新旧比較' : '資料間の照合'}${r.ai && !r.ai.error ? '＋AI' : ''}</span></td>
      <td data-l="指摘"><span>${r.counts.ng ? `<span class="chip chip-red">不一致 ${r.counts.ng}</span> ` : ''}${r.counts.check ? `<span class="chip chip-gray">要確認 ${r.counts.check}</span> ` : ''}${r.counts.change ? `<span class="chip chip-orange">変更 ${r.counts.change}</span> ` : ''}${r.counts.done ? `<span class="chip chip-green">確認済み ${r.counts.done}</span>` : ''}${!r.counts.total ? '<span class="muted">なし</span>' : ''}</span></td></tr>`).join('')}
      </tbody></table></div>` : `<div class="card empty"><b>記録はまだありません</b><a href="#check">資料を照合する</a></div>`}`;
  app.querySelectorAll('tr.row').forEach(tr => tr.onclick = e => { if (!e.target.closest('a')) location.hash = tr.dataset.href; });
  app.querySelectorAll('.summary .stat').forEach(b => { b.disabled = true; b.style.cursor = 'default'; });
  setSync(list[0]?.at);
}

// ---------- CSV（Excelで開ける報告書） ----------
function downloadCsv(run) {
  const max = Math.max(2, ...run.findings.map(f => f.obs.length));
  const head = ['No', '状態', '種類', '出どころ', '指摘', '内容', '記号・品番'];
  for (let i = 1; i <= max; i++) head.push(`資料${i}`, `場所${i}`, `値${i}`);
  head.push('確認日時', 'メモ');
  const rows = [head];
  visible(run).forEach((f, n) => {
    const st = stateOf(f, run);
    const r = [n + 1, CHIP[st][0], f.category, { rule: 'ルール照合', diff: '新旧比較', ai: 'AI照合' }[f.source] || '', f.title, f.message, f.key || ''];
    for (let i = 0; i < max; i++) { const o = f.obs[i] || {}; r.push(o.doc || '', o.loc || '', o.value || ''); }
    r.push(run.confirmed[f.id] ? fmtTime(run.confirmed[f.id].at) : '', run.confirmed[f.id]?.note || '');
    rows.push(r);
  });
  const body = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  if (LOCAL) {
    // Artifact の中ではファイルを保存できないので、クリップボードへ（Excel に貼り付けられる形）
    const tsv = rows.map(r => r.map(v => String(v).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
    navigator.clipboard.writeText(tsv)
      .then(() => toast('コピーしました。Excel に貼り付けてください'))
      .catch(() => toast('コピーできませんでした。サーバー版（start.bat）では CSV で書き出せます'));
    return;
  }
  const csv = '﻿' + body;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `照合結果_${run.at.slice(0, 10)}_${run.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 40)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 表示設定メニュー（ひな形と同じ動き） ----------
const btn = $('#menu-button'), drawer = $('#list-drawer'), backdrop = $('#backdrop');
function setMenu(open) {
  drawer.classList.toggle('open', open); drawer.toggleAttribute('inert', !open); drawer.setAttribute('aria-hidden', String(!open));
  backdrop.hidden = !open; btn.setAttribute('aria-expanded', String(open)); document.body.classList.toggle('list-drawer-open', open);
  if (open) $('#q').focus(); else btn.focus();
}
btn.onclick = () => setMenu(true);
$('#menu-close').onclick = () => setMenu(false);
backdrop.onclick = () => setMenu(false);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawer.classList.contains('open')) { e.preventDefault(); setMenu(false); } });
$('#q').addEventListener('input', e => { state.q = e.target.value; renderList(); });
$('#sort').addEventListener('change', e => { state.sort = e.target.value; renderList(); });
drawer.querySelectorAll('.seg').forEach(seg => seg.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  seg.querySelectorAll('button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
  if (b.dataset.v) { state.view = b.dataset.v; save('view', state.view); }
  if (b.dataset.f) { state.filter = b.dataset.f; markStats(); }
  renderList();
}));
function syncSeg() {
  drawer.querySelectorAll('[data-f]').forEach(x => { const on = x.dataset.f === state.filter; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
}
drawer.querySelectorAll('[data-v]').forEach(x => { const on = x.dataset.v === state.view; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
$('#refresh').onclick = async () => {
  const m = $('#drawer-msg'), b = $('#refresh');
  if (!state.run) return;
  b.disabled = true;
  try {
    const id = state.run.id; state.run = null;
    await fetchRun(id); renderList();
    m.className = 'drawer-msg done'; m.textContent = '最新の記録を読み込みました';
  } catch { m.className = 'drawer-msg error'; m.textContent = '読み込めませんでした。サーバーが動いているか確認してください'; }
  m.hidden = false; b.disabled = false;
};

// ---------- 小物 ----------
function phead(en, jp, sub) {
  return `<div class="phead"><div><div class="kicker">${en}</div><div class="title"><span class="big" aria-hidden="true">${en}</span><h1>${jp}</h1></div></div><div class="sub">${sub}</div></div>`;
}
function setSync(at) {
  const dot = $('#sync-dot'), t = $('#sync-text');
  dot.classList.toggle('warn', false);
  t.textContent = at ? `${fmtTime(at).slice(-5)} 照合` : (state.config.ai ? 'AI照合 使えます' : 'ルール照合');
}
function fmtTime(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const short = s => String(s).replace(/\.(pdf|xlsx|xlsm|xls|xlsb|csv)$/i, '');
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
function busy(b, on, label) { b.disabled = on; b.innerHTML = on ? `<span class="busy">${h(label)}</span>` : h(label); }
let toastTimer;
function toast(text, ms = 3200) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.textContent = text; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
function load(k, d) { try { return localStorage.getItem('gran-shogo:' + k) || d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem('gran-shogo:' + k, v); } catch { /* 保存できなくても動く */ } }
