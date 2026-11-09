# ブラウザ版の結果（<case>/web.json）を、試作の正解ラベル（label/truth.json）で採点する
import json, sys
t = json.load(open('label/truth.json')); pref = {'hino': 'hi', 'oribe': 'or', 'senda': 'se', 'numata': 'nu'}
J = {'ok': 'R', 'ng': 'N', 'memo': 'M', 'wait': '?'}
ok = n = fr = fn = 0; bad = []; mm = [0, 0]; miss = []
for case in pref:
    rep = json.load(open(f'{case}/web.json'))
    base = json.load(open(f'{case}/out/report.json'))
    for pb in base:
        pr = [p for p in rep if p['p'] == pb['scan_page']]
        if not pr: continue
        for ib in pb.get('items', []):
            k = f"{pref[case]}{pb['scan_page']}-{ib['no']}"; tr = t.get(k, ['?'])[0]
            bx, by, bw, bh = ib['box']; cx, cy = bx + bw / 2, by + bh / 2
            # 正解の書き込みの中心を含む箱（なければ一番近い箱）
            cand = [i for i in pr[0]['items'] if i['box'][0] <= cx <= i['box'][0] + i['box'][2] and i['box'][1] <= cy <= i['box'][1] + i['box'][3]]
            best = min(cand or pr[0]['items'], key=lambda i: (i['box'][0] + i['box'][2] / 2 - cx) ** 2 + (i['box'][1] + i['box'][3] / 2 - cy) ** 2, default=None)
            if best is None or not cand:
                if tr in 'RN': miss.append(k)
                continue
            p = J[best['judge']]
            if tr == 'M': mm[1] += 1; mm[0] += p == 'M'
            if tr not in 'RN': continue
            n += 1; ok += p == tr
            if tr == 'N' and p == 'R': fr += 1; bad.append(k)
            if tr == 'R' and p != 'R': fn += 1; bad.append(k + '(' + p + ')')
print(f"指示 {ok}/{n} 正解 ／ 未反映→反映の誤り {fr} ／ 反映→未反映の誤り {fn} ／ 誤り {bad} ／ 見落とし {miss}")
print(f"指示ではない書き込みをメモと判定: {mm[0]}/{mm[1]}")
