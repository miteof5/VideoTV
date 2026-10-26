"use client";

import { useEffect, useState } from "react";
import type { ModelDescriptor } from "@/providers/types";

/**
 * 模型清单，全局只取一次。
 *
 * 用模块级缓存而不是 store：这份数据是**静态**的（Provider 注册表在服务启动时
 * 就固定了），不会在会话中途变化。放进 Zustand 只会多一份需要同步的状态。
 * 每个节点面板各发一次请求也没必要 —— 画布上有二十个节点就是二十次请求。
 */
let cache: ModelDescriptor[] | null = null;
let inflight: Promise<ModelDescriptor[]> | null = null;

function load(): Promise<ModelDescriptor[]> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/api/models")
      .then((r) => r.json())
      .then((d: { models?: ModelDescriptor[] }) => {
        cache = d.models ?? [];
        return cache;
      })
      .catch(() => {
        // 拉不到就当作没有模型。此时下拉框为空，plan 会回落到默认 Provider，
        // 整条链路仍然能跑 —— 比让面板崩掉好。
        inflight = null;
        return [] as ModelDescriptor[];
      });
  }
  return inflight;
}

export function useModels(): ModelDescriptor[] {
  const [models, setModels] = useState<ModelDescriptor[]>(cache ?? []);

  useEffect(() => {
    if (cache) return;
    let alive = true;
    void load().then((m) => {
      if (alive) setModels(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  return models;
}
