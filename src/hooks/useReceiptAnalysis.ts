import { useEffect, useState } from "react";
import { validateImageFile } from "@/lib/imageUpload";
import type { AnalyzeReceiptResponse } from "@/types/receipt";

interface SelectedFile {
  file: File;
  objectUrl: string;
}

export function useReceiptAnalysis() {
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeReceiptResponse | null>(null);

  useEffect(() => {
    return () => {
      if (selected) URL.revokeObjectURL(selected.objectUrl);
    };
  }, [selected]);

  function selectFile(file: File | null): void {
    if (!file) return;
    const error = validateImageFile(file);
    setSelected(error ? null : { file, objectUrl: URL.createObjectURL(file) });
    setFieldError(error);
    setApiError(null);
    setResult(null);
  }

  async function analyze(): Promise<void> {
    if (!selected || isProcessing) return;
    setIsProcessing(true);
    setApiError(null);
    setResult(null);
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
      setResult(body as AnalyzeReceiptResponse);
    } catch {
      setApiError(
        "通信中にエラーが発生しました。ネットワーク接続を確認して再度お試しください。",
      );
    } finally {
      setIsProcessing(false);
    }
  }

  return { selected, fieldError, isProcessing, apiError, result, selectFile, analyze };
}
