# レシート取り込み PoC

レシート画像をアップロードすると、Gemini API が内容を読み取って一覧表示する Next.js (App Router) の PoC です。

日本語レシートの画像認識・OCR・構造化抽出が業務に使えそうか、人が元画像と照合して検証するためのアプリです。自動経費登録や Google Sheets 連携は含みません。

## 構成と採用モデル

Next.js / TypeScript / React と Google 公式 SDK `@google/genai` を使用します。2026-10-06 時点の [公式モデル一覧](https://ai.google.dev/gemini-api/docs/models)で Stable とされる `gemini-3.8-flash` を既定とし、`GEMINI_MODEL` で変更できます。

ブラウザーの画像入力 → Next.js Route Handler → Gemini Interactions API（画像＋JSON Schema）→ Zod 検証済みの `Receipt` → 結果画面、という構成です。Gemini 呼び出しと API キーはサーバー側に限定します。

- `app/page.tsx` / `app/globals.css`: ページ構成と共通スタイル
- `src/components/ReceiptImporter.tsx` / `ReceiptResults.tsx`: アップロード、プレビュー、結果、処理状態を表示
- `src/hooks/useReceiptAnalysis.ts`: ファイル選択、プレビューURLの管理、解析APIとの通信
- `src/lib/imageUpload.ts`: フロント・サーバー共通の画像形式とサイズ制限
- `app/api/receipts/analyze/route.ts`: 画像の受信・検証・日本語エラー応答
- `src/lib/receiptAnalysis.ts`: モデル定数、抽出指示、Structured Output、処理時間・usage の取得
- `src/lib/receiptSchema.ts` / `src/types/receipt.ts`: 検証と再利用可能な `Receipt` 型
- `scripts/evaluate-jawildtext.mjs`: 公開データセットの簡易評価

抽出項目は店舗名、取引日、小計、消費税額、合計、支払方法、適格請求書発行事業者登録番号、明細（品名・数量・単価・金額）です。将来の Sheets 連携では `Receipt` 型を再利用できます。

## 必要条件

- Node.js >= 20.9
- npm

## セットアップ

```sh
npm install
cp .env.example .env.local
```

`.env.local` に `GEMINI_API_KEY` を設定してください。`.env.local` は Git 管理外であり、API キーをコミットしないでください。

```sh
GEMINI_API_KEY=各自のキー
GEMINI_MODEL=  # 空の場合は gemini-3.8-flash を使用
```

## 起動

```sh
npm run dev -- --port 3100
```

ブラウザーで http://localhost:3100 を開きます。

## 使い方

1. 「レシート画像のアップロード」で JPEG / PNG / WebP の画像を選びます（10MiB まで）。
2. プレビューを確認し「レシートを解析する」を押します。
3. 抽出結果（店舗名・購入日・金額など）と明細の一覧が表示されます。必ず画像と見比べてください。
4. 「処理情報」には応答時間とトークン数のみ表示します。読み取り精度を示すものではありません。

画面の状態は、未選択・選択済み・解析中・成功・エラーで切り替わります。API 側の失敗でも選択画像は保持されます。

## API

`POST /api/receipts/analyze` に `multipart/form-data` の `file` フィールドで画像を送ります。

成功時の応答:

```json
{
  "receipt": {
    "merchant": "店舗名",
    "date": "2025-11-21",
    "subtotal": 2109,
    "tax": 211,
    "total": 2320,
    "paymentMethod": "現金",
    "invoiceRegistrationNumber": null,
    "items": [{ "name": "品名", "quantity": 1, "unitPrice": 1190, "price": 1190 }]
  },
  "metadata": {
    "model": "gemini-3.8-flash",
    "processingTimeMs": 1234,
    "usage": { "inputTokens": 100, "outputTokens": 50, "totalTokens": 150 }
  }
}
```

読み取れなかった値は `null`（明細なしは空配列）です。エラー時は `{ "error": "日本語メッセージ" }` と適切な HTTP ステータスを返します。

## 評価 (JaWildText receipt_kie)

E2E と精度評価には、公開データセット [llm-jp/jawildtext](https://huggingface.co/datasets/llm-jp/jawildtext) の `receipt_kie` 設定（実画像＋アノテーション 1,151 件、Apache-2.0）を使用します。論文は [JaWildText (arXiv:2603.27942)](https://arxiv.org/abs/2603.27942)、コードは [llm-jp/jawildtext](https://github.com/llm-jp/jawildtext) です。

評価スクリプトは画像とアノテーションを一時的に取得するだけで、保存しません。予測値・参照値・画像・URL を出力やファイルに残しません。ベンチマーク利用が目的であり、店舗・顧客の特定や購買行動の推測には使いません。

```sh
# 既定 5 件の評価
npm run evaluate:jawildtext

# 明示的な件数・開始位置（全件は API クォータ確認後に分割実行）
npm run evaluate:jawildtext -- --limit 50 --offset 0
npm run evaluate:jawildtext -- --limit 100 --offset 50 --report ./eval-report.json
```

注意:

- リクエストは逐次送信し、429 を受けたら即時中断します。自動リトライはしません。全件実行の前に現在のクォータを確認してください。
- 計測値は選択サンプルの診断用であり、JaWildText 論文の正式な KIE F1 評価手順の再現ではありません。明細指標は品名＋金額ペアの簡易一致（数量は無視）です。

### 計測・確認記録

過去の結果は [docs の記録一覧](./docs/README.md) に保存しています。

[2026-10-06 の初期計測・確認結果](./docs/measurements/2026-10-06.md)には、公開実画像でのE2E（解析処理時間43,675ms）、先頭5件の評価（3件成功・2件APIエラー）、成功3件の項目別一致率・明細指標、429での中断、UI・実装の確認を記録しています。集計JSONも同梱しています。

これらは少数サンプルの診断結果であり、業務精度や処理性能の保証ではありません。APIエラーの原因・制限解除時刻など、未確認の点は記録内に明記しています。

## データの取り扱い

- アップロードした画像は Gemini API へ送信されます。社内レシートなど未公開の購入情報は、保持・利用条件を確認するまで送信しないでください。
- データセットのライセンス（Apache-2.0）と Gemini API のデータ条件は別物です。無償枠では入力内容が Google の製品改善に利用される場合があり、保持期間や規約は変更されることがあります。`store: false` は Interactions の保存を無効化するだけであり、プロバイダーの規約に優先しません。
- 参考: [料金](https://ai.google.dev/gemini-api/docs/pricing) / [利用規約](https://ai.google.dev/gemini-api/terms) / [レート制限](https://ai.google.dev/gemini-api/docs/rate-limits)

## PoC で確認するケース

店舗名・取引日・合計・税額を重点的に、画像と抽出結果を照合してください。

- 通常の印刷レシート、日本語と英数字の混在、長いレシート、小さい文字
- 斜め撮影、暗い画像、ピンボケ、一部欠損、手書き領収書
- 8% / 10% の混在、税込 / 税抜、合計 / 小計 / 預り金 / お釣りの区別
- 適格請求書発行事業者登録番号の有無と読み取り誤り

## 既知の制約と次の対応

- 1 回につき画像 1 枚、最大 10MiB です。画像補正・複数画像処理・DB 保存・認証はありません。
- Gemini リクエストのタイムアウトは 180 秒です。SDK の自動再試行は無効化し、利用制限（429）を受けた評価 CLI は中断します。
- Structured Output が保証するのは JSON の構造です。値の正しさは保証されず、未読・不明な項目は `null` になります。画面に編集・確定機能はないため、読み取り結果は元画像と照合してください。
- 5 件の初期評価は動作確認用です。業務精度の判断には、上記ケースを含めたサンプル拡大と誤りの分類が必要です。
- 本番化では、利用者の認証・権限、アップロード制限、API タイムアウト・レート制限、監視、データ保持・利用条件を具体化してください。次の機能候補は、人による修正・確定と、その確定済みデータを使う Sheets 連携です。

## 開発用コマンド

```sh
npm run lint
npm run typecheck
npm run build
```
