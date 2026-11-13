# ZENJU-AI — Claude Code 向けの決まりごと

グランハウス（注文住宅）の社内ツールを置くリポジトリ。今あるのは `gran-shogo/`（資料照合）と `gran-kanamono/`（金物図の着色。使い方と仕組みは `gran-kanamono/README.md`）。
はじめて触るときは `gran-shogo/HANDOFF.md` → `gran-shogo/README.md` → `gran-shogo/research/README.md` の順に読む。

## 必ず守ること
- **お客様の資料をリポジトリに入れない。** 図面PDF・スキャン・見積・施主名・住所・金額は、コード・テスト・コメント・コミットメッセージ・PR・Issue のどこにも書かない。物件は記号（hi / or / se / nu / ya / ka …）で書く。テスト用の図面はリポジトリの外のフォルダに置き、環境変数 `DATA` で渡す。
- **有料の API を使う仕組みにしない。** 個人開発で費用をかけられないため、判定はブラウザの中の処理（pdf.js・OpenCV.js など無料のオープンソース）で行う。AI照合（Claude API）は「任意・キーがあるときだけ」の今の形から広げない。
- **資料はブラウザの外へ送らない。** PDF の読み込み・照合・書き込みの洗い出しは端末の中で完結させる。外部へ送る処理を足すときは、必ず先に依頼者に相談する。
- 画面の言葉は、現場の人が読んで分かるやさしい日本語にする（専門用語・英語の略語を画面に出さない）。
- 見た目は `public/gran-os-base.css`（グランOS 基本CSS。値を変えない）に合わせ、このアプリだけの部品は `public/app.css` に書く。

## よく使うコマンド（`gran-shogo/` で実行）
- `npm install` … ライブラリと画面用ファイル（public/vendor）を用意
- `npm start` … http://127.0.0.1:3985/ で起動
- `npm test` … 単体テスト（17件。変更したら必ず通す）
- `DATA=<テスト用図面フォルダ> research/e2e/run_labeled.sh` … 正解表のある4物件で MARKUP を採点（今は「指示 40/40 正解」。これを下げる変更は入れない）
- `python3 scripts/build_artifact.py <出力先>` … スマホで開ける claude.ai Artifact 版を作る

`gran-kanamono/` では `npm install` → `npm start`（http://127.0.0.1:3986/）・`npm test`（単体テスト8件）・`node scripts/check.mjs <図面.pdf>`（実物で記号の数を確かめる）。

## 進め方
- 1つの課題 = 1つのブランチ = 1つの PR。課題は GitHub の Issue にある。
- 精度に関わる変更は、変更前後の採点結果（run_labeled.sh の出力）を PR に書く。
- 見た目を変えたら、PC（1440px）とスマホ（390px）で画面を撮って確かめる。
