"""extract.py の area.json と敷地の設定から、画面で読む敷地データ（sites/<記号>.json）を作る。

使い方:
  python3 tools/build_data.py --area <area.json> --site <敷地の設定.json> --out public/sites/<記号>.json [--plateau <plateau.json>]

--plateau を付けると、建物は PLATEAU（tools/plateau.py）の形と実測の高さを使う（道路・水路は地理院のまま）。

敷地の設定（リポジトリの外に置く）:
  {
    "name": "画面に出す敷地の名前",
    "note": "敷地の説明（面積など）",
    "lotNote": "敷地の形の出どころ（測量図・地図から概算 など）",
    "lot": [[x, z], ...]                     ← 敷地の角（x=東, z=南, m）。または↓
    "lotRect": {"w": 18.6, "d": 53.3, "angle": 0, "cx": 0, "cz": 0},
                                              ← 間口 w（東西）×奥行 d（南北）の長方形を angle 度（時計回り）回して中心 (cx, cz) に置く
    "labels": [{"t": "道路の名前", "x": 0, "z": 0, "size": 12, "y": 6}]
  }

建物の高さは地理院データにないので推定する（k は種類。画面で階数を直せる）:
  3101 普通 → 2階 6m前後＋切妻（22%は平屋3.3m）。260㎡超は陸屋根6.5〜9m（k=l）
  3102 堅ろう → 9〜16m（k=s）、3111 無壁舎 → 3m（k=n）
"""
import argparse, json, math, os, random, sys

ROOFC = ['#3d4046', '#4a4f57', '#5b4a3f', '#2f3a4a', '#6b6f73', '#34302d', '#7a5a44']
WALLC = ['#efece6', '#e6e1d8', '#d9d4cb', '#f4f2ee', '#cfc8bd', '#e9e4dc', '#bfb6aa', '#dcd6cc']


