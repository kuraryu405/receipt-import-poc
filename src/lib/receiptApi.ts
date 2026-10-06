import type { BatchIssues } from "@/types/receipt";

interface ErrorResponseOptions {
  batchIssues?: BatchIssues;
  retryAfterSeconds?: number;
}

/** 両方の解析APIで同じエラー形式と待機ヘッダーを返す。 */
export function errorResponse(
  status: number,
  message: string,
  options: ErrorResponseOptions = {},
): Response {
  const body: ErrorResponseOptions & { error: string } = { error: message };
  if (options.batchIssues) body.batchIssues = options.batchIssues;

  const headers: Record<string, string> = {};
  const retryAfterSeconds = options.retryAfterSeconds;
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
