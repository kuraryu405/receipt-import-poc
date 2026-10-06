import {
  DEFAULT_GEMINI_MODEL,
  ReceiptAnalysisError,
  analyzeReceiptImages,
} from "@/lib/receiptAnalysis";
import {
  MAX_BATCH_FILES,
  MAX_BATCH_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_MIB,
  SUPPORTED_FORMAT_LABEL,
  isAllowedImageMimeType,
} from "@/lib/imageUpload";
import type { AnalyzeReceiptBatchResponse } from "@/types/receipt";

export const runtime = "nodejs";

const FILES_FIELD = "files";
const IMAGE_IDS_FIELD = "imageIds";
const BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function errorResponse(
  status: number,
  message: string,
  options?: {
    batchIssues?: {
      missingImageIds: string[];
      duplicateImageIds: string[];
      unexpectedImageIdCount: number;
    };
    retryAfterSeconds?: number;
  },
): Response {
  const body: {
    error: string;
    batchIssues?: {
      missingImageIds: string[];
      duplicateImageIds: string[];
      unexpectedImageIdCount: number;
    };
    retryAfterSeconds?: number;
  } = { error: message };
  if (options?.batchIssues) {
    body.batchIssues = options.batchIssues;
  }
  const headers: Record<string, string> = {};
  if (
    options?.retryAfterSeconds !== undefined &&
    Number.isInteger(options.retryAfterSeconds) &&
    (options.retryAfterSeconds as number) >= 0
  ) {
    body.retryAfterSeconds = options.retryAfterSeconds;
    headers["Retry-After"] = String(options.retryAfterSeconds);
  }
  return Response.json(body, { status, headers });
}

function toErrorResponse(error: ReceiptAnalysisError): Response {
  return errorResponse(error.status, error.message, {
    ...(error.batchIssues ? { batchIssues: error.batchIssues } : {}),
    ...(error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
  });
}

export async function POST(request: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(
      400,
      "multipart/form-data 形式で画像とID一覧を送信してください。",
    );
  }

  const fileEntries = formData.getAll(FILES_FIELD);
  if (fileEntries.length < 1 || fileEntries.length > MAX_BATCH_FILES) {
    return errorResponse(
      400,
      `画像は1〜${MAX_BATCH_FILES}件で送信してください。`,
    );
  }
  for (const entry of fileEntries) {
    if (!(entry instanceof File)) {
      return errorResponse(
        400,
        "multipart/form-data 形式で画像とID一覧を送信してください。",
      );
    }
  }
  const files = fileEntries as File[];

  const imageIdsEntry = formData.get(IMAGE_IDS_FIELD);
  if (typeof imageIdsEntry !== "string") {
    return errorResponse(
      400,
      "画像に対応するID一覧（imageIds）が送信されていません。",
    );
  }
  let imageIds: unknown;
  try {
    imageIds = JSON.parse(imageIdsEntry);
  } catch {
    return errorResponse(400, "ID一覧（imageIds）の形式が不正です。");
  }
  if (
    !Array.isArray(imageIds) ||
    imageIds.length !== files.length ||
    imageIds.length < 1 ||
    imageIds.length > MAX_BATCH_FILES
  ) {
    return errorResponse(400, "画像の件数とIDの件数が一致しません。");
  }
  const seen = new Set<string>();
  for (const imageId of imageIds) {
    if (
      typeof imageId !== "string" ||
      !BATCH_ID_PATTERN.test(imageId) ||
      seen.has(imageId)
    ) {
      return errorResponse(
        400,
        "IDの形式が不正です。半角英数字・ハイフン・アンダースコアで指定してください。",
      );
    }
    seen.add(imageId);
  }
  const orderedIds = imageIds as string[];

  for (const file of files) {
    if (file.size <= 0) {
      return errorResponse(
        400,
        "空のファイルは解析できません。有効な画像ファイルをお送りください。",
      );
    }
  }
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return errorResponse(
        413,
        `ファイルサイズは${MAX_FILE_SIZE_MIB}MiB以下にしてください。`,
      );
    }
  }
  for (const file of files) {
    if (!isAllowedImageMimeType(file.type)) {
      return errorResponse(
        415,
        `${SUPPORTED_FORMAT_LABEL} 形式の画像をお送りください。`,
      );
    }
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_BATCH_SIZE_BYTES) {
    return errorResponse(
      413,
      "合計ファイルサイズが上限を超えています。小さい画像でお試しください。",
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return errorResponse(
      500,
      "サーバーのAPIキー設定が不足しています。管理者にお問い合わせください。",
    );
  }
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

  const images = await Promise.all(
    files.map(async (file, index) => {
      const imageId = orderedIds[index];
      if (typeof imageId !== "string") {
        throw new ReceiptAnalysisError(
          400,
          "画像の件数とIDの件数が一致しません。",
        );
      }
      return {
        imageId,
        imageBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
        mimeType: file.type,
      };
    }),
  );

  try {
    const result = await analyzeReceiptImages({
      apiKey,
      model,
      images: images.map((image) => {
        const mimeType = image.mimeType;
        if (!isAllowedImageMimeType(mimeType)) {
          throw new ReceiptAnalysisError(
            415,
            `${SUPPORTED_FORMAT_LABEL} 形式の画像をお送りください。`,
          );
        }
        return {
          imageId: image.imageId,
          imageBase64: image.imageBase64,
          mimeType,
        };
      }),
    });
    return Response.json({
      receipts: result.receipts,
      metadata: {
        model: result.model,
        processingTimeMs: result.processingTimeMs,
        usage: result.usage,
      },
    } satisfies AnalyzeReceiptBatchResponse);
  } catch (error) {
    if (error instanceof ReceiptAnalysisError) {
      return toErrorResponse(error);
    }
    return errorResponse(
      500,
      "レシートの解析中にエラーが発生しました。再度お試しください。",
    );
  }
}
