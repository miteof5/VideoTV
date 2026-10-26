"use client";

import { useEffect } from "react";
import { useRunStore } from "@/stores/runStore";

// 订阅一次运行的 SSE 流。
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

export function useRunStream() {
  const runId = useRunStore((s) => s.runId);
  const ingest = useRunStore((s) => s.ingest);
  const finish = useRunStore((s) => s.finish);

  useEffect(() => {
    if (!runId) return;

    const es = new EventSource(`/api/runs/${runId}/stream`);
    const cleanups: (() => void)[] = [];

    for (const type of EVENT_TYPES) {
      const handler = (e: MessageEvent) => {
        try {
          ingest(type, JSON.parse(e.data), Number(e.lastEventId) || undefined);
        } catch {
          // 单条事件解析失败不该让整条流挂掉
        }
      };
      es.addEventListener(type, handler as EventListener);
      cleanups.push(() =>
        es.removeEventListener(type, handler as EventListener)
      );
    }

    const onEnd = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        finish(data.status);
      } catch {
        finish("succeeded");
      }
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
  }, [runId, ingest, finish]);
}
