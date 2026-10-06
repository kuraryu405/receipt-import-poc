import { ApiError, GoogleGenAI } from "@google/genai";
import { safeParseReceipt } from "@/lib/receiptSchema";
import type { Receipt } from "@/types/receipt";

/** GEMINI_MODEL が未設定の場合に使用するモデル。 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/** アップロード画像の上限サイズ (10 MiB)。 */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** 受け付ける画像形式。 */
export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AllowedImageMimeType =
  (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export function isAllowedImageMimeType(
  mimeType: string,
): mimeType is AllowedImageMimeType {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export interface ReceiptUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface AnalyzeReceiptResult {
  receipt: Receipt;
  model: string;
  processingTimeMs: number;
  usage: ReceiptUsage;
}

/** HTTP ステータスに対応付けられた解析失敗。メッセージは利用者向け日本語のみを持つ。 */
export class ReceiptAnalysisError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ReceiptAnalysisError";
    this.status = status;
  }
}

const RECEIPT_EXTRACTION_PROMPT = [
  "あなたは日本のレシート読取アシスタントです。",
  "添付のレシート画像から情報を抽出し、指定の JSON オブジェクトを1つだけ出力してください。",
  "各フィールドの意味は次のとおりです。",
  "- merchant: 店舗名。",
  "- date: 購入日。判読できる場合のみ YYYY-MM-DD 形式。",
  "- subtotal: 小計（税抜）。",
  "- tax: 消費税額。",
  "- total: 合計金額。",
  "- paymentMethod: 支払方法（例: 現金、クレジットカード、電子マネー）。",
  "- invoiceRegistrationNumber: 適格請求書発行事業者登録番号（T+13桁）。",
  "- items: 明細行の配列。各行は name（品名）、quantity（数量）、unitPrice（単価）、price（金額）を持ちます。",
  "厳守事項:",
  "- 読み取れない値は推測せず null にしてください。明細が無い場合は items を空配列にしてください。",
  "- 金額・数量は通貨記号や桁区切りを除いた JSON 数値にしてください。",
  "- 日付は特定できる場合のみ YYYY-MM-DD にし、特定できなければ null にしてください。",
].join("\n");

/** Interactions API の response_format に渡す JSON Schema。未読値は null を許す。 */
const RECEIPT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "merchant",
    "date",
    "subtotal",
    "tax",
    "total",
    "paymentMethod",
    "invoiceRegistrationNumber",
    "items",
  ],
  properties: {
    merchant: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    subtotal: { type: ["number", "null"] },
    tax: { type: ["number", "null"] },
    total: { type: ["number", "null"] },
    paymentMethod: { type: ["string", "null"] },
    invoiceRegistrationNumber: { type: ["string", "null"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "quantity", "unitPrice", "price"],
        properties: {
          name: { type: ["string", "null"] },
          quantity: { type: ["number", "null"] },
          unitPrice: { type: ["number", "null"] },
          price: { type: ["number", "null"] },
        },
      },
    },
  },
};

export interface AnalyzeReceiptInput {
  apiKey: string;
  model: string;
  imageBase64: string;
  mimeType: AllowedImageMimeType;
}

/**
 * レシート画像を Gemini Interactions API で解析し、検証済みの Receipt を返す。
 * 上流のエラー本文・画像・APIキー・スタックトレースは外に出さない。
 */
export async function analyzeReceiptImage(
  input: AnalyzeReceiptInput,
): Promise<AnalyzeReceiptResult> {
  const startedAt = Date.now();
  const ai = new GoogleGenAI({ apiKey: input.apiKey });

  let outputText: string | undefined;
  let usage: ReceiptUsage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  };

  try {
    const interaction = await ai.interactions.create({
      model: input.model,
      input: [
        { type: "text", text: RECEIPT_EXTRACTION_PROMPT },
        { type: "image", data: input.imageBase64, mime_type: input.mimeType },
      ],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: RECEIPT_JSON_SCHEMA,
      },
      store: false,
    });
    outputText = interaction.output_text;
    usage = {
      inputTokens: interaction.usage?.total_input_tokens ?? null,
      outputTokens: interaction.usage?.total_output_tokens ?? null,
      totalTokens: interaction.usage?.total_tokens ?? null,
    };
  } catch (error) {
    // 上流の詳細は返さず、状態に応じた定型メッセージに変換する。
    console.error("[receipts/analyze] Gemini API call failed");
    throw toAnalysisError(error);
  }

  if (!outputText || outputText.trim() === "") {
    throw new ReceiptAnalysisError(
      502,
      "AIからの応答が空でした。画像を確認して再度お試しください。",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new ReceiptAnalysisError(
      502,
      "AIの応答をJSONとして解釈できませんでした。再度お試しください。",
    );
  }

  const validated = safeParseReceipt(parsed);
  if (!validated.success) {
    console.error("[receipts/analyze] Receipt validation failed");
    throw new ReceiptAnalysisError(
      502,
      "AIの応答形式が不正でした。再度お試しください。",
    );
  }

  return {
    receipt: validated.data,
    model: input.model,
    processingTimeMs: Date.now() - startedAt,
    usage,
  };
}

/** SDK のエラーを利用者向けの定型メッセージ付き ReceiptAnalysisError に変換する。 */
function toAnalysisError(error: unknown): ReceiptAnalysisError {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return new ReceiptAnalysisError(
        429,
        "リクエストが集中しています。しばらく待ってから再度お試しください。",
      );
    }
    if (error.status === 401 || error.status === 403) {
      return new ReceiptAnalysisError(
        500,
        "サーバーのAPIキー設定に問題があります。管理者にお問い合わせください。",
      );
    }
    if (error.status === 400) {
      return new ReceiptAnalysisError(
        502,
        "画像を解析できませんでした。別の画像でお試しください。",
      );
    }
    if (error.status >= 500) {
      return new ReceiptAnalysisError(
        502,
        "解析サービスが一時的に利用できません。しばらく待ってから再度お試しください。",
      );
    }
  }
  return new ReceiptAnalysisError(
    502,
    "解析サービスが一時的に利用できません。しばらく待ってから再度お試しください。",
  );
}
