#!/usr/bin/env bash
# 日本郵便の郵便番号マスタ (KEN_ALL UTF-8 版 + 事業所個別郵便番号) を data/ に取得する。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
BASE=https://www.post.japanpost.jp/service/search/zipcode/download

curl -fsSL "$BASE/utf/zip/utf_ken_all.zip" -o data/utf_ken_all.zip
unzip -o -q data/utf_ken_all.zip -d data
# utf_ken_all.zip は utf_ken_all.csv を含む

curl -fsSL "$BASE/office/zip/jigyosyo.zip" -o data/jigyosyo.zip
unzip -o -q data/jigyosyo.zip -d data
iconv -f CP932 -t UTF-8 data/JIGYOSYO.CSV > data/jigyosyo_utf8.csv

echo "KEN_ALL:   $(wc -l < data/utf_ken_all.csv) rows"
echo "JIGYOSYO:  $(wc -l < data/jigyosyo_utf8.csv) rows"
