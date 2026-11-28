"""国土地理院の標高タイルから、敷地まわりの地面の高さと、遠くの山の稜線（方角ごとの見上げる角度）を作る。

使い方:
  python3 tools/terrain.py --lat 35.0 --lon 136.0 --cache <タイルを置くフォルダ> --out <terrain.json>
  python3 tools/terrain.py --apply <terrain.json> --site-json <sites/記号.json>   ← できている敷地データに地形を足す

- 地面：基盤地図情報 数値標高モデル 5m メッシュ（航空レーザー測量 dem5a。なければ写真測量 dem5b、なければ 10m の dem）を、
  敷地を中心に --radius m の四角へ --step m 間隔で読む（標高 T.P. m）
- 稜線：10m メッシュ（ズーム11・約70m 間隔）で半径 --far m まで、方角 1度ごとに「山が見える高さの角度」を出す。
  地球が丸いぶん（と大気の屈折）を引いてある。この角度より太陽が低いと、山に隠れて日が当たらない
出力は build_data.py の --terrain で使う。
"""
import argparse, io, json, math, os, sys, urllib.request
from PIL import Image

URL = 'https://cyberjapandata.gsi.go.jp/xyz/{kind}/{z}/{x}/{y}.png'


class Tiles:
    def __init__(self, kinds, z, cache):
        self.kinds, self.z, self.cache, self.mem = kinds, z, cache, {}
        os.makedirs(cache, exist_ok=True)

    def tile(self, kind, x, y):
        key = (kind, x, y)
        if key in self.mem:
            return self.mem[key]
        path = os.path.join(self.cache, f'{kind}_{self.z}_{x}_{y}.png')
        if not os.path.exists(path):
            try:
                urllib.request.urlretrieve(URL.format(kind=kind, z=self.z, x=x, y=y), path)
            except Exception:
                open(path, 'wb').close()  # タイルがない（海や整備されていない所）
        data = open(path, 'rb').read()
        img = Image.open(io.BytesIO(data)).convert('RGB') if data else None
        self.mem[key] = img.load() if img else None
        return self.mem[key]

    def px(self, gx, gy):
        """世界のピクセル位置 → 標高（なければ None）"""
        x, y = int(gx // 256), int(gy // 256)
        for kind in self.kinds:
            t = self.tile(kind, x, y)
            if t is None:
                continue
            r, g, b = t[int(gx % 256), int(gy % 256)]
            if (r, g, b) == (128, 0, 0):
                continue
            v = (r << 16) + (g << 8) + b
            if v >= 1 << 23:
                v -= 1 << 24
            return v * .01
        return None

    def at(self, lat, lon):
        """緯度経度の標高（まわり4点から補間）"""
        n = 2 ** self.z * 256
        gx = (lon + 180) / 360 * n - .5
        la = math.radians(lat)
        gy = (1 - math.log(math.tan(la) + 1 / math.cos(la)) / math.pi) / 2 * n - .5
        x0, y0 = math.floor(gx), math.floor(gy)
        fx, fy = gx - x0, gy - y0
        vs = [(self.px(x0 + i, y0 + j), (fx if i else 1 - fx) * (fy if j else 1 - fy)) for i in (0, 1) for j in (0, 1)]
        vs = [(v, w) for v, w in vs if v is not None]
        if not vs:
            return None
        return sum(v * w for v, w in vs) / sum(w for _, w in vs)


def apply_terrain(site, TR):
    """敷地データ（sites/記号.json の中身）に地形を入れる。敷地の中央の地面を 0 とした高さ（cm）にし、建物の足元の高さ y を足す"""
    def T(x, z):
        fi, fj = (x - TR['x0']) / TR['step'], (z - TR['z0']) / TR['step']
        i, j = int(math.floor(fi)), int(math.floor(fj)); u, v = fi - i, fj - j
        g = lambda ii, jj: TR['h'][max(0, min(TR['nz'] - 1, jj)) * TR['nx'] + max(0, min(TR['nx'] - 1, ii))]
        return g(i, j) * (1 - u) * (1 - v) + g(i + 1, j) * u * (1 - v) + g(i, j + 1) * (1 - u) * v + g(i + 1, j + 1) * u * v
    lot = site['lot']
    e0 = T(sum(p[0] for p in lot) / len(lot), sum(p[1] for p in lot) / len(lot))
    site['terr'] = {'x0': TR['x0'], 'z0': TR['z0'], 'step': TR['step'], 'nx': TR['nx'], 'nz': TR['nz'], 'e0': round(e0, 2),
                    'hc': [round((h - e0) * 100) for h in TR['h']], 'src': TR.get('src', '')}
    site['hor'] = TR['hor']
    for o in site['b']:
        o['y'] = round(min(T(x, z) for x, z in o['p']) - e0, 2)  # 建物の角の地面のいちばん低い所
    return site


def main():
    if '--apply' in sys.argv:
        ap = argparse.ArgumentParser(); ap.add_argument('--apply', required=True); ap.add_argument('--site-json', required=True)
        a = ap.parse_args()
        site = apply_terrain(json.load(open(a.site_json, encoding='utf-8')), json.load(open(a.apply)))
        json.dump(site, open(a.site_json, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
        print('地形を足しました', a.site_json, '敷地の中央の標高', site['terr']['e0'])
        return
    ap = argparse.ArgumentParser()
    ap.add_argument('--lat', type=float, required=True)
    ap.add_argument('--lon', type=float, required=True)
    ap.add_argument('--cache', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--radius', type=float, default=350, help='地面を読む範囲（四角の半分）m')
    ap.add_argument('--step', type=float, default=5, help='地面を読む間隔 m')
    ap.add_argument('--far', type=float, default=30000, help='山を探す範囲 m')
    a = ap.parse_args()
    LAT, LON = a.lat, a.lon
    mx, my = 111320 * math.cos(math.radians(LAT)), 110950
    ll = lambda x, z: (LAT - z / my, LON + x / mx)

    near = Tiles(['dem5a_png', 'dem5b_png'], 15, a.cache)
    coarse = Tiles(['dem_png'], 14, a.cache)
    n = int(round(2 * a.radius / a.step)) + 1
    x0 = -a.radius
    H = []
    for j in range(n):
        for i in range(n):
            la, lo = ll(x0 + i * a.step, x0 + j * a.step)
            v = near.at(la, lo)
            if v is None:
                v = coarse.at(la, lo)
            H.append(None if v is None else round(v, 2))
    vals = [v for v in H if v is not None]
    if not vals:
        raise SystemExit('標高が読めませんでした')
    mean = sum(vals) / len(vals)
    H = [mean if v is None else v for v in H]
    e0 = near.at(LAT, LON) or coarse.at(LAT, LON) or mean

    # 遠くの山の稜線：方角ごとに、見える角度の最大
    far = Tiles(['dem_png'], 11, a.cache)
    R_EARTH, K = 6371000, .13  # 大気の屈折係数
    hor = []
    for az in range(360):
        dx, dz = math.sin(math.radians(az)), -math.cos(math.radians(az))
        best, r = 0.0, 300.0
        while r <= a.far:
            v = far.at(*ll(dx * r, dz * r))
            if v is not None:
                drop = r * r / (2 * R_EARTH) * (1 - K)
                best = max(best, math.degrees(math.atan2(v - drop - (e0 + 1.5), r)))
            r += 60 if r < 3000 else 120
        hor.append(round(best, 2))
    out = {'x0': x0, 'z0': x0, 'step': a.step, 'nx': n, 'nz': n, 'e0': round(e0, 2), 'h': H, 'hor': hor,
           'src': '国土地理院 基盤地図情報 数値標高モデル（5m・10m）'}
    json.dump(out, open(a.out, 'w'), separators=(',', ':'))
    print('地面', n, '×', n, '点', '標高', round(min(vals), 2), '〜', round(max(vals), 2), 'm', 'ピンの標高', round(e0, 2))
    top = sorted(range(360), key=lambda k: -hor[k])[:5]
    print('山がいちばん高く見える方角', [(k, hor[k]) for k in top])


if __name__ == '__main__':
    main()
