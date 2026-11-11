#!/bin/bash
# 正解表のある4物件（hi/or/se/nu）で MARKUP を動かして採点する。
# 使い方: DATA=<テスト用図面のフォルダ> ./run_labeled.sh
#   DATA の中は <記号>/scan.pdf・before.pdf・after.pdf（作り方は research/e2e/README.md）
#   図面はお客様の資料なので、リポジトリの外に置くこと
set -u
: "${DATA:?DATA にテスト用図面のフォルダを指定してください}"
HERE=$(cd "$(dirname "$0")" && pwd)
for c in hi or se nu; do
  timeout 900 node "$HERE/mk-e2e.cjs" "$DATA/$c/web.json" "$DATA/$c/web.png" "$DATA/$c/scan.pdf" "$DATA/$c/before.pdf" "$DATA/$c/after.pdf" > "$DATA/$c/run.log" 2>&1 || echo "FAIL $c（$DATA/$c/run.log を見る）"
done
python3 -I "$HERE/score_web.py" "$DATA"
