import type { AnalyzeReceiptResponse, Receipt } from "@/types/receipt";

type AmountKey = "subtotal" | "tax" | "total";
type SummaryField =
  | { key: AmountKey; label: string; kind: "yen" }
  | { key: Exclude<keyof Receipt, AmountKey | "items">; label: string; kind: "text" };

const SUMMARY_FIELDS: SummaryField[] = [
  { key: "merchant", label: "店舗名", kind: "text" },
  { key: "date", label: "取引日", kind: "text" },
  { key: "subtotal", label: "小計", kind: "yen" },
  { key: "tax", label: "消費税額", kind: "yen" },
  { key: "total", label: "合計金額", kind: "yen" },
  { key: "paymentMethod", label: "支払方法", kind: "text" },
  { key: "invoiceRegistrationNumber", label: "適格請求書登録番号", kind: "text" },
];

function formatYen(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${value.toLocaleString("ja-JP")}円`;
}

function formatText(value: string | null): string {
  if (value === null || value === "") return "—";
  return value;
}

function formatNumber(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return value.toLocaleString("ja-JP");
}

function formatTokens(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString("ja-JP")} トークン`;
}

interface ReceiptResultsProps {
  result: AnalyzeReceiptResponse | null;
  isProcessing: boolean;
}

export function ReceiptResults({ result, isProcessing }: ReceiptResultsProps) {
  return (
    <section aria-labelledby="result-heading" className="result">
      <h2 id="result-heading">読み取り結果</h2>
      {isProcessing ? <p>解析しています…</p> : null}
      {result ? (
        <p className="help-text">「—」は読み取れなかった項目です。</p>
      ) : (
        <p className="help-text">
          解析すると以下の項目が表示されます。値は読み取り後に反映されます。
        </p>
      )}
      <dl className="summary-list">
        {SUMMARY_FIELDS.map((field) => {
          const rowClassName =
            field.key === "total"
              ? "summary-list__row summary-list__row--total"
              : "summary-list__row";
          return (
            <div key={field.key} className={rowClassName}>
              <dt>{field.label}</dt>
              <dd>
                {field.kind === "yen"
                  ? formatYen(result?.receipt[field.key] ?? null)
                  : formatText(result?.receipt[field.key] ?? null)}
              </dd>
            </div>
          );
        })}
      </dl>

      <h3 id="items-heading">明細</h3>
      <div className="table-scroll">
        <table className="items-table">
          <caption>
            {result && result.receipt.items.length > 0
              ? "抽出された明細"
              : result
                ? "明細"
                : "明細の表示項目"}
          </caption>
          <thead>
            <tr>
              <th scope="col">品名</th>
              <th scope="col">数量</th>
              <th scope="col">単価</th>
              <th scope="col">金額</th>
            </tr>
          </thead>
          <tbody>
            {result && result.receipt.items.length > 0 ? (
              result.receipt.items.map((item, index) => (
                <tr key={index}>
                  <td>{formatText(item.name)}</td>
                  <td className="numeric">{formatNumber(item.quantity)}</td>
                  <td className="numeric">{formatYen(item.unitPrice)}</td>
                  <td className="numeric">{formatYen(item.price)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4}>
                  {result
                    ? "明細は読み取れませんでした。"
                    : "解析後に明細を表示します。"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {result ? (
        <>
          <h3 id="meta-heading">処理情報</h3>
          <p className="help-text">
            応答にかかった時間とトークン数です。読み取り精度を示すものではありません。
          </p>
          <dl className="summary-list">
            <div className="summary-list__row">
              <dt>使用モデル</dt>
              <dd>{result.metadata.model}</dd>
            </div>
            <div className="summary-list__row">
              <dt>処理時間</dt>
              <dd className="numeric">
                {result.metadata.processingTimeMs.toLocaleString("ja-JP")} ミリ秒
              </dd>
            </div>
            <div className="summary-list__row">
              <dt>入力トークン数</dt>
              <dd className="numeric">{formatTokens(result.metadata.usage.inputTokens)}</dd>
            </div>
            <div className="summary-list__row">
              <dt>出力トークン数</dt>
              <dd className="numeric">{formatTokens(result.metadata.usage.outputTokens)}</dd>
            </div>
            <div className="summary-list__row">
              <dt>合計トークン数</dt>
              <dd className="numeric">{formatTokens(result.metadata.usage.totalTokens)}</dd>
            </div>
          </dl>

          <details className="raw-json">
            <summary>応答のJSONを表示する</summary>
            <pre>{JSON.stringify(result, null, 2)}</pre>
          </details>
        </>
      ) : null}
    </section>
  );
}
