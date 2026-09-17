# jev-jp-address

日本郵便の郵便番号マスタ (KEN_ALL / JIGYOSYO) をマスターデータとし、
非正規化された日本の住所を **都道府県 → 市区町村 → 町域 → 番地・建物** の順に段階的に正規化して
郵便番号を出力する CLI です。

ルール・マスタ照合で確定できない箇所だけ、AI SDK (`experimental_evaluate`) 経由で
TypeSafe **Jev** に「候補からの選択 (Choice)」を問い、確率・confidence を結果に残します。
Jev はテキストを生成しないため、正規化文字列の組み立ては常にコード側で行います。

```
入力: とうきょうとちよだくかすみがせき2-1-2
正規化: 東京都千代田区霞が関2-1-2
郵便番号: 100-0013
  都道府県: 東京都    [ai p=1.00 conf=1.00]
  市区町村: 千代田区  [ai p=1.00 conf=1.00]
  町域    : 霞が関    [ai p=0.99 conf=0.99]
  番地: 2-1-2  建物: -
  AI: 3 calls, 3009 tokens, 440ms
```

## セットアップ

```sh
npm install
scripts/download-data.sh          # data/utf_ken_all.csv, data/jigyosyo_utf8.csv を取得 (curl/unzip/iconv)
export TYPESAFE_AI_API_KEY=...    # Jev を使う場合のみ
npm run build                     # dist/cli.js
```

Node.js 20 以上。依存は `ai` と `@ai-sdk/typesafe-ai` のみです。

## 使い方

```sh
# 1 件
node dist/cli.js "千代田区麹町三丁目12番14号 ケンオール株式会社"
# 標準入力 (1 行 1 件)、JSON 出力
cat addresses.txt | node dist/cli.js --json
# Jev を使わずルールのみ
node dist/cli.js --no-ai "東京都港区芝浦1-16-1"
# 判定過程を表示
node dist/cli.js --verbose "..."
```

| オプション | 説明 |
|---|---|
| `--master <path>` | KEN_ALL (UTF-8) CSV (既定 `data/utf_ken_all.csv`) |
| `--office <path>` | JIGYOSYO (UTF-8) CSV (既定 `data/jigyosyo_utf8.csv`)。無ければ大口事業所番号は解決しない |
| `--no-ai` | Jev を使わない |
| `--model <id>` | TypeSafe モデル ID (既定 `jev-latest`) |
| `--threshold <0-1>` | この確度未満の AI 判定を要レビューにする (既定 0.7) |
| `--json` | 1 行 1 JSON で出力 |
| `--verbose` | 各段階のログを stderr に出力 |

### JSON 出力

```json
{
  "input": "東京都渋谷区渋谷2-24-12 渋谷スクランブルスクエア15階",
  "normalized": "東京都渋谷区渋谷2-24-12 渋谷スクランブルスクエア15階",
  "postalCode": "1506115",
  "postalCodeKind": "building",
  "townPostalCode": "1500002",
  "prefecture": "東京都", "city": "渋谷区", "town": "渋谷",
  "block": "2-24-12", "building": "渋谷スクランブルスクエア15階",
  "stages": { "prefecture": {"value":"東京都","method":"rule","probability":1}, "...": "..." },
  "needsReview": false, "reasons": [],
  "ai": { "calls": 0, "inputTokens": 0, "latencyMs": 0 }
}
```

- `postalCode`: 最終的な郵便番号。`postalCodeKind` が `building` (高層ビル階層別) / `office` (大口事業所個別番号) のときは
  `townPostalCode` に通常の町域番号も併記します。
- `stages.*.method`: `rule` (文字列・マスタ照合) / `zip` (入力郵便番号から確定) / `ai` (Jev) / `none`。
  `ai` のときは `probability` と `confidence` が入ります。
- `needsReview` / `reasons`: 低確度、郵便番号候補が複数、入力郵便番号との矛盾、町域未特定 など。

## 処理フロー

