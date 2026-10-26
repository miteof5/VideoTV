"use client";

import { useRunStore } from "@/stores/runStore";
import type { RunMode } from "@/engine/plan";

/**
 * 发起一次运行。
 *
 * 现在唯一的入口是节点面板里的「生成」（见 nodes/common.tsx）。
 * 右上角的「运行全部」在 2026-10-25 删掉了，所以 mode 不再有默认值 ——
 * 默认值存在的意义是「调用方懒得想」，而那种懒得想的默认恰好是最贵的执行方式。
 *
 * 仍然只保留这一个函数：提交成功后要 `beginRun` 这种约定，写第二份 fetch 就会漏，
 * 而漏掉的症状是「点了有反应但进度条不动」—— 最难查的那类。
 */
export async function startRun(
  projectId: string,
  mode: RunMode,
  targetId?: string,
  action?: string
): Promise<void> {
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, mode, targetId, action }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    runId?: string;
    error?: string;
    nodeIds?: string[];
  };

  if (!res.ok || !data.runId) {
    throw new Error(data.error ?? "提交失败");
  }

  // 乐观切换：立刻订阅这条新 run 的 SSE。
  // 等服务端把 status 推回来再切，中间会有一小段「什么都没发生」。
  useRunStore.getState().beginRun(data.runId, data.nodeIds ?? []);
}
