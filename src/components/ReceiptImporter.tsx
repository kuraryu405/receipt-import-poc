"use client";

import { useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { useReceiptAnalysis } from "@/hooks/useReceiptAnalysis";
import {
  IMAGE_ACCEPT_ATTRIBUTE,
  MAX_FILE_SIZE_MIB,
  SUPPORTED_FORMAT_LABEL,
} from "@/lib/imageUpload";
import { ReceiptResults } from "@/components/ReceiptResults";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ReceiptImporter() {
  const { selected, fieldError, isProcessing, apiError, result, selectFile, analyze } =
    useReceiptAnalysis();
  const [isDragOver, setIsDragOver] = useState(false);

  function handleInputChange(event: ChangeEvent<HTMLInputElement>): void {
    // input.value の消去で FileList が無効化されるブラウザーがあるため、
    // 安定した File を先に取り出してから値を消去する。
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    selectFile(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsDragOver(false);
    selectFile(event.dataTransfer.files[0] ?? null);
  }

  return (
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
                対応形式は{SUPPORTED_FORMAT_LABEL}、ファイルサイズは{MAX_FILE_SIZE_MIB}MiBまでです。ファイルを選択するか、枠内にドロップして置き換えできます。
              </p>
            </>
          ) : (
            <>
              <p className="drop-lead">レシート画像をここにドロップ</p>
              <label className="file-label" htmlFor="receipt-file">
                レシート画像を選択
              </label>
              <p className="help-text" id="receipt-file-help">
                対応形式は{SUPPORTED_FORMAT_LABEL}、ファイルサイズは{MAX_FILE_SIZE_MIB}MiBまでです。枠内にファイルをドラッグ＆ドロップすることもできます。
              </p>
            </>
          )}
          <input
            id="receipt-file"
            className="file-input"
            type="file"
            accept={IMAGE_ACCEPT_ATTRIBUTE}
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
          onClick={analyze}
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

      <ReceiptResults result={result} isProcessing={isProcessing} />
    </div>
  );
}
