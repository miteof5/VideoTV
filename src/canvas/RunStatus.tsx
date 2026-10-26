"use client";

import { useCallback, useEffect, useState } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import { useRunStore } from "@/stores/runStore";
import { NODE_STATUS, RUN_STATUS } from "@/lib/constants";

/*
 * 运行状态条：看进度、停止、报错。
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

export function RunStatus() {
  const nodeCount = useCanvasStore((s) => s.nodes.length);
  const runId = useRunStore((s) => s.runId);
  const status = useRunStore((s) => s.status);
  const runtime = useRunStore((s) => s.runtime);
  const scope = useRunStore((s) => s.scope);
  const summaryError = useRunStore((s) => s.summaryError);

  const [stalled, setStalled] = useState(false);

  const busy = BUSY.includes(status);

  // 卡在"排队中"的检测。
  //
  // 没有 Worker 进程时，run 会永远停在 pending，界面上只显示"排队中"，
  // 用户根本不知道是自己没起 Worker 还是系统卡了。
  // 给一个 3 秒的宽限再提示，比让人干等强。
  useEffect(() => {
    if (status !== RUN_STATUS.PENDING) {
      setStalled(false);
      return;
    }
    const timer = setTimeout(() => setStalled(true), 3000);
    return () => clearTimeout(timer);
  }, [status]);

  const cancel = useCallback(async () => {
    if (!runId) return;
    await fetch(`/api/runs/${runId}/cancel`, { method: "POST" }).catch(() => {});
    // 乐观更新：不等服务端回话就先把状态改掉。
    // 取消本来就是"我不要了"，慢半拍的界面比错的界面更烦人。
    useRunStore.getState().ingest("run.status", { status: RUN_STATUS.CANCELLED });
  }, [runId]);

  // 有 scope 就只统计本次参与的节点 —— 单节点运行时分母必须是 1，
  // 否则会出现「1/5」这种和用户刚点的操作对不上的数字。
  // 没有 scope（刷新页面后恢复历史）时退回统计全部。
  const watched =
    scope.length > 0 ? scope.map((id) => runtime[id]) : Object.values(runtime);
  const total = scope.length > 0 ? scope.length : nodeCount;
  const done = watched.filter((r) => r?.status === NODE_STATUS.SUCCEEDED).length;
  const failed = watched.filter((r) => r?.status === NODE_STATUS.FAILED).length;

  if (!busy && !summaryError) return null;

  return (
    <div className="flex items-center gap-2">
      {busy && (
        <>
          <div className="rounded-md border border-[color:var(--line-1)] bg-[color:var(--surface-glass)] px-2.5 py-1.5 text-[length:var(--fs-meta)] text-[color:var(--ink-2)] shadow-sm backdrop-blur">
            {status === RUN_STATUS.PENDING ? "排队中" : "运行中"} · {done}/
            {total}
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

      {stalled && (
        <div className="max-w-xs rounded-md border border-amber-900 bg-amber-950/70 px-2.5 py-1.5 text-[length:var(--fs-meta)] leading-relaxed text-amber-200 shadow-sm">
          一直在排队？检查 Worker 是否启动：
          <code className="mx-1 rounded bg-amber-900/70 px-1">npm run worker</code>
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
