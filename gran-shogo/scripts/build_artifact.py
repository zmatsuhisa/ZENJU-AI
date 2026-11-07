"""claude.ai の Artifact（スマホでも開けるお試し版）用のフォルダを作る。

使い方: python3 scripts/build_artifact.py <出力フォルダ>
- public/ の画面と照合エンジンをコピーし、ライブラリ（pdf.js・SheetJS）は jsDelivr から読むように書き換える
  （Artifact は自分のファイルと許可された配信元しか読めないため）
- サンプルの Excel は Artifact に置けないので base64 の文字にして置く
- index.html は中身だけにする（<!doctype>・<head>・<body> は公開時に付く）
"""
import base64
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public"
PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build"
XLSX = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs"
OPENCV = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js"
SAMPLES = {
    "平面図_旧.pdf": "plan_old.pdf", "平面図_新.pdf": "plan_new.pdf", "建具表.xlsx": "tategu.xlsx",
    "仕上表.xlsx": "shiage.xlsx", "見積_旧.xlsx": "estimate_old.xlsx", "見積_新.xlsx": "estimate_new.xlsx",
}


def replace_once(s: str, old: str, new: str) -> str:
    if old not in s:
        raise SystemExit(f"書き換え先が見つかりません: {old[:60]}")
    return s.replace(old, new)


def main(out: Path) -> None:
    if out.exists():
        shutil.rmtree(out)
    (out / "samples").mkdir(parents=True)
    shutil.copytree(PUB / "js", out / "js")
    for f in ["gran-os-base.css", "app.css", "logo.svg"]:
        shutil.copy(PUB / f, out / f)

    app = (out / "js/app.js").read_text(encoding="utf-8")
    app = replace_once(app, "import * as pdfjs from '../vendor/pdf.min.mjs';", f"import * as pdfjs from '{PDFJS}/pdf.min.mjs';")
    app = replace_once(app, "import * as XLSX from '../vendor/xlsx.mjs';", f"import * as XLSX from '{XLSX}';")
    app = replace_once(
        app,
        "pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;",
        "// Artifact 版：別サイトの Worker は作れないので、pdf.js の処理はページの中で動かす\n"
        f"pdfjs.GlobalWorkerOptions.workerSrc = '{PDFJS}/pdf.worker.min.mjs';\n"
        f"globalThis.pdfjsWorker ??= await import('{PDFJS}/pdf.worker.min.mjs');",
    )
    app = replace_once(app, "const CV_SRC = new URL('../vendor/opencv.js', import.meta.url).href;", f"const CV_SRC = '{OPENCV}';")
    app = re.sub(r"const PDF_OPTS = \{.*?\};", "const PDF_OPTS = { useSystemFonts: true };", app, count=1)
    app = replace_once(
        app,
        """    const r = await fetch('samples/' + SAMPLES[n]);
    if (!r.ok) throw new Error(n);
    return { name: n, buf: await r.arrayBuffer() };""",
        """    // Artifact 版：Excel のサンプルは base64 の文字で置いてある
    const path = 'samples/' + SAMPLES[n] + (/\\.xlsx$/.test(SAMPLES[n]) ? '.b64.txt' : '');
    const r = await fetch(path);
    if (!r.ok) throw new Error(n);
    if (!path.endsWith('.b64.txt')) return { name: n, buf: await r.arrayBuffer() };
    const bin = atob((await r.text()).trim());
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return { name: n, buf: u8.buffer };""",
    )
    (out / "js/app.js").write_text(app, encoding="utf-8")

    for jp, en in SAMPLES.items():
        src = ROOT / "samples" / jp
        if en.endswith(".xlsx"):
            (out / "samples" / (en + ".b64.txt")).write_text(base64.b64encode(src.read_bytes()).decode())
        else:
            shutil.copy(src, out / "samples" / en)

    html = (PUB / "index.html").read_text(encoding="utf-8")
    head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
    body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
    keep = [l.strip() for l in head.splitlines() if re.search(r"fonts\.g|gran-os-base|app\.css|logo\.svg", l)]
    body = re.sub(r"<script>if \('serviceWorker'.*?</script>", "", body, flags=re.S).strip()
    (out / "index.html").write_text(
        "<title>資料照合</title>\n" + "\n".join(keep)
        + "\n<style>:root{color-scheme:light} body{background:#f0f0f0}</style>\n" + body + "\n",
        encoding="utf-8",
    )
    files = sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file() and p.name != "index.html")
    print("\n".join(files))


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist-artifact")
