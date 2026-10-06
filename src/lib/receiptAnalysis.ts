import { GoogleGenAI } from "@google/genai";
import {
  IMAGE_ID_PATTERN,
  safeParseBatchReceipts,
  safeParseReceipt,
} from "@/lib/receiptSchema";
import { MAX_BATCH_FILES, type AllowedImageMimeType } from "@/lib/imageUpload";
import type {
  BatchReceiptResult,
  BatchIssues,
  Receipt,
  ReceiptAnalysisMetadata,
  ReceiptUsage,
} from "@/types/receipt";

/** GEMINI_MODEL が未設定の場合に使用するモデル。 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export interface AnalyzeReceiptResult extends ReceiptAnalysisMetadata {
  receipt: Receipt;
}

export interface AnalyzeReceiptBatchImage {
  imageId: string;
  imageBase64: string;
  mimeType: AllowedImageMimeType;
}

export interface AnalyzeReceiptBatchInput {
  apiKey: string;
  model: string;
  images: AnalyzeReceiptBatchImage[];
}

export interface AnalyzeReceiptBatchResult extends ReceiptAnalysisMetadata {
  receipts: BatchReceiptResult[];
}

/** HTTP ステータスに対応付けられた解析失敗。メッセージは利用者向け日本語のみを持つ。 */
export class ReceiptAnalysisError extends Error {
  readonly status: number;
  readonly batchIssues?: BatchIssues;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    message: string,
    options?: { batchIssues?: BatchIssues; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = "ReceiptAnalysisError";
    this.status = status;
    if (options?.batchIssues) {
      this.batchIssues = options.batchIssues;
    }
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

const RECEIPT_FIELD_LINES = [
  "各フィールドの意味は次のとおりです。",
  "- merchant: 店舗名。",
  "- date: 購入日。判読できる場合のみ YYYY-MM-DD 形式。",
  "- subtotal: 小計（税抜）。",
  "- tax: 消費税額。",
  "- total: 合計金額。",
  "- paymentMethod: 支払方法（例: 現金、クレジットカード、電子マネー）。",
  "- invoiceRegistrationNumber: 適格請求書発行事業者登録番号（T+13桁）。",
  "- items: 明細行の配列。各行は name（品名）、quantity（数量）、unitPrice（単価）、price（金額）を持ちます。",
];

const RECEIPT_STRICT_LINES = [
  "厳守事項:",
  "- 読み取れない値は推測せず null にしてください。明細が無い場合は items を空配列にしてください。",
  "- 金額・数量は通貨記号や桁区切りを除いた JSON 数値にしてください。",
  "- 日付は特定できる場合のみ YYYY-MM-DD にし、特定できなければ null にしてください。",
  "- total は「合計」「総合計」等の支払合計のみとし、「お預り」「お釣り」は使用禁止です。",
  "- subtotal は「小計」と明記された税抜金額のみとし、無印の合計から逆算・転記しないでください。税込・税抜の区別が不明なら null にしてください。",
  "- tax は印字された税額の合計のみとし、税率（8%・10%）と混同禁止です。軽減税率の併記があっても税額が明示・一意に定まらなければ null にしてください。税額を計算・合算・推定しないでください。",
  "- invoiceRegistrationNumber は印字され判読できる場合のみ出力し、生成・補完は禁止です。",
];

const RECEIPT_EXTRACTION_PROMPT = [
  "あなたは日本のレシート読取アシスタントです。",
  "添付のレシート画像から情報を抽出し、指定の JSON オブジェクトを1つだけ出力してください。",
  "画像に印字された情報のみを抽出し、推測・計算・補完は禁止です。",
  ...RECEIPT_FIELD_LINES,
  ...RECEIPT_STRICT_LINES,
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
    thoughtTokens: null,
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
    usage = toReceiptUsage(interaction.usage);
  } catch (error) {
    // 上流の詳細は返さず、状態に応じた定型メッセージに変換する。
    console.error(
      "[receipts/analyze] Gemini API call failed:",
      getHttpStatus(error) ?? null,
    );
    throw toAnalysisError(error);
  }

  const parsed = parseAnalysisOutput(outputText);

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

/** バッチ用の抽出プロンプト。単票の safeguards を共有し複数画像の独立性を明示する。 */
function buildBatchExtractionPrompt(): string {
  return [
    "あなたは日本のレシート読取アシスタントです。",
    "添付の複数枚のレシート画像を一括で読み取り、指定の JSON オブジェクトを1つだけ出力してください。",
    "各画像は独立した1件のレシートです。画像間で店舗名・明細・日付・金額を結合・混同しないでください。画像Aの店舗名と画像Bの金額のように、別の画像の情報を混ぜないでください。",
    "各入力画像には直前のテキストで示した imageId が付いています。出力の receipts 配列に、各入力 imageId に対応する結果をちょうど1件ずつ含めてください。ファイル名は使わず imageId のみで対応付けてください。",
    "画像に印字された情報のみを抽出し、推測・計算・補完は禁止です。",
    ...RECEIPT_FIELD_LINES,
    ...RECEIPT_STRICT_LINES,
  ].join("\n");
}

/** バッチ Structured Output 用 JSON Schema。単票スキーマの複製に imageId を足したフラット形式。 */
function buildBatchJsonSchema(imageIds: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["receipts"],
    properties: {
      receipts: {
        type: "array",
        minItems: imageIds.length,
        maxItems: imageIds.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: [...RECEIPT_JSON_SCHEMA.required, "imageId"],
          properties: {
            ...RECEIPT_JSON_SCHEMA.properties,
            imageId: { type: "string", enum: imageIds },
          },
        },
      },
    },
  };
}

