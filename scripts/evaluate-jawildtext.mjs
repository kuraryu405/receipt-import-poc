#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
/**
 * JaWildText receipt_kie の簡易評価スクリプト (依存なし・Node >= 20.9)。
 *
 * 公開データセット llm-jp/jawildtext の receipt_kie 画像を
 * ローカルの /api/receipts/analyze-batch にまとめて投げ、ヘッダー4項目と
 * 明細ペアの一致率を集計する PoC 診断用ツール。
 *
 * 厳守事項:
 * - データセットの画像・アノテーション・予測値・URL を保存しない。
 *   行ごとの出力は進捗番号と粗い状態のみ。集計 JSON のみ標準出力する。
 * - Gemini を直接呼ばない。API キーを扱わない (サーバー側の .env.local を使用)。
 * - 429 を受けたら即時停止し、リトライや連続送信をしない。
 * - 1 区切りにつき POST は1回のみ。並列送信や固定待機のキューは使わない。
 */

const DATASET = "llm-jp/jawildtext";
const CONFIG = "receipt_kie";
const SPLIT = "train";
const TOTAL_ROWS = 1151;
const ROWS_PAGE_SIZE = 100; // datasets-server の1回あたり上限
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 1画像あたり 10MiB
const MAX_BATCH_FILES = 10; // 1リクエストあたり最大10画像
const MAX_BATCH_TOTAL_BYTES = 60 * 1024 * 1024; // 1リクエスト合計 60MiB
const DEFAULT_LIMIT = 5;
const DEFAULT_BATCH_SIZE = 10;
const REPORT_VERSION = 2;

const USAGE = `使い方:
  node scripts/evaluate-jawildtext.mjs [options]

オプション:
  --base-url URL   評価対象アプリの起点 (既定: http://localhost:3100)
  --limit N        評価件数 1-${TOTAL_ROWS} (既定: ${DEFAULT_LIMIT})
  --offset N       開始位置 0 以上 (既定: 0。1151 件の全件は分割実行する)
  --batch-size N   1リクエストあたりの画像件数 1-${MAX_BATCH_FILES} (既定: ${DEFAULT_BATCH_SIZE})
  --report PATH    集計のみの JSON レポートを書き出す (既定: 書き出さない)
  --help, -h       この使い方を表示する

動作:
  有効な画像を --batch-size 件ずつに区切り、/api/receipts/analyze-batch へ
  1区切り1リクエストで順番に送信する。1画像の場合も単票エンドポイントは
  使わず、常にバッチエンドポイントを使う。合計が 60MiB を超える区切りは
  送信前に失敗として扱い、自動で細分化しない。429 を受けたら残りの区切り
  を送らずに中断する。

終了コード: 0 完了 / 1 実行時失敗 / 2 引数エラー / 3 クォータ到達で中断
`;