1. 前処理: NFKC、全角→半角、ダッシュ類・長音区切りの統一、〒/郵便番号の抽出
2. 都道府県: 前方一致 → 郵便番号 → 市区町村名からの逆引き (同名市が複数県にある場合は町域名で判別) → Jev (47 択)
3. 市区町村: 郡省略・「市+区」の揺れ・異体字を含む前方一致 → 郵便番号 → Jev (県内の市区町村)
4. 町域: 最長前方一致 (異体字・「ケ/ヶ/が」「ノ/の」・漢数字丁目を吸収)、京都市は通り名を飛ばした任意位置一致、
   「以下に掲載がない場合」「一円」「の次に番地がくる場合」の町域なしレコード → 郵便番号 → Jev (町域候補)。
   候補が Jev の上限 255 を超える場合は類似度上位 200 件で試し、外れたら全候補をチャンク評価
5. 番地・建物: 漢数字・丁目/番/号 を `1-2-3` 形式へ、残りを建物名として保持
6. 郵便番号: 町域に複数番号があれば丁目範囲や「(北)/(南)」等の括弧指定で絞り込み、
   KEN_ALL の高層ビル階層別レコードと JIGYOSYO の事業所番号で上書き (町域番号は別途保持)

Jev に渡すのは「候補リスト (+ 該当なし)」の Choice 質問で、`state` には元の住所と前段の結果を含め、
各候補には KEN_ALL のカタカナ読みを `criteria` の説明として添えます (ひらがな入力の照合精度が上がる)。

### Jev の判定を優先する仕組み

- **ルール一致の検証**: 町域が前方一致しても、その後ろに番地ではない文字が残る場合 (例: `宮町西2-24` → `宮町` + `西2-24`)
  は誤字・入替の可能性があるため、ルール候補 + 類似度上位 30 件を Jev に見せ、別候補が p≥0.7 なら Jev の判定で上書きします。
  ルール候補を支持した場合も Jev の probability が結果に残り、低ければ要レビューになります。
- **2 段階の fuzzy 選択**: 1 周目 (該当なし付き) で p<0.7 なら、「誤字・脱字・入替・かな表記が含まれている前提で
  文字/読みが最も近いものを必ず選ぶ」指示で、文字 bigram・読み類似度の上位 30 件から該当なし無しで再判定します。
  2 周目が p≥0.6 かつ 1 周目より高いときだけ採用し、それ以外は 1 周目の結果 (要レビュー) を返します。

## 評価

```sh
npm run eval -- --no-ai   # ルールのみ → eval/report-no-ai.md
npm run eval              # Jev あり  → eval/report.md
npm run robustness        # 摂動耐性 (欠落/誤字/入替/かな) ルールのみ vs Jev → eval/robustness.md
npm test                  # ユニットテスト (data/ があればパイプラインも)
```

`scripts/robustness.ts` は、ルールのみで正解できた住所の正規形 28 件に対して
「町域/市区町村名の 1 文字欠落・無関係な漢字への 1 文字誤字・隣接 2 文字入替・ひらがな表記」を seed 固定で自動生成し
(218 件)、ルールのみと Jev ありの正答率、Jev の probability と正誤の関係 (キャリブレーション)、
不正解が要レビューに落ちる割合を集計します。

`eval/samples.json` には kenall.jp の比較記事の 10 件、Zenrin / 日経 XTECH / Qiita / Geolonia / KenAll ニュースレターで
「正規化が難しい」とされている住所 30 件、計 40 件を出典付きで収録しています。結果は `eval/report.md` を参照してください。

## 制限

- 市区町村名を省略して町域名だけの入力、町域を特定できない入力はレビュー対象として返します。
- 「札幌市西区24-2-2-3-3」のように数字だけで町名 (二十四軒二条) を表す入力には対応していません。
- 通り名だけで町名を含まない京都市の住所 (「河原町通四条上る」など) は KEN_ALL に町名が無いため解決できません。
- 入力に事業所名・ビル名がある場合、KEN_ALL / JIGYOSYO に該当があれば町域番号より特定の番号を優先します
  (`townPostalCode` に町域番号を保持)。
- Jev は早期アクセス中のモデルで、確率は小数 2 桁に丸められます。
