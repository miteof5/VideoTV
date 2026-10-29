"use client";

import { useEffect } from "react";
import { ErrorPanel } from "../../_components/ErrorPanel";

/**
 * 项目页专属错误边界。
 *
 * 为什么不靠根 error.tsx 一个兜住：项目页是最容易崩的地方（旧项目的
 * data 过不了 zod、产物文件被删了但引用还在、SSE 断流），而它崩的时候
 * 用户最需要知道的是「是我这个项目坏了，还是整个应用坏了」。
 * 单独一层能给出更准的话，而根 error 只能说"这块出错了"。
 *
 * 注意它只能盖住**渲染**阶段的错误。SSE 断流那种运行时错误由
 * 画布自己的提示条处理（见 RunStatus / Canvas 的 error banner），
 * 不会冒到这里 —— 冒到这里就意味着一崩整页，那是更坏的处理方式。
 */
export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[project page error]", error);
  }, [error]);

  return (
    <ErrorPanel
      title="这个项目没能打开"
      description="画布在渲染时出错了。节点、连线和已经生成的东西都还在库里，重试一下通常能回来；如果一直不行，回到列表再进一次这个项目。"
      detail={error.message || error.digest}
      onRetry={reset}
    />
  );
}
