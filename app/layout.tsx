import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "レシート取り込み PoC",
  description: "レシート取り込みの最小構成",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
