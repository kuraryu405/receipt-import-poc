import type { z } from "zod";
import type { receiptItemSchema, receiptSchema } from "@/lib/receiptSchema";

/**
 * レシートの共有型。
 * Gemini Structured Output の実行時検証後に利用する正規形。
 * 読み取れなかった値は null で表現する。
 */

export type ReceiptItem = z.infer<typeof receiptItemSchema>;

export type Receipt = z.infer<typeof receiptSchema>;

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