function failUsage(message) {
  console.error(`引数エラー: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    baseUrl: "http://localhost:3100",
    limit: DEFAULT_LIMIT,
    offset: 0,
    batchSize: DEFAULT_BATCH_SIZE,
    report: null,
  };
  const getValue = (flag, raw) => {
    if (raw === undefined) failUsage(`${flag} に値が必要です。`);
    return raw;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/) : [arg, undefined];
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (flag === "--base-url") {
      opts.baseUrl = getValue(flag, inline ?? argv[++i]);
    } else if (flag === "--limit") {
      opts.limit = Number(getValue(flag, inline ?? argv[++i]));
    } else if (flag === "--offset") {
      opts.offset = Number(getValue(flag, inline ?? argv[++i]));
    } else if (flag === "--batch-size") {
      opts.batchSize = Number(getValue(flag, inline ?? argv[++i]));
    } else if (flag === "--report") {
      opts.report = getValue(flag, inline ?? argv[++i]);
    } else {
      failUsage(`不明な引数: ${arg}`);
    }
  }
  let base;
  try {
    base = new URL(opts.baseUrl);
  } catch {
    failUsage("--base-url は http(s) の URL を指定してください。");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    failUsage("--base-url は http(s) の URL を指定してください。");
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > TOTAL_ROWS) {
    failUsage(`--limit は 1 から ${TOTAL_ROWS} の整数で指定してください。`);
  }
  if (!Number.isInteger(opts.offset) || opts.offset < 0 || opts.offset >= TOTAL_ROWS) {
    failUsage(`--offset は 0 から ${TOTAL_ROWS - 1} の整数で指定してください。`);
  }
  if (
    !Number.isInteger(opts.batchSize) ||
    opts.batchSize < 1 ||
    opts.batchSize > MAX_BATCH_FILES
  ) {
    failUsage(`--batch-size は 1 から ${MAX_BATCH_FILES} の整数で指定してください。`);
  }
  opts.baseUrl = base.toString().replace(/\/$/, "");
  return opts;
}

/* ---------- 正規化 ---------- */

/** NFKC と空白除去による文字列正規化。 */
function normText(value) {
  return value.normalize("NFKC").replace(/\s+/g, "");
}

function isPopulated(value) {
  return typeof value === "string" && normText(value) !== "";
}

/** 通貨記号・桁区切りを除き金額を数値化する。解釈できなければ null。 */
function parseAmount(raw) {
  if (typeof raw === "number") return Number.isNaN(raw) ? null : raw;
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[\s　,、]/g, "")
    .replace(/[¥￥円$]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

/**
 * 認識可能な日本語・ISO の日付表記を YYYY-MM-DD に正規化する。
 * 特定できない表記は null (呼び出し側で分母から除外する)。
 */
function normalizeDate(raw) {
  if (typeof raw !== "string") return null;
  const stripped = raw
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/[（(][^（）()]*[）)]$/, "");
  const jp = stripped.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  const iso = stripped.match(/(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  const m = jp ?? iso;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isInteger(y) || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/* ---------- データセット取得 ---------- */

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchRows(offset, length) {
  const rows = [];
  let rest = length;
  let cursor = offset;
  while (rest > 0) {
    const page = Math.min(rest, ROWS_PAGE_SIZE);
    const url =
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
      `&config=${CONFIG}&split=${SPLIT}&offset=${cursor}&length=${page}`;
    const body = await fetchJson(url, 30000);
    if (!Array.isArray(body.rows)) throw new Error("unexpected rows response");
    rows.push(...body.rows);
    cursor += page;
    rest -= page;
  }
  return rows;
}

/** 画像バイト列のシグネチャから形式を判定する。対応外は null。 */
function detectImage(bytes) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

function refValue(field) {
  if (!field || field.value === null || field.value === undefined) return null;
  return typeof field.value === "string" ? field.value : String(field.value);
}

/* ---------- スコアリング ---------- */

function newFieldStats() {
  return {
    merchant: { correct: 0, scored: 0 },
    date: { correct: 0, scored: 0 },
    total: { correct: 0, scored: 0 },
    tax: { correct: 0, scored: 0 },
  };
}

function scoreTextField(stats, ref, pred) {
  if (!isPopulated(ref)) return;
  stats.scored += 1;
  if (isPopulated(pred) && normText(ref) === normText(pred)) stats.correct += 1;
}

function scoreDateField(stats, ref, pred) {
  const refDate = normalizeDate(ref);
  if (refDate === null) return;
  stats.scored += 1;
  if (normalizeDate(pred) === refDate) stats.correct += 1;
}

function scoreAmountField(stats, ref, pred) {
  const refNum = parseAmount(ref);
  if (refNum === null) return;
  stats.scored += 1;
  if (typeof pred === "number" && !Number.isNaN(pred) && pred === refNum) {
    stats.correct += 1;
  }
}

function refItemPairs(lineItems) {
  if (!Array.isArray(lineItems)) return [];
  const pairs = [];
  for (const item of lineItems) {
    if (!item || typeof item !== "object") continue;
    const name = refValue(item.item_name);
    const price = parseAmount(refValue(item.item_price));
    if (isPopulated(name) && price !== null) {
      pairs.push({ name: normText(name), price });
    }
  }
  return pairs;
}

function predItemPairs(items) {
  if (!Array.isArray(items)) return [];
  const pairs = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (
      isPopulated(item.name) &&
      typeof item.price === "number" &&
      !Number.isNaN(item.price)
    ) {
      pairs.push({ name: normText(item.name), price: item.price });
    }
  }
  return pairs;
}

/** 品名+金額ペアの多重集合マッチングで TP/FP/FN を数える。 */
function matchItemPairs(refPairs, predPairs) {
  const pool = [...predPairs];
  let tp = 0;
  let fn = 0;
  for (const ref of refPairs) {
    const idx = pool.findIndex(
      (p) => p.name === ref.name && p.price === ref.price,
    );
    if (idx >= 0) {
      tp += 1;
      pool.splice(idx, 1);
    } else {
      fn += 1;
    }
  }
  return { tp, fp: pool.length, fn };
}

function round4(value) {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

/* ---------- バッチ評価の補助 ---------- */

/** データセット行番号 (0 始まり) から匿名の画像 ID を作る。 */
function buildImageId(datasetRowIndex) {
  return `receipt-${String(datasetRowIndex + 1).padStart(3, "0")}`;
}

/** 成功時のみ記録する数値 (有限・0 以上) かを判定する。 */
function asNonNegativeNumber(value) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : null;
}

/** usage の各トークン数を成功時のみ数値化する。欠損は null。 */
function sanitizeUsage(raw) {
  if (!raw || typeof raw !== "object") {
    return { inputTokens: null, outputTokens: null, thoughtTokens: null, totalTokens: null };
  }
  const record = raw;
  return {
    inputTokens: asNonNegativeNumber(record.inputTokens),
    outputTokens: asNonNegativeNumber(record.outputTokens),
    thoughtTokens: asNonNegativeNumber(record.thoughtTokens),
    totalTokens: asNonNegativeNumber(record.totalTokens),
  };
}

/**
 * 429 の再試行可能秒数をヘッダーまたは応答本文から読み取る。
 * 値は待機に使わず報告専用。特定できなければ null。
 */
function parseRetryAfterSeconds(headers, bodyText) {
  const fromHeader = headers?.get?.("retry-after");
  if (typeof fromHeader === "string" && fromHeader.trim() !== "") {
    const seconds = Number(fromHeader.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
    const asDate = Date.parse(fromHeader.trim());
    if (Number.isFinite(asDate)) {
      const diff = Math.floor((asDate - Date.now()) / 1000);
      if (Number.isFinite(diff) && diff >= 0) return diff;
    }
  }
  if (typeof bodyText === "string" && bodyText !== "") {
    try {
      const body = JSON.parse(bodyText);
      const candidates = body && typeof body === "object"
        ? [
          body.retryAfterSeconds,
          body.retryAfter,
          body.retry_after_seconds,
          body.retry_after,
        ]
        : [];
      for (const candidate of candidates) {
        const num = typeof candidate === "string" ? Number(candidate) : candidate;
        if (typeof num === "number" && Number.isFinite(num) && num >= 0) {
          return Math.floor(num);
        }
      }
    } catch {
      // 本文が JSON でなくても報告上は欠損扱いにする。
    }
  }
  return null;
}

/**
 * バッチ応答の receipts と要求 ID 集合を厳密に突合する。
 * 最終契約のフラット形式 (imageId + Receipt 項目) のみを受け付ける。
 * 件数・重複・未知 ID の不一致があれば null を返し、呼び出し側で
 * グループ全体を失敗扱いにする。位置の仮定は一切しない。
 */
function mapReceiptsByImageId(body, expectedIds) {
  if (!body || typeof body !== "object") return null;
  const receipts = body.receipts;
  if (!Array.isArray(receipts)) return null;
  if (receipts.length !== expectedIds.length) return null;
  const expected = new Set(expectedIds);
  const byId = new Map();
  for (const entry of receipts) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    if (typeof entry.imageId !== "string") return null;
    const rawId = entry.imageId;
    if (!expected.has(rawId) || byId.has(rawId)) return null;
    const receipt = { ...entry };
    delete receipt.imageId;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
    byId.set(rawId, receipt);
  }
  if (byId.size !== expectedIds.length) return null;
  for (const id of expectedIds) {
    if (!byId.has(id)) return null;
  }
  return byId;
}

/**
 * 採点前に Receipt の基本形状を検証する。不正な成功扱いを避けるため、
 * nullable 型 (merchant/date は string|null、total/tax は finite number|null)
 * と items 配列の存在を必須とする。items が欠損している場合は 0 件と
 * 推測せず不正扱いにする。
 */
function isValidReceiptShape(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return false;
  for (const key of ["merchant", "date"]) {
    const v = receipt[key];
    if (!(v === null || typeof v === "string")) return false;
  }
  for (const key of ["total", "tax"]) {
    const v = receipt[key];
    if (!(v === null || (typeof v === "number" && Number.isFinite(v)))) return false;
  }
  if (!Array.isArray(receipt.items)) return false;
  for (const item of receipt.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const n = item.name;
    if (!(n === null || n === undefined || typeof n === "string")) return false;
    const p = item.price;
    if (
      !(p === null || p === undefined || (typeof p === "number" && Number.isFinite(p)))
    ) {
      return false;
    }
  }
  return true;
}

/** 計測値の集計 (欠損除外。0 件は sum/mean を null にする)。 */
function summarizeValues(values) {
  const nums = values.filter(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
  if (nums.length === 0) return { count: 0, sum: null, mean: null };
  const sum = nums.reduce((a, b) => a + b, 0);
  return { count: nums.length, sum, mean: sum / nums.length };
}

/* ---------- メイン ---------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runStarted = new Date();
  const startedAtISO = runStarted.toISOString();
  const wallStart = Date.now();
  const effectiveLimit = Math.min(opts.limit, TOTAL_ROWS - opts.offset);

  // 失敗時即終了: ローカルサーバーの到達確認 (行内容は扱わない)。
  try {
    await fetch(opts.baseUrl, { signal: AbortSignal.timeout(8000) });
  } catch {
    console.error(
      "ローカルサーバーに接続できません。先に開発サーバーを起動してください。",
    );
    process.exit(1);
  }

  let rows;
  try {
    rows = await fetchRows(opts.offset, effectiveLimit);
  } catch {
    console.error("データセット行の取得に失敗しました。時間をおいて再試行してください。");
    process.exit(1);
  }

  const stats = newFieldStats();
  let itemTp = 0;
  let itemFp = 0;
  let itemFn = 0;
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let modelId = null;

  const requests = [];
  const successMetas = [];
  let attempted = 0;
  let successfulGroups = 0;
  let failedGroups = 0;
  let quotaStopped = false;
  let retryAfterSeconds = null;
  let groupIndex = 0;
  let consumedRows = 0;

  // 1区切り分の POST を実行する。画像バイト列は呼び出し後に破棄する。
  // 戻り値が "quota" の場合のみ呼び出し側で残り行の取得を中断する。
  // oversize 事前除外は実際の POST ではないため attempted/failedGroups
  // (requestStats.failed) に含めず、failed 画像数のみ加算する。
  async function flushGroup(group, g) {
    const label = `group ${g + 1}`;
    const rowIndices = group.map((item) => item.datasetRowIndex);
    const imageCount = group.length;
    const totalBytes = group.reduce((sum, item) => sum + item.bytes.length, 0);

    if (totalBytes > MAX_BATCH_TOTAL_BYTES) {
      failed += imageCount;
      requests.push({
        groupIndex: g,
        rowIndices,
        imageCount,
        httpStatus: null,
        status: "error",
        errorCategory: "group-oversize",
        localRejected: true,
        model: null,
        processingTimeMs: null,
        usage: null,
      });
      console.log(`#${label} fail:group-oversize`);
      return "done";
    }

    const imageIds = group.map((item) => item.imageId);
    let res = null;
    let httpStatus = null;
    let rawText = "";
    attempted += 1;
    try {
      const form = new FormData();
      for (const item of group) {
        form.append(
          "files",
          new Blob([item.bytes], { type: item.mime }),
          `${item.imageId}.${item.ext}`,
        );
      }
      form.append("imageIds", JSON.stringify(imageIds));
      res = await fetch(`${opts.baseUrl}/api/receipts/analyze-batch`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(360000),
      });
      httpStatus = res.status;
      rawText = await res.text();
    } catch {
      failed += imageCount;
      failedGroups += 1;
      requests.push({
        groupIndex: g,
        rowIndices,
        imageCount,
        httpStatus: null,
        status: "error",
        errorCategory: "network",
        localRejected: false,
        model: null,
        processingTimeMs: null,
        usage: null,
      });
      console.log(`#${label} fail:api-network`);
      return "done";
    }

    if (httpStatus === 429) {
      retryAfterSeconds = parseRetryAfterSeconds(res.headers, rawText);
      failed += imageCount;
      failedGroups += 1;
      quotaStopped = true;
      requests.push({
        groupIndex: g,
        rowIndices,
        imageCount,
        httpStatus,
        status: "error",
        errorCategory: "quota",
        localRejected: false,
        model: null,
        processingTimeMs: null,
        usage: null,
      });
      console.error(
        "APIクォータに到達したため中断します (429)。クォータを確認してから分割実行してください。",
      );
      return "quota";
    }

    if (!res.ok) {
      failed += imageCount;
      failedGroups += 1;
      requests.push({
        groupIndex: g,
        rowIndices,
        imageCount,
        httpStatus,
        status: "error",
        errorCategory: "http-error",
        localRejected: false,
        model: null,
        processingTimeMs: null,
        usage: null,
      });
      console.log(`#${label} fail:api-${httpStatus}`);
      return "done";
    }

    let apiBody = null;
    try {
      apiBody = JSON.parse(rawText);
    } catch {
      failed += imageCount;
      failedGroups += 1;
      requests.push({
        groupIndex: g,
        rowIndices,
        imageCount,
        httpStatus,
        status: "error",
        errorCategory: "invalid-response",
        localRejected: false,
        model: null,
        processingTimeMs: null,
        usage: null,
      });
      console.log(`#${label} fail:invalid-response`);
      return "done";
    }

    const byId = mapReceiptsByImageId(apiBody, imageIds);
    if (!byId) {
      failed += imageCount;
      failedGroups += 1;
      requests.push({
        groupIndex: g,
        rowIndices,
        imageCount,
        httpStatus,
        status: "error",
        errorCategory: "mapping-mismatch",
        localRejected: false,
        model: null,
        processingTimeMs: null,
        usage: null,
      });
      console.log(`#${label} fail:mapping-mismatch`);
      return "done";
    }

    for (const id of imageIds) {
      if (!isValidReceiptShape(byId.get(id))) {
        failed += imageCount;
        failedGroups += 1;
        requests.push({
          groupIndex: g,
          rowIndices,
          imageCount,
          httpStatus,
          status: "error",
          errorCategory: "invalid-response",
          localRejected: false,
          model: null,
          processingTimeMs: null,
          usage: null,
        });
        console.log(`#${label} fail:invalid-response`);
        return "done";
      }
    }

    const meta = apiBody?.metadata && typeof apiBody.metadata === "object"
      ? apiBody.metadata
      : {};
    const sanitizedModel = typeof meta.model === "string" && meta.model !== ""
      ? meta.model
      : null;
    const sanitizedProcessing = asNonNegativeNumber(meta.processingTimeMs);
    const sanitizedUsage = sanitizeUsage(meta.usage);
    if (sanitizedModel !== null && modelId === null) {
      modelId = sanitizedModel;
    }

    // ID 対応付けの確定後にのみ採点する。位置の仮定はしない。
    const byImageId = new Map(group.map((item) => [item.imageId, item]));
    for (const id of imageIds) {
      const target = byImageId.get(id);
      const receipt = byId.get(id);
      if (!target || !receipt) continue;
      const fields = target.fields ?? {};
      scoreTextField(stats.merchant, refValue(fields.store_name), receipt.merchant);
      scoreDateField(stats.date, refValue(fields.date), receipt.date);
      scoreAmountField(stats.total, refValue(fields.total_amount), receipt.total);
      scoreAmountField(stats.tax, refValue(fields.tax_amount), receipt.tax);
      const m = matchItemPairs(
        refItemPairs(fields.line_items),
        predItemPairs(receipt.items),
      );
      itemTp += m.tp;
      itemFp += m.fp;
      itemFn += m.fn;
    }
    processed += imageCount;
    successfulGroups += 1;
    successMetas.push({
      imageCount,
      processingTimeMs: sanitizedProcessing,
      usage: sanitizedUsage,
    });
    requests.push({
      groupIndex: g,
      rowIndices,
      imageCount,
      httpStatus,
      status: "success",
      errorCategory: null,
      localRejected: false,
      model: sanitizedModel,
      processingTimeMs: sanitizedProcessing,
      usage: sanitizedUsage,
    });
    console.log(`#${label} ok`);
    return "done";
  }

  // 行メタデータは範囲分を保持するが、画像バイト列は batchSize 件ずつだけ
  // 保持し、1 POST ごとに破棄する。429 後は次の行を読み込まない。
  // 有効画像の区切りは件数基準のみ (容量による自動細分化はしない)。
  let pending = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (quotaStopped) break;
    const ordinal = `${i + 1}/${rows.length}`;
    const datasetRowIndex = opts.offset + i;
    const row = rows[i]?.row;
    const imageSrc = row?.image?.src;
    consumedRows = i + 1;
    if (typeof imageSrc !== "string" || imageSrc === "") {
      skipped += 1;
      console.log(`#${ordinal} skip:invalid-row`);
      continue;
    }

    let bytes;
    try {
      const res = await fetch(imageSrc, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = Buffer.from(await res.arrayBuffer());
    } catch {
      skipped += 1;
      console.log(`#${ordinal} skip:download`);
      continue;
    }

    const detected = detectImage(bytes);
    if (!detected) {
      skipped += 1;
      console.log(`#${ordinal} skip:unsupported`);
      continue;
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      skipped += 1;
      console.log(`#${ordinal} skip:oversize`);
      continue;
    }

    pending.push({
      imageId: buildImageId(datasetRowIndex),
      datasetRowIndex,
      bytes,
      mime: detected.mime,
      ext: detected.ext,
      fields: row?.fields ?? {},
    });

    if (pending.length >= opts.batchSize) {
      const group = pending;
      pending = [];
      const outcome = await flushGroup(group, groupIndex);
      groupIndex += 1;
      for (const item of group) {
        item.bytes = null;
      }
      if (outcome === "quota") break;
    }
  }

  if (!quotaStopped && pending.length > 0) {
    const group = pending;
    pending = [];
    await flushGroup(group, groupIndex);
    groupIndex += 1;
    for (const item of group) {
      item.bytes = null;
    }
  }
  pending = [];

  let unstartedImages = 0;
  if (quotaStopped) {
    unstartedImages = Math.max(0, rows.length - consumedRows);
  }

  const precision = itemTp + itemFp === 0 ? null : itemTp / (itemTp + itemFp);
  const recall = itemTp + itemFn === 0 ? null : itemTp / (itemTp + itemFn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);

  const processingSummary = summarizeValues(
    successMetas.map((m) => m.processingTimeMs).filter((v) => v !== null),
  );
  const inputSummary = summarizeValues(
    successMetas.map((m) => m.usage.inputTokens).filter((v) => v !== null),
  );
  const outputSummary = summarizeValues(
    successMetas.map((m) => m.usage.outputTokens).filter((v) => v !== null),
  );
  const thoughtSummary = summarizeValues(
    successMetas.map((m) => m.usage.thoughtTokens).filter((v) => v !== null),
  );
  const totalSummary = summarizeValues(
    successMetas.map((m) => m.usage.totalTokens).filter((v) => v !== null),
  );
  const coveredImages = successMetas
    .filter((m) => m.usage.totalTokens !== null)
    .reduce((sum, m) => sum + m.imageCount, 0);
  const totalTokensPerReceiptAllocated = totalSummary.sum === null || coveredImages === 0
    ? { mean: null, totalTokensSum: totalSummary.sum, coveredImages, note: "按分参考値: 成功リクエストの totalTokens 合計を対象画像数で割った値。分母は totalTokens が得られた成功画像の合計。" }
    : {
      mean: totalSummary.sum / coveredImages,
      totalTokensSum: totalSummary.sum,
      coveredImages,
      note: "按分参考値: 成功リクエストの totalTokens 合計を対象画像数で割った値。分母は totalTokens が得られた成功画像の合計。",
    };

  const runFinished = new Date();
  const finishedAtISO = runFinished.toISOString();
  const wallTimeMs = Date.now() - wallStart;

  const report = {
    reportVersion: REPORT_VERSION,
    startedAt: startedAtISO,
    finishedAt: finishedAtISO,
    dataset: DATASET,
    config: CONFIG,
    split: SPLIT,
    requestedLimit: opts.limit,
    effectiveLimit,
    offset: opts.offset,
    batchSize: opts.batchSize,
    wallTimeMs,
    model: modelId ?? "unknown",
    processed,
    skipped,
    failed,
    fields: {
      merchant: {
        correct: stats.merchant.correct,
        scored: stats.merchant.scored,
        accuracy: round4(
          stats.merchant.scored === 0 ? null : stats.merchant.correct / stats.merchant.scored,
        ),
      },
      date: {
        correct: stats.date.correct,
        scored: stats.date.scored,
        accuracy: round4(
          stats.date.scored === 0 ? null : stats.date.correct / stats.date.scored,
        ),
      },
      total: {
        correct: stats.total.correct,
        scored: stats.total.scored,
        accuracy: round4(
          stats.total.scored === 0 ? null : stats.total.correct / stats.total.scored,
        ),
      },
      tax: {
        correct: stats.tax.correct,
        scored: stats.tax.scored,
        accuracy: round4(
          stats.tax.scored === 0 ? null : stats.tax.correct / stats.tax.scored,
        ),
      },
    },
    lineItems: {
      tp: itemTp,
      fp: itemFp,
      fn: itemFn,
      precision: round4(precision),
      recall: round4(recall),
      f1: round4(f1),
      note: "PoC診断用の簡易指標であり、JaWildText論文の正式なKIE F1評価手順の再現ではない。",
    },
    requestStats: {
      attempted,
      successful: successfulGroups,
      failed: failedGroups,
      quotaStopped,
      unstartedImages,
      unstartedImagesNote: "クォータ中断後に未試行で残った行数。画像の有効性未確認の行を含む。",
      retryAfterSeconds,
    },
    requests,
    measurements: {
      processingTimeMs: processingSummary,
      inputTokens: inputSummary,
      outputTokens: outputSummary,
      thoughtTokens: thoughtSummary,
      totalTokens: totalSummary,
      totalTokensPerReceiptAllocated,
    },
  };

  console.log(JSON.stringify(report));

  if (opts.report) {
    try {
      await writeFile(opts.report, `${JSON.stringify(report, null, 2)}\n`);
    } catch {
      console.error("レポートの書き出しに失敗しました。パスを確認してください。");
      process.exit(1);
    }
  }

  if (quotaStopped) process.exit(3);
}

main().catch(() => {
  console.error("評価中に予期しないエラーが発生しました。");
  process.exit(1);
});
