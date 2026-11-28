"""照合・新旧比較の精度を測るための「架空の物件」をたくさん作る（実在の案件・お客様とは関係ありません）。

使い方:  python3 research/bench/make_bench.py <出力フォルダ> [物件数=24] [乱数の種=1]

物件ごとに次を作り、仕込んだ食い違い・変更を truth.json に書く。
  平面図.pdf / 電気図.pdf（ある物件だけ） / 建具表.xlsx か 建具表.pdf / 仕上表.xlsx / 見積.xlsx
  平面図_旧.pdf → 平面図_新.pdf、見積_旧.xlsx → 見積_新.xlsx（新旧比較用）

書き方のゆれ（実際の図面・表でよくあるもの）を物件ごとに変える:
  - 寸法の書き方：W1650xH1100 / Ｗ１６５０×Ｈ１１００ / 1650×1100 / W=1650 と H=1100 を2行 / 寸法なし
  - 記号の書き方：AW1 / AW-1 / ＡＷ１
  - 建具表：1行1記号の Excel / 見出しが2段（寸法の下に W・H）/ 寸法が1つの欄 / 数量が「2ヶ所」の文字 /
            PDF の表（行が記号）/ PDF の表（列が記号・縦横が逆）
  - 見積：品番の欄あり / 品名の中に品番 / 工事ごとの見出し行 / 1式・諸経費
  - 図面のまぎらわしい文字：通り芯（X1・Y2）・図番（A-03）・注記の記号（※AW1〜AW3は…）・S=1/100・CH2400・2F
"""
import json
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from openpyxl import Workbook
from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

for p in ["/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf", "/usr/share/fonts/truetype/fonts-japanese-gothic.ttf",
          "C:/Windows/Fonts/msgothic.ttc"]:
    if Path(p).exists():
        pdfmetrics.registerFont(TTFont("JP", p))
        break
else:
    raise SystemExit("日本語フォントが見つかりません")

PW, PH = landscape(A3)
FW = str.maketrans("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-=x", "０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ－＝×")

WIN_NAMES = ["アルミ樹脂複合サッシ 引違い窓", "アルミ樹脂複合サッシ 縦すべり出し窓", "アルミ樹脂複合サッシ FIX窓",
             "アルミ樹脂複合サッシ 上げ下げ窓", "アルミ樹脂複合サッシ 横すべり出し窓", "掃き出し窓"]
DOOR_NAMES = ["室内ドア 片開き", "室内引戸", "クローゼット折戸", "トイレドア", "上吊り引戸"]
LIGHTS = [("DL", "ダウンライト"), ("PL", "ペンダントライト"), ("BL", "ブラケットライト"), ("CL", "シーリングライト"),
          ("FT", "フットライト"), ("SL", "スポットライト")]
FINISH = [("床", "フローリング", "KB"), ("壁", "クロス", "TW"), ("天井", "クロス", "TC"), ("床", "クッションフロア", "CF")]
ROOMS = ["LDK", "洋室1", "洋室2", "主寝室", "和室", "書斎", "WIC", "洗面脱衣", "浴室", "トイレ", "玄関", "ホール"]


def fmt_code(code, style):
    if style == "hyphen" and "-" not in code:
        i = next(k for k, ch in enumerate(code) if ch.isdigit())
        return code[:i] + "-" + code[i:]
    if style == "full":
        return code.translate(FW)
    return code


def size_lines(w, h, style):
    if style == "wx":
        return [f"W{w}xH{h}"]
    if style == "full":
        return [f"W{w}xH{h}".translate(FW)]
    if style == "bare":
        return [f"{w}×{h}"]
    if style == "eq2":
        return [f"W={w}", f"H={h}"]
    return []


