import { useMemo } from "react";
import type { CompletedBatchRun } from "@/types/receipt";

function formatTokens(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString("ja-JP")} トークン`;
}

function formatTokenTotal(
  value: number | null,
  known: number,
  runs: number,
): string {
  if (value === null) return "—";
  if (known < runs) {
    return `${formatTokens(value)}（${runs}件中${known}件の合計）`;
  }
  return formatTokens(value);
}

interface BatchMeasurementsProps {
  completedRuns: CompletedBatchRun[];
}

export function BatchMeasurements({ completedRuns }: BatchMeasurementsProps) {
  const aggregate = useMemo(() => {
    if (completedRuns.length === 0) return null;
    let input = 0;
    let output = 0;
    let total = 0;
    let thought = 0;
    let inputKnown = 0;
    let outputKnown = 0;
    let totalKnown = 0;
    let thoughtKnown = 0;
    let time = 0;
    let images = 0;
    const models = new Set<string>();
    for (const run of completedRuns) {
      images += run.imageCount;
      time += run.metadata.processingTimeMs;
      models.add(run.metadata.model);
      const usage = run.metadata.usage;
      if (usage.inputTokens != null) {
        input += usage.inputTokens;
        inputKnown += 1;
      }
      if (usage.outputTokens != null) {
        output += usage.outputTokens;
        outputKnown += 1;
      }
      if (usage.totalTokens != null) {
        total += usage.totalTokens;
        totalKnown += 1;
      }
      if (usage.thoughtTokens != null) {
        thought += usage.thoughtTokens;
        thoughtKnown += 1;
      }
    }
    return {
      runs: completedRuns.length,
      images,
      time,
      models: [...models].sort(),
      input: inputKnown > 0 ? input : null,
      inputKnown,
      output: outputKnown > 0 ? output : null,
      outputKnown,
      total: totalKnown > 0 ? total : null,
      totalKnown,
      thought: thoughtKnown > 0 ? thought : null,
      thoughtKnown,
    };
  }, [completedRuns]);

  const measurementJson = useMemo(
    () =>
      JSON.stringify(
        {
          batches: completedRuns.map((run) => ({
            imageCount: run.imageCount,
            model: run.metadata.model,
            processingTimeMs: run.metadata.processingTimeMs,
            usage: run.metadata.usage,
          })),
        },
        null,
        2,
      ),
    [completedRuns],
  );

  function handleDownloadMeasurements(): void {
    const blob = new Blob([measurementJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "receipt-batch-measurements.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-labelledby="batch-meta-heading">
      <h2 id="batch-meta-heading">一括処理の記録</h2>
      {aggregate ? (
        <>
          <p className="help-text">
            この処理時間とトークン数は、まとめて送った画像全体の値です。
          </p>
          <dl className="summary-list">
            <div className="summary-list__row">
              <dt>リクエスト成功数</dt>
              <dd className="numeric">{aggregate.runs.toLocaleString("ja-JP")}</dd>
            </div>
            <div className="summary-list__row">
              <dt>処理した画像数（合計）</dt>
              <dd className="numeric">{aggregate.images.toLocaleString("ja-JP")}</dd>
            </div>
            <div className="summary-list__row">
              <dt>使用モデル</dt>
              <dd>{aggregate.models.join("、")}</dd>
            </div>
            <div className="summary-list__row">
              <dt>処理時間（合計）</dt>
              <dd className="numeric">
                {aggregate.time.toLocaleString("ja-JP")} ミリ秒
              </dd>
            </div>
            {aggregate.runs > 1 ? (
              <div className="summary-list__row">
                <dt>1回あたりの平均処理時間</dt>
                <dd className="numeric">
                  {Math.round(aggregate.time / aggregate.runs).toLocaleString("ja-JP")} ミリ秒
                </dd>
              </div>
            ) : null}
            <div className="summary-list__row">
              <dt>入力トークン数（合計）</dt>
              <dd className="numeric">
                {formatTokenTotal(aggregate.input, aggregate.inputKnown, aggregate.runs)}
              </dd>
            </div>
            <div className="summary-list__row">
              <dt>出力トークン数（合計）</dt>
              <dd className="numeric">
                {formatTokenTotal(aggregate.output, aggregate.outputKnown, aggregate.runs)}
              </dd>
            </div>
            <div className="summary-list__row">
              <dt>思考トークン数（合計）</dt>
              <dd className="numeric">
                {formatTokenTotal(aggregate.thought, aggregate.thoughtKnown, aggregate.runs)}
              </dd>
            </div>
            <div className="summary-list__row">
              <dt>合計トークン数（合計）</dt>
              <dd className="numeric">
                {formatTokenTotal(aggregate.total, aggregate.totalKnown, aggregate.runs)}
              </dd>
            </div>
          </dl>
          <details className="raw-json">
            <summary>一括全体のJSONを表示する</summary>
            <pre>{measurementJson}</pre>
          </details>
          <p>
            <button
              type="button"
              className="button button--secondary"
              onClick={handleDownloadMeasurements}
            >
              計測用JSONをダウンロードする
            </button>
          </p>
          <p className="help-text">
            ファイル名・レシート内容・画像URLを含まない集計用です。
          </p>
        </>
      ) : (
        <p className="help-text">
          解析が成功すると、使用モデル・処理時間・トークン数をまとめて記録します。
        </p>
      )}
    </section>
  );
}
