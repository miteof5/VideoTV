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

/**
 * 一条运行的本地状态。
 *
 * 为什么不再是「store 上直接挂 runId / status」：并发放开之后，画布上
 * 可能同时有三条 run 在跑（三个不同节点各点了一次）。只留一个 runId
 * 意味着后点的那条会把前一条挤掉 —— 前一条的节点进度、失败原因、
 * 积分全都看不到了，而它还在真实花钱。
 */
export interface RunEntry {
  id: string;
  status: string;
  /** 这条 run 参与运行的节点。进度分母按它算 */
  scope: string[];
  summaryError: string | null;
  credits: number;
  nodeCount: number;
}

interface RunStore {
  /**
   * 还在订阅的 run（跑完就移出）。useRunStream 按它开 N 条 SSE。
   */
  runIds: string[];
  /** 本页会话内出现过的 run，按 id 索引 */
  runs: Record<string, RunEntry>;

  /** 所有 run 聚合出来的状态。界面上的「排队中 / 运行中 / 失败」读它 */
  status: string;
  summaryError: string | null;
  /** 参与本次（或这批）运行的节点集合 */
  scope: string[];
  runtime: Record<string, NodeRuntime>;
  logs: LogEntry[];
  /**
   * 刚跑完那次的积分。显示在右上角，下次开跑时清空。
   *
   * 为什么放在 store 而不是事件流里直接显示：结束事件到达时那条 run
   * 已经不在 runIds 里了（订阅已关闭），组件需要一个「跑完后仍然可读」的地方。
   */
  lastCredits: {
    credits: number;
    nodes: number;
    projectCredits: number;
  } | null;

  /** 项目页首次渲染时用数据库里的节点状态填充（刷新后还能看到上次结果） */
  hydrate: (runtime: Record<string, NodeRuntime>) => void;
  beginRun: (runId: string, scope?: string[]) => void;
  /**
   * 消费一条 SSE 事件。
   * seq 是事件在库里的自增序号，断线重连补发时靠它给日志去重 ——
   * 否则重连一次日志面板就多一截重复内容。
   * runId 标记这条事件来自哪条流 —— 多条 run 并行时，run.status 必须归对人。
   */
  ingest: (type: string, payload: Record<string, unknown>, seq?: number, runId?: string) => void;
  finish: (runId: string, status: string) => void;
  reset: () => void;
}

const MAX_LOGS = 100;

const ACTIVE: string[] = [RUN_STATUS.PENDING, RUN_STATUS.RUNNING];
/** 已经结束的状态。显式标成 string[] 而不是让 TS 推成字面量联合 —— 后者接不住 string */
const TERMINAL: string[] = [
  RUN_STATUS.SUCCEEDED,
  RUN_STATUS.FAILED,
  RUN_STATUS.CANCELLED,
];

/**
 * 多条 run 聚合成一个状态。
 *
 * 优先级：running > pending > failed > cancelled > succeeded。
 * 「有一条还在跑就算在跑」是这里唯一重要的判断 —— 否则一条先跑完
 * 就会把状态条关掉，而另外两条还在花钱。
 */
function deriveStatus(runs: Record<string, RunEntry>): string {
  const list = Object.values(runs);
  if (list.length === 0) return "idle";
  if (list.some((r) => r.status === RUN_STATUS.RUNNING)) return RUN_STATUS.RUNNING;
  if (list.some((r) => r.status === RUN_STATUS.PENDING)) return RUN_STATUS.PENDING;
  if (list.some((r) => r.status === RUN_STATUS.FAILED)) return RUN_STATUS.FAILED;
  if (list.some((r) => r.status === RUN_STATUS.CANCELLED)) return RUN_STATUS.CANCELLED;
  return RUN_STATUS.SUCCEEDED;
}

/**
 * 进度分母取「还在跑的 run」的节点并集。
 *
 * 全跑完后仍保留并集，否则最后那一帧会从「3/3」跳成「0/0」——
 * 用户刚看到三个节点全绿，数字却突然归零，像是把结果弄丢了。
 */
