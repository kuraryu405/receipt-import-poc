# 複数レシートの一括解析

## 目的と範囲

最大10枚の画像を、1回のGemini Interactions APIリクエストにまとめて送る。リクエスト数を減らし、元画像と結果を照合できるPoCにする。

画面の選択上限は10枚。画像ごとのAPI連打、並列実行数の設定、固定の送信間隔、バックグラウンドキューは使用しない。容量超過を理由に送信を自動分割しない。

## 公式仕様の確認（2026-10-06）

| 確認項目 | 公式仕様 |
| --- | --- |
| 使用モデル | Stableの `gemini-3.8-flash`。画像入力・Structured Outputに対応 |
| 複数画像 | Interactionsの `input` 配列に複数の画像を含められる |
| 画像数 | 最大3,600画像／リクエスト。10枚はこの制限内 |
| Inline容量 | 100MB／リクエストまたはペイロード |
| モデルのトークン上限 | 入力1,048,576、出力65,536 |
| 利用枠 | RPM・TPM・RPDなどのプロジェクトの利用枠は別途適用される |

参照：[画像入力](https://ai.google.dev/gemini-api/docs/image-understanding#prompting-with-multiple-images)、[容量](https://ai.google.dev/gemini-api/docs/file-input-methods#input-method-comparison)、[モデル](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[Structured Output](https://ai.google.dev/gemini-api/docs/structured-output)、[利用制限](https://ai.google.dev/gemini-api/docs/rate-limits)。

PoC側の制限はJPEG・PNG・WebP、1枚10MiB、合計60MiB、最大10枚。60MiBはbase64で約80MiB（約83.9MB）となるため、JSONや指示文の余裕を含めて100MB未満に収める保守的な制限としている。60MiBはGoogleが定めた上限ではない。

モデルのトークン上限を満たしても、無料枠のTPM・RPD等に達する場合がある。10枚にまとめれば常に成功する、時間や料金が10分の1になる、という保証はない。

## 画面での操作

1. 最大10枚をまとめて選択するか、ドロップして追加する。
2. 画像一覧のファイル名を押すと、対応するプレビューと読み取り結果が切り替わる。
3. 未解析の画像をまとめて解析する。選択だけではAPIを呼ばない。
4. 結果を元画像と見比べる。処理情報は画像全体をまとめた1リクエストの値として確認する。
5. 失敗時は画像を保持する。再試行は利用者の明示操作で行い、成功済みの画像を自動で再送しない。

実行中は画像の追加・削除を無効にし、同じバッチの二重送信を防ぐ。画像数・個別容量・合計容量の不正は、送信前とサーバー側で検知する。

## APIと対応付け

`POST /api/receipts/analyze-batch` にmultipart/form-dataを送る。

- `files`：画像ファイルを繰り返し指定する（1〜10件）。
- `imageIds`：送信順に対応する一意なIDのJSON配列（例：`["receipt-001","receipt-002"]`）。

モデルへ、各画像の直前に `imageId` を明示する。画像は独立したレシートとして扱い、異なる画像の店舗名・金額・明細等を混ぜず、入力のIDをそのまま返すよう指示する。ファイル名は識別用のプロンプトに含めない。

応答の形式：

```ts
type BatchReceiptResult = Receipt & { imageId: string };

type AnalyzeReceiptBatchResponse = {
  receipts: BatchReceiptResult[];
  metadata: ReceiptAnalysisMetadata;
};
```

既存のReceipt型と検証スキーマを再利用する。Structured Outputのスキーマには入力IDの候補と必要件数を設定し、返却後にもZod・件数・ID集合を検証する。返却配列の順番だけに依存せず、`imageId` で対応付ける。

欠落・重複・未知IDは502の異常として検知し、バッチ全体を未確定にする。欠落した入力IDは `batchIssues.missingImageIds` で返し、画面でファイル名へ対応付けて説明する。未知のモデル出力IDをそのままエラーログや応答へ転記しない。

以前の単票API `POST /api/receipts/analyze` は互換性のため残している。現在の複数選択UIと評価CLIは一括APIを使用する。Gemini呼び出しはサーバー側だけで行う。

## 利用制限とタイムアウト

SDKの自動再試行は無効（`maxRetries: 0`）。429で新しい送信を止め、自動的には再送しない。

上流エラーで利用可能な `Retry-After` が得られた場合は、安全な秒数としてAPI応答に伝える。画面はその待機時間を尊重し、CLIは待機指定を記録して終了コード3で中断する。ヘッダーがない場合は正確な解除時刻を推定しない。

一括解析のSDKタイムアウトは300秒、画面・CLIの待機上限は360秒。単票APIの180秒タイムアウトは維持する。`store: false` を使用するが、Geminiのデータ利用条件がなくなる設定ではない。

## 公開データセットでの評価

```sh
# 10枚を1回で評価
npm run evaluate:jawildtext -- --limit 10 --batch-size 10 --report ./eval-report.json

# 大きい対象範囲は最大10枚ずつ直列実行（利用枠を確認してから）
npm run evaluate:jawildtext -- --limit 20 --batch-size 10 --offset 0 --report ./eval-report.json
```

既定は `limit=5`、`batch-size=10`。有効な5枚を1リクエストで送る。`--batch-size` は1〜10で、1・3・5・10枚の条件比較にも使用できる。`--delay-ms` と並列実行の設定はない。

CLIは1バッチ分だけ画像を保持し、バッチ間を直列実行する。429で次のバッチの取得・送信を中断する。容量超過を自動で別リクエストへ分割しない。

## 計測値の読み方

usageと処理時間は、1画像の値ではなく、Geminiへの1リクエスト全体の値。まとめた10枚へ同じusageを10回足してはならない。

- 入力・出力・思考・合計トークンはSDKの返値を記録する。未取得は `null` とし、思考分を差から推定しない。
- CLIの `requests` に呼び出し単位の匿名行番号、件数、成否、HTTPステータス、処理時間、usageを記録する。
- `measurements` の平均は、成功したリクエストのうち実測値が得られた件数を分母にする。欠損は0として含めない。
- 総トークンを画像数で割る値は按分参考値。各画像の独立したトークン実測ではない。
- API成功率、成功画像に対する抽出精度、リクエスト単位の時間・usageを区別する。
- 計測用JSONには画像・画像URL・ファイル名・レシートの参照値や予測値・APIキーを含めない。

最新の確認結果は [計測記録一覧](./README.md) を参照。
