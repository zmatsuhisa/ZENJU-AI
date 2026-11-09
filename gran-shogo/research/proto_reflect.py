"""試作v2：打合せ前の版・手書きスキャン・打合せ後の版の3つで、修正指示の反映を判定する。
使い方: python3 proto_reflect2.py <スキャンPDF> <打合せ前PDF> <打合せ後PDF> <出力フォルダ>
- 手書き＝スキャン − 打合せ前の版（位置合わせのあと、版にない線・色）
- 反映＝手書きの場所で、打合せ前の版と打合せ後の版の線が変わったか（CADどうしなのでノイズが少ない）
- 指示外の変更＝打合せ前→後で変わったのに、手書きがない場所
"""
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

DPI = 110
K = lambda n: np.ones((n, n), np.uint8)


def render(pdf, prefix, out):
    import pymupdf
    doc = pymupdf.open(pdf)
    imgs, words = [], []
    for i, page in enumerate(doc):
        f = out / f"{prefix}-{i+1:02d}.png"
        if not f.exists():
            page.get_pixmap(dpi=DPI).save(str(f))
        imgs.append(cv2.imread(str(f)))
        sc = DPI / 72
        words.append([(w[0]*sc, w[1]*sc, w[2]*sc, w[3]*sc, w[4]) for w in page.get_text("words")])
    return imgs, words


def text_diff(wb, wa, Hinv, shape):
    """打合せ前と後で、同じ場所の文字が変わったところ（900→910 など）"""
    m = np.zeros(shape, np.uint8)
    if Hinv is not None and wa:
        pts = np.float32([[(w[0]+w[2])/2, (w[1]+w[3])/2] for w in wa]).reshape(-1, 1, 2)
        pts = cv2.perspectiveTransform(pts, Hinv).reshape(-1, 2)
        wa = [(px-(w[2]-w[0])/2, py-(w[3]-w[1])/2, px+(w[2]-w[0])/2, py+(w[3]-w[1])/2, w[4]) for (px, py), w in zip(pts, wa)]
    def unmatched(A, B):
        res = []
        for a in A:
            ca = ((a[0]+a[2])/2, (a[1]+a[3])/2)
            if not any(b[4] == a[4] and abs((b[0]+b[2])/2-ca[0]) < 8 and abs((b[1]+b[3])/2-ca[1]) < 8 for b in B):
                res.append(a)
        return res
    for w in unmatched(wb, wa) + unmatched(wa, wb):
        cv2.rectangle(m, (int(w[0]), int(w[1])), (int(w[2]), int(w[3])), 255, -1)
    return m