class Project:
    def __init__(self, idx, rnd):
        self.idx = idx
        self.r = rnd
        r = rnd
        self.code_style = r.choice(["plain", "plain", "hyphen", "full"])
        self.size_style = r.choice(["wx", "wx", "full", "bare", "eq2", "none"])
        self.size_every = r.random() < 0.5          # 寸法をすべての記号に書くか、最初の1つだけか
        self.tategu_fmt = r.choice(["xl", "xl2", "xlsize", "pdfrows", "pdfcols"])
        self.qty_text = r.random() < 0.35            # 建具表の数量を「2ヶ所」の文字で書く
        self.est_code_in_name = r.random() < 0.4     # 見積の品番を品名の中に書く
        self.light_labels = r.random() < 0.7         # 照明の記号を器具ごとに書く（なければ凡例の数だけ）
        self.elec_sheet = r.random() < 0.5           # 照明を別の電気図にする
        self.two_floors = r.random() < 0.6
        self.noise = r.random() < 0.8
        self.note_codes = r.random() < 0.5           # 注記で記号に触れる（※AW1〜AW3は防火設備）

        nwin = r.randint(3, 7)
        self.windows = []
        for i in range(1, nwin + 1):
            w = r.choice([405, 640, 780, 1185, 1235, 1650, 1690, 2560])
            h = r.choice([370, 570, 770, 970, 1170, 1370, 2030])
            self.windows.append(dict(code=f"AW{i}", name=r.choice(WIN_NAMES), w=w, h=h, n=r.randint(1, 3)))
        ndoor = r.randint(2, 4)
        self.doors = [dict(code=f"WD{i}", name=r.choice(DOOR_NAMES), w=r.choice([650, 733, 778, 820]),
                           h=r.choice([2000, 2033, 2200]), n=r.randint(1, 4)) for i in range(1, ndoor + 1)]
        self.doors.append(dict(code="SD1", name="玄関ドア", w=r.choice([922, 1000, 1240]), h=r.choice([2330, 2400]), n=1))
        self.lights = []
        for (fam, name) in r.sample(LIGHTS, r.randint(2, 4)):
            for j in range(1, r.randint(1, 2) + 1):
                self.lights.append(dict(code=f"{fam}-{j}", name=name, n=r.randint(1, 6)))
        self.finishes = []
        for (part, name, fam) in r.sample(FINISH, 3):
            self.finishes.append(dict(code=f"{fam}-{r.randint(1, 9)}{r.randint(10, 99)}{r.randint(0, 9)}",
                                      part=part, name=name, rooms=r.sample(ROOMS, r.randint(2, 4))))
        self.truth = []        # 照合で出るべき指摘
        self.excluded = set()  # 見積に載せない記号
        self.est_qty = {}      # 見積の数量の上書き
        self.tbl_qty = {}      # 建具表の数量の上書き
        self.tbl_size = {}     # 建具表の寸法の上書き
        self.est_code = {}     # 見積の品番の上書き（書き間違い）
        self.extra_drawing = []  # 図面にだけある建具（建具表にない）
        self.plant()

    # ---------- 食い違いを仕込む ----------
    def plant(self):
        r = self.r
        kinds = r.sample(["size", "qty_tbl", "qty_est", "miss_est", "typo", "miss_tbl", "light_qty", "light_miss"],
                         r.randint(2, 4))
        sized = [w for w in self.windows] if self.size_style != "none" else []
        for k in kinds:
            if k == "size" and sized:
                w = r.choice(sized)
                dim = r.choice(["w", "h"])
                self.tbl_size[w["code"]] = (dim, w[dim] + r.choice([-50, 50, 100, -100]))
                self.truth.append(dict(cat="寸法", key=w["code"]))
            elif k == "qty_tbl":
                d = r.choice(self.windows + self.doors[:-1])
                self.tbl_qty[d["code"]] = d["n"] + r.choice([1, -1] if d["n"] > 1 else [1])
                self.truth.append(dict(cat="数量", key=d["code"]))
            elif k == "qty_est":
                d = r.choice([x for x in self.windows + self.doors if x["code"] not in self.tbl_qty])
                self.est_qty[d["code"]] = d["n"] + r.choice([1, -1] if d["n"] > 1 else [1])
                self.truth.append(dict(cat="数量", key=d["code"]))
            elif k == "miss_est":
                d = r.choice([x for x in self.windows + self.doors if x["code"] not in self.tbl_qty and x["code"] not in self.est_qty and x["code"] not in self.tbl_size])
                self.excluded.add(d["code"])
                self.truth.append(dict(cat="記載漏れ", key=d["code"], missing="見積"))
            elif k == "typo":
                f = r.choice(self.finishes)
                c = f["code"]
                wrong = c[:-1] + str((int(c[-1]) + r.choice([1, 2, 3])) % 10)
                self.est_code[c] = wrong
                self.truth.append(dict(cat="品番", key="|".join(sorted([c, wrong]))))
            elif k == "miss_tbl":
                code = f"AW{len(self.windows) + 1}"
                self.extra_drawing.append(dict(code=code, name="FIX窓", w=640, h=1170, n=1))
                self.excluded.add(code)
                self.truth.append(dict(cat="記載漏れ", key=code, missing="建具表"))
                self.truth.append(dict(cat="記載漏れ", key=code, missing="見積"))
            elif k == "light_qty":
                l = r.choice(self.lights)
                self.est_qty[l["code"]] = l["n"] + r.choice([1, -1] if l["n"] > 1 else [1])
                self.truth.append(dict(cat="数量", key=l["code"]))
            elif k == "light_miss":
                l = r.choice([x for x in self.lights if x["code"] not in self.est_qty])
                self.excluded.add(l["code"])
                self.truth.append(dict(cat="記載漏れ", key=l["code"], missing="見積"))

    # ---------- 図面 ----------
    def draw_frame(self, c, title, rev="改訂 1", sheet="A-03"):
        c.setLineWidth(0.8)
        c.rect(20, 20, PW - 40, PH - 40)
        c.rect(PW - 300, 20, 280, 110)
        c.setFont("JP", 9)
        c.drawString(PW - 290, 112, f"架空邸{self.idx} 新築工事")
        c.drawString(PW - 290, 96, f"{title}  S=1/100")
        if self.noise:
            c.drawString(PW - 290, 80, f"図番 {sheet}   工番 A{1600 + self.idx}")
        c.drawString(PW - 290, 64, rev)
        c.drawString(PW - 290, 48, "株式会社サンプル設計（架空）")

    def draw_grid(self, c):
        if not self.noise:
            return
        c.setFont("JP", 9)
        for i in range(1, 8):
            x = 90 + i * 100
            c.circle(x, PH - 50, 9)
            c.drawCentredString(x, PH - 53, f"X{i}")
        for j in range(1, 6):
            y = 140 + j * 100
            c.circle(50, y, 9)
            c.drawCentredString(50, y - 3, f"Y{j}")

    def place_items(self, c, items, slots, size=True):
        c.setFont("JP", 10)
        k = 0
        for it in items:
            for m in range(it["n"]):
                x, y = slots[k % len(slots)]
                k += 1
                c.setLineWidth(4)
                c.line(x, y + 14, x + 60, y + 14)
                c.setLineWidth(1)
                c.drawString(x, y, fmt_code(it["code"], self.code_style))
                if size and (self.size_every or m == 0):
                    for li, s in enumerate(size_lines(it["w"], it["h"], self.size_style)):
                        c.setFont("JP", 8)
                        c.drawString(x - 4, y - 11 - li * 10, s)
                        c.setFont("JP", 10)

    def slots(self, n, x0=105, y0=200, cols=7, dx=106, dy=-45):
        return [(x0 + (i % cols) * dx, y0 + (i // cols) * dy) for i in range(n)]

    def floors(self):
        """記号をどの階に置くか（2階建てなら半分ずつ）"""
        items = self.windows + self.extra_drawing
        if not self.two_floors:
            return [(items, self.doors, "1階平面図")]
        a, b = [], []
        for it in items:
            n1 = (it["n"] + 1) // 2
            a.append(dict(it, n=n1))
            if it["n"] - n1:
                b.append(dict(it, n=it["n"] - n1))
        da = [dict(d, n=(d["n"] + 1) // 2) for d in self.doors]
        db = [dict(d, n=d["n"] - (d["n"] + 1) // 2) for d in self.doors if d["n"] - (d["n"] + 1) // 2]
        return [(a, da, "1階平面図"), (b, db, "2階平面図")]

    def draw_plan_page(self, c, wins, doors, title, *, old=None, lights=True):
        """old=None は照合用。old=True/False は新旧比較用（変更を仕込む）"""
        shift = (0, 0) if old in (None, True) else (self.shift_dx, self.shift_dy)
        c.saveState()
        c.translate(*shift)
        c.setLineWidth(2.5)
        c.rect(90, 150, 760, 540)
        c.setLineWidth(1.2)
        c.line(470, 150, 470, 690)
        c.line(90, 420, 470, 420)
        rooms = list(ROOMS[:4])
        if old is False and self.change_room:
            rooms[2] = "書斎"
        c.setFont("JP", 14)
        for (x, y), name in zip([(130, 340), (330, 340), (530, 340), (700, 340)], rooms):
            c.drawString(x, y, name)
        if old is False:
            c.drawString(800, 300, "収納")
        # 寸法線の数字（同じ数字がいくつも出る）
        c.setFont("JP", 8)
        dims = ["910", "1820", "910", "2730", "910", "1820"]
        if old is False:
            dims[3] = "3640"
        for i, t in enumerate(dims):
            c.drawString(120 + i * 120, 705, t)
        self.place_items(c, wins, self.slots(sum(w["n"] for w in wins), y0=650), size=True)
        self.place_items(c, doors, self.slots(sum(d["n"] for d in doors), y0=470), size=False)
        if self.note_codes and wins:
            c.setFont("JP", 9)
            last = fmt_code(wins[-1]["code"], self.code_style)
            first = fmt_code(wins[0]["code"], self.code_style)
            c.drawString(110, 170, f"※{first}～{last}は防火設備（網入りガラス）とする")
        if self.noise:
            c.setFont("JP", 8)
            c.drawString(380, 305, "CH2400")
            c.drawString(820, 372, "PS")
            c.drawString(120, 305, "GL+500")
        if lights:
            self.draw_lights(c)
        c.restoreState()

    def draw_lights(self, c):
        c.setFont("JP", 9)
        k = 0
        for l in self.lights:
            for _ in range(l["n"]):
                x, y = 520 + (k % 8) * 40, 190 + (k // 8) * 34
                k += 1
                c.circle(x, y, 6)
                if self.light_labels:
                    c.drawString(x - 8, y - 16, l["code"])
        # 凡例
        c.setFont("JP", 11)
        c.drawString(890, 700, "器具凡例")
        c.setFont("JP", 10)
        for i, l in enumerate(self.lights):
            y = 676 - i * 20
            c.circle(895, y + 3, 5)
            c.drawString(908, y, l["code"])
            c.drawString(960, y, l["name"])
            c.drawString(1090, y, f"{l['n']}台")

    def make_plan(self, path):
        c = canvas.Canvas(str(path), pagesize=(PW, PH))
        fl = self.floors()
        for i, (wins, doors, title) in enumerate(fl):
            self.draw_frame(c, title, sheet=f"A-0{3 + i}")
            self.draw_grid(c)
            self.draw_plan_page(c, wins, doors, title, lights=(not self.elec_sheet and i == 0))
            c.showPage()
        c.save()
        if self.elec_sheet:
            c = canvas.Canvas(str(path.with_name("電気図.pdf")), pagesize=(PW, PH))
            self.draw_frame(c, "電気設備図", sheet="E-01")
            self.draw_grid(c)
            c.setLineWidth(2.5)
            c.rect(90, 150, 760, 540)
            self.draw_lights(c)
            c.showPage()
            c.save()

    # ---------- 建具表 ----------
    def tategu_rows(self):
        rows = []
        for d in self.windows + self.doors:
            w, h = d["w"], d["h"]
            if d["code"] in self.tbl_size:
                dim, v = self.tbl_size[d["code"]]
                w, h = (v, h) if dim == "w" else (w, v)
            n = self.tbl_qty.get(d["code"], d["n"])
            rows.append(dict(code=d["code"], name=d["name"], w=w, h=h, n=n))
        return rows

    def make_tategu(self, outdir):
        rows = self.tategu_rows()
        qty = (lambda n: f"{n}ヶ所") if self.qty_text else (lambda n: n)
        f = self.tategu_fmt
        if f.startswith("xl"):
            wb = Workbook()
            ws = wb.active
            ws.title = "建具表"
            ws.append([f"建具表（架空邸{self.idx}）"])
            ws.append([])
            if f == "xl":
                ws.append(["記号", "名称", "W", "H", "数量", "備考"])
                for x in rows:
                    ws.append([x["code"], x["name"], x["w"], x["h"], qty(x["n"]), "Low-E複層"])
            elif f == "xl2":
                ws.append(["符号", "品名", "寸法", None, "箇所数", "備考"])
                ws.merge_cells("C3:D3")
                ws.append([None, None, "W", "H", None, None])
                for x in rows:
                    ws.append([x["code"], x["name"], x["w"], x["h"], qty(x["n"]), ""])
            else:
                ws.append(["記号", "名称", "寸法(W×H)", "数量", "仕様"])
                for x in rows:
                    ws.append([x["code"], x["name"], f"{x['w']}×{x['h']}", qty(x["n"]), ""])
            path = outdir / "建具表.xlsx"
            wb.save(path)
            return path
        path = outdir / "建具表.pdf"
        c = canvas.Canvas(str(path), pagesize=(PW, PH))
        self.draw_frame(c, "建具表", sheet="A-10")
        if f == "pdfrows":
            heads = ["記号", "名称", "W", "H", "数量", "備考"]
            xs = [60, 140, 420, 500, 580, 680]
            c.setFont("JP", 11)
            for x, t in zip(xs, heads):
                c.drawString(x, 760, t)
            c.setFont("JP", 10)
            for i, d in enumerate(rows):
                y = 735 - i * 22
                vals = [d["code"], d["name"], f"{d['w']:,}" if self.r.random() < 0.5 else str(d["w"]), str(d["h"]), str(qty(d["n"])), "Low-E複層"]
                for x, t in zip(xs, vals):
                    c.drawString(x, y, t)
                c.line(50, y - 6, 800, y - 6)
        else:  # 列が記号（縦横が逆の表）
            labels = ["記号", "名称", "W", "H", "数量", "ガラス"]
            per = 7
            for blk in range(0, len(rows), per):
                part = rows[blk:blk + per]
                top = 760 - (blk // per) * 300
                c.setFont("JP", 10)
                for j, t in enumerate(labels):
                    c.drawString(60, top - j * 26, t)
                for i, d in enumerate(part):
                    x = 150 + i * 140
                    vals = [d["code"], d["name"][-6:], f"{d['w']:,}", f"{d['h']:,}", str(qty(d["n"])), "Low-E"]
                    for j, t in enumerate(vals):
                        c.drawString(x, top - j * 26, t)
        c.showPage()
        c.save()
        return path

    # ---------- 仕上表 ----------
    def make_shiage(self, outdir):
        wb = Workbook()
        ws = wb.active
        ws.title = "仕上表"
        ws.append([f"内部仕上表（架空邸{self.idx}）"])
        ws.append([])
        ws.append(["室名", "部位", "仕上", "品番", "備考"])
        for f in self.finishes:
            for room in f["rooms"]:
                ws.append([room, f["part"], f["name"], f["code"], ""])
        wb.save(outdir / "仕上表.xlsx")

    # ---------- 見積 ----------
    def est_rows(self, variant=None):
        rows = []

        def item(code, name, n, unit, price):
            if code in self.excluded:
                return
            n = self.est_qty.get(code, n)
            code = self.est_code.get(code, code)
            rows.append([code, name, n, unit, price])

        rows.append(["■建具工事", None, None, None, None])
        for d in self.windows:
            item(d["code"], d["name"], d["n"], "箇所", 30000 + d["w"] * 20)
        for d in self.doors:
            item(d["code"], d["name"], d["n"], "箇所", 42000)
        rows.append(["■内装工事", None, None, None, None])
        for f in self.finishes:
            item(f["code"], f["name"], len(f["rooms"]) * 12, "㎡", 1500)
        rows.append(["■電気工事", None, None, None, None])
        for l in self.lights:
            item(l["code"], l["name"], l["n"], "台", 6800)
        rows.append([None, "照明器具取付費", 1, "式", 25000])
        rows.append(["■諸経費", None, None, None, None])
        rows.append([None, "現場管理費", 1, "式", 180000])
        rows.append(["APW330", "樹脂窓オプション（参考）", 1, "式", 0])
        return rows

    def write_estimate(self, path, rows, formulas=None):
        wb = Workbook()
        ws = wb.active
        ws.title = "見積"
        ws.append([f"御見積書（架空邸{self.idx}）"])
        ws.append([])
        if self.est_code_in_name:
            ws.append(["品名", "数量", "単位", "単価", "金額"])
            for code, name, n, unit, price in rows:
                if code and str(code).startswith("■"):
                    ws.append([code, None, None, None, None])
                else:
                    ws.append([f"{name} {code}" if code else name, n, unit, price, None])
            qcol, pcol, mcol = "B", "D", "E"
        else:
            ws.append(["品番", "品名", "数量", "単位", "単価", "金額"])
            for row in rows:
                ws.append(row + [None])
            qcol, pcol, mcol = "C", "E", "F"
        for r in range(4, ws.max_row + 1):
            if ws[f"{qcol}{r}"].value is not None:
                ws[f"{mcol}{r}"] = (formulas or {}).get(r, f"={qcol}{r}*{pcol}{r}")
        wb.save(path)

    def make_estimate(self, outdir):
        self.write_estimate(outdir / "見積.xlsx", self.est_rows())

    # ---------- 新旧比較 ----------
    def make_diff(self, outdir):
        r = self.r
        self.shift_dx, self.shift_dy = r.choice([(0, 0), (0, 0), (0, -30), (25, 0), (-18, 22)])
        self.change_room = r.random() < 0.6
        wins, doors, title = self.floors()[0]
        truth = []
        old_wins = [dict(w) for w in wins]
        new_wins = [dict(w) for w in wins]
        changed = r.choice([w for w in new_wins if w["n"] >= 1])
        orig = dict(changed)
        changed["w"] = orig["w"] + 50
        if self.size_style != "none":
            before = size_lines(orig["w"], orig["h"], self.size_style)
            after = size_lines(changed["w"], changed["h"], self.size_style)
            reps = orig["n"] if self.size_every else 1
            for b, a in zip(before, after):
                if b != a:
                    for _ in range(reps):
                        truth.append(dict(type="changed", before=b, after=a))
        for path, old in [(outdir / "平面図_旧.pdf", True), (outdir / "平面図_新.pdf", False)]:
            c = canvas.Canvas(str(path), pagesize=(PW, PH))
            self.draw_frame(c, title, rev="改訂 1" if old else "改訂 2")
            self.draw_grid(c)
            self.draw_plan_page(c, old_wins if old else new_wins, doors, title, old=old, lights=False)
            c.showPage()
            c.save()
        truth.append(dict(type="changed", before="改訂 1", after="改訂 2"))
        truth.append(dict(type="added", after="収納"))
        truth.append(dict(type="changed", before="2730", after="3640"))
        if self.change_room:
            truth.append(dict(type="changed", before="洋室2", after="書斎"))

        # 見積の新旧
        old_rows = self.est_rows()
        new_rows = [list(x) for x in old_rows]
        etruth = []
        items = [i for i, x in enumerate(new_rows) if x[0] and not str(x[0]).startswith("■") and x[2] is not None and x[0] not in ("APW330",)]
        i = r.choice(items)
        new_rows[i][2] = new_rows[i][2] + 2
        etruth.append(dict(type="changed", key=new_rows[i][0], col="数量"))
        j = r.choice([k for k in items if k != i])
        removed = new_rows.pop(j)
        etruth.append(dict(type="removed", key=removed[0]))
        ins = r.choice([k for k in range(1, len(new_rows)) if new_rows[k][0] and str(new_rows[k][0]).startswith("■")])
        new_rows.insert(ins, ["HB-1", "収納 枕棚・ハンガーパイプ", 1, "式", 18000])
        etruth.append(dict(type="added", key="HB-1"))
        self.write_estimate(outdir / "見積_旧.xlsx", old_rows)
        self.write_estimate(outdir / "見積_新.xlsx", new_rows)
        return truth, etruth

    def build(self, outdir):
        outdir.mkdir(parents=True, exist_ok=True)
        self.make_plan(outdir / "平面図.pdf")
        tpath = self.make_tategu(outdir)
        self.make_shiage(outdir)
        self.make_estimate(outdir)
        dtruth, etruth = self.make_diff(outdir)
        recalc(sorted(outdir.glob("見積*.xlsx")))
        docs = ["平面図.pdf"] + (["電気図.pdf"] if self.elec_sheet else []) + [tpath.name, "仕上表.xlsx", "見積.xlsx"]
        meta = {k: getattr(self, k) for k in ["code_style", "size_style", "size_every", "tategu_fmt", "qty_text",
                                              "est_code_in_name", "light_labels", "elec_sheet", "two_floors", "noise", "note_codes"]}
        return dict(id=outdir.name, docs=docs, style=meta, cross=self.truth,
                    diffPdf=dtruth, diffXlsx=etruth)


def recalc(paths):
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        return
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([soffice, "--headless", "--calc", "--convert-to", "xlsx", "--outdir", tmp, *map(str, paths)],
                       check=False, capture_output=True, timeout=600)
        for p in paths:
            out = Path(tmp) / p.name
            if out.exists():
                shutil.move(str(out), p)


def main():
    out = Path(sys.argv[1])
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 24
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    out.mkdir(parents=True, exist_ok=True)
    cases = []
    for i in range(1, n + 1):
        p = Project(i, random.Random(seed * 1000 + i))
        cases.append(p.build(out / f"p{i:02d}"))
    (out / "truth.json").write_text(json.dumps(cases, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{n} 物件を作りました: {out}")


if __name__ == "__main__":
    main()