function deriveScope(runs: Record<string, RunEntry>): string[] {
  const list = Object.values(runs);
  const active = list.filter((r) => ACTIVE.includes(r.status));
  const use = active.length > 0 ? active : list;
  return [...new Set(use.flatMap((r) => r.scope))];
}

/** 只在全都停下时才把错误露出来 —— 跑着的时候旧错误是噪音 */
function deriveError(runs: Record<string, RunEntry>): string | null {
  const list = Object.values(runs);
  if (list.some((r) => ACTIVE.includes(r.status))) return null;
  return list.map((r) => r.summaryError).filter(Boolean)[0] ?? null;
}

export const useRunStore = create<RunStore>((set, get) => ({
  runIds: [],
  runs: {},
  status: "idle",
  summaryError: null,
  scope: [],
  runtime: {},
  logs: [],
  lastCredits: null,

  hydrate: (runtime) => set({ runtime }),

  beginRun: (runId, scope = []) =>
    set((s) => {
      /*
       * 上一批全都停了 → 开一批新的。
       *
       * 清 runs 是为了让进度分母只包含这一批的节点。不清的话，先跑 A
       * 再跑 B，界面会显示「2/2」而不是「1/1」—— 数字对不上用户刚点的东西。
       */
      const allIdle = !Object.values(s.runs).some((r) => ACTIVE.includes(r.status));
      const base = allIdle ? {} : s.runs;

      const prev = base[runId];
      const entry: RunEntry = prev
        ? { ...prev, scope: scope.length > 0 ? scope : prev.scope }
        : {
            id: runId,
            status: RUN_STATUS.PENDING,
            scope,
            summaryError: null,
            credits: 0,
            nodeCount: 0,
          };

      const runs = { ...base, [runId]: entry };
      const runIds = s.runIds.includes(runId) ? s.runIds : [...s.runIds, runId];

      return {
        runs,
        runIds,
        status: deriveStatus(runs),
        scope: deriveScope(runs),
        summaryError: deriveError(runs),
        lastCredits: null,
        // 新的一条 run 才清日志；同一条重复提交（幂等命中）保留已有内容
        logs: prev ? s.logs : [],
      };
    }),

  ingest: (type, payload, seq, runId) => {
    switch (type) {
      case "node.status": {
        const { nodeId, status, error } = payload as {
          nodeId?: string;
          status?: string;
          error?: string | null;
        };
        if (!nodeId || !status) break;
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
        const { nodeId, percent } = payload as {
          nodeId?: string;
          percent?: number;
        };
        if (!nodeId) break;
        set((s) => ({
          runtime: {
            ...s.runtime,
            [nodeId]: {
              ...s.runtime[nodeId],
              status: s.runtime[nodeId]?.status ?? NODE_STATUS.RUNNING,
              progress: percent ?? 0,
            },
          },
        }));
        break;
      }

      case "node.output": {
        const { nodeId, assetId, kind, mimeType, sizeBytes } = payload as {
          nodeId?: string;
          assetId?: string;
          kind?: string;
          mimeType?: string;
          sizeBytes?: number;
        };
        if (!nodeId || !assetId || !kind) break;
        set((s) => ({
          runtime: {
            ...s.runtime,
            [nodeId]: {
              ...s.runtime[nodeId],
              status: NODE_STATUS.SUCCEEDED,
              progress: 1,
              output: {
                assetId,
                kind,
                mimeType: mimeType ?? "",
                sizeBytes: sizeBytes ?? 0,
              },
            },
          },
        }));
        break;
      }

      case "node.text": {
        const { nodeId, prompt } = payload as { nodeId?: string; prompt?: string };
        if (!nodeId || typeof prompt !== "string") break;
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
        const ev = payload as {
          status?: string;
          error?: string | null;
          credits?: number;
          nodeCount?: number;
          projectCredits?: number;
        };
        const status = ev.status;
        if (!status) break;

        /*
         * 没有 runId 就没法归到具体某条 run 上 —— 这是留给「本地乐观更新」
         * 以外场景的兜底：直接忽略，而不是瞎猜一条改掉。猜错的后果是
         * 另一条正在跑的 run 被莫名其妙标成失败。
         */
        if (!runId) break;

        set((s) => {
          const prev = s.runs[runId] ?? {
            id: runId,
            status,
            scope: [] as string[],
            summaryError: null,
            credits: 0,
            nodeCount: 0,
          };

          const entry: RunEntry = {
            ...prev,
            status,
            summaryError: ev.error ?? prev.summaryError,
            credits: typeof ev.credits === "number" ? ev.credits : prev.credits,
            nodeCount:
              typeof ev.nodeCount === "number" ? ev.nodeCount : prev.nodeCount,
          };

          const runs = { ...s.runs, [runId]: entry };

          // 取消后把所有还"在转"的节点复位，不然画布上会留下一圈永远转不完的动画
          const runtime =
            status === RUN_STATUS.CANCELLED
              ? mapValues(s.runtime, (r) =>
                  r.status === NODE_STATUS.QUEUED || r.status === NODE_STATUS.RUNNING
                    ? { ...r, status: NODE_STATUS.IDLE, progress: 0 }
                    : r
                )
              : s.runtime;

          const done = TERMINAL.includes(status);
          /*
           * 回执要算**这一批全部 run 的和**，不是刚结束那条自己的数。
           *
           * 并行时三条 run 各自走完、各自发结束事件，最后到达的那条会覆盖
           * 这份回执。只写它自己那份，用户看到的是「本次 1 个节点 · 10 积分」——
           * 而实际上刚刚跑完 3 个节点、花了 30。这是实测出来的（2026-10-28）。
           *
           * 回执只在全部停下时才显示（RunStatus 里 `!busy` 才渲染），
           * 所以中间的「跑完一条」不会让用户看到半截数字。
           */
          const batchCredits = Object.values(runs).reduce(
            (sum, r) => sum + r.credits,
            0
          );
          const batchNodes = Object.values(runs).reduce(
            (sum, r) => sum + r.nodeCount,
            0
          );
          const lastCredits =
            done && entry.credits > 0
              ? {
                  credits: batchCredits,
                  nodes: batchNodes,
                  projectCredits:
                    typeof ev.projectCredits === "number"
                      ? ev.projectCredits
                      : 0,
                }
              : s.lastCredits;

          return {
            runs,
            runtime,
            status: deriveStatus(runs),
            scope: deriveScope(runs),
            summaryError: deriveError(runs),
            lastCredits,
          };
        });
        break;
      }

      case "log": {
        const ev = payload as {
          nodeId?: string | null;
          level?: LogEntry["level"];
          message?: string;
        };
        const id = seq ?? Date.now() + Math.random();
        if (get().logs.some((l) => l.seq === id)) break;
        const entry: LogEntry = {
          seq: id,
          nodeId: ev.nodeId ?? null,
          level: ev.level ?? "info",
          message: ev.message ?? "",
        };
        set((s) => ({ logs: [...s.logs, entry].slice(-MAX_LOGS) }));
        break;
      }
    }
  },

  finish: (runId, status) =>
    set((s) => {
      const prev = s.runs[runId];
      if (!prev) return { runIds: s.runIds.filter((id) => id !== runId) };

      const runs = {
        ...s.runs,
        [runId]: { ...prev, status: prev.status || status },
      };

      return {
        runs,
        // 跑完就不再订阅：EventSource 留着会让浏览器不断重连一条已经结束的流
        runIds: s.runIds.filter((id) => id !== runId),
        status: deriveStatus(runs),
        scope: deriveScope(runs),
        summaryError: deriveError(runs),
      };
    }),

  reset: () =>
    set({
      runIds: [],
      runs: {},
      status: "idle",
      summaryError: null,
      scope: [],
      logs: [],
      lastCredits: null,
    }),
}));

function mapValues<K extends string, V>(
  obj: Record<K, V>,
  fn: (v: V) => V
): Record<K, V> {
  const out = {} as Record<K, V>;
  for (const key of Object.keys(obj) as K[]) out[key] = fn(obj[key]);
  return out;
}
