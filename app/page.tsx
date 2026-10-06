"use client";

import { useEffect, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import type { Receipt } from "@/types/receipt";

/** 画像サイズ上限 (10 MiB)。サーバー側の制限と合わせる。 */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const ACCEPT_ATTR = ACCEPTED_MIME_TYPES.join(",");
const SUPPORTED_FORMAT_LABEL = "JPEG・PNG・WebP";

interface AnalyzeUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

interface AnalyzeResult {
  receipt: Receipt;
  metadata: {
    model: string;
    processingTimeMs: number;
    usage: AnalyzeUsage;
  };
}

interface SelectedFile {
  file: File;
  objectUrl: string;
}

type SummaryKind = "text" | "yen";

const SUMMARY_FIELDS: { key: keyof Omit<Receipt, "items">; label: string; kind: SummaryKind }[] = [
  { key: "merchant", label: "店舗名", kind: "text" },
  { key: "date", label: "取引日", kind: "text" },
  { key: "subtotal", label: "小計", kind: "yen" },
  { key: "tax", label: "消費税額", kind: "yen" },
  { key: "total", label: "合計金額", kind: "yen" },
  { key: "paymentMethod", label: "支払方法", kind: "text" },
  { key: "invoiceRegistrationNumber", label: "適格請求書登録番号", kind: "text" },
];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

function validateFile(file: File): string | null {
  if (file.size <= 0) {
    return "空のファイルは解析できません。有効な画像ファイルをお選びください。";
  }
  if (!ACCEPTED_MIME_TYPES.includes(file.type as (typeof ACCEPTED_MIME_TYPES)[number])) {
    return `${SUPPORTED_FORMAT_LABEL} 形式の画像をお選びください。`;
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return "ファイルサイズは10MiB以下にしてください。小さい画像でお試しください。";
  }
  return null;
}

export default function Home() {
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [rawJson, setRawJson] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (selected) URL.revokeObjectURL(selected.objectUrl);
    };
  }, [selected]);

  function handleFiles(file: File | null): void {
    if (!file) return;
    const error = validateFile(file);
    if (selected) URL.revokeObjectURL(selected.objectUrl);
    if (error) {
      setSelected(null);
      setFieldError(error);
      setApiError(null);
      setResult(null);
      setRawJson(null);
      return;
    }
    setSelected({ file, objectUrl: URL.createObjectURL(file) });
    setFieldError(null);
    setApiError(null);
    setResult(null);
    setRawJson(null);
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>): void {
    // input.value の消去で FileList が無効化されるブラウザーがあるため、
    // 安定した File を先に取り出してから値を消去する。
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    handleFiles(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsDragOver(false);
    handleFiles(event.dataTransfer.files[0] ?? null);
  }

  async function handleAnalyze(): Promise<void> {
    if (!selected || isProcessing) return;
    setIsProcessing(true);
    setApiError(null);
    setResult(null);
    setRawJson(null);
    try {
      const formData = new FormData();
      formData.append("file", selected.file);
      const response = await fetch("/api/receipts/analyze", {
        method: "POST",
        body: formData,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
            ? body.error
            : "レシートの解析に失敗しました。時間をおいて再度お試しください。";
        setApiError(message);
        return;
      }
      if (typeof body !== "object" || body === null || !("receipt" in body) || !("metadata" in body)) {
        setApiError("サーバーから正しい応答を受け取れませんでした。再度お試しください。");
        return;
      }
      setResult(body as AnalyzeResult);
      setRawJson(JSON.stringify(body, null, 2));
    } catch {
      setApiError(
        "通信中にエラーが発生しました。ネットワーク接続を確認して再度お試しください。",
      );
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <main>
      <h1>レシート取り込み PoC</h1>
      <p>
        レシート画像をアップロードすると、内容を自動で読み取って一覧表示します。読み取り結果は必ず画像と見比べてご確認ください。
      </p>
      <p className="flow-note">手順：画像を選択 → Geminiで解析 → 読み取り結果を確認</p>

      <div className="columns">
        <section aria-labelledby="upload-heading" className="upload">
          <h2 id="upload-heading">レシート画像のアップロード</h2>
          <div
            className="drop-area"
            data-dragover={isDragOver}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
          >
            {selected ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- blob: object URLはnext/imageの最適化対象外のため */}
                <img
                  className="drop-preview"
                  src={selected.objectUrl}
                  alt="選択中のレシート画像のプレビュー"
                />
                <p className="file-name">
                  選択中のファイル: {selected.file.name}（{formatFileSize(selected.file.size)}）
                </p>
                <label className="file-label" htmlFor="receipt-file">
                  別の画像を選択
                </label>
                <p className="help-text" id="receipt-file-help">
                  対応形式は{SUPPORTED_FORMAT_LABEL}、ファイルサイズは10MiBまでです。ファイルを選択するか、枠内にドロップして置き換えできます。
                </p>
              </>
            ) : (
              <>
                <p className="drop-lead">レシート画像をここにドロップ</p>
                <label className="file-label" htmlFor="receipt-file">
                  レシート画像を選択
                </label>
                <p className="help-text" id="receipt-file-help">
                  対応形式は{SUPPORTED_FORMAT_LABEL}、ファイルサイズは10MiBまでです。枠内にファイルをドラッグ＆ドロップすることもできます。
                </p>
              </>
            )}
            <input
              id="receipt-file"
              className="file-input"
              type="file"
              accept={ACCEPT_ATTR}
              aria-describedby="receipt-file-help"
              onChange={handleInputChange}
            />
            {fieldError ? (
              <p className="field-error" role="alert">
                {fieldError}
              </p>
            ) : null}
          </div>

          <button
            type="button"
            className="button button--primary analyze-button"
            disabled={!selected || isProcessing}
            onClick={handleAnalyze}
          >
            {isProcessing ? "解析しています…" : "レシートを解析する"}
          </button>

          {isProcessing ? (
            <div className="processing">
              <p role="status">レシートを解析しています。しばらくお待ちください。</p>
              <progress aria-label="レシート解析の進行状況" />
            </div>
          ) : null}

          {apiError ? (
            <div className="banner banner--error" role="alert">
              <p className="banner__title">解析できませんでした</p>
              <p className="banner__body">{apiError}</p>
            </div>
          ) : null}

          {!isProcessing && !apiError && result ? (
            <p role="status" className="status-note">
              解析が完了しました。下の結果を画像と見比べてご確認ください。
            </p>
          ) : null}
        </section>

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
              const raw = result ? result.receipt[field.key] : null;
              const value =
                typeof raw === "number" || typeof raw === "string" ? raw : null;
              const rowClassName =
                field.key === "total"
                  ? "summary-list__row summary-list__row--total"
                  : "summary-list__row";
              return (
                <div key={field.key} className={rowClassName}>
                  <dt>{field.label}</dt>
                  <dd>
                    {field.kind === "yen" && typeof value === "number"
                      ? formatYen(value)
                      : formatText(typeof value === "string" ? value : null)}
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

              {rawJson ? (
                <details className="raw-json">
                  <summary>応答のJSONを表示する</summary>
                  <pre>{rawJson}</pre>
                </details>
              ) : null}
            </>
          ) : null}
        </section>
      </div>

      <aside className="data-note" role="note" aria-labelledby="data-handling-title">
        <p className="data-note__title" id="data-handling-title">
          データの取り扱い
        </p>
        <p className="data-note__body">
          このPoCでは公開データセット JaWildText の receipt_kie
          画像を評価に使用します。画像はGemini APIへ送信されます。社内レシートなど未公開の購入情報は送信しないでください。実運用データを扱う前に、APIの保持・利用条件を確認してください。
        </p>
      </aside>
    </main>
  );
}
