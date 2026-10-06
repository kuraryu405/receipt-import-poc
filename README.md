# レシート取り込み PoC

レシート画像をアップロードすると、Gemini API が内容を読み取って一覧表示する Next.js (App Router) の PoC です。

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

## データの取り扱い

- アップロードした画像は Gemini API へ送信されます。社内レシートなど未公開の購入情報は、保持・利用条件を確認するまで送信しないでください。
- データセットのライセンス（Apache-2.0）と Gemini API のデータ条件は別物です。無償枠では入力内容が Google の製品改善に利用される場合があり、保持期間や規約は変更されることがあります。`store: false` は Interactions の保存を無効化するだけであり、プロバイダーの規約に優先しません。
- 参考: [料金](https://ai.google.dev/gemini-api/docs/pricing) / [利用規約](https://ai.google.dev/gemini-api/terms) / [レート制限](https://ai.google.dev/gemini-api/docs/rate-limits)

## 開発用コマンド

```sh
npm run lint
npm run typecheck
npm run build
```
