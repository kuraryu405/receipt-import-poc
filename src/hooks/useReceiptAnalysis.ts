import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_BATCH_FILES,
  MAX_BATCH_SIZE_BYTES,
  MAX_BATCH_SIZE_MIB,
  MAX_SELECTED_FILES,
  validateImageFile,
} from "@/lib/imageUpload";
import { safeParseReceipt } from "@/lib/receiptSchema";
import type {
  Receipt,
  ReceiptAnalysisMetadata,
  ReceiptUsage,
} from "@/types/receipt";

export const CLIENT_TIMEOUT_MS = 360_000;

/** Date に格納できる待機秒数の上限。タイマーは1秒ずつ更新する。 */
const MAX_RETRY_AFTER_SEC = Math.floor((8_640_000_000_000_000 - Date.now()) / 1000);

export type BatchItemStatus = "queued" | "processing" | "success" | "error";

export interface ReceiptBatchItem {
  imageId: string;
  file: File;
  objectUrl: string;
  status: BatchItemStatus;
  receipt: Receipt | null;
  error: string | null;
}

export interface CompletedBatchRun {
  imageCount: number;
  metadata: ReceiptAnalysisMetadata;
}

interface BatchErrorBody {
  error?: unknown;
  batchIssues?: {
    missingImageIds?: unknown;
    duplicateImageIds?: unknown;
    unexpectedImageIdCount?: unknown;
  };
  retryAfterSeconds?: unknown;
}

function toErrorMessage(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function clampRetrySeconds(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  const ceiled = Math.ceil(value);
  if (!Number.isFinite(ceiled) || ceiled < 0) return null;
  return Math.min(ceiled, MAX_RETRY_AFTER_SEC);
}

function parseRetryAfterHeader(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds)) {
    return clampRetrySeconds(asSeconds);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diffSec = (dateMs - Date.now()) / 1000;
    if (!Number.isFinite(diffSec)) return null;
    if (diffSec <= 0) return 0;
    return Math.min(Math.ceil(diffSec), MAX_RETRY_AFTER_SEC);
  }
  return null;
}

function toFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function toUsageOrNull(value: unknown): ReceiptUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  return {
    inputTokens: toFiniteNumberOrNull(record.inputTokens),
    outputTokens: toFiniteNumberOrNull(record.outputTokens),
    totalTokens: toFiniteNumberOrNull(record.totalTokens),
    thoughtTokens:
      "thoughtTokens" in record ? toFiniteNumberOrNull(record.thoughtTokens) : null,
  };
}

function toMetadataOrNull(value: unknown): ReceiptAnalysisMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.model !== "string" || record.model.length === 0) return null;
  if (
    typeof record.processingTimeMs !== "number" ||
    !Number.isFinite(record.processingTimeMs) ||
    record.processingTimeMs < 0
  ) {
    return null;
  }
  const usage = toUsageOrNull(record.usage);
  if (!usage) return null;
  return {
    model: record.model,
    processingTimeMs: record.processingTimeMs,
    usage,
  };
}

function normalizeBatchEntry(
  entry: unknown,
): { imageId: string; receipt: Receipt } | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.imageId !== "string") return null;
  const { imageId, ...rest } = record;
  const parsed = safeParseReceipt(rest);
  if (!parsed.success) return null;
  return { imageId, receipt: parsed.data };
}

let imageIdCounter = 0;

function nextImageId(): string {
  imageIdCounter += 1;
  return `receipt-${String(imageIdCounter).padStart(3, "0")}`;
}

function formatTotalBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