/** SDK の usage から ReceiptUsage を作る。thought は実測値のみで推測しない。 */
function toReceiptUsage(
  usage:
    | {
        total_input_tokens?: number | undefined;
        total_output_tokens?: number | undefined;
        total_tokens?: number | undefined;
        total_thought_tokens?: number | undefined;
      }
    | undefined,
): ReceiptUsage {
  return {
    inputTokens: usage?.total_input_tokens ?? null,
    outputTokens: usage?.total_output_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
    thoughtTokens: usage?.total_thought_tokens ?? null,
  };
}

/**
 * 複数レシート画像を Gemini Interactions API の1リクエストで解析する。
 * リクエスト全体で usage / processingTimeMs を1つだけ返す。画像ごとの内訳は作らない。
 * 入力 ID と出力 ID の不一致（件数・欠落・重複・未知）は 502 で失敗させる。
 */
export async function analyzeReceiptImages(
  input: AnalyzeReceiptBatchInput,
): Promise<AnalyzeReceiptBatchResult> {
  const startedAt = Date.now();
  const images = input.images;
  if (
    !Array.isArray(images) ||
    images.length < 1 ||
    images.length > MAX_BATCH_FILES
  ) {
    throw new ReceiptAnalysisError(
      400,
      `画像は1〜${MAX_BATCH_FILES}件で送信してください。`,
    );
  }
  const seen = new Set<string>();
  for (const image of images) {
    if (
      typeof image.imageId !== "string" ||
      !IMAGE_ID_PATTERN.test(image.imageId) ||
      seen.has(image.imageId)
    ) {
      throw new ReceiptAnalysisError(
        400,
        "画像に対応するIDが不正です。半角英数字・ハイフン・アンダースコアで指定してください。",
      );
    }
    seen.add(image.imageId);
    if (typeof image.imageBase64 !== "string" || image.imageBase64.length === 0) {
      throw new ReceiptAnalysisError(
        400,
        "画像データが不正です。有効な画像ファイルをお送りください。",
      );
    }
  }
  const orderedIds = images.map((image) => image.imageId);

  const ai = new GoogleGenAI({ apiKey: input.apiKey });
  let outputText: string | undefined;
  let usage: ReceiptUsage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    thoughtTokens: null,
  };

  try {
    const interaction = await ai.interactions.create(
      {
        model: input.model,
        input: [
          { type: "text", text: buildBatchExtractionPrompt() },
          ...images.flatMap((image) => [
            { type: "text" as const, text: `次の画像のimageId: ${image.imageId}` },
            {
              type: "image" as const,
              data: image.imageBase64,
              mime_type: image.mimeType,
            },
          ]),
        ],
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: buildBatchJsonSchema(orderedIds),
        },
        store: false,
      },
      { maxRetries: 0, timeout: 300_000 },
    );
    outputText = interaction.output_text;
    usage = toReceiptUsage(interaction.usage);
  } catch (error) {
    // 上流の詳細・ID・画像は外に出さない。
    console.error(
      "[receipts/analyze-batch] Gemini API call failed:",
      getHttpStatus(error) ?? null,
    );
    throw toAnalysisError(error);
  }

  const parsed = parseAnalysisOutput(outputText);

  const validated = safeParseBatchReceipts(parsed);
  if (!validated.success) {
    console.error("[receipts/analyze-batch] Batch receipt validation failed");
    throw new ReceiptAnalysisError(
      502,
      "AIの応答形式が不正でした。再度お試しください。",
    );
  }

  const expected = new Set(orderedIds);
  const counts = new Map<string, number>();
  const byId = new Map<string, BatchReceiptResult>();
  let unexpectedImageIdCount = 0;
  for (const entry of validated.data.receipts) {
    const entryId = entry.imageId;
    if (!expected.has(entryId)) {
      unexpectedImageIdCount += 1;
      continue;
    }
    counts.set(entryId, (counts.get(entryId) ?? 0) + 1);
    if (!byId.has(entryId)) {
      byId.set(entryId, entry);
    }
  }
  const duplicateImageIds = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([entryId]) => entryId)
    .sort();
  const missingImageIds = orderedIds.filter((entryId) => !counts.has(entryId));
  if (
    missingImageIds.length > 0 ||
    duplicateImageIds.length > 0 ||
    unexpectedImageIdCount > 0 ||
    validated.data.receipts.length !== orderedIds.length
  ) {
    console.error("[receipts/analyze-batch] Batch receipt ID mismatch");
    throw new ReceiptAnalysisError(
      502,
      "AIの応答と入力画像の対応が一致しません。結果の欠落・重複を確認して再度お試しください。",
      {
        batchIssues: {
          missingImageIds,
          duplicateImageIds,
          unexpectedImageIdCount,
        },
      },
    );
  }

  const receipts: BatchReceiptResult[] = [];
  for (const entryId of orderedIds) {
    const entry = byId.get(entryId);
    if (!entry) {
      console.error("[receipts/analyze-batch] Batch receipt ID mismatch");
      throw new ReceiptAnalysisError(
        502,
        "AIの応答に不足している画像があります。不足した画像を確認して再度お試しください。",
        {
          batchIssues: {
            missingImageIds: orderedIds.filter(
              (candidate) => !byId.has(candidate),
            ),
            duplicateImageIds: [],
            unexpectedImageIdCount: 0,
          },
        },
      );
    }
    receipts.push(entry);
  }

  return {
    receipts,
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
    const retryAfterSeconds = parseRetryAfterFromError(error);
    return new ReceiptAnalysisError(
      429,
      "APIの利用上限に達しました（レート制限）。しばらく待ってから再度お試しください。",
      retryAfterSeconds !== undefined
        ? { retryAfterSeconds }
        : undefined,
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

/** 429 の Retry-After を安全な秒数に変換する。使えない場合は undefined。 */
function parseRetryAfterFromError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const headers = (error as { headers?: unknown }).headers;
  if (headers === undefined || headers === null) {
    return undefined;
  }
  let raw: unknown;
  if (typeof (headers as { get?: unknown }).get === "function") {
    try {
      raw = (headers as { get: (name: string) => unknown }).get("Retry-After");
    } catch {
      return undefined;
    }
  } else if (typeof headers === "object") {
    const record = headers as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() === "retry-after") {
        raw = record[key];
        break;
      }
    }
  }
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0
      ? raw
      : undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  if (value === "") {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    const seconds = Number.parseInt(value, 10);
    return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  const remaining = Math.ceil((timestamp - Date.now()) / 1000);
  if (!Number.isFinite(remaining)) {
    return undefined;
  }
  return Math.max(0, remaining);
}

/** クライアント側タイムアウト (APIConnectionTimeoutError) かを名前で判定する。 */
function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (error as { name?: unknown }).name === "APIConnectionTimeoutError";
}

function parseAnalysisOutput(outputText: string | undefined): unknown {
  if (!outputText || outputText.trim() === "") {
    throw new ReceiptAnalysisError(
      502,
      "AIからの応答が空でした。画像を確認して再度お試しください。",
    );
  }

  try {
    return JSON.parse(outputText);
  } catch {
    throw new ReceiptAnalysisError(
      502,
      "AIの応答をJSONとして解釈できませんでした。再度お試しください。",
    );
  }
}
