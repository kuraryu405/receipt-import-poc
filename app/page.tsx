import { ReceiptImporter } from "@/components/ReceiptImporter";

export default function Home() {
  return (
    <main>
      <h1>レシート取り込み PoC</h1>
      <p>
        レシート画像をアップロードすると、内容を自動で読み取って一覧表示します。読み取り結果は必ず画像と見比べてご確認ください。
      </p>
      <p className="flow-note">手順：画像を選択 → Geminiで解析 → 読み取り結果を確認</p>

      <ReceiptImporter />

      <aside className="data-note" role="note" aria-labelledby="data-handling-title">
        <p className="data-note__title" id="data-handling-title">
          データの取り扱い
        </p>
        <p className="data-note__body">
          このPoCでは公開データセット JaWildText の receipt_kie
          画像を評価に使用します。画像はGemini APIへ送信されます。社内レシートなど未公開の購入情報は送信しないでください。実運用データを扱う前に、APIの保持・利用条件を確認してください。
        </p>
      </aside>
    </main>
  );
}
