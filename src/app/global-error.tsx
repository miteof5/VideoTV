"use client";

import { useEffect } from "react";

/**
 * 最后一道边界：`layout.tsx` 自己崩了（或者 globals.css 没加载上）时用它。
 *
 * 为什么样式全是内联写死的字面值：
 * 走到这里说明 `<html>` / `<body>` 那层已经出了问题，全局 CSS 不一定还在。
 * 如果用 `var(--surface-0)` 这类变量，变量没定义时页面上会只剩默认白底黑字 ——
 * 在一个全黑的编辑器里突然弹出刺眼的白页，比错误本身更像故障。
 * 所以这里不依赖任何外部样式，颜色直接写死。
 *
 * 它必须自己渲染 <html> 和 <body>：这一层在 RootLayout 之外。
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    console.error("[global error]", error);
  }, [error]);

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#0a0a0a",
          color: "#ededed",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
        }}
      >
        <div style={{ width: "100%", maxWidth: 420 }}>
          <div
            style={{
              width: 36,
              height: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 999,
              border: "1px solid #7f1d1d",
              background: "rgba(69,10,10,0.6)",
              color: "#fca5a5",
              fontSize: 15,
              fontWeight: 500,
            }}
          >
            !
          </div>

          <h1 style={{ margin: "16px 0 0", fontSize: 18, fontWeight: 500 }}>
            应用没能启动
          </h1>

          <p
            style={{
              margin: "8px 0 0",
              fontSize: 14,
              lineHeight: 1.6,
              color: "#a3a3a3",
            }}
          >
            连页面的外壳都没渲染出来，这通常不是你的数据出了问题。你的项目和已经生成的东西都还在库里。
          </p>

          {error.message ? (
            <pre
              style={{
                margin: "16px 0 0",
                maxHeight: 160,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                border: "1px solid #262626",
                borderRadius: 6,
                background: "#171717",
                padding: "8px 12px",
                fontSize: 12,
                lineHeight: 1.6,
                color: "#a3a3a3",
              }}
            >
              {error.message}
            </pre>
          ) : null}

          <div style={{ marginTop: 24, display: "flex", gap: 8 }}>
            {/*
              这里只能用 location.reload()，不能像其他 error 页那样用 reset()：
              global-error 的 reset 只重渲染这一层，如果失败发生在 layout
              初始化阶段，重渲染会立刻再崩一次，用户看到的是"点了没反应"。
            */}
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                height: 32,
                padding: "0 16px",
                borderRadius: 8,
                border: "1px solid #525252",
                background: "#000",
                color: "#fff",
                fontSize: 14,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              重新加载
            </button>

            {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
                这一层 Next 的路由器本身可能就是坏的（layout 都没渲染出来），
                而 Link 要经过客户端路由。原生 a 在这里不是偷懒，是唯一还可靠的跳转。 */}
            <a
              href="/"
              style={{
                height: 32,
                display: "flex",
                alignItems: "center",
                padding: "0 16px",
                borderRadius: 8,
                border: "1px solid #3a3a3a",
                color: "#a3a3a3",
                fontSize: 14,
                textDecoration: "none",
              }}
            >
              回到项目列表
            </a>
          </div>
        </div>
      </body>
    </html>
  );
}
