"use client";

import { useEffect } from "react";
import { ErrorPanel } from "./_components/ErrorPanel";

/**
 * 根级错误边界。`layout.tsx` 之下的任何一页崩了都落到这里。
 *
 * 为什么需要它（2026-10-28 补）：在这之前 `src/app` 下没有 error.tsx，
 * 任何组件抛错（旧项目数据过不了 zod、资产 404、SSE 断流）都是 Next 的
 * 默认错误页 —— 白屏 + 英文堆栈，没有重试入口，只能重启 dev。
 * 而这是用户唯一能看到自己作品的地方。
 *
 * 它盖不住 layout 本身出错，那种情况由 global-error.tsx 接。
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // dev 下 Next 自己会在终端打完整堆栈；这条是为了在生产里也能从
    // 浏览器控制台捞到原始信息（生产只给 digest，没有 message）
    console.error("[page error]", error);
  }, [error]);

  return (
    <ErrorPanel
      title="这块出错了"
      description="页面没能渲染完成。你的项目和已经生成的东西都还在，没有丢 —— 重试一下通常就好了。"
      detail={error.message || error.digest}
      onRetry={reset}
    />
  );
}
