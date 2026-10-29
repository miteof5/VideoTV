"use client";

import { useCallback, useEffect, useState } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useRunStore } from "@/stores/runStore";
import { NODE_STATUS, RUN_STATUS } from "@/lib/constants";

/*
 * 运行状态条：看进度、停止、报错、看这次花了多少。
 *
 * 它**不发起运行** —— 发起运行在节点面板的「生成」里。
 * 右上角原来那个「▶ 运行全部」在 2026-10-25 按人要求删掉了（连同它的后端模式）：
 * 创作台的价值在单个产物，一键跑全图意味着让人等一堆他并不关心的节点。
 *
 * 删掉按钮之后这个组件的性格变了：**有事才出现，没事什么都不画**。
 * 所以非忙碌且没有错误时直接 return null，而不是留一个空壳占着右上角 ——
 * 空壳会把「已保存」那个徽标往左挤，留下一段说不清来由的空白。
 */

const BUSY: string[] = [RUN_STATUS.PENDING, RUN_STATUS.RUNNING];
/** 跑完的积分显示多久。太长会一直占着右上角，太短会让人没看见就没了 */
const CREDITS_VISIBLE_MS = 15_000;

export function RunStatus() {
  const nodeCount = useCanvasStore((s) => s.nodes.length);
  const runIds = useRunStore((s) => s.runIds);
  const status = useRunStore((s) => s.status);
  const runtime = useRunStore((s) => s.runtime);
  const scope = useRunStore((s) => s.scope);
  const summaryError = useRunStore((s) => s.summaryError);
  const lastCredits = useRunStore((s) => s.lastCredits);

  const [creditsHidden, setCreditsHidden] = useState<typeof lastCredits>(null);

  const busy = BUSY.includes(status);
  const creditsVisible = Boolean(lastCredits) && creditsHidden !== lastCredits;

  // 积分只停留一会儿。它是「这次花了多少」的回执，不是常驻指标 ——
  // 常驻的东西应该放在项目页头部（累计积分）。
  useEffect(() => {
    if (!lastCredits) return;
    const timer = setTimeout(() => setCreditsHidden(lastCredits), CREDITS_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [lastCredits]);

  // 卡在"排队中"的检测交给 <StallHint />（见文件末尾）：
  // 它的「等了 3 秒」是一个只属于自己生命周期的状态，放在这里就得在
  // status 变化时手动重置，那是一次多余的同步 setState。

  const cancel = useCallback(async () => {
    if (runIds.length === 0) return;
    // 并行时可能有 3 条 run，只取消一条的话另外两条会继续跑、继续花钱，
    // 而「停止」在用户心里是「全都别跑了」。
    await Promise.all(
      runIds.map((id) =>
        fetch(`/api/runs/${id}/cancel`, { method: "POST" }).catch(() => {})
      )
    );
    // 乐观更新：不等服务端回话就先把状态改掉。
    // 取消本来就是"我不要了"，慢半拍的界面比错的界面更烦人。
    for (const id of runIds) {
      useRunStore
        .getState()
        .ingest("run.status", { status: RUN_STATUS.CANCELLED }, undefined, id);
    }
  }, [runIds]);

  // 有 scope 就只统计本次参与的节点 —— 单节点运行时分母必须是 1，
  // 否则会出现「1/5」这种和用户刚点的操作对不上的数字。
  // 没有 scope（刷新页面后恢复历史）时退回统计全部。
  const watched =
    scope.length > 0 ? scope.map((id) => runtime[id]) : Object.values(runtime);
  const total = scope.length > 0 ? scope.length : nodeCount;
  const done = watched.filter((r) => r?.status === NODE_STATUS.SUCCEEDED).length;
  const failed = watched.filter((r) => r?.status === NODE_STATUS.FAILED).length;

  if (!busy && !summaryError && !(creditsVisible && lastCredits)) return null;

  return (
    <div className="flex items-center gap-2">
      {busy && (
        <>
          <div
            data-run-strip
            className="rounded-md border border-[color:var(--line-1)] bg-[color:var(--surface-glass)] px-2.5 py-1.5 text-[length:var(--fs-meta)] text-[color:var(--ink-2)] shadow-sm backdrop-blur"
          >
            {status === RUN_STATUS.PENDING ? "排队中" : "运行中"} · {done}/
            {total}
            {/* 并行时把「几条任务」说出来，否则 3 个节点各自在跑和一条 run
                跑 3 个节点，在界面上长得一模一样 */}
            {runIds.length > 1 && (
              <span className="ml-1 text-[color:var(--ink-3)]">
                （{runIds.length} 个任务）
              </span>
            )}
            {failed > 0 && (
              <span className="ml-1 text-red-400">失败 {failed}</span>
            )}
          </div>
          <button
            onClick={cancel}
            className="rounded-md border border-[color:var(--line-2)] bg-[color:var(--surface-glass)] px-2.5 py-1.5 text-[length:var(--fs-meta)] font-medium text-[color:var(--ink-1)] shadow-sm backdrop-blur transition-colors hover:bg-[color:var(--surface-3)]"
          >
            停止
          </button>
        </>
      )}

      {status === RUN_STATUS.PENDING && <StallHint />}

      {/*
        跑完的积分回执。
        用中性色而不是绿色：这是信息，不是「成功」—— 失败的那次也花了钱，
        而失败原因已经在下面那条红色摘要里说过了。
      */}
      {!busy && creditsVisible && lastCredits && (
        <div
          data-credits-chip
          data-credits={lastCredits.credits}
          data-nodes={lastCredits.nodes}
          className="rounded-md border border-[color:var(--line-2)] bg-[color:var(--surface-glass)] px-2.5 py-1.5 text-[length:var(--fs-meta)] text-[color:var(--ink-2)] shadow-sm backdrop-blur"
          title={
            lastCredits.projectCredits > 0
              ? `这个项目累计消耗 ${lastCredits.projectCredits} 积分`
              : undefined
          }
        >
          本次 {lastCredits.nodes} 个节点 · 消耗{" "}
          <span className="font-medium text-[color:var(--ink-1)]">
            {lastCredits.credits}
          </span>{" "}
          积分
        </div>
      )}

      {summaryError && !busy && (
        <div className="max-w-sm truncate rounded-md border border-red-900 bg-red-950/70 px-2.5 py-1.5 text-[length:var(--fs-meta)] text-red-200 shadow-sm">
          {summaryError}
        </div>
      )}
    </div>
  );
}

/**
 * 「一直在排队？检查 Worker 是否启动」。
 *
 * ### 为什么单独一个组件
 *
 * 它需要一个「已经等了 3 秒」的计时，而这个计时只在**排队期间**有意义。
 * 放在 RunStatus 里就得在 status 离开 pending 时把它重置回 false ——
 * 那是在 effect 里同步 setState（React 会报级联渲染），而且多一次
 * 「先清空再计时」的中间帧。
 *
 * 做成只在 pending 时挂载的组件，状态跟着生命周期走：不再排队就卸载，
 * 下次排队重新从 0 秒开始。一行重置逻辑都不用写。
 */
function StallHint() {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setStalled(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  if (!stalled) return null;

  return (
    <div className="max-w-xs rounded-md border border-amber-900 bg-amber-950/70 px-2.5 py-1.5 text-[length:var(--fs-meta)] leading-relaxed text-amber-200 shadow-sm">
      一直在排队？检查 Worker 是否启动：
      <code className="mx-1 rounded bg-amber-900/70 px-1">npm run worker</code>
    </div>
  );
}