export function useReceiptAnalysis() {
  const [items, setItems] = useState<ReceiptBatchItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [cooldown, setCooldown] = useState<{
    untilMs: number;
    totalSec: number;
    message: string;
  } | null>(null);
  const [cooldownRemainingSec, setCooldownRemainingSec] = useState(0);
  const [lastMetadata, setLastMetadata] =
    useState<ReceiptAnalysisMetadata | null>(null);
  const [completedRuns, setCompletedRuns] = useState<CompletedBatchRun[]>([]);

  const isProcessingRef = useRef(false);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemsRef = useRef<ReceiptBatchItem[]>([]);

  const commitItems = useCallback((next: ReceiptBatchItem[]): void => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const item of itemsRef.current) URL.revokeObjectURL(item.objectUrl);
    };
  }, []);

  useEffect(() => {
    if (cooldown == null) return undefined;
    const tick = (): void => {
      if (!mountedRef.current) return;
      const remaining = Math.max(
        0,
        Math.ceil((cooldown.untilMs - Date.now()) / 1000),
      );
      setCooldownRemainingSec(remaining);
      if (remaining <= 0) {
        setCooldown(null);
        return;
      }
      cooldownTimerRef.current = setTimeout(tick, 1000);
    };
    const timer = setTimeout(tick, 1000);
    cooldownTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (cooldownTimerRef.current === timer) cooldownTimerRef.current = null;
    };
  }, [cooldown]);

  const cooldownRetryAtText = useMemo(() => {
    if (cooldown == null) return null;
    return new Date(cooldown.untilMs).toLocaleString("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }, [cooldown]);

  const activeItem: ReceiptBatchItem | null =
    items.find((item) => item.imageId === activeId) ?? null;

  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  const isOverTotalLimit = totalBytes > MAX_BATCH_SIZE_BYTES;
  const pendingItems = items.filter((item) => item.status === "queued");
  const errorItems = items.filter((item) => item.status === "error");
  const successCount = items.filter((item) => item.status === "success").length;
  const inCooldown = cooldown != null;

  const selectFiles = useCallback(
    (files: FileList | File[] | null): void => {
      if (isProcessingRef.current) return;
      if (!files) return;
      const incoming: File[] = Array.from(files);
      if (incoming.length === 0) return;

      const errors: string[] = [];
      const valid: File[] = [];
      for (const file of incoming) {
        const reason = validateImageFile(file);
        if (reason) {
          errors.push(`${file.name}: ${reason}`);
        } else {
          valid.push(file);
        }
      }

      const previous = itemsRef.current;
      const room = MAX_SELECTED_FILES - previous.length;
      if (room <= 0) {
        setFieldErrors([
          ...errors,
          `選択は${MAX_SELECTED_FILES}枚までです。追加できませんでした（${incoming.length}枚を受信）。有効な結果は削除していません。`,
        ]);
        setBatchError(null);
        return;
      }
      const accepted = valid.slice(0, room);
      const dropped = valid.length - accepted.length;
      const added: ReceiptBatchItem[] = accepted.map((file) => ({
        imageId: nextImageId(),
        file,
        objectUrl: URL.createObjectURL(file),
        status: "queued" as const,
        receipt: null,
        error: null,
      }));
      const next = [...previous, ...added];
      const nextErrors = [...errors];
      if (dropped > 0) {
        nextErrors.push(
          `選択は${MAX_SELECTED_FILES}枚までです。${accepted.length}枚を追加し、${dropped}枚を追加していません。有効な結果は削除していません。`,
        );
      }
      commitItems(next);
      setFieldErrors(nextErrors);
      const nextTotal = next.reduce((sum, item) => sum + item.file.size, 0);
      if (nextTotal > MAX_BATCH_SIZE_BYTES) {
        setBatchError(
          `合計ファイルサイズが上限（${MAX_BATCH_SIZE_MIB}MiB）を超えています（現在 ${formatTotalBytes(nextTotal)}）。画像を減らしてください。自動で分割しません。`,
        );
      } else {
        setBatchError(null);
      }
      if (added.length > 0) {
        setActiveId((current) => {
          if (current && next.some((item) => item.imageId === current)) {
            return current;
          }
          return added[0]?.imageId ?? next[0]?.imageId ?? null;
        });
      }
    },
    [commitItems],
  );

  const removeItem = useCallback(
    (imageId: string): void => {
      if (isProcessingRef.current) return;
      const previous = itemsRef.current;
      const target = previous.find((item) => item.imageId === imageId);
      if (!target) return;
      URL.revokeObjectURL(target.objectUrl);
      const next = previous.filter((item) => item.imageId !== imageId);
      commitItems(next);
      setActiveId((current) => {
        if (current !== imageId) return current;
        return next[0]?.imageId ?? null;
      });
      const nextTotal = next.reduce((sum, item) => sum + item.file.size, 0);
      if (nextTotal <= MAX_BATCH_SIZE_BYTES) {
        setBatchError((current) =>
          current != null && current.includes("合計ファイルサイズ")
            ? null
            : current,
        );
      }
      setFieldErrors([]);
    },
    [commitItems],
  );

  const clearAll = useCallback((): void => {
    if (isProcessingRef.current) return;
    const previous = itemsRef.current;
    for (const item of previous) URL.revokeObjectURL(item.objectUrl);
    commitItems([]);
    setActiveId(null);
    setFieldErrors([]);
    setBatchError(null);
  }, [commitItems]);

  const sendBatch = useCallback(
    async (targets: ReceiptBatchItem[]): Promise<void> => {
      if (targets.length === 0 || targets.length > MAX_BATCH_FILES) return;
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;
      const sentIds = targets.map((item) => item.imageId);
      if (mountedRef.current) {
        setIsProcessing(true);
        setBatchError(null);
        const previous = itemsRef.current;
        commitItems(
          previous.map((item) =>
            sentIds.includes(item.imageId)
              ? { ...item, status: "processing" as const, error: null }
              : item,
          ),
        );
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

      try {
        const formData = new FormData();
        for (const item of targets) formData.append("files", item.file);
        formData.append("imageIds", JSON.stringify(sentIds));

        let response: Response;
        try {
          response = await fetch("/api/receipts/analyze-batch", {
            method: "POST",
            body: formData,
            signal: controller.signal,
          });
        } catch (error) {
          if (!mountedRef.current) return;
          const message =
            error instanceof DOMException && error.name === "AbortError"
              ? "解析がタイムアウトしました（360秒）。画像を減らして再度お試しください。"
              : "通信中にエラーが発生しました。ネットワーク接続を確認して再度お試しください。";
          commitItems(
            itemsRef.current.map((item) =>
              sentIds.includes(item.imageId)
                ? { ...item, status: "error" as const, error: message }
                : item,
            ),
          );
          setBatchError(message);
          return;
        }

        const retryHeader = parseRetryAfterHeader(
          response.headers.get("Retry-After"),
        );
        const body: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          if (!mountedRef.current) return;
          const errorBody = (body ?? {}) as BatchErrorBody;
          const message = toErrorMessage(
            errorBody.error,
            "レシートの解析に失敗しました。時間をおいて再度お試しください。",
          );
          const rawRetry =
            typeof errorBody.retryAfterSeconds === "number"
              ? errorBody.retryAfterSeconds
              : null;
          const retryAfterSeconds =
            rawRetry == null ? null : clampRetrySeconds(rawRetry);
          const cooldownSec =
            retryHeader ?? retryAfterSeconds ?? (response.status === 429 ? 0 : null);
          if (response.status === 429 && cooldownSec != null && cooldownSec > 0) {
            const untilMs = Date.now() + cooldownSec * 1000;
            const retryAt = new Date(untilMs).toLocaleString("ja-JP", {
      month: "numeric",
      day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
            const waitMessage = `${message} ${retryAt}以降に再試行を受け付けます。利用枠の回復時刻は保証されません。`;
            setCooldown({ untilMs, totalSec: cooldownSec, message: waitMessage });
            setCooldownRemainingSec(cooldownSec);
            setBatchError(waitMessage);
            commitItems(
              itemsRef.current.map((item) =>
                sentIds.includes(item.imageId)
                  ? { ...item, status: "error" as const, error: waitMessage }
                  : item,
              ),
            );
            return;
          }
          const issues = errorBody.batchIssues;
          let detail = message;
          if (issues && typeof issues === "object") {
            const byId = new Map(
              targets.map((item) => [item.imageId, item.file.name]),
            );
            const parts: string[] = [];
            const missing = Array.isArray(issues.missingImageIds)
              ? (issues.missingImageIds as unknown[]).filter(
                  (id): id is string => typeof id === "string",
                )
              : [];
            for (const id of missing) {
              parts.push(`未確定: ${byId.get(id) ?? id}`);
            }
            if (typeof issues.unexpectedImageIdCount === "number" && issues.unexpectedImageIdCount > 0) {
              parts.push("応答に入力にないIDがあります（一括は未確定）");
            }
            if (
              Array.isArray(issues.duplicateImageIds) &&
              (issues.duplicateImageIds as unknown[]).length > 0
            ) {
              parts.push("応答に重複IDがあります（一括は未確定）");
            }
            if (parts.length > 0) detail = `${message}（${parts.join("／")}）`;
          }
          setBatchError(detail);
          commitItems(
            itemsRef.current.map((item) =>
              sentIds.includes(item.imageId)
                ? { ...item, status: "error" as const, error: detail }
                : item,
            ),
          );
          return;
        }

        if (!mountedRef.current) return;
        const record =
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>)
            : null;
        const rawReceipts = record?.receipts;
        const metadata = toMetadataOrNull(record?.metadata);
        if (!Array.isArray(rawReceipts) || !metadata) {
          const message =
            "サーバーから正しい応答を受け取れませんでした。再度お試しください。";
          setBatchError(message);
          commitItems(
            itemsRef.current.map((item) =>
              sentIds.includes(item.imageId)
                ? { ...item, status: "error" as const, error: message }
                : item,
            ),
          );
          return;
        }
        const normalized: { imageId: string; receipt: Receipt }[] = [];
        let invalid = false;
        for (const entry of rawReceipts) {
          const parsed = normalizeBatchEntry(entry);
          if (!parsed) {
            invalid = true;
            break;
          }
          normalized.push(parsed);
        }
        const expected = new Set(sentIds);
        const seen = new Set<string>();
        if (!invalid) {
          if (normalized.length !== sentIds.length) {
            invalid = true;
          } else {
            for (const entry of normalized) {
              if (!expected.has(entry.imageId) || seen.has(entry.imageId)) {
                invalid = true;
                break;
              }
              seen.add(entry.imageId);
            }
          }
        }
        if (invalid) {
          const byId = new Map(
            targets.map((item) => [item.imageId, item.file.name]),
          );
          const returnedIds = new Set(
            normalized
              .map((entry) => entry.imageId)
              .filter((id) => typeof id === "string"),
          );
          const missingNames = sentIds
            .filter((id) => !returnedIds.has(id))
            .map((id) => byId.get(id) ?? id);
          const message =
            missingNames.length > 0
              ? `応答が送信と一致しません（一括は未確定）。未確定: ${missingNames.join("、")}`
              : "AIの応答形式が不正でした（一括は未確定）。再度お試しください。未知・欠落・重複のある出力は採用していません。";
          setBatchError(message);
          commitItems(
            itemsRef.current.map((item) =>
              sentIds.includes(item.imageId)
                ? { ...item, status: "error" as const, error: message }
                : item,
            ),
          );
          return;
        }

        const byId = new Map(normalized.map((entry) => [entry.imageId, entry.receipt]));
        commitItems(
          itemsRef.current.map((item) =>
            sentIds.includes(item.imageId)
              ? {
                  ...item,
                  status: "success" as const,
                  receipt: byId.get(item.imageId) ?? null,
                  error: null,
                }
              : item,
          ),
        );
        setLastMetadata(metadata);
        setCompletedRuns((previous) => [
          ...previous,
          { imageCount: sentIds.length, metadata },
        ]);
      } finally {
        clearTimeout(timeoutId);
        if (abortRef.current === controller) abortRef.current = null;
        isProcessingRef.current = false;
        if (mountedRef.current) setIsProcessing(false);
      }
    },
    [commitItems],
  );

  const analyze = useCallback(async (): Promise<void> => {
    if (isProcessingRef.current) return;
    if (cooldown != null) return;
    if (itemsRef.current.reduce((sum, item) => sum + item.file.size, 0) > MAX_BATCH_SIZE_BYTES)
      return;
    const queued = itemsRef.current.filter((item) => item.status === "queued");
    if (queued.length === 0) return;
    await sendBatch(queued);
  }, [cooldown, sendBatch]);

  const retryFailed = useCallback(async (): Promise<void> => {
    if (isProcessingRef.current) return;
    if (cooldown != null) return;
    if (itemsRef.current.reduce((sum, item) => sum + item.file.size, 0) > MAX_BATCH_SIZE_BYTES)
      return;
    const previous = itemsRef.current;
    const next = previous.map((item) =>
      item.status === "error"
        ? { ...item, status: "queued" as const, error: null }
        : item,
    );
    commitItems(next);
    const targets = next.filter((item) => item.status === "queued");
    if (targets.length === 0) return;
    await sendBatch(targets);
  }, [cooldown, commitItems, sendBatch]);

  return {
    items,
    activeId,
    activeItem,
    setActiveId,
    fieldErrors,
    batchError,
    isProcessing,
    cooldownRemainingSec,
    cooldownRetryAtText,
    inCooldown,
    lastMetadata,
    completedRuns,
    totalBytes,
    isOverTotalLimit,
    pendingCount: pendingItems.length,
    errorCount: errorItems.length,
    successCount,
    selectFiles,
    removeItem,
    clearAll,
    analyze,
    retryFailed,
  };
}
