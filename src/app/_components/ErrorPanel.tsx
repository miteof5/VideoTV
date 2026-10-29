"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";

/**
 * 是否已经试过一次轻量重试。
 *
 * 为什么是模块级变量而不是 useState：第一次点击会调 `reset()`，它把整个
 * 错误边界重置 —— ErrorPanel 被卸载再挂载，组件内的 state 全部归零。
 * 实测过：用 useState 时按钮文案永远停在「重试」，用户不知道还能再点一次。
 *
 * 模块级会跟着页面刷新归零，这没问题：刷新之后如果还崩，用户本来就要
 * 重新走一遍「先便宜后贵」的流程。
 */
let softRetryTried = false;

/**
 * 出错时的统一面板。三处共用：根 error、项目页 error、404。
 * （global-error 不用它 —— 那层的全局 CSS 可能已经没了，见该文件）
 *
 * ### 为什么第一句话是「东西没丢」
 *
 * 页面崩掉的那一刻，用户真正担心的不是"这个 bug 怎么回事"，而是
 * "我刚做的片子还在不在"。先把这件事答了，剩下的信息才有意义。
 * 而且这句话是真的 —— 项目、节点、产物都在 SQLite 和 ./storage 里，
 * 渲染失败碰不到它们。
 *
 * ### 为什么「重试」要点两次才整页重载
 *
 * 这条是实测出来的（2026-10-28），不是保守设计：
 *
 * 第一次点击走 `reset()` + `router.refresh()`，也就是"轻量重试"——
 * 它想保留画布状态、SSE 订阅、相机位置。但真浏览器里点过：**页面没变**。
 * 服务端组件抛的错（项目数据 zod 校验失败、数据库查询失败——正是最常崩的
 * 那两类）在错误边界挂着的时候，`refresh()` 的结果会被丢掉。等 8 秒也一样。
 *
 * 所以第二次点击直接 `location.reload()`。它一定有效，代价是丢掉画布内存态
 * （节点位置有 800ms 防抖落库，未提交的编辑会没）。
 *
 * 为什么不一开始就 reload：大多数崩溃其实一次轻量重试就能过（客户端渲染错误），
 * 而 reload 的代价是实打实的。分级的意思不是"赌一次"，是"便宜的先用"。
 *
 * 按钮文案跟着变，是为了让用户知道「刚才那下不是没反应，只是没修好」。
 * 一个点了毫无变化的按钮，比一个明说"要重新加载"的按钮更让人怀疑产品坏了。
 *
 * ### 为什么用 Tailwind 的 text-lg/text-sm 而不是 --fs-*
 *
 * 那三组 --fs-* 是给画布和裸节点用的（跟随画布缩放），错误页不在画布里，
 * 套进去反而会被画布的断点尺寸影响。这里就是普通的页面文字。
 */
export function ErrorPanel({
  title,
  description,
  detail,
  onRetry,
  retryLabel = "重试",
  homeLabel = "回到项目列表",
}: {
  title: string;
  description: string;
  /** 原始错误信息。默认折叠 —— 展开是给排查用的，不是给用户读的 */
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
  homeLabel?: string;
}) {
  const router = useRouter();

  const handleRetry = () => {
    if (softRetryTried) {
      // 第二次：整页重载。这条路一定能修，前提是用户愿意丢画布内存态。
      window.location.reload();
      return;
    }

    // 第一次：轻量重试。先清客户端的错误状态，再让服务端重跑一遍数据请求。
    // 顺序不能反：先 refresh 的话，客户端错误边界还挂着，新的渲染会被丢弃。
    softRetryTried = true;
    onRetry?.();
    router.refresh();
  };

  const label = softRetryTried ? "重新加载页面" : retryLabel;

  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-[420px]">
        <div className="flex h-9 w-9 items-center justify-center rounded-full border border-red-900 bg-red-950/60 text-[15px] font-medium leading-none text-red-300">
          !
        </div>

        <h1 className="mt-4 text-lg font-medium text-[color:var(--ink-1)]">
          {title}
        </h1>

        <p className="mt-2 text-sm leading-relaxed text-[color:var(--ink-2)]">
          {description}
        </p>

        {detail ? (
          <details className="mt-4">
            <summary className="cursor-pointer list-none text-xs text-[color:var(--ink-3)] transition-colors hover:text-[color:var(--ink-2)]">
              错误详情
            </summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[color:var(--line-1)] bg-[color:var(--surface-1)] px-3 py-2 text-xs leading-relaxed text-[color:var(--ink-2)]">
              {detail}
            </pre>
          </details>
        ) : null}

        <div className="mt-6 flex items-center gap-2">
          {onRetry ? (
            <button
              type="button"
              onClick={handleRetry}
              className="flex h-8 items-center rounded-lg border border-[color:var(--line-3)] bg-[color:var(--btn-bg)] px-4 text-sm font-medium text-white transition-colors hover:bg-[color:var(--btn-bg-hover)]"
            >
              {label}
            </button>
          ) : null}

          {/* 这里用 Link 而不是 location.href：客户端路由在这一层是活的
              （上面刚用过 router.refresh），没必要为它做一次整页跳转。
              global-error 那层才需要原生 a —— 那里连 layout 都没了。 */}
          <Link
            href="/"
            className="flex h-8 items-center rounded-lg border border-[color:var(--line-2)] px-4 text-sm text-[color:var(--ink-2)] transition-colors hover:border-[color:var(--line-3)] hover:text-[color:var(--ink-1)]"
          >
            {homeLabel}
          </Link>
        </div>

        {/* 第一次重试没修好时，明确告诉用户下一步是什么 ——
            否则他只会觉得"这个按钮坏了" */}
        {softRetryTried ? (
          <p className="mt-3 text-xs leading-relaxed text-[color:var(--ink-3)]">
            刚才那次是原地重试，没能修好。再点一次会重新加载整个页面，画布上还没保存的改动会丢。
          </p>
        ) : null}
      </div>
    </div>
  );
}
