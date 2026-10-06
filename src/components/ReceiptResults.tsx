import type { Receipt } from "@/types/receipt";

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

interface ReceiptResultsProps {
  receipt: Receipt | null;
  isProcessing: boolean;
  fileName?: string | null;
  error?: string | null;
  imageId?: string | undefined;
}

export function ReceiptResults({
  receipt,
  isProcessing,
  fileName,
  error,
  imageId,
}: ReceiptResultsProps) {
  const jsonValue =
    receipt && imageId ? { imageId, ...receipt } : receipt;
  return (
    <section aria-labelledby="result-heading" className="result">
      <h2 id="result-heading">読み取り結果</h2>
      {fileName ? (
        <p className="help-text">表示中: {fileName}</p>
      ) : (
        <p className="help-text">画像を選択するとプレビューと結果を表示します。</p>
      )}
      {error ? (
        <div className="banner banner--error" role="alert">
          <p className="banner__title">この画像は解析できませんでした</p>
          <p className="banner__body">{error}</p>
        </div>
      ) : null}
      {isProcessing ? <p>解析しています…</p> : null}
      {receipt ? (
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
                  ? formatYen(receipt?.[field.key] ?? null)
                  : formatText(receipt?.[field.key] ?? null)}
              </dd>
            </div>
          );
        })}
      </dl>

      <h3 id="result-items-heading">明細</h3>
      <div className="table-scroll">
        <table className="items-table">
          <caption>
            {receipt && receipt.items.length > 0
              ? "抽出された明細"
              : receipt
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
            {receipt && receipt.items.length > 0 ? (
              receipt.items.map((item, index) => (
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
                  {receipt
                    ? "明細は読み取れませんでした。"
                    : "解析後に明細を表示します。"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {receipt && jsonValue ? (
        <details className="raw-json">
          <summary>応答のJSONを表示する</summary>
          <pre>{JSON.stringify(jsonValue, null, 2)}</pre>
        </details>
      ) : null}
    </section>
  );
}
