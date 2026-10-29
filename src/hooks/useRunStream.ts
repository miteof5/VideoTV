"use client";

import { useEffect } from "react";
import { useRunStore } from "@/stores/runStore";

// 订阅运行的 SSE 流。
//
// 用原生 EventSource 而不是手写 fetch + ReadableStream：
// 自动重连、Last-Event-ID 补发、按 event: 字段分派，这三件事浏览器已经做好了。
// 自己实现一遍只会得到一份更容易出错的副本。

// 这里漏一个类型，症状是「后端明明发了、前端永远收不到」，
// 而且没有任何报错 —— 事件被 EventSource 静默丢弃了。
// 加新事件类型时必须同步加到 events.ts 的 PayloadMap 和 runStore 的 switch 里。
const EVENT_TYPES = [
  "node.status",
  "node.progress",
  "node.output",
  "node.text",
  "run.status",
  "log",
] as const;

/**
 * 订阅**所有**在跑的 run，一条流一个 EventSource。
 *
 * ### 为什么不是只订阅「当前那条」
 *
 * A 阶段之前同一时间只允许一条 run，所以 store 里只有一个 runId。
 * 并发放开之后，用户可以在三个节点上各点一次 —— 三次点击 = 三条 run。
 * 只订阅最后一条的话，前两条的节点会永远停在「生成中」：
 * Worker 在跑、数据库在变、界面不动，而钱在花。
 *
 * 代价是 N 条 EventSource。N ≤ 3（MAX_CONCURRENT_TASKS），可接受。
 *
 * ### 为什么依赖一个拼接字符串
 *
 * runIds 是数组，每次 set 都是新引用。直接放依赖里会让 effect
 * 在**任何** store 更新后重跑（包括进度事件），反复关流重连。
 * 拼成字符串后，只有「订阅集合真的变了」才重连。
 */
export function useRunStream() {
  const runIds = useRunStore((s) => s.runIds);
  const ingest = useRunStore((s) => s.ingest);
  const finish = useRunStore((s) => s.finish);

  const key = runIds.join(",");

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) return;

    const disposers = ids.map((runId) => openStream(runId, ingest, finish));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, [key, ingest, finish]);
}

function openStream(
  runId: string,
  ingest: ReturnType<typeof useRunStore.getState>["ingest"],
  finish: ReturnType<typeof useRunStore.getState>["finish"]
): () => void {
  const es = new EventSource(`/api/runs/${runId}/stream`);
  const cleanups: (() => void)[] = [];

  for (const type of EVENT_TYPES) {
    const handler = (e: MessageEvent) => {
      try {
        // runId 必须带进去：多条流同时进来时，run.status 要归到对的那条
        ingest(type, JSON.parse(e.data), Number(e.lastEventId) || undefined, runId);
      } catch {
        // 单条事件解析失败不该让整条流挂掉
      }
    };
    es.addEventListener(type, handler as EventListener);
    cleanups.push(() => es.removeEventListener(type, handler as EventListener));
  }

  const onEnd = (e: MessageEvent) => {
    let status = "succeeded";
    try {
      status = JSON.parse(e.data).status ?? status;
    } catch {
      // 解析失败按成功处理：end 只在这条 run 结束时发，状态事件通常已经先到了
    }
    finish(runId, status);
    es.close();
  };
  es.addEventListener("end", onEnd as EventListener);
  cleanups.push(() => es.removeEventListener("end", onEnd as EventListener));

  // 不处理 onerror 里的重连：EventSource 自己会重连，
  // 而且重连时会自动带上 Last-Event-ID，服务端按 seq 补发遗漏的事件。
  // 手动重连反而会丢掉这个能力，导致中间的事件永久丢失。

  return () => {
    for (const c of cleanups) c();
    es.close();
  };
}
