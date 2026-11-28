// 図面の画像をまとめて「印刷・PDFで保存」したり、「画像で zip にまとめて保存」したりする（新旧比較・書き込みの洗い出しで共通）
import { makeZip } from './core/zip.js';

const toJpeg = (canvas, q = 0.9) => new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('画像にできませんでした'))), 'image/jpeg', q));

/**
 * 1枚ずつ用紙に並べて、ブラウザの印刷画面を出す（「PDFに保存」を選べば PDF になる）
 * @param {{title:string, canvas:HTMLCanvasElement}[]} sheets
 */
export async function printSheets(sheets, { heading = '' } = {}) {
  document.getElementById('print-sheets')?.remove();
  const box = document.createElement('div');
  box.id = 'print-sheets';
  const urls = [];
  for (const s of sheets) {
    const url = URL.createObjectURL(await toJpeg(s.canvas, 0.92));
    urls.push(url);
    const fig = document.createElement('figure');
    const cap = document.createElement('figcaption');
    cap.textContent = [heading, s.title].filter(Boolean).join('　');
    const img = new Image();
    img.src = url; img.alt = s.title;
    fig.append(cap, img);
    box.append(fig);
  }
  document.body.append(box);
  // 図面は横長が多いので、この印刷だけ用紙を横向きにする
  const page = document.createElement('style');
  page.textContent = '@page { size: landscape; margin: 8mm; }';
  document.head.append(page);
  document.body.classList.add('print-sheets');
  await Promise.all([...box.querySelectorAll('img')].map(i => (i.complete ? null : new Promise(r => { i.onload = i.onerror = r; }))));
  const done = () => {
    document.body.classList.remove('print-sheets');
    page.remove(); box.remove();
    urls.forEach(u => URL.revokeObjectURL(u));
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(() => { if (!matchMedia('print').matches && document.body.classList.contains('print-sheets')) done(); }, 60000);
}

/**
 * 画像（JPEG）にして、1つの zip で保存する
 * @param {{name:string, canvas:HTMLCanvasElement}[]} sheets
 */
export async function saveZip(sheets, zipName) {
  const files = [];
  for (const s of sheets) files.push({ name: s.name.replace(/[\\/:*?"<>|]/g, '') + '.jpg', data: new Uint8Array(await (await toJpeg(s.canvas)).arrayBuffer()) });
  const blob = new Blob([makeZip(files)], { type: 'application/zip' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = zipName.replace(/[\\/:*?"<>|]/g, '');
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

export const today = () => new Date().toLocaleDateString('sv-SE');