def drawn(img):
    """線・文字・色（白い紙以外）"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    return (((hsv[..., 2] < 165) | (hsv[..., 1] > 60)) & ~((hsv[..., 1] < 25) & (hsv[..., 2] > 200))).astype(np.uint8) * 255


ORB = cv2.ORB_create(8000)
BF = cv2.BFMatcher(cv2.NORM_HAMMING)


def affine(a_gray, b_gray):
    k1, d1 = ORB.detectAndCompute(a_gray, None)
    k2, d2 = ORB.detectAndCompute(b_gray, None)
    if d1 is None or d2 is None:
        return 0, None
    good = [m for m, n in (x for x in BF.knnMatch(d1, d2, k=2) if len(x) == 2) if m.distance < 0.75 * n.distance]
    if len(good) < 25:
        return len(good), None
    src = np.float32([k1[g.queryIdx].pt for g in good]).reshape(-1, 1, 2)
    dst = np.float32([k2[g.trainIdx].pt for g in good]).reshape(-1, 1, 2)
    H, inl = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
    return (int(inl.sum()) if inl is not None else 0), H


def best_page(img, pages):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    res = [affine(g, cv2.cvtColor(p, cv2.COLOR_BGR2GRAY)) for p in pages]
    i = int(np.argmax([r[0] for r in res]))
    return i, res[i]


def main(scan_pdf, base_pdf, after_pdf, out):
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    scans, _ = render(scan_pdf, "s", out)
    bases, wbases = render(base_pdf, "b", out)
    afters, wafters = render(after_pdf, "a", out)
    report = []
    for si, scan in enumerate(scans, 1):
        bi, (inl, H) = best_page(scan, bases)
        if H is None or inl < 250:
            report.append({"scan_page": si, "note": "打合せ前の版に合うページがない（表紙・メモなど）", "inliers": inl})
            continue
        base = bases[bi]
        h, w = base.shape[:2]
        warped = cv2.warpPerspective(scan, H, (w, h), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))
        # 細かい位置ずれを ECC でもう一段合わせる
        try:
            wg = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
            bg = cv2.cvtColor(base, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
            M = np.eye(3, 3, dtype=np.float32)
            _, M = cv2.findTransformECC(cv2.GaussianBlur(bg, (5, 5), 0), cv2.GaussianBlur(wg, (5, 5), 0), M, cv2.MOTION_HOMOGRAPHY,
                                        (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-5), None, 5)
            warped = cv2.warpPerspective(warped, M, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderValue=(255, 255, 255))
        except cv2.error:
            pass
        ai, (inl2, H2) = best_page(base, afters)
        after = cv2.warpPerspective(afters[ai], np.linalg.inv(H2), (w, h), borderValue=(255, 255, 255)) if H2 is not None else None
        # 手書き：スキャンにあって打合せ前の版にない
        # 色ペン：版に色のない所の色 ／ 黒ペン：版の線から少し離れた所の黒（印刷で太った線は除く）
        hsv_s, hsv_b = cv2.cvtColor(warped, cv2.COLOR_BGR2HSV), cv2.cvtColor(base, cv2.COLOR_BGR2HSV)
        col_s = ((hsv_s[..., 1] > 70) & (hsv_s[..., 2] > 60)).astype(np.uint8) * 255
        col_b = ((hsv_b[..., 1] > 40)).astype(np.uint8) * 255
        dark_s = (cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) < 110).astype(np.uint8) * 255
        any_b = (cv2.cvtColor(base, cv2.COLOR_BGR2GRAY) < 235).astype(np.uint8) * 255
        hand = cv2.bitwise_or(cv2.bitwise_and(col_s, cv2.bitwise_not(cv2.dilate(col_b | any_b, K(9)))),
                              cv2.bitwise_and(dark_s, cv2.bitwise_not(cv2.dilate(any_b, K(15)))))
        hand = cv2.morphologyEx(hand, cv2.MORPH_OPEN, K(2))
        border = np.zeros_like(hand); m = 25; border[m:-m, m:-m] = 255  # スキャンの縁の影は除く
        hand = cv2.bitwise_and(hand, border)
        groups = cv2.dilate(hand, K(41))
        n, lab, stats, _ = cv2.connectedComponentsWithStats(groups)
        # 打合せ前→後の変化（CADどうし）
        if after is not None:
            # 形の違いだけを見る：白以外を「描いてある」とする（線の色の変化は数えない）
            pb = (cv2.cvtColor(base, cv2.COLOR_BGR2GRAY) < 225).astype(np.uint8) * 255
            pa = (cv2.cvtColor(after, cv2.COLOR_BGR2GRAY) < 225).astype(np.uint8) * 255
            diff = (((pb > 0) & (cv2.dilate(pa, K(5)) == 0)) | ((pa > 0) & (cv2.dilate(pb, K(5)) == 0))).astype(np.uint8) * 255
            tdiff = text_diff(wbases[bi], wafters[ai], np.linalg.inv(H2), diff.shape)
            diff = cv2.bitwise_or(diff, tdiff)
            # 小さな文字の書き換えを消さないよう、開閉処理ではなく「孤立した数ピクセルの点」だけ消す
            nn, ll, ss, _ = cv2.connectedComponentsWithStats(diff, connectivity=8)
            keep = np.zeros(nn, bool); keep[1:] = ss[1:, cv2.CC_STAT_AREA] >= 4
            diff = (keep[ll]).astype(np.uint8) * 255
        else:
            diff = np.zeros_like(hand)
        vis = cv2.addWeighted(after if after is not None else base, 0.5, np.full_like(base, 255), 0.5, 0)
        vis[diff > 0] = (220, 120, 40)
        vis[hand > 0] = (40, 150, 40)
        items, covered = [], np.zeros_like(hand)
        for k in range(1, n):
            x, y, bw, bh, _ = stats[k]
            ink = int((hand[y:y + bh, x:x + bw] > 0).sum())
            if ink < 120:
                continue
            # まっすぐな細長い線だけ（印刷のずれ）は手書きではない
            hb = hand[y:y + bh, x:x + bw]
            ys, xs = np.nonzero(hb)
            if len(xs) and (np.ptp(ys) < 8 or np.ptp(xs) < 8):
                continue
            p = 60  # 矢印で少し離れた所を指すことが多いので広めに見る
            x0, y0, x1, y1 = max(0, x - p), max(0, y - p), min(w, x + bw + p), min(h, y + bh + p)
            ch = int((diff[y0:y1, x0:x1] > 0).sum())
            ok = ch > 25
            covered[y0:y1, x0:x1] = 255
            items.append({"no": len(items) + 1, "box": [int(x0), int(y0), int(x1 - x0), int(y1 - y0)], "ink": ink, "change_px": ch,
                          "judge": "反映あり" if ok else "未反映の疑い"})
            c = (40, 160, 40) if ok else (40, 40, 230)
            cv2.rectangle(vis, (x0, y0), (x1, y1), c, 3)
            cv2.putText(vis, str(len(items)), (x0 + 4, y0 + 28), cv2.FONT_HERSHEY_SIMPLEX, 1.0, c, 2)
            crop = np.hstack([warped[y0:y1, x0:x1], base[y0:y1, x0:x1], (after if after is not None else base)[y0:y1, x0:x1]])
            cv2.imwrite(str(out / f"crop_p{si}_{len(items):02d}.png"), crop)
        # 指示外の変更
        extra = cv2.bitwise_and(cv2.dilate(diff, K(31)), cv2.bitwise_not(covered))
        n2, _, st2, _ = cv2.connectedComponentsWithStats(extra)
        others = []
        for k in range(1, n2):
            x, y, bw, bh, _ = st2[k]
            px = int((diff[y:y + bh, x:x + bw] > 0).sum())
            if px < 150:
                continue
            others.append({"box": [int(x), int(y), int(bw), int(bh)], "change_px": px})
            cv2.rectangle(vis, (x, y), (x + bw, y + bh), (0, 140, 255), 2)
        cv2.imwrite(str(out / f"result_p{si}.png"), vis)
        report.append({"scan_page": si, "base_page": bi + 1, "after_page": ai + 1, "inliers": inl, "items": items, "others": others})
        ok = sum(i["judge"] == "反映あり" for i in items)
        print(f"スキャンp.{si} → 前p.{bi+1}/後p.{ai+1}（一致点{inl}） 指示{len(items)}件：反映あり{ok}・未反映の疑い{len(items)-ok} ／ 指示外の変更{len(others)}か所")
    for r in report:
        if "note" in r:
            print(f"スキャンp.{r['scan_page']}：{r['note']}")
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:5])
