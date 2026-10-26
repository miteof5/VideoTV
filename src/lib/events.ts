import { db } from "@/lib/db";

// 运行事件流 —— 跨进程的状态回传通道。
//
// 为什么必须落库，而不是内存 EventEmitter：
// Worker 是**独立进程**，和 Next.js 的 Route Handler 不共享内存地址空间。
// 一个进程里的 EventEmitter 再怎么写，另一个进程也收不到。
// 这是 SSE 最容易被忽略的前提：推送方和订阅方往往不在同一个进程里。
//
// 用一张自增表当队列，顺带白拿三个能力：
//   1. seq 单调递增，SSE 只要记住「上次读到哪」就能增量推送
//   2. 断线重连时浏览器会带上 Last-Event-ID，可以精确补发，不重不漏
//   3. 刷新页面能回放整条历史，新开的标签页不会一片空白
//
// 代价是轮询（1s 一次）而不是真正的推送。单机规模下这点开销可以忽略；
// 将来要分布式时换成 Redis Pub/Sub 或 Postgres LISTEN/NOTIFY，本文件接口不用改。

export const EVENT_TYPE = {
  /** 节点状态变化：queued → running → succeeded / failed */
  NODE_STATUS: "node.status",
  /** 进度 0~1。会节流，不是每帧都发 */
  NODE_PROGRESS: "node.progress",
  /** 产物就绪，带上 assetId 让前端去换预览 */
  NODE_OUTPUT: "node.output",
  /**
   * 文本被改写了（润色 / 拆分镜这类动作的产出）。
   *
   * 为什么不复用 NODE_OUTPUT：那个事件的意思是「去 /api/assets/<id> 换预览」。
   * 文本动作的产出不是资产文件，而是要**覆盖回节点内容**的一段文字。
   * 混用会导致前端拿一个不存在的 assetId 去加载图片。
   */
  NODE_TEXT: "node.text",
  /** 整次运行的状态 */
  RUN_STATUS: "run.status",
  /** 给人看的日志行，排查时很有用 */
  LOG: "log",
} as const;
export type EventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

export interface NodeStatusPayload {
  nodeId: string;
  status: string;
  error?: string | null;
}

export interface NodeProgressPayload {
  nodeId: string;
  percent: number;
}

export interface NodeOutputPayload {
  nodeId: string;
  assetId: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
}

export interface RunStatusPayload {
  status: string;
  error?: string | null;
}

export interface LogPayload {
  nodeId?: string | null;
  level: "info" | "warn" | "error";
  message: string;
}

export interface NodeTextPayload {
  nodeId: string;
  /** 新的节点文本内容，前端直接写回节点 */
  prompt: string;
  /** 是哪个动作产生的，便于显示「上次用『润色扩写』改过」 */
  action?: string;
}

export type EventPayloadMap = {
  [EVENT_TYPE.NODE_STATUS]: NodeStatusPayload;
  [EVENT_TYPE.NODE_PROGRESS]: NodeProgressPayload;
  [EVENT_TYPE.NODE_OUTPUT]: NodeOutputPayload;
  [EVENT_TYPE.NODE_TEXT]: NodeTextPayload;
  [EVENT_TYPE.RUN_STATUS]: RunStatusPayload;
  [EVENT_TYPE.LOG]: LogPayload;
};

/** 落库一条事件，返回它的 seq（SSE 里当 event id 用） */
export async function emit<T extends EventType>(
  runId: string,
  type: T,
  payload: EventPayloadMap[T]
): Promise<number> {
  const row = await db.runEvent.create({
    data: { runId, type, payload: JSON.stringify(payload) },
  });
  return row.seq;
}

/**
 * 批量写多条事件（保持给定顺序）。
 *
 * 用在"一批节点同时进入某个状态"这种场景（比如提交运行后全部置为排队中）。
 * 逐条 emit 也不是不行，但那会在提交接口上串行等好几次数据库往返，
 * 而这本来应该是立即返回的操作。
 */
export async function emitMany(
  runId: string,
  entries: { type: EventType; payload: unknown }[]
): Promise<void> {
  if (entries.length === 0) return;
  await db.runEvent.createMany({
    data: entries.map((e) => ({
      runId,
      type: e.type,
      payload: JSON.stringify(e.payload),
    })),
  });
}

/** 批量写日志。日志量大，合并成一次事务省掉重复的往返开销 */
export async function emitLog(
  runId: string,
  entries: LogPayload[]
): Promise<void> {
  if (entries.length === 0) return;
  await db.runEvent.createMany({
    data: entries.map((e) => ({
      runId,
      type: EVENT_TYPE.LOG,
      payload: JSON.stringify(e),
    })),
  });
}

export interface StoredEvent {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

/**
 * 读取 seq > afterSeq 的事件。
 *
 * 用严格大于而不是大于等于：Last-Event-ID 是「我已经收到的最后一条」，
 * 从它之后开始才不会重复发。
 */
export async function readSince(
  runId: string,
  afterSeq: number,
  limit = 500
): Promise<StoredEvent[]> {
  const rows = await db.runEvent.findMany({
    where: { runId, seq: { gt: afterSeq } },
    orderBy: { seq: "asc" },
    take: limit,
  });

  return rows.map((r) => ({
    seq: r.seq,
    type: r.type,
    payload: safeParse(r.payload),
    createdAt: r.createdAt,
  }));
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
