# gran-sun3d（日照3D）

敷地のまわり半径約300mの街並みを、国土地理院のベクトルタイルから3Dで組み立てて、
日付・時刻ごとの影と、敷地の直射日照時間を確かめるブラウザのツール。
計算はすべてブラウザの中（three.js と `public/js/sun.js`）で行い、外へは何も送らない。

## できること
- 日付・時刻を動かして、街の影と太陽の位置を見る（冬至・春分・夏至・秋分はボタン1つ）
- 敷地の日照時間マップ（1m間隔）
- **まわりの建物の高さを直す**：3Dで建物を押す（または「敷地に影を落とす建物」の「選ぶ」）→ 階数を ＋／− 。
  直した高さはその端末に残る（`localStorage` の `gos-sun-h-<記号>`）
- **敷地に影を落とす建物**：選んだ日に、敷地へ長く影を落としている建物の上位5棟と、その時間
- **計画の建物を置いて比べる**：平屋／2階建ての箱を置いて、南の庭（平均）と1階LDKの窓（南の面のまん中・床から1.2m）の
  日照時間を、冬至・春分・夏至で並べて比べる。大きさ・位置はスライダー、パソコンでは3Dの箱を引っぱって動かせる
- 敷地が2つ以上あれば、右上で切り替え

## 動かし方
```
cd gran-sun3d
SITES=<敷地データのフォルダ> npm start   # → http://127.0.0.1:3986/?site=<記号>
npm test                                 # 太陽の位置・影の判定・計画の建物の計算（7件）
```
敷地データ（`sites/index.json` と `sites/<記号>.json`）はお客様の敷地の位置と形なので、**リポジトリに入れない**。
リポジトリの外のフォルダに置いて `SITES` で渡す（`public/sites/` は .gitignore 済み）。

`sites/index.json` の形：`[{"key": "ha", "name": "画面に出す名前"}, ...]`

## 敷地データの作り方
1. 地理院のタイルから建物・道路・水路を取り出す（タイルは `--download` で 3×3 枚取ってくる）
   ```
   python3 tools/extract.py --lat <緯度> --lon <経度> --tiles <タイルのフォルダ> --out <area.json> --download
   ```
   （`pip install mapbox-vector-tile` が必要）
2. 敷地の設定ファイル（リポジトリの外）を書く。形は `tools/build_data.py` の先頭に説明あり。
   敷地は角の座標 `lot`、または長方形 `lotRect`（間口・奥行・向き・中心）で書ける
3. 画面用のデータを作る
   ```
   python3 tools/build_data.py --area <area.json> --site <敷地の設定.json> --out <SITESのフォルダ>/<記号>.json
   ```
4. `sites/index.json` に足す

## 決まりごと
- 座標は 原点＝ピン位置、x=東、z=南（three.js では -z が北）、単位 m
- 建物の高さは地理院データにないので推定（木造2階6m前後＋切妻・22%は平屋3.3m、堅ろう9〜16m、大型6.5〜9m、無壁舎3m）
- 日照は建物の平面形＋高さで判定（10分刻み）。木と車は計算に入れない
- 階数⇔高さ：木造 1階3.3m・2階6.2m・3階9.1m（＋切妻）、鉄骨・RC 3.5m×階＋0.5m
- 計画の建物：平屋の軒3.3m・2階の軒6.2m に 4.5寸の切妻。棟は東西。向きは敷地のいちばん長い辺に合わせる
- 見た目は `public/gran-os-base.css`（グランOS v2.1。値は変えない）、このアプリだけの部品は `public/app.css`

## ファイル
```
public/index.html   画面
public/app.css      このアプリだけの見た目
public/js/sun.js    太陽の位置・影の判定・日照時間・計画の建物の計算（画面とテストで共用）
public/js/app.js    3Dの組み立てと操作（three.js r128）
tools/extract.py    地理院タイル → area.json
tools/build_data.py area.json＋敷地の設定 → sites/<記号>.json
server.js           パソコンで開くための小さなサーバー
test/sun.test.js    計算のテスト
```

## claude.ai の Artifact（スマホで開ける版）にするとき
`public/` の中身と、`SITES` のフォルダの `sites/*.json` を、同じ並び（`sites/…`）で1つの Artifact に載せる。
