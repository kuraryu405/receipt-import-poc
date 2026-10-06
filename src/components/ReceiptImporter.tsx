"use client";

import { useMemo, useState } from "react";
import type { ChangeEvent } from "react";
import { useReceiptAnalysis } from "@/hooks/useReceiptAnalysis";
import {
  IMAGE_ACCEPT_ATTRIBUTE,
  MAX_BATCH_FILES,
  MAX_BATCH_SIZE_MIB,
  MAX_FILE_SIZE_MIB,
  MAX_SELECTED_FILES,
  SUPPORTED_FORMAT_LABEL,
} from "@/lib/imageUpload";
import { ReceiptResults } from "@/components/ReceiptResults";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatTokens(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString("ja-JP")} トークン`;
}

function formatTokenTotal(
  value: number | null,
  known: number,
  runs: number,
): string {
  if (value === null) return "—";
  if (known < runs) {
    return `${formatTokens(value)}（${runs}件中${known}件の合計）`;
  }
  return formatTokens(value);
}

function statusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "待機中";
    case "processing":
      return "解析中";
    case "success":
      return "完了";
    case "error":
      return "失敗";
    default:
      return status;
  }
}

export function ReceiptImporter() {
  const {
    items,
    activeId,
    activeItem,
    setActiveId,
    fieldErrors,
    batchError,
    isProcessing,
    inCooldown,
    cooldownRemainingSec,
    cooldownRetryAtText,
    completedRuns,
    totalBytes,
    isOverTotalLimit,
    pendingCount,
    errorCount,
    successCount,
    selectFiles,
    removeItem,
    clearAll,
    analyze,
    retryFailed,
  } = useReceiptAnalysis();
  const [isDragOver, setIsDragOver] = useState(false);

  function handleInputChange(event: ChangeEvent<HTMLInputElement>): void {
    const files = event.target.files ? Array.from(event.target.files) : null;
    event.target.value = "";
    selectFiles(files);
  }

  const canAnalyze =
    !isProcessing &&
    !inCooldown &&
    !isOverTotalLimit &&
    pendingCount > 0 &&
    pendingCount <= MAX_BATCH_FILES;
  const canRetry =
    !isProcessing &&
    !inCooldown &&
    !isOverTotalLimit &&
    errorCount > 0;

  const processingCount = items.filter(
    (item) => item.status === "processing",
  ).length;

  const aggregate = useMemo(() => {
    if (completedRuns.length === 0) return null;
    let input = 0;
    let output = 0;
    let total = 0;
    let thought = 0;
    let inputKnown = 0;
    let outputKnown = 0;
    let totalKnown = 0;
    let thoughtKnown = 0;
    let time = 0;
    let images = 0;
    const models = new Set<string>();
    for (const run of completedRuns) {
      images += run.imageCount;
      time += run.metadata.processingTimeMs;
      models.add(run.metadata.model);
      const usage = run.metadata.usage;
      if (usage.inputTokens != null) {
        input += usage.inputTokens;
        inputKnown += 1;
      }
      if (usage.outputTokens != null) {
        output += usage.outputTokens;
        outputKnown += 1;
      }
      if (usage.totalTokens != null) {
        total += usage.totalTokens;
        totalKnown += 1;
      }
      if (usage.thoughtTokens != null) {
        thought += usage.thoughtTokens;
        thoughtKnown += 1;
      }
    }
    return {
      runs: completedRuns.length,
      images,
      time,
      models: [...models].sort(),
      input: inputKnown > 0 ? input : null,
      inputKnown,
      output: outputKnown > 0 ? output : null,
      outputKnown,
      total: totalKnown > 0 ? total : null,
      totalKnown,
      thought: thoughtKnown > 0 ? thought : null,
      thoughtKnown,
    };
  }, [completedRuns]);

  const measurementJson = useMemo(
    () =>
      JSON.stringify(
        {
          batches: completedRuns.map((run) => ({
            imageCount: run.imageCount,
            model: run.metadata.model,
            processingTimeMs: run.metadata.processingTimeMs,
            usage: run.metadata.usage,
          })),
        },
        null,
        2,
      ),
    [completedRuns],
  );

  function handleDownloadMeasurements(): void {
    const blob = new Blob([measurementJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "receipt-batch-measurements.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  const mainButtonLabel =
    isProcessing && processingCount > 0
      ? `解析しています（${processingCount}枚）`
      : `選択した画像をまとめて解析する（${pendingCount}枚）`;

  return (
    <>
      <div className="columns">
        <section aria-labelledby="upload-heading" className="upload">
          <h2 id="upload-heading">レシート画像のアップロード</h2>
          <p className="help-text" id="receipt-file-help">
            対応形式は{SUPPORTED_FORMAT_LABEL}、1枚あたり
            {MAX_FILE_SIZE_MIB}MiBまで・合計{MAX_BATCH_SIZE_MIB}MiBまで・最大
            {MAX_SELECTED_FILES}枚です。ファイルを選択するか、枠内にドロップして追加できます。
          </p>
          <div
            className="drop-area"
            data-dragover={isDragOver && !isProcessing}
            onDragOver={(event) => {
              event.preventDefault();
              if (isProcessing) return;
              setIsDragOver(true);
            }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragOver(false);
              if (isProcessing) return;
              selectFiles(Array.from(event.dataTransfer.files));
            }}
          >
            {activeItem ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element -- blob: object URLはnext/imageの最適化対象外のため */}
                <img
                  className="drop-preview"
                  src={activeItem.objectUrl}
                  alt={`${activeItem.file.name}のプレビュー`}
                />
                <p className="file-name">
                  {activeItem.file.name}（{formatFileSize(activeItem.file.size)}）・
                  {statusLabel(activeItem.status)}
                </p>
              </>
            ) : (
              <p className="drop-lead">レシート画像をここにドロップ</p>
            )}
            <label className="file-label" htmlFor="receipt-file">
              レシート画像を選択（複数可）
            </label>
            <input
              id="receipt-file"
              className="file-input"
              type="file"
              accept={IMAGE_ACCEPT_ATTRIBUTE}
              multiple
              disabled={isProcessing}
              aria-describedby="receipt-file-help"
              onChange={handleInputChange}
            />
            {fieldErrors.length > 0 ? (
              <div role="alert">
                {fieldErrors.map((message, index) => (
                  <p key={index} className="field-error">
                    {message}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="button button--primary analyze-button"
            disabled={!canAnalyze}
            onClick={analyze}
          >
            {mainButtonLabel}
          </button>
          <p className="help-text">
            {isProcessing
              ? `${processingCount}枚を1回でまとめて解析しています。`
              : "未解析の画像を1回でまとめて送信します。"}
            トークン消費と利用上限にご注意ください。
          </p>

          {errorCount > 0 ? (
            <button
              type="button"
              className="button button--secondary"
              disabled={!canRetry}
              onClick={retryFailed}
            >
              失敗分を再試行する（{errorCount}枚、成功分は再送しません）
            </button>
          ) : null}

          {isProcessing && processingCount > 0 ? (
            <p role="status">解析しています（{processingCount}枚）</p>
          ) : null}

          {inCooldown ? (
            <p role="status">
              利用上限のため待機しています。約{cooldownRemainingSec}
              秒後
              {cooldownRetryAtText ? `（${cooldownRetryAtText}ごろ）` : null}
              から再試行を受け付けます。利用枠が回復する時刻を保証するものではありません。
            </p>
          ) : null}

          {batchError ? (
            <div className="banner banner--error" role="alert">
              <p className="banner__title">解析できませんでした</p>
              <p className="banner__body">{batchError}</p>
            </div>
          ) : null}

          {!isProcessing && !batchError && successCount > 0 ? (
            <p role="status" className="status-note">
              {pendingCount > 0
                ? `解析済み${successCount}枚。未解析${pendingCount}枚があります。`
                : `解析が完了しました（${successCount}枚）。読み取り結果を画像と見比べてご確認ください。`}
            </p>
          ) : null}

          {items.length > 0 ? (
            <>
              <h3 id="upload-selected-heading">選択中の画像（{items.length}枚）</h3>
              <div
                className="table-scroll selection-list"
                role="region"
                aria-labelledby="upload-selected-heading"
                tabIndex={0}
              >
                <table className="items-table">
                  <caption>
                    ファイル名のボタンでプレビューと結果を切り替えます
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">ファイル名</th>
                      <th scope="col">状態</th>
                      <th scope="col">削除</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.imageId}>
                        <td>
                          <button
                            type="button"
                            aria-pressed={item.imageId === activeId}
                            onClick={() => setActiveId(item.imageId)}
                          >
                            {item.file.name}
                          </button>
                        </td>
                        <td>{statusLabel(item.status)}</td>
                        <td>
                          <button
                            type="button"
                            disabled={isProcessing}
                            onClick={() => removeItem(item.imageId)}
                            aria-label={`${item.file.name}を削除する`}
                          >
                            削除
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="help-text">
                合計 {formatFileSize(totalBytes)} ／ 上限 {MAX_BATCH_SIZE_MIB}
                MiB
                {isOverTotalLimit
                  ? "（上限超過のため解析できません。画像を減らしてください）"
                  : null}
              </p>
              <button
                type="button"
                className="button button--secondary"
                disabled={isProcessing || items.length === 0}
                onClick={clearAll}
              >
                選択をすべてクリア
              </button>
            </>
          ) : null}
        </section>

        <ReceiptResults
          receipt={activeItem?.receipt ?? null}
          isProcessing={isProcessing && activeItem?.status === "processing"}
          fileName={activeItem?.file.name ?? null}
          error={
            activeItem?.status === "error" ? (activeItem.error ?? null) : null
          }
          imageId={activeItem?.imageId}
        />
      </div>

      <section aria-labelledby="batch-meta-heading">
        <h2 id="batch-meta-heading">一括処理の記録</h2>
        {aggregate ? (
          <>
            <p className="help-text">
              この処理時間とトークン数は、まとめて送った画像全体の値です。
            </p>
            <dl className="summary-list">
              <div className="summary-list__row">
                <dt>リクエスト成功数</dt>
                <dd className="numeric">{aggregate.runs.toLocaleString("ja-JP")}</dd>
              </div>
              <div className="summary-list__row">
                <dt>処理した画像数（合計）</dt>
                <dd className="numeric">{aggregate.images.toLocaleString("ja-JP")}</dd>
              </div>
              <div className="summary-list__row">
                <dt>使用モデル</dt>
                <dd>{aggregate.models.join("、")}</dd>
              </div>
              <div className="summary-list__row">
                <dt>処理時間（合計）</dt>
                <dd className="numeric">
                  {aggregate.time.toLocaleString("ja-JP")} ミリ秒
                </dd>
              </div>
              {aggregate.runs > 1 ? (
                <div className="summary-list__row">
                  <dt>1回あたりの平均処理時間</dt>
                  <dd className="numeric">
                    {Math.round(aggregate.time / aggregate.runs).toLocaleString("ja-JP")} ミリ秒
                  </dd>
                </div>
              ) : null}
              <div className="summary-list__row">
                <dt>入力トークン数（合計）</dt>
                <dd className="numeric">
                  {formatTokenTotal(aggregate.input, aggregate.inputKnown, aggregate.runs)}
                </dd>
              </div>
              <div className="summary-list__row">
                <dt>出力トークン数（合計）</dt>
                <dd className="numeric">
                  {formatTokenTotal(aggregate.output, aggregate.outputKnown, aggregate.runs)}
                </dd>
              </div>
              <div className="summary-list__row">
                <dt>思考トークン数（合計）</dt>
                <dd className="numeric">
                  {formatTokenTotal(aggregate.thought, aggregate.thoughtKnown, aggregate.runs)}
                </dd>
              </div>
              <div className="summary-list__row">
                <dt>合計トークン数（合計）</dt>
                <dd className="numeric">
                  {formatTokenTotal(aggregate.total, aggregate.totalKnown, aggregate.runs)}
                </dd>
              </div>
            </dl>
            <details className="raw-json">
              <summary>一括全体のJSONを表示する</summary>
              <pre>{measurementJson}</pre>
            </details>
            <p>
              <button
                type="button"
                className="button button--secondary"
                onClick={handleDownloadMeasurements}
              >
                計測用JSONをダウンロードする
              </button>
            </p>
            <p className="help-text">
              ファイル名・レシート内容・画像URLを含まない集計用です。
            </p>
          </>
        ) : (
          <p className="help-text">
            解析が成功すると、使用モデル・処理時間・トークン数をまとめて記録します。
          </p>
        )}
      </section>
    </>
  );
}