def inpoly(x, z, P):
    r = False
    j = len(P) - 1
    for i in range(len(P)):
        xi, zi = P[i]
        xj, zj = P[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
            r = not r
        j = i
    return r


def area(P):
    return abs(sum(P[i][0] * P[i - 1][1] - P[i - 1][0] * P[i][1] for i in range(len(P)))) / 2


def obb(P):
    """建物の外形に一番小さく合う長方形（棟の向きを決める）"""
    best = None
    for i in range(len(P)):
        x1, z1 = P[i - 1]
        x2, z2 = P[i]
        L = math.hypot(x2 - x1, z2 - z1)
        if L < 0.5:
            continue
        ux, uz = (x2 - x1) / L, (z2 - z1) / L
        us = [p[0] * ux + p[1] * uz for p in P]
        vs = [-p[0] * uz + p[1] * ux for p in P]
        A = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or A < best[0]:
            best = (A, ux, uz, min(us), max(us), min(vs), max(vs))
    A, ux, uz, u0, u1, v0, v1 = best
    if (u1 - u0) < (v1 - v0):  # 長辺方向を棟にする
        ux, uz, u0, u1, v0, v1 = -uz, ux, v0, v1, -u1, -u0
    cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
    return {'cx': round(cu * ux - cv * uz, 2), 'cz': round(cu * uz + cv * ux, 2), 'ux': round(ux, 4), 'uz': round(uz, 4),
            'L': round(u1 - u0, 2), 'W': round(v1 - v0, 2)}


def lot_of(site):
    if 'lot' in site:
        return site['lot']
    r = site['lotRect']
    a = math.radians(r.get('angle', 0))
    c, s = math.cos(a), math.sin(a)
    w, d = r['w'] / 2, r['d'] / 2
    return [[round(r.get('cx', 0) + x * c - z * s, 2), round(r.get('cz', 0) + x * s + z * c, 2)]
            for x, z in ((-w, -d), (w, -d), (w, d), (-w, d))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--area', required=True)
    ap.add_argument('--site', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--plateau', help='tools/plateau.py の出力。あれば建物はこちらを使う')
    ap.add_argument('--terrain', help='tools/terrain.py の出力。あれば地面の高さと遠くの山を入れる')
    a = ap.parse_args()
    d = json.load(open(a.area))
    site = json.load(open(a.site))
    random.seed(a.seed)
    LOT = lot_of(site)

    B = []
    removed = 0
    PL = json.load(open(a.plateau)) if a.plateau else None
    for b in (PL['b'] if PL else []):
        P = b['p']
        if len(P) < 3:
            continue
        if inpoly(sum(x for x, z in P) / len(P), sum(z for x, z in P) / len(P), LOT):
            removed += 1
            continue
        A = area(P)
        if A < 4:
            continue
        o = {'p': P, 'm': 1, 'mt': b['h']}  # m=1：高さは実測（mt は実測の高さそのもの）
        if b.get('fl'):
            o['fl'] = b['fl']
        if b.get('c') in (3003, 3004):          # 屋根だけ（車庫・倉庫など）
            o.update(k='n', h=b['h'], r='f', wc='#a9a8a3')
        elif b.get('s') == 601 and b['h'] <= 12:  # 木造：実測の高さを棟とみなし、切妻の軒の高さを逆算
            ob = obb(P)
            rise = min(ob['W'] / 2 * .45, 2.5)
            o.update(k='w', h=round(max(2.4, b['h'] - rise), 2), r='g', wc=random.choice(WALLC), rc=random.choice(ROOFC), o=ob)
        elif A > 260 and b['h'] < 10:
            o.update(k='l', h=b['h'], r='f', wc=random.choice(['#d6d3cc', '#c4c1ba', '#e0ddd6']))
        else:
            o.update(k='s', h=b['h'], r='f', wc=random.choice(['#d8d6d0', '#c9c6bf', '#e2ded6', '#bcbab4']))
        B.append(o)
    for b in ([] if PL else d['b']):
        P = b['p'][:-1] if b['p'][0] == b['p'][-1] else b['p']
        if len(P) < 3:
            continue
        if inpoly(sum(x for x, z in P) / len(P), sum(z for x, z in P) / len(P), LOT):
            removed += 1  # 敷地の中の今の建物は消す（建て替え前提）
            continue
        A = area(P)
        if A < 4:
            continue
        o = {'p': P}
        if b['c'] == 3102:
            o.update(k='s', h=round(random.uniform(9, 16), 1), r='f', wc=random.choice(['#d8d6d0', '#c9c6bf', '#e2ded6', '#bcbab4']))
        elif b['c'] == 3111:
            o.update(k='n', h=3.0, r='f', wc='#a9a8a3')
        elif A > 260:
            o.update(k='l', h=round(random.uniform(6.5, 9), 1), r='f', wc=random.choice(['#d6d3cc', '#c4c1ba', '#e0ddd6']))
        else:
            one = random.random() < .22
            o.update(k='w', h=3.3 if one else round(random.uniform(5.8, 6.4), 1), r='g', wc=random.choice(WALLC), rc=random.choice(ROOFC), o=obb(P))
        B.append(o)
    TR = json.load(open(a.terrain)) if a.terrain else None
    W = {0: 3, 1: 4.5, 2: 8, 3: 14, 4: 20}
    RD = [{'p': r['p'], 'w': W.get(r['rnkWidth'], 4)} for r in d['r'] if r['ftCode'] in (2701, 2711)]
    EDGE = [r['p'] for r in d['r'] if r['ftCode'] in (2201, 2203)]
    WA = [w['p'] for w in d['w']]
    out = {'name': site.get('name', ''), 'note': site.get('note', ''), 'lotNote': site.get('lotNote', ''),
           'src': (PL.get('src') or 'PLATEAU') if PL else '地理院',
           'hNote': '建物の形と高さは3D都市モデル（PLATEAU・国土交通省）の実測。木造は実測の高さを棟とし、4.5寸の切妻で軒の高さを逆算' if PL else '',
           'lat': d.get('lat', site.get('lat')), 'lon': d.get('lon', site.get('lon')),
           'labels': site.get('labels', []), 'lot': LOT, 'b': B, 'r': RD, 'e': EDGE, 'w': WA}
    if TR:  # 地面の高さと遠くの山（tools/terrain.py）
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from terrain import apply_terrain
        apply_terrain(out, TR)
    json.dump(out, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('建物', len(B), '敷地の中で消した建物', removed, '道路', len(RD), '道路のふち', len(EDGE), '敷地面積', round(area(LOT), 1), '㎡')


if __name__ == '__main__':
    main()
