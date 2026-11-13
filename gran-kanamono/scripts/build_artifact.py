"""claude.ai の Artifact（スマホでも開ける版）用のフォルダを作る。

使い方: python3 scripts/build_artifact.py <出力フォルダ>
- public/ の画面をコピーし、ライブラリ（pdf.js・pdf-lib）は jsDelivr から読むように書き換える
  （Artifact は自分のファイルと許可された配信元しか読めないため）
- 図面はブラウザの中で読むだけで、どこにも送らない（ライブラリを配信元から読むだけ）
- index.html は中身だけにする（<!doctype>・<head>・<body> は公開時に付く）
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public"
PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38"
PDFLIB = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js"


def replace_once(s: str, old: str, new: str) -> str:
    if old not in s:
        raise SystemExit(f"書き換え先が見つかりません: {old[:60]}")
    return s.replace(old, new)


def main(out: Path) -> None:
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(PUB / "js", out / "js")
    for f in ["gran-os-base.css", "app.css", "logo.svg"]:
        shutil.copy(PUB / f, out / f)

    app = (out / "js/app.js").read_text(encoding="utf-8")
    app = replace_once(app, "import * as pdfjs from '../vendor/pdf.min.mjs';", f"import * as pdfjs from '{PDFJS}/legacy/build/pdf.min.mjs';")
    app = replace_once(app, "import * as PDFLib from '../vendor/pdf-lib.esm.min.js';", f"import * as PDFLib from '{PDFLIB}';")
    app = replace_once(
        app,
        "pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;",
        "// Artifact 版：別サイトの Worker は作れないので、pdf.js の処理はページの中で動かす\n"
        f"pdfjs.GlobalWorkerOptions.workerSrc = '{PDFJS}/legacy/build/pdf.worker.min.mjs';\n"
        f"globalThis.pdfjsWorker ??= await import('{PDFJS}/legacy/build/pdf.worker.min.mjs');",
    )
    app = replace_once(app, "cMapUrl: new URL('../vendor/cmaps/', import.meta.url).href", f"cMapUrl: '{PDFJS}/cmaps/'")
    app = replace_once(app, "standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).href", f"standardFontDataUrl: '{PDFJS}/standard_fonts/'")
    (out / "js/app.js").write_text(app, encoding="utf-8")

    html = (PUB / "index.html").read_text(encoding="utf-8")
    head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
    body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
    keep = [l.strip() for l in head.splitlines() if re.search(r"fonts\.g|gran-os-base|app\.css|logo\.svg", l)]
    (out / "index.html").write_text(
        "<title>金物着色</title>\n" + "\n".join(keep)
        + "\n<style>:root{color-scheme:light} body{background:#f0f0f0}</style>\n" + body.strip() + "\n",
        encoding="utf-8",
    )
    files = sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file() and p.name != "index.html")
    print("\n".join(files))


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist-artifact")
