"""確認用の架空サンプル資料を作る（実在の案件・お客様とは関係ありません）。

仕込んである食い違い（調査メモの例と同じ）:
  1. 窓寸法   平面図(新) AW1 W1650 ／ 建具表 AW1 W1600
  2. 床材品番 仕上表 AA-101 ／ 見積 AA-102
  3. 照明器具 図面に PL-1 あり ／ 見積に該当項目なし
  4. 設備数量 図面 DL-1 3台 ／ 見積 DL-1 2台
新旧比較: 平面図(旧→新) で AW1 の幅・収納の追加・WD1 の移動、見積(旧→新) で数量・行の追加削除・数式の変更。
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OUT = Path(__file__).parent
FONT_PATHS = [
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf",
    "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
    "C:/Windows/Fonts/msgothic.ttc",
]
for p in FONT_PATHS:
    if Path(p).exists():
        pdfmetrics.registerFont(TTFont("JP", p))
        break
else:
    raise SystemExit("日本語フォントが見つかりません")


def plan(path: Path, new: bool) -> None:
    W, H = landscape(A3)
    c = canvas.Canvas(str(path), pagesize=(W, H))
    c.setTitle("平面図（サンプル）")
    # 外周と間仕切り
    c.setLineWidth(3)
    c.rect(80, 120, 760, 560)
    c.setLineWidth(1.5)
    c.line(480, 120, 480, 680)
    c.line(80, 400, 480, 400)
    c.line(480, 420, 840, 420)
    if new:
        c.line(700, 420, 700, 300)  # 収納を追加
    c.setFont("JP", 16)
    c.drawString(250, 560, "LDK")
    c.drawString(230, 250, "洋室1")
    c.drawString(620, 560, "洋室2")
    c.drawString(600, 250, "浴室")
    if new:
        c.drawString(740, 360, "収納")
    c.setFont("JP", 11)

    def label(x, y, code, size=None):
        c.drawString(x, y, code)
        if size:
            c.setFont("JP", 9)
            c.drawString(x - 4, y - 13, size)
            c.setFont("JP", 11)

    # 窓（外壁の上に太線）
    c.setLineWidth(5)
    for x0, x1, y in [(160, 300, 680), (560, 700, 680)]:
        c.line(x0, y, x1, y)
    c.line(80, 200, 80, 320)
    c.setLineWidth(1)
    label(205, 692, "AW1", "W1650xH1100" if new else "W1600xH1100")
    label(605, 692, "AW1", "W1650xH1100" if new else "W1600xH1100")
    label(40, 330, "AW2", "W780xH970")
    # ドア
    label(300, 410, "WD1")
    label(500, 300, "WD1")
    label(560, 430, "WD1") if new else label(640, 430, "WD1")
    label(840 - 60, 130, "SD1")
    # 照明（丸と記号）
    for x, y in [(200, 600), (330, 600), (250, 300)]:
        c.circle(x, y, 7)
        c.drawString(x + 10, y - 4, "DL-1")
    c.circle(650, 600, 9)
    c.drawString(662, 596, "PL-1")
    # 凡例
    c.setFont("JP", 12)
    c.drawString(880, 660, "器具凡例")
    c.setFont("JP", 11)
    rows = [("DL-1", "ダウンライト", "3台"), ("PL-1", "ペンダントライト", "1台")]
    for i, (code, name, qty) in enumerate(rows):
        y = 635 - i * 22
        c.drawString(880, y, code)
        c.drawString(940, y, name)
        c.drawString(1060, y, qty)
    # 図面枠
    c.setFont("JP", 10)
    c.drawString(880, 160, "サンプル邸 新築工事（架空）")
    c.drawString(880, 142, "1階平面図  S=1/100")
    c.drawString(880, 124, "改訂 2" if new else "改訂 1")
    c.showPage()
    c.save()


def book(path: Path, title: str, header: list, rows: list, formulas=None) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = title
    ws.append([f"{title}（サンプル邸・架空）"])
    ws["A1"].font = Font(bold=True, size=13)
    ws.append([])
    ws.append(header)
    for cell in ws[3]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill("solid", fgColor="EEEEEE")
    for r in rows:
        ws.append(r)
    if formulas:
        formulas(ws)
    for col, w in zip("ABCDEFG", [10, 22, 10, 10, 8, 12, 14]):
        ws.column_dimensions[col].width = w
    wb.save(path)


def estimate(path: Path, new: bool) -> None:
    rows = [
        ["AW1", "アルミサッシ 引違い窓", 2, "箇所", 68000],
        ["AW2", "アルミサッシ 縦すべり出し窓", 1, "箇所", 32000],
        ["SD1", "玄関ドア", 1, "箇所", 245000],
        ["WD1", "室内ドア", 3, "箇所", 42000],
        ["AA-102" if new else "AA-101", "床フローリング", 48 if new else 45, "㎡", 6800],
        ["BB-201", "壁クロス", 210, "㎡", 1100],
        ["DL-1", "ダウンライト", 2, "台", 5800],
    ]
    if not new:
        rows.append(["CL-9", "シーリングライト（旧仕様）", 2, "台", 9800])
    if new:
        rows.append(["HB-1", "収納 枕棚・ハンガーパイプ", 1, "式", 18000])

    def f(ws):
        for r in range(4, 4 + len(rows)):
            # 新では床の行だけ金額の式を変えてある（端数切り上げ→切り捨ての例）
            if new and ws[f"A{r}"].value == "AA-102":
                ws[f"F{r}"] = f"=ROUNDDOWN(C{r}*E{r},-2)"
            else:
                ws[f"F{r}"] = f"=C{r}*E{r}"
        last = 3 + len(rows)
        ws[f"E{last + 1}"] = "合計"
        ws[f"F{last + 1}"] = f"=SUM(F4:F{last})"

    book(path, "見積", ["品番", "品名", "数量", "単位", "単価", "金額"], rows, f)


def recalc(paths: list) -> None:
    """openpyxl は数式の計算結果を保存しないので、LibreOffice があれば計算させて保存し直す"""
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        return
    with tempfile.TemporaryDirectory() as tmp:
        for p in paths:
            subprocess.run([soffice, "--headless", "--calc", "--convert-to", "xlsx", "--outdir", tmp, str(p)],
                           check=False, capture_output=True, timeout=120)
            out = Path(tmp) / p.name
            if out.exists():
                shutil.move(str(out), p)


def main() -> None:
    plan(OUT / "平面図_旧.pdf", new=False)
    plan(OUT / "平面図_新.pdf", new=True)
    book(OUT / "建具表.xlsx", "建具表", ["記号", "名称", "W", "H", "数量", "仕様"], [
        ["AW1", "アルミサッシ 引違い窓", 1600, 1100, 2, "Low-E複層"],
        ["AW2", "アルミサッシ 縦すべり出し窓", 780, 970, 1, "Low-E複層"],
        ["SD1", "玄関ドア", 922, 2330, 1, "断熱 D2仕様"],
        ["WD1", "室内ドア", 778, 2033, 3, "片開き"],
    ])
    book(OUT / "仕上表.xlsx", "仕上表", ["室名", "部位", "仕上", "品番", "備考"], [
        ["LDK", "床", "フローリング", "AA-101", ""],
        ["洋室1", "床", "フローリング", "AA-101", ""],
        ["LDK", "壁", "クロス", "BB-201", ""],
        ["洋室1", "壁", "クロス", "BB-201", ""],
    ])
    estimate(OUT / "見積_旧.xlsx", new=False)
    estimate(OUT / "見積_新.xlsx", new=True)
    recalc([OUT / "見積_旧.xlsx", OUT / "見積_新.xlsx"])
    print("samples をつくりました:", ", ".join(sorted(p.name for p in OUT.iterdir() if p.suffix in {".pdf", ".xlsx"})))


if __name__ == "__main__":
    main()
