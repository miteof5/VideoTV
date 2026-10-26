import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VideoTV",
  description: "无限画布 + 节点式工作流的 AI 视频生产平台",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-[color:var(--surface-0)] text-[color:var(--ink-1)]">
        {children}
      </body>
    </html>
  );
}
