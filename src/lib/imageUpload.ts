/** ブラウザーとサーバーで共有するアップロード制限。 */
export const MAX_FILE_SIZE_MIB = 10;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MIB * 1024 * 1024;
export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export const IMAGE_ACCEPT_ATTRIBUTE = ALLOWED_IMAGE_MIME_TYPES.join(",");
export const SUPPORTED_FORMAT_LABEL = "JPEG・PNG・WebP";

/** バッチ解析の共有制限。最大10件を1リクエストで処理する。 */
export const MAX_BATCH_FILES = 10;
/** バッチ合計の保守的な PoC 上限（60MiB raw → base64 約80MiB < inline 100MB）。 */
export const MAX_BATCH_SIZE_MIB = 60;
export const MAX_BATCH_SIZE_BYTES = MAX_BATCH_SIZE_MIB * 1024 * 1024;
/** 選択 UI が保持できる最大ファイル数。 */
export const MAX_SELECTED_FILES = 10;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export function isAllowedImageMimeType(
  mimeType: string,
): mimeType is AllowedImageMimeType {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function validateImageFile(file: File): string | null {
  if (file.size <= 0) {
    return "空のファイルは解析できません。有効な画像ファイルをお選びください。";
  }
  if (!isAllowedImageMimeType(file.type)) {
    return `${SUPPORTED_FORMAT_LABEL} 形式の画像をお選びください。`;
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `ファイルサイズは${MAX_FILE_SIZE_MIB}MiB以下にしてください。小さい画像でお試しください。`;
  }
  return null;
}
