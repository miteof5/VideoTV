import { db } from "@/lib/db";
import { JOB_STATUS, NODE_STATUS, RUN_STATUS } from "@/lib/constants";
import { buildPlan, type PlanOptions } from "@/engine/plan";
import { emit, emitMany, EVENT_TYPE, type EventType } from "@/lib/events";

// 一次运行的生命周期管理：创建、取消、查询。
//
// 放在 service 层而不是 Route Handler 里，是因为 Worker 也要用同样的规则
// 判断"这个 run 还活着吗"。规则只有一份，就不会出现
// 「API 认为结束了，Worker 还在跑」这种不一致。

export interface CreateRunResult {
  runId: string;
  batchCount: number;
  jobCount: number;
  /** 复用了多少个上游节点（单节点运行时通常 > 0） */
  reusedCount: number;
  /** 本次参与运行的节点 id。前端用它算进度，否则会把复用的节点也算进分母 */
  nodeIds: string[];
}

/**
 * 创建一次运行：算计划 → 写 Run + Jobs → 把所有节点置为排队中。
 *
 * 为什么先取消同项目的其他活跃 run：
 * 两个 run 同时操作同一批 Node.status，会互相覆盖 ——
 * A 刚把节点标成 succeeded，B 立刻又标成 queued，前端就会看到状态乱跳。
 * 而且同一个节点被两个 job 同时调模型，是在真金白银地重复扣费。
 */
export async function createRun(
  projectId: string,
  opts: PlanOptions = {}
): Promise<CreateRunResult> {
  // 动作是对「一个节点」的临时指令，跟全图运行没有语义上的交集。
  // 允许它在 branch 模式上，就等于允许「润色 A，顺便把 A 的上游全重跑一遍」——
  // 那不是用户想要的，而且会白花钱。
  if (opts.action && (opts.mode !== "node" || !opts.targetId)) {
    throw new Error("节点动作只能用在单节点运行上");
  }

  const plan = await buildPlan(projectId, opts);

  if (plan.nodeIds.length === 0) {
    throw new Error("画布上没有可运行的节点");
  }
  if (plan.runIds.length === 0) {
    throw new Error("这次执行没有需要运行的节点");
  }

  const active = await db.run.findMany({
    where: {
      projectId,
      status: { in: [RUN_STATUS.PENDING, RUN_STATUS.RUNNING] },
    },
    select: { id: true },
  });
  for (const r of active) {
    await cancelRun(r.id, "被新的运行取代");
  }

  const run = await db.run.create({
    data: { projectId, status: RUN_STATUS.PENDING },
  });

  // 只为 runIds 建 Job —— 这就是「单节点运行会复用上游产物」的落地点。
  // batch 仍用全图批号，Worker 遍历全图批次时，没有 job 的批次自然捞到空。
  await db.job.createMany({
    data: plan.runIds.map((id) => {
      const step = plan.steps.get(id);
      return {
        runId: run.id,
        nodeId: id,
        batch: step?.batch ?? 0,
        action: step?.action ?? null,
      };
    }),
  });

  // 先把节点置成"排队中"，前端点完运行就能立刻看到反馈。
  // 不做这一步，用户点完按钮到 Worker 真正捞起任务之间
  // 可能有几百毫秒的空白，看起来像"点了没反应"。
  await db.node.updateMany({
    where: { projectId, id: { in: plan.runIds } },
    data: { status: NODE_STATUS.QUEUED, error: null },
  });

  // 光改数据库不够 —— 前端不读 Node 表，它只认 SSE 事件。
  // 少了这几条事件，画布上会一直挂着上一次运行的"已完成"，
  // 用户点了运行却看不到任何变化，直到 Worker 捞起第一个节点才动。
  const events: { type: EventType; payload: unknown }[] = plan.runIds.map(
    (nodeId) => ({
      type: EVENT_TYPE.NODE_STATUS,
      payload: { nodeId, status: NODE_STATUS.QUEUED },
    })
  );

  // 复用了哪些上游要说出来。否则用户点「只跑这个」，
  // 看到上游没变色但结果是对的，会怀疑是不是用了几年前的旧图。
  if (plan.reusedIds.length > 0) {
    events.push({
      type: EVENT_TYPE.LOG,
      payload: {
        nodeId: null,
        level: "info",
        message: `复用 ${plan.reusedIds.length} 个上游节点的已有产物，不重跑`,
      },
    });
  }

  await emitMany(run.id, events);

  await emit(run.id, EVENT_TYPE.RUN_STATUS, { status: RUN_STATUS.PENDING });

  return {
    runId: run.id,
    batchCount: plan.batches.length,
    jobCount: plan.runIds.length,
    reusedCount: plan.reusedIds.length,
    nodeIds: plan.runIds,
  };
}

/** 取消。已经在跑的 job 由 Worker 收到 abort 后自行收尾 */
export async function cancelRun(runId: string, reason = "用户取消") {
  const run = await db.run.findUnique({ where: { id: runId } });
  if (!run) return;
  if (
    run.status !== RUN_STATUS.PENDING &&
    run.status !== RUN_STATUS.RUNNING
  ) {
    return;
  }

  await db.run.update({
    where: { id: runId },
    data: { status: RUN_STATUS.CANCELLED, endedAt: new Date() },
  });

  // 没跑到的节点复位成 idle，不然画布上会留下一片永远不动的"排队中"
  const unfinished = await db.job.findMany({
    where: {
      runId,
      status: { in: [JOB_STATUS.PENDING, JOB_STATUS.RUNNING] },
    },
    select: { nodeId: true },
  });
  if (unfinished.length > 0) {
    await db.node.updateMany({
      where: { id: { in: unfinished.map((j) => j.nodeId) } },
      data: { status: NODE_STATUS.IDLE, error: null },
    });
  }

  await emit(runId, EVENT_TYPE.RUN_STATUS, {
    status: RUN_STATUS.CANCELLED,
    error: reason,
  });
}

export interface RunSnapshot {
  id: string;
  projectId: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  jobs: {
    id: string;
    nodeId: string;
    batch: number;
    status: string;
    attempts: number;
    lastError: string | null;
  }[];
}

/** 前端首屏渲染用的快照。之后的状态变化都走 SSE 增量 */
export async function getRunSnapshot(
  runId: string
): Promise<RunSnapshot | null> {
  const run = await db.run.findUnique({
    where: { id: runId },
    include: { jobs: { orderBy: { batch: "asc" } } },
  });
  if (!run) return null;

  return {
    id: run.id,
    projectId: run.projectId,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    jobs: run.jobs.map((j) => ({
      id: j.id,
      nodeId: j.nodeId,
      batch: j.batch,
      status: j.status,
      attempts: j.attempts,
      lastError: j.lastError,
    })),
  };
}

/** 该项目最近一次运行。项目页打开时用它恢复上次的运行状态 */
export async function getLatestRun(projectId: string) {
  return db.run.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}
