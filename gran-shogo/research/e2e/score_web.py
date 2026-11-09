# MARKUP の結果（<DATA>/<記号>/web.json）を正解表（research/truth.json）で採点する
# 使い方: python3 score_web.py <DATA>
import json, sys, pathlib
HERE = pathlib.Path(__file__).resolve().parent
DATA = pathlib.Path(sys.argv[1])
t = json.load(open(HERE.parent / 'truth.json', encoding='utf-8'))
J = {'ok': 'R', 'ng': 'N', 'memo': 'M', 'wait': '?'}
ok = n = fr = fn = 0; bad = []; mm = [0, 0]; miss = []
for case in ['hi', 'or', 'se', 'nu']:
    rep = json.load(open(DATA / case / 'web.json'))
    # 正解表の番号は、試作で拾った書き込みの箱（labels/<記号>_boxes.json）に付いている。箱の中心で今の結果と突き合わせる
    base = json.load(open(HERE / 'labels' / f'{case}_boxes.json'))
    for pb in base:
        pr = [p for p in rep if p['p'] == pb['scan_page']]
        if not pr: continue
        for ib in pb['items']:
            k = f"{case}{pb['scan_page']}-{ib['no']}"; tr = t.get(k, ['?'])[0]
            bx, by, bw, bh = ib['box']; cx, cy = bx + bw / 2, by + bh / 2
            cand = [i for i in pr[0]['items'] if i['box'][0] <= cx <= i['box'][0] + i['box'][2] and i['box'][1] <= cy <= i['box'][1] + i['box'][3]]
            best = min(cand, key=lambda i: (i['box'][0] + i['box'][2] / 2 - cx) ** 2 + (i['box'][1] + i['box'][3] / 2 - cy) ** 2, default=None)
            if best is None:
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
