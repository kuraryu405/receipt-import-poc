import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "レシート取り込み PoC",
  description: "レシート画像をアップロードして内容を抽出するPoC",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <head>
        {/* DADS公式の案内に沿ったGoogle Fontsの読み込み。取得失敗時はsans-serifで表示される。 */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Routerではhead内linkが公式手段。DADS指定のGoogle Fonts読み込みを優先する */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@100..900&family=Noto+Sans+Mono:wght@100..900&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
