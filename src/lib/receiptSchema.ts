import { z } from "zod";

export const IMAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Gemini レスポンスを実行時検証するための Zod スキーマ。
 * 未読値は null を許容する。items 自体は配列として必ず存在する。
 */
export const receiptItemSchema = z.object({
  name: z.string().nullable(),
  quantity: z.number().nullable(),
  unitPrice: z.number().nullable(),
  price: z.number().nullable(),
});

export const receiptSchema = z.object({
  merchant: z.string().nullable(),
  date: z.string().nullable(),
  subtotal: z.number().nullable(),
  tax: z.number().nullable(),
  total: z.number().nullable(),
  paymentMethod: z.string().nullable(),
  invoiceRegistrationNumber: z.string().nullable(),
  items: z.array(receiptItemSchema),
});

/** 失敗時に例外ではなく結果オブジェクトを返したい場合に使う。 */
export function safeParseReceipt(data: unknown) {
  return receiptSchema.safeParse(data);
}

/** バッチ応答の実行時スキーマ。receipt フィールド群に imageId を持つフラット形式。 */
export const batchReceiptResultSchema = receiptSchema.extend({
  imageId: z.string(),
});

export const batchReceiptResponseSchema = z.object({
  receipts: z.array(batchReceiptResultSchema),
});

/** 失敗時に例外ではなく結果オブジェクトを返したい場合に使う。 */
export function safeParseBatchReceipts(data: unknown) {
  return batchReceiptResponseSchema.safeParse(data);
}
