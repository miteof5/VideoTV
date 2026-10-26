"use client";

import { create } from "zustand";
import { NODE_STATUS, RUN_STATUS } from "@/lib/constants";
import { useCanvasStore } from "@/stores/canvasStore";

// 运行态 store。
//
// 为什么要和 canvasStore 分开：
// 画布的改动要防抖落库（dirty / revision 那套机制），而运行态是**瞬时的**——
// 它每秒变好几次，而且本来就是服务端写进数据库的，前端再回写一次纯属多余。
// 塞进同一个 store 的话，每次进度更新都会把画布标脏，
// 用户会看到「未保存」疯狂闪烁，还会白白多发一堆保存请求。

export interface NodeOutput {
  assetId: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
}

export interface LogEntry {
  seq: number;
  nodeId: string | null;
  level: "info" | "warn" | "error";
  message: string;
}

export interface NodeRuntime {
  status: string;
  progress: number;
  output?: NodeOutput;
  error?: string | null;
}

interface RunStore {
  runId: string | null;
  status: string;
  /** 整次运行的错误摘要（"3 个节点失败：…"） */
  summaryError: string | null;
  /**
   * 本次运行真正参与的节点 id。
   *
   * 为什么需要它：单节点运行只会跑 1 个节点，但 runtime 里还留着上一次
   * 整图运行的产物和状态。进度如果按 runtime 算分母，会出现「1/5」
   * 这种莫名其妙的数字 —— 用户明明只点了一个节点。
   */
  scope: string[];
  runtime: Record<string, NodeRuntime>;
  logs: LogEntry[];

  /** 项目页首次渲染时用数据库里的节点状态填充（刷新后还能看到上次结果） */
  hydrate: (runtime: Record<string, NodeRuntime>) => void;
  beginRun: (runId: string, scope?: string[]) => void;
  /**
   * 消费一条 SSE 事件。
   * seq 是事件在库里的自增序号，断线重连补发时靠它给日志去重 ——
   * 否则重连一次日志面板就多一截重复内容。
   */
  ingest: (type: string, payload: any, seq?: number) => void;
  finish: (status: string) => void;
  reset: () => void;
}

const MAX_LOGS = 100;

export const useRunStore = create<RunStore>((set, get) => ({
  runId: null,
  status: "idle",
  summaryError: null,
  scope: [],
  runtime: {},
  logs: [],

  hydrate: (runtime) => set({ runtime }),

  beginRun: (runId, scope = []) =>
    set({
      runId,
      status: RUN_STATUS.PENDING,
      summaryError: null,
      scope,
      // 不要清空 runtime：旧的产物预览应该保留到新结果出来。
      // 一开跑就把画面清空，用户会以为刚才的东西丢了。
      logs: [],
    }),

  ingest: (type, payload, seq) => {
    switch (type) {
      case "node.status": {
        const { nodeId, status, error } = payload;
        set((s) => ({
          runtime: {
            ...s.runtime,
            [nodeId]: {
              ...s.runtime[nodeId],
              status,
              error: error ?? null,
              // 开始跑就把进度归零，否则会残留上一次的进度条
              progress: status === NODE_STATUS.RUNNING ? 0 : (s.runtime[nodeId]?.progress ?? 0),
              ...(status === NODE_STATUS.SUCCEEDED ? { progress: 1 } : {}),
            },
          },
        }));
        break;
      }

      case "node.progress": {
        const { nodeId, percent } = payload;
        set((s) => ({
          runtime: {
            ...s.runtime,
            [nodeId]: {
              ...s.runtime[nodeId],
              status: s.runtime[nodeId]?.status ?? NODE_STATUS.RUNNING,
              progress: percent,
            },
          },
        }));
        break;
      }

      case "node.output": {
        const { nodeId, assetId, kind, mimeType, sizeBytes } = payload;
        set((s) => ({
          runtime: {
            ...s.runtime,
            [nodeId]: {
              ...s.runtime[nodeId],
              status: NODE_STATUS.SUCCEEDED,
              progress: 1,
              output: { assetId, kind, mimeType, sizeBytes },
            },
          },
        }));
        break;
      }

      case "node.text": {
        const { nodeId, prompt } = payload;
        /*
         * 优化结果写回**本节点**的 `optimizedPrompt`，不再新建节点。
         *
         * ### 为什么改了
         *
         * 早先的决策是「结果另开一个文本节点，原文一动不动」，理由是
         * 原文只存在 `prompt` 一个字段里，覆盖就永久丢了。
         * 现在原始描述在 `prompt`、优化结果在 `optimizedPrompt`，原文有
         * 独立住处 —— 那条前提不存在了。而且用户按「发送」时预期的
         * 就是「我这句话的改写版出现在卡片上」，不是画布上多一张卡。
         *
         * ### 为什么前端还要自己写一次
         *
         * Worker 已经把它写进数据库了，但画布的 nodes 是**内存态**，
         * 数据库的改动不会自动回灌。不在这里写，症状是
         * 「运行成功了，卡片上还是旧内容」—— 直到刷新页面才变。
         * 这也是 save 链路会跟着跑一次的原因：值相同，无害，
         * 而且能把 Worker 那次写入与画布对齐。
         */
        useCanvasStore.getState().updateNodeData(nodeId, {
          optimizedPrompt: prompt,
        });
        break;
      }

      case "run.status": {
        const { status, error } = payload;
        if (status === RUN_STATUS.CANCELLED) {
          // 取消后把所有还"在转"的节点复位，不然画布上会留下一圈永远转不完的动画
          set((s) => ({
            status,
            runtime: mapValues(s.runtime, (r) =>
              r.status === NODE_STATUS.QUEUED || r.status === NODE_STATUS.RUNNING
                ? { ...r, status: NODE_STATUS.IDLE, progress: 0 }
                : r
            ),
          }));
        } else {
          set({ status });
        }
        if (error) set({ summaryError: error });
        break;
      }

      case "log": {
        const id = seq ?? Date.now() + Math.random();
        if (get().logs.some((l) => l.seq === id)) break;
        const entry: LogEntry = {
          seq: id,
          nodeId: payload.nodeId ?? null,
          level: payload.level ?? "info",
          message: payload.message,
        };
        set((s) => ({ logs: [...s.logs, entry].slice(-MAX_LOGS) }));
        break;
      }
    }
  },

  finish: (status) => {
    const s = get();
    if (
      s.status === RUN_STATUS.SUCCEEDED ||
      s.status === RUN_STATUS.FAILED ||
      s.status === RUN_STATUS.CANCELLED
    ) {
      return;
    }
    set({ status });
  },

  reset: () =>
    set({ runId: null, status: "idle", summaryError: null, scope: [], logs: [] }),
}));

function mapValues<K extends string, V>(
  obj: Record<K, V>,
  fn: (v: V) => V
): Record<K, V> {
  const out = {} as Record<K, V>;
  for (const key of Object.keys(obj) as K[]) out[key] = fn(obj[key]);
  return out;
}
