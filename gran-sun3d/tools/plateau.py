"""PLATEAU（国交省の3D都市モデル）から、敷地まわりの建物の形と実測の高さを取り出す。

使い方:
  python3 tools/plateau.py --lat 35.0 --lon 136.0 --cache <CityGMLを置くフォルダ> --out <plateau.json> [--download]

--download を付けると、敷地のまわり（半径 --radius m）にかかる3次メッシュ（約1km四方）の建築物ファイル（CityGML）を
PLATEAU のデータカタログ API で探して取ってくる。PLATEAU の建物がない市町村では何も出ない（そのときは地理院の建物を使う）。
出典の表示：「3D都市モデル（Project PLATEAU）国土交通省」

出力（build_data.py の --plateau で使う）:
  {"src": "PLATEAU <市> <年>", "b": [{"p": [[x,z],...], "h": 実測の高さ m, "fl": 地上階数 or null, "s": 構造, "c": 種類, "g": 地面の標高 m}]}
座標は 原点＝ピン位置、x=東、z=南、単位 m（extract.py と同じ）。
"""
import argparse, glob, json, math, os, urllib.request
import xml.etree.ElementTree as ET

API = 'https://api.plateauview.mlit.go.jp/datacatalog/citygml/m:{mesh}'
NS = {'bldg': 'http://www.opengis.net/citygml/building/2.0', 'gml': 'http://www.opengis.net/gml',
      'core': 'http://www.opengis.net/citygml/2.0'}


def mesh3(lat, lon):
    a = lat * 1.5; p = int(a); a2 = (a - p) * 8; q = int(a2); r = int((a2 - q) * 10)
    b = lon - 100; u = int(b); b2 = (b - u) * 8; v = int(b2); w = int((b2 - v) * 10)
    return f'{p}{u}{q}{v}{r}{w}'


def meshes_around(lat, lon, radius):
    dlat, dlon = radius / 110950, radius / (111320 * math.cos(math.radians(lat)))
    out = set()
    for i in range(-4, 5):
        for j in range(-4, 5):
            out.add(mesh3(lat + dlat * i / 4, lon + dlon * j / 4))
    return sorted(out)


def download(lat, lon, radius, cache):
    os.makedirs(cache, exist_ok=True)
    src = []
    for m in meshes_around(lat, lon, radius):
        path = os.path.join(cache, f'{m}_bldg.gml')
        if os.path.exists(path):
            continue
        with urllib.request.urlopen(API.format(mesh=m), timeout=60) as r:
            cat = json.load(r)
        for city in cat.get('cities', []):
            files = city.get('files', {}).get('bldg')
            if files:
                url = files[0]['url']
            elif city.get('url', '').endswith('.zip'):
                # 新しい版で建物のファイルが一覧にないときは、同じ版の置き場所から探す
                url = city['url'][:-4] + f'/udx/bldg/{m}_bldg_6697_op.gml'
            else:
                continue
            try:
                urllib.request.urlretrieve(url, path)
                src.append(f"{city['cityName']} {city.get('year', '')}")
                print('取得', m, city['cityName'], city.get('year'))
                break
            except Exception as e:  # その区画に建物のファイルがない
                print('なし', m, city['cityName'], e)
    return src


def pos(text):
    v = [float(x) for x in text.split()]
    return [(v[i], v[i + 1], v[i + 2]) for i in range(0, len(v), 3)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lat', type=float, required=True)
    ap.add_argument('--lon', type=float, required=True)
    ap.add_argument('--cache', required=True, help='CityGML（<メッシュ>_bldg.gml）を置くフォルダ')
    ap.add_argument('--out', required=True)
    ap.add_argument('--radius', type=float, default=330)
    ap.add_argument('--download', action='store_true')
    a = ap.parse_args()
    LAT, LON, R = a.lat, a.lon, a.radius
    src = download(LAT, LON, R, a.cache) if a.download else []
    sp = os.path.join(a.cache, 'src.txt')  # どの版を取ったか（次に取らずに使うとき用）
    if src:
        open(sp, 'w').write('・'.join(sorted(set(src))))
    elif os.path.exists(sp):
        src = [open(sp).read().strip()]
    mx, my = 111320 * math.cos(math.radians(LAT)), 110950
    loc = lambda la, lo: (round((lo - LON) * mx, 2), round((LAT - la) * my, 2))
    B = []
    for f in sorted(glob.glob(os.path.join(a.cache, '*_bldg.gml'))):
        for _, el in ET.iterparse(f, events=('end',)):
            if el.tag != '{%s}Building' % NS['bldg']:
                continue
            ring = el.find('bldg:lod0RoofEdge//gml:posList', NS)
            if ring is None:
                ring = el.find('bldg:lod0FootPrint//gml:posList', NS)
            solid = el.findall('bldg:lod1Solid//gml:posList', NS)
            if ring is None and solid:  # 形がないときは LOD1 の箱の底から
                zs = [p for s in solid for p in pos(s.text)]
                z0 = min(z for _, _, z in zs)
                ring = next((s for s in solid if all(abs(z - z0) < .01 for _, _, z in pos(s.text))), None)
            if ring is None:
                el.clear(); continue
            pts = [loc(la, lo) for la, lo, _ in pos(ring.text)]
            cx, cz = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
            if math.hypot(cx, cz) > R:
                el.clear(); continue
            mh = el.find('bldg:measuredHeight', NS)
            zs = [z for s in solid for _, _, z in pos(s.text)]
            h = float(mh.text) if mh is not None and float(mh.text) > 0 else (max(zs) - min(zs) if zs else None)
            if not h:
                el.clear(); continue
            st = el.find('bldg:storeysAboveGround', NS)
            fl = int(st.text) if st is not None and st.text and 0 < int(st.text) < 100 else None
            stype = el.find('.//{*}buildingStructureType')
            cls = el.find('bldg:class', NS)
            if pts[0] == pts[-1]:
                pts = pts[:-1]
            B.append({'p': [list(p) for p in pts], 'h': round(h, 1), 'fl': fl,
                      's': int(stype.text) if stype is not None else None, 'c': int(cls.text) if cls is not None else None,
                      'g': round(min(zs), 2) if zs else None})
            el.clear()
    json.dump({'src': 'PLATEAU ' + '・'.join(sorted(set(src))) if src else 'PLATEAU', 'b': B}, open(a.out, 'w'), ensure_ascii=False)
    from collections import Counter
    print('建物', len(B), '構造', dict(Counter(b['s'] for b in B)), '階数あり', sum(1 for b in B if b['fl']))


if __name__ == '__main__':
    main()
