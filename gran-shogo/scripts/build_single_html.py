"""資料照合を「1つの HTML ファイル」にまとめる（Claude もサーバーもいらない版）。

使い方: python3 scripts/build_single_html.py <出力ファイル.html>
- 画面（index.html・CSS・ロゴ）と照合の部品（public/js）を1つのファイルに入れる
- ライブラリ（pdf.js・SheetJS・OpenCV.js）は jsDelivr から読む（資料は送らない。部品を受け取るだけ）
- AI照合（Claude API）は外し、記録はこのブラウザの中にだけ残す
- 社内の掲示ページ（LINE WORKS のログインの後ろ）などにそのまま置ける
"""
import base64
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public"
JS = PUB / "js"
PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38"
XLSX = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs"
OPENCV = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js"
SAMPLES = {
    "plan_old.pdf": "平面図_旧.pdf", "plan_new.pdf": "平面図_新.pdf", "tategu.xlsx": "建具表.xlsx",
    "shiage.xlsx": "仕上表.xlsx", "estimate_old.xlsx": "見積_旧.xlsx", "estimate_new.xlsx": "見積_新.xlsx",
}
# 依存される側から順に並べる
ORDER = ["core/normalize.js", "core/shift.js", "core/zip.js", "core/readers.js", "core/diff.js", "core/check.js",
         "overlay.js", "vector.js", "sheets.js", "markup/engine.js", "markup/view.js"]


def replace_once(s: str, old: str, new: str) -> str:
    if s.count(old) != 1:
        raise SystemExit(f"書き換え先が1か所に決まりません: {old[:60]}")
    return s.replace(old, new)


def resolve(base: str, rel: str) -> str:
    parts = (Path(base).parent / rel).parts
    out = []
    for p in parts:
        if p == "..":
            out.pop()
        elif p != ".":
            out.append(p)
    return "/".join(out)


IMPORT = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*'(\.[^']+)';\s*$", re.M)


def local_imports(src: str, me: str) -> str:
    def sub(m):
        names = ", ".join(n.strip().replace(" as ", ": ") for n in m.group(1).split(",") if n.strip())
        return f"const {{ {names} }} = __M['{resolve(me, m.group(2))}'];"
    return IMPORT.sub(sub, src)


def module(path: str) -> str:
    src = local_imports((JS / path).read_text(encoding="utf-8"), path)
    names = re.findall(r"^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)", src, re.M)
    src = re.sub(r"^export\s+", "", src, flags=re.M)
    if re.search(r"^\s*(import|export)\b", src, re.M):
        raise SystemExit(f"まとめられない import/export が残っています: {path}")
    return f"// ===== {path} =====\n__M['{path}'] = await (async () => {{\n{src}\nreturn {{ {', '.join(names)} }};\n}})();\n"


def app_js() -> str:
    a = (JS / "app.js").read_text(encoding="utf-8")
    a = replace_once(a, "import * as pdfjs from '../vendor/pdf.min.mjs';", f"import * as pdfjs from '{PDFJS}/legacy/build/pdf.min.mjs';")
    a = replace_once(a, "import * as XLSX from '../vendor/xlsx.mjs';", f"import * as XLSX from '{XLSX}';")
    a = replace_once(a, "import './pagematch.js';", "// pagematch.js はこの上に入れてある")
    a = replace_once(
        a, "pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;",
        "// 別サイトの Worker は作れないので、pdf.js の処理はページの中で動かす\n"
        f"pdfjs.GlobalWorkerOptions.workerSrc = '{PDFJS}/legacy/build/pdf.worker.min.mjs';\n"
        f"globalThis.pdfjsWorker ??= await import('{PDFJS}/legacy/build/pdf.worker.min.mjs');")
    a = replace_once(a, "const CV_SRC = new URL('../vendor/opencv.js', import.meta.url).href;", f"const CV_SRC = '{OPENCV}';")
    a = re.sub(r"const PDF_OPTS = \{.*?\};",
               f"const PDF_OPTS = {{ cMapUrl: '{PDFJS}/cmaps/', cMapPacked: true, standardFontDataUrl: '{PDFJS}/standard_fonts/' }};",
               a, count=1)
    # サーバーは無い：記録はこのブラウザの中だけ、AI照合なし
    a = re.sub(r"fetch\('api/config'\)\n.*?\.finally\(route\);",
               "LOCAL = true; state.config = { ai: false, local: true, single: true }; route();", a, count=1, flags=re.S)
    a = re.sub(r"\n\s*<label class=\"opt\"><input type=\"checkbox\" id=\"use-ai\".*?</label>", "", a, count=1, flags=re.S)
    a = replace_once(a, "$('#use-ai').addEventListener(", "$('#use-ai')?.addEventListener(")
    # サンプルはこのファイルの中に入れてある
    a = replace_once(a, """    const r = await fetch('samples/' + SAMPLES[n]);
    if (!r.ok) throw new Error(n);
    return { name: n, buf: await r.arrayBuffer() };""", """    const b = __SAMPLES[SAMPLES[n]];
    if (!b) throw new Error(n);
    const bin = atob(b), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return { name: n, buf: u8.buffer };""")
    a = local_imports(a, "app.js")
    ext = re.findall(r"^import \* as \w+ from 'https:[^']+';$", a, re.M)
    a = re.sub(r"^import \* as \w+ from 'https:[^']+';\n", "", a, flags=re.M)
    if re.search(r"^\s*(import|export)\b|import\.meta|fetch\('samples", a, re.M):
        raise SystemExit("app.js にまとめられない所が残っています")
    return "\n".join(ext), a


def main(out: Path) -> None:
    ext, app = app_js()
    samples = {en: base64.b64encode((ROOT / "samples" / jp).read_bytes()).decode() for en, jp in SAMPLES.items()}
    js = "\n".join([
        ext,
        "const __M = {};",
        f"const __SAMPLES = {__import__('json').dumps(samples)};",
        *[module(p) for p in ORDER],
        "// ===== pagematch.js =====\n" + (JS / "pagematch.js").read_text(encoding="utf-8"),
        "// ===== app.js =====\n" + app,
    ]).replace("</script", "<\\/script")

    html = (PUB / "index.html").read_text(encoding="utf-8")
    body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
    body = re.sub(r"\s*<script.*?</script>", "", body, flags=re.S).strip()
    css = (PUB / "gran-os-base.css").read_text(encoding="utf-8") + "\n" + (PUB / "app.css").read_text(encoding="utf-8")
    logo = base64.b64encode((PUB / "logo.svg").read_bytes()).decode()
    page = f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>資料照合</title>
<!-- グランOS 資料照合（1ファイル版）。資料はこの端末の中だけで読み、外へは送りません。
     外から読むのは画面の部品（jsDelivr：pdf.js・SheetJS・OpenCV.js）と文字（Google Fonts）だけです。 -->
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,{logo}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700;900&family=Poppins:wght@500;600;700&display=swap">
<style>
{css}
:root{{color-scheme:light}} body{{background:#f0f0f0}}
</style>
</head>
<body>
{body}
<script type="module">
{js}
</script>
</body>
</html>
"""
    out.write_text(page, encoding="utf-8")
    print(out, f"{len(page.encode()) / 1024:.0f} KB")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "資料照合.html")
