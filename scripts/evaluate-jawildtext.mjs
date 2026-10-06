#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
/**
 * JaWildText receipt_kie の簡易評価スクリプト (依存なし・Node >= 20.9)。
 *
 * 公開データセット llm-jp/jawildtext の receipt_kie 画像を一件ずつ
 * ローカルの /api/receipts/analyze に投げ、ヘッダー4項目と明細ペアの
 * 一致率を集計する PoC 診断用ツール。
 *
 * 厳守事項:
 * - データセットの画像・アノテーション・予測値・URL を保存しない。
 *   行ごとの出力は進捗番号と粗い状態のみ。集計 JSON のみ標準出力する。
 * - Gemini を直接呼ばない。API キーを扱わない (サーバー側の .env.local を使用)。
 * - 429 を受けたら即時停止し、リトライや連続送信をしない。
 */

const DATASET = "llm-jp/jawildtext";
const CONFIG = "receipt_kie";
const SPLIT = "train";
const TOTAL_ROWS = 1151;
const ROWS_PAGE_SIZE = 100; // datasets-server の1回あたり上限
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // サーバーの 10MiB 制限と合わせる
const DEFAULT_LIMIT = 5;
const DEFAULT_DELAY_MS = 1000;

const USAGE = `使い方:
  node scripts/evaluate-jawildtext.mjs [options]

オプション:
  --base-url URL   評価対象アプリの起点 (既定: http://localhost:3100)
  --limit N        評価件数 1-${TOTAL_ROWS} (既定: ${DEFAULT_LIMIT})
  --offset N       開始位置 0 以上 (既定: 0。1151 件の全件は分割実行する)
  --delay-ms MS    解析リクエスト間の待ち時間 (既定: ${DEFAULT_DELAY_MS})
  --report PATH    集計のみの JSON レポートを書き出す (既定: 書き出さない)
  --help, -h       この使い方を表示する

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
    delayMs: DEFAULT_DELAY_MS,
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
    } else if (flag === "--delay-ms") {
      opts.delayMs = Number(getValue(flag, inline ?? argv[++i]));
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
  if (!Number.isInteger(opts.delayMs) || opts.delayMs < 0) {
    failUsage("--delay-ms は 0 以上の整数で指定してください。");
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- メイン ---------- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
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
  let quotaStopped = false;

  for (let i = 0; i < rows.length; i += 1) {
    const ordinal = `${i + 1}/${rows.length}`;
    const row = rows[i]?.row;
    const imageSrc = row?.image?.src;
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

    if (i > 0 && opts.delayMs > 0) await sleep(opts.delayMs);

    let apiBody = null;
    let apiStatus = 0;
    try {
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: detected.mime }), `receipt.${detected.ext}`);
      const res = await fetch(`${opts.baseUrl}/api/receipts/analyze`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(300000),
      });
      apiStatus = res.status;
      if (res.status === 429) {
        console.error(
          "APIクォータに到達したため中断します (429)。クォータを確認してから分割実行してください。",
        );
        quotaStopped = true;
        break;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      apiBody = await res.json();
    } catch {
      failed += 1;
      console.log(`#${ordinal} fail:api-${apiStatus || "network"}`);
      continue;
    }

    const receipt = apiBody?.receipt;
    if (!receipt || typeof receipt !== "object") {
      failed += 1;
      console.log(`#${ordinal} fail:invalid-response`);
      continue;
    }
    if (typeof apiBody?.metadata?.model === "string" && modelId === null) {
      modelId = apiBody.metadata.model;
    }

    const fields = row?.fields ?? {};
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
    processed += 1;
    console.log(`#${ordinal} ok`);
  }

  const precision = itemTp + itemFp === 0 ? null : itemTp / (itemTp + itemFp);
  const recall = itemTp + itemFn === 0 ? null : itemTp / (itemTp + itemFn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);

  const report = {
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
