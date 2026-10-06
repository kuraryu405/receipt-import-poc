import type { z } from "zod";
import type { receiptSchema } from "@/lib/receiptSchema";

/**
 * レシートの共有型。
 * Gemini Structured Output の実行時検証後に利用する正規形。
 * 読み取れなかった値は null で表現する。
 */

export type Receipt = z.infer<typeof receiptSchema>;

/** 入力にないIDは値を返さず、件数だけを伝える。 */
export interface BatchIssues {
  missingImageIds: string[];
  duplicateImageIds: string[];
  unexpectedImageIdCount: number;
}

export interface ReceiptUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** thinking モデルの thought トークン。非対応時は null。後方互換のため任意。 */
  thoughtTokens?: number | null;
}

export interface ReceiptAnalysisMetadata {
  model: string;
  processingTimeMs: number;
  usage: ReceiptUsage;
}

export interface AnalyzeReceiptResponse {
  receipt: Receipt;
  metadata: ReceiptAnalysisMetadata;
}

export type BatchReceiptResult = Receipt & {
  imageId: string;
};

export interface AnalyzeReceiptBatchResponse {
  receipts: BatchReceiptResult[];
  metadata: ReceiptAnalysisMetadata;
}

export interface CompletedBatchRun {
  imageCount: number;
  metadata: ReceiptAnalysisMetadata;
}
