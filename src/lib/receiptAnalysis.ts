import { GoogleGenAI } from "@google/genai";
import { safeParseReceipt } from "@/lib/receiptSchema";
import type { AllowedImageMimeType } from "@/lib/imageUpload";
import type { Receipt, ReceiptAnalysisMetadata, ReceiptUsage } from "@/types/receipt";

/** GEMINI_MODEL が未設定の場合に使用するモデル。 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export interface AnalyzeReceiptResult extends ReceiptAnalysisMetadata {
  receipt: Receipt;
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
  "画像に印字された情報のみを抽出し、推測・計算・補完は禁止です。",
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
  "- total は「合計」「総合計」等の支払合計のみとし、「お預り」「お釣り」は使用禁止です。",
  "- subtotal は「小計」と明記された税抜金額のみとし、無印の合計から逆算・転記しないでください。税込・税抜の区別が不明なら null にしてください。",
  "- tax は印字された税額の合計のみとし、税率（8%・10%）と混同禁止です。軽減税率の併記があっても税額が明示・一意に定まらなければ null にしてください。税額を計算・合算・推定しないでください。",
  "- invoiceRegistrationNumber は印字され判読できる場合のみ出力し、生成・補完は禁止です。",
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
    const interaction = await ai.interactions.create(
      {
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
      },
      { maxRetries: 0, timeout: 180_000 },
    );
    outputText = interaction.output_text;
    usage = {
      inputTokens: interaction.usage?.total_input_tokens ?? null,
      outputTokens: interaction.usage?.total_output_tokens ?? null,
      totalTokens: interaction.usage?.total_tokens ?? null,
    };
  } catch (error) {
    // 上流の詳細は返さず、状態に応じた定型メッセージに変換する。
    console.error(
      "[receipts/analyze] Gemini API call failed:",
      getHttpStatus(error) ?? null,
    );
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
  if (isTimeoutError(error)) {
    return new ReceiptAnalysisError(
      504,
      "解析がタイムアウトしました。しばらく待ってから再度お試しください。",
    );
  }
  const status = getHttpStatus(error);
  if (status === 429) {
    return new ReceiptAnalysisError(
      429,
      "APIの利用上限に達しました（レート制限）。しばらく待ってから再度お試しください。",
    );
  }
  if (status === 401 || status === 403) {
    return new ReceiptAnalysisError(
      500,
      "サーバーのAPIキー設定に問題があります。管理者にお問い合わせください。",
    );
  }
  if (status === 404) {
    return new ReceiptAnalysisError(
      500,
      "指定されたモデルが見つかりません。管理者にお問い合わせください。",
    );
  }
  if (status === 400) {
    return new ReceiptAnalysisError(
      502,
      "画像を解析できませんでした。別の画像でお試しください。",
    );
  }
  return new ReceiptAnalysisError(
    502,
    "解析サービスが一時的に利用できません。しばらく待ってから再度お試しください。",
  );
}

/**
 * 未知のエラーから HTTP ステータスのみを安全に読み取る。
 * Interactions 系の内部エラー (APIError/RateLimitError 等) は
 * 公開 ApiError ではないため instanceof を使わず、
 * status → statusCode の順に有限の整数 (100..599) のみ受け付ける。
 */
function getHttpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const record = error as Record<string, unknown>;
  for (const key of ["status", "statusCode"] as const) {
    const value = record[key];
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 100 &&
      value <= 599
    ) {
      return value;
    }
  }
  return null;
}

/** クライアント側タイムアウト (APIConnectionTimeoutError) かを名前で判定する。 */
function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (error as { name?: unknown }).name === "APIConnectionTimeoutError";
}
