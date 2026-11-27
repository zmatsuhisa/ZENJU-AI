"""地理院ベクトルタイル（z16 .pbf）から、敷地まわりの建物・道路・水路を取り出す。

使い方:
  python3 tools/extract.py --lat 35.0 --lon 136.0 --tiles <タイルを置くフォルダ> --out <area.json> [--download]

--download を付けると、足りないタイル（敷地を中心に 3×3 枚）を地理院から取ってくる。
座標は 原点＝ピン位置、x=東、z=南、単位 m。
"""
import argparse, glob, json, math, os, re, urllib.request
from collections import Counter

import mapbox_vector_tile as mvt

Z = 16
URL = 'https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap/16/{x}/{y}.pbf'


def tile_of(lat, lon):
    n = 2 ** Z
    x = (lon + 180) / 360 * n
    la = math.radians(lat)
    y = (1 - math.log(math.tan(la) + 1 / math.cos(la)) / math.pi) / 2 * n
    return int(x), int(y)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lat', type=float, required=True)
    ap.add_argument('--lon', type=float, required=True)
    ap.add_argument('--tiles', required=True, help='タイル（x_y.pbf）を置くフォルダ')
    ap.add_argument('--out', required=True)
    ap.add_argument('--radius', type=float, default=330, help='取り出す半径 m')
    ap.add_argument('--download', action='store_true')
    a = ap.parse_args()
    LAT, LON, R = a.lat, a.lon, a.radius

    os.makedirs(a.tiles, exist_ok=True)
    if a.download:
        cx, cy = tile_of(LAT, LON)
        for x in (cx - 1, cx, cx + 1):
            for y in (cy - 1, cy, cy + 1):
                p = os.path.join(a.tiles, f'{x}_{y}.pbf')
                if not os.path.exists(p):
                    urllib.request.urlretrieve(URL.format(x=x, y=y), p)

    N = 2 ** Z
    mx = 111320 * math.cos(math.radians(LAT))
    my = 110950

    def ll(tx, ty, px, py, ext):
        lon = (tx + px / ext) / N * 360 - 180
        yy = (ty + py / ext) / N
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy))))
        return lon, lat

    def loc(lon, lat):
        return ((lon - LON) * mx, (LAT - lat) * my)

    B, RD, W = [], [], []
    files = sorted(glob.glob(os.path.join(a.tiles, '*.pbf')))
    if not files:
        raise SystemExit('タイルがありません。--download を付けて取ってきてください')
    for f in files:
        tx, ty = map(int, re.findall(r'\d+', os.path.basename(f))[:2])
        d = mvt.decode(open(f, 'rb').read(), default_options={'y_coord_down': True})

        def conv(ring, ext):
            return [loc(*ll(tx, ty, p[0], p[1], ext)) for p in ring]

        for k, arr in (('building', B), ('waterarea', W)):
            if k not in d:
                continue
            ext = d[k]['extent']
            for ft in d[k]['features']:
                g = ft['geometry']
                polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates'] if g['type'] == 'MultiPolygon' else []
                for p in polys:
                    ring = conv(p[0], ext)
                    cx = sum(q[0] for q in ring) / len(ring)
                    cz = sum(q[1] for q in ring) / len(ring)
                    if math.hypot(cx, cz) <= R:
                        arr.append({'c': ft['properties'].get('ftCode'), 'p': [[round(q[0], 1), round(q[1], 1)] for q in ring]})
        if 'road' in d:
            ext = d['road']['extent']
            for ft in d['road']['features']:
                g = ft['geometry']
                ls = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates'] if g['type'] == 'MultiLineString' else []
                for l in ls:
                    pts = conv(l, ext)
                    if any(math.hypot(q[0], q[1]) <= R + 40 for q in pts):
                        RD.append({'p': [[round(q[0], 1), round(q[1], 1)] for q in pts],
                                   **{k: ft['properties'].get(k) for k in ('ftCode', 'rnkWidth', 'rdCtg', 'lvOrder')}})

    print('建物', len(B), dict(Counter(b['c'] for b in B)), '道路', len(RD), '水路', len(W))
    json.dump({'lat': LAT, 'lon': LON, 'b': B, 'r': RD, 'w': W}, open(a.out, 'w'))
    near = sorted(B, key=lambda b: min(math.hypot(*q) for q in b['p']))[:6]
    print('ピンに近い建物:')
    for b in near:
        print(' ', b['c'], b['p'][:6])


if __name__ == '__main__':
    main()
