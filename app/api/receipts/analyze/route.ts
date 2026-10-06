import {
  DEFAULT_GEMINI_MODEL,
  ReceiptAnalysisError,
  analyzeReceiptImage,
} from "@/lib/receiptAnalysis";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_FILE_SIZE_MIB,
  SUPPORTED_FORMAT_LABEL,
  isAllowedImageMimeType,
} from "@/lib/imageUpload";
import type { AnalyzeReceiptResponse } from "@/types/receipt";

export const runtime = "nodejs";

const FILE_FIELD = "file";

function errorResponse(
  status: number,
  message: string,
  retryAfterSeconds?: number,
): Response {
  const body: { error: string; retryAfterSeconds?: number } = {
    error: message,
  };
  const headers: Record<string, string> = {};
  if (
    retryAfterSeconds !== undefined &&
    Number.isInteger(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    body.retryAfterSeconds = retryAfterSeconds;
    headers["Retry-After"] = String(retryAfterSeconds);
  }
  return Response.json(body, { status, headers });
}

export async function POST(request: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(
      400,
      "multipart/form-data 形式で画像を送信してください。",
    );
  }

  const entry = formData.get(FILE_FIELD);
  if (!(entry instanceof File)) {
    return errorResponse(
      400,
      `画像ファイル（file）が送信されていません。${SUPPORTED_FORMAT_LABEL} のいずれかをお送りください。`,
    );
  }
  if (entry.size <= 0) {
    return errorResponse(
      400,
      "空のファイルは解析できません。有効な画像ファイルをお送りください。",
    );
  }
  if (entry.size > MAX_FILE_SIZE_BYTES) {
    return errorResponse(
      413,
      `ファイルサイズは${MAX_FILE_SIZE_MIB}MiB以下にしてください。`,
    );
  }
  if (!isAllowedImageMimeType(entry.type)) {
    return errorResponse(
      415,
      `${SUPPORTED_FORMAT_LABEL} 形式の画像をお送りください。`,
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

  const imageBase64 = Buffer.from(await entry.arrayBuffer()).toString("base64");

  try {
    const result = await analyzeReceiptImage({
      apiKey,
      model,
      imageBase64,
      mimeType: entry.type,
    });
    return Response.json({
      receipt: result.receipt,
      metadata: {
        model: result.model,
        processingTimeMs: result.processingTimeMs,
        usage: result.usage,
      },
    } satisfies AnalyzeReceiptResponse);
  } catch (error) {
    if (error instanceof ReceiptAnalysisError) {
      return errorResponse(
        error.status,
        error.message,
        error.retryAfterSeconds,
      );
    }
    return errorResponse(
      500,
      "レシートの解析中にエラーが発生しました。再度お試しください。",
    );
  }
}
