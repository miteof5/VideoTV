import { db } from "@/lib/db";
import {
  JOB_STATUS,
  NODE_STATUS,
  RUN_STATUS,
  MAX_CONCURRENT_PER_USER,
  WAIT_TIMEOUT_MS,
} from "@/lib/constants";
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
  /**
   * 这次提交撞上了已经在跑的同一个节点 —— 返回的是那条 run，没有新建。
   *
   * 前端不需要特殊处理（订阅同一个 runId 就会看到同一份进度），
   * 但这个字段让调用方能区分「新建了」和「复用了」，排查时很关键。
   */
  reusedExisting: boolean;
  /** 有几个上游节点正在被别的 run 处理，本次挂起等它们 */
  waitingCount: number;
}

/**
 * 创建一次运行：算计划 → 写 Run + Jobs → 把要跑的节点置为排队中。
 *
 * ### 这里**不再取消任何 run**（2026-10-28 改）
 *
 * 原来是「新建 run 前，取消这个项目所有活跃 run」。那条规则在单任务时代
 * 是合理的（两个 run 同时写同一批 Node.status 会互相覆盖），但它同时
 * 让并发永远只能是 1 —— 你点第二个节点，第一个立刻被取消。
 *
 * 现在换成两条更细的规则，各自负责一件事：
 *   1. **同一个目标节点**已有活跃 run → 直接把那条 run 还回去（幂等，A-6）
 *   2. **不同的目标节点** → 各跑各的；如果共用某个上游，就挂起等它（A-4）
 *
 * 两条合起来覆盖了原来那条粗暴规则想防的所有情况，而且不牺牲并发。
 */
/**
 * createRun 的入参。
 *
 * 比 PlanOptions 多一个 userId —— 用户的身份是**调度与记账**的事，
 * 不是「怎么排计划」的事，所以不塞进 engine/plan 的类型里。
 */
export interface CreateRunOptions extends PlanOptions {
  /** 谁点的这次运行。写进 Run.userId，供「每用户并发」和积分归属用 */
  userId?: string;
}

export async function createRun(
  projectId: string,
  opts: CreateRunOptions = {}
): Promise<CreateRunResult> {
  // 动作是对「一个节点」的临时指令，跟全图运行没有语义上的交集。
  // 允许它在 branch 模式上，就等于允许「润色 A，顺便把 A 的上游全重跑一遍」——
  // 那不是用户想要的，而且会白花钱。
  if (opts.action && (opts.mode !== "node" || !opts.targetId)) {
    throw new Error("节点动作只能用在单节点运行上");
  }

  // ---- 1. 幂等：同一个节点已经有活跃 run，就复用 ----
  //
  // 挡的是这三种绕过前端按钮的提交（A-6）：两个标签页、直接 POST、
  // 前端那层 disabled 哪天被改坏。后果比「多跑一次」更糟 ——
  // 第二条 run 会调模型、会扣积分，而第一条的调用不会被取消。
  if (opts.targetId) {
    const existing = await findActiveRunForTarget(projectId, opts.targetId);
    if (existing) {
      return {
        runId: existing.id,
        batchCount: 0,
        jobCount: existing.nodeIds.length,
        reusedCount: 0,
        nodeIds: existing.nodeIds,
        reusedExisting: true,
        waitingCount: 0,
      };
    }
  }

  // ---- 2. 并发名额 ----
  //
  // 满了就明确拒绝，**不静默排队**：静默排队的表现是「点了没反应」，
  // 用户会再点一次、再点一次，然后在某个时刻突然同时跑起来。
  await reapStaleRuns();

  /*
   * 名额按**人**算，不按机器算（2026-10-29 改，C 批 2）。
   *
   * 原来这里是全表 count —— 单用户时它和「按人」等价，多用户时就成了
   * 「别人占满三个名额，你点什么都被拒」。用户根本不知道那是别人的任务，
   * 只会觉得这个产品不好使。
   *
   * 没有 userId 时（内部调用、老测试）退回全局计数，**不放宽**：
   * 少一个条件只会让计数变大，绝不会让不该跑的跑起来。
   */
  const activeCount = await db.run.count({
    where: {
      status: { in: [RUN_STATUS.PENDING, RUN_STATUS.RUNNING] },
      // 挂起等待上游的 run 不占名额 —— 它没有在消耗任何模型额度
      waitingOn: null,
      ...(opts.userId ? { userId: opts.userId } : {}),
    },
  });
  if (activeCount >= MAX_CONCURRENT_PER_USER) {
    throw new Error(
      `你已经有 ${MAX_CONCURRENT_PER_USER} 个任务在运行，等其中一跑完再试`
    );
  }

  const plan = await buildPlan(projectId, opts);

  if (plan.nodeIds.length === 0) {
    throw new Error("画布上没有可运行的节点");
  }
  if (plan.runIds.length === 0) {
    throw new Error("这次执行没有需要运行的节点");
  }

  // ---- 3. 重叠节点：挂起等待，不各跑一遍 ----
  //
  // 典型场景：一张图 + 两个不同提示词各跑一个视频。第二个 run 的 branch
  // 会带上那张图。这时**不能**让它再跑一遍图 —— 模型不是确定性的，
  // 同一段提示词跑两次会得到两张不同的图，于是两个视频的起点不一致，
  // 正好违背「用同一张图」的本意，还多扣 10 积分。
  //
  // 所以：这些节点不进本 run 的 Job 列表，run 挂起；Worker 等它们跑完，
  // 下游从库里读那个已经存在的产物。
  //
  // 只认「活跃且没在等待」的 run：一个正在等待的 run 自己的 job 也是
  // pending，但它此刻什么都没在跑，不该让别人等它。
  const occupied = await db.job.findMany({
    where: {
      nodeId: { in: plan.runIds },
      status: { in: [JOB_STATUS.PENDING, JOB_STATUS.RUNNING] },
      run: {
        status: { in: [RUN_STATUS.PENDING, RUN_STATUS.RUNNING] },
        waitingOn: null,
      },
    },
    select: { nodeId: true },
  });
  const inPlan = new Set(plan.runIds);
  const waitingOn = [...new Set(occupied.map((j) => j.nodeId))].filter((id) =>
    inPlan.has(id)
  );

  // 目标节点自己正被别的 run 跑着（只可能是迁移前的老 run ——
  // 新 run 都有 targetId，上面第 1 步就挡住了）。这种情况等下去没有意义：
  // 它跑完这个节点就已经有产物了，再等一条不跑任何节点的 run 纯属空转。
  if (opts.targetId && waitingOn.includes(opts.targetId)) {
    throw new Error("这个节点正在运行，等它跑完再试");
  }

  const jobIds = plan.runIds.filter((id) => !waitingOn.includes(id));
  if (jobIds.length === 0) {
    throw new Error("这次执行没有需要运行的节点");
  }

  const run = await db.run.create({
    data: {
      projectId,
      userId: opts.userId ?? null,
      status: RUN_STATUS.PENDING,
      targetId: opts.targetId ?? null,
      waitingOn: waitingOn.length > 0 ? JSON.stringify(waitingOn) : null,
      waitingSince: waitingOn.length > 0 ? new Date() : null,
    },
  });

  // 只为 jobIds 建 Job —— 这就是「单节点运行会复用上游产物」的落地点。
  // batch 仍用全图批号，Worker 遍历全图批次时，没有 job 的批次自然捞到空。
  await db.job.createMany({
    data: jobIds.map((id) => {
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
  //
  // **范围必须是 jobIds，不能是 plan.runIds**：正在被另一个 run 跑的节点
  // 此刻是 running，把它改成 queued 会让画布上那个节点从「生成中」
  // 莫名退回「排队中」，而那条 run 还在真实调用模型。
  await db.node.updateMany({
    where: { projectId, id: { in: jobIds } },
    data: { status: NODE_STATUS.QUEUED, error: null },
  });

  // 光改数据库不够 —— 前端不读 Node 表，它只认 SSE 事件。
  // 少了这几条事件，画布上会一直挂着上一次运行的"已完成"，
  // 用户点了运行却看不到任何变化，直到 Worker 捞起第一个节点才动。
  const events: { type: EventType; payload: unknown }[] = jobIds.map(
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

  if (waitingOn.length > 0) {
    events.push({
      type: EVENT_TYPE.LOG,
      payload: {
        nodeId: null,
        level: "info",
        message: `有 ${waitingOn.length} 个上游节点正在被另一次运行处理，本次会等它跑完再用同一个产物`,
      },
    });
  }

  await emitMany(run.id, events);

  await emit(run.id, EVENT_TYPE.RUN_STATUS, { status: RUN_STATUS.PENDING });

  return {
    runId: run.id,
    batchCount: plan.batches.length,
    jobCount: jobIds.length,
    reusedCount: plan.reusedIds.length,
    nodeIds: jobIds,
    reusedExisting: false,
    waitingCount: waitingOn.length,
  };
}

/** 同一个项目 + 同一个目标节点的活跃 run。幂等和「节点正在跑」都靠它 */
async function findActiveRunForTarget(projectId: string, targetId: string) {
  const run = await db.run.findFirst({
    where: {
      projectId,
      targetId,
      status: { in: [RUN_STATUS.PENDING, RUN_STATUS.RUNNING] },
    },
    orderBy: { createdAt: "desc" },
    include: { jobs: { select: { nodeId: true } } },
  });
  if (!run) return null;
  return { id: run.id, nodeIds: run.jobs.map((j) => j.nodeId) };
}

/**
 * 清掉「排了很久队但从没开始跑」的 run。
 *
 * 为什么必须有：并发名额是按活跃 run 数算的。如果某次运行提交后
 * Worker 一直没起来（或者被 kill 在启动阶段），那条 run 会永远停在
 * pending 占着一个名额。攒到 3 条，这个人之后任何操作都会被
 * 「你已经有 3 个任务在运行」拒掉 —— 而实际上一个都没在跑。
 *
 * 判据是「pending 且超过等待上限」：Worker 每 800ms 轮询一次，
 * 一条真正有 worker 负责的 run 不可能 pending 十分钟。
 * 只清 PENDING，不碰 RUNNING —— 一个 30 秒的视频跑十分钟是正常的。
 */
async function reapStaleRuns() {
  const stale = await db.run.findMany({
    where: {
      status: RUN_STATUS.PENDING,
      waitingOn: null,
      createdAt: { lt: new Date(Date.now() - WAIT_TIMEOUT_MS) },
    },
    select: { id: true },
  });
  for (const r of stale) {
    await cancelRun(r.id, "排队太久没有开始执行，已自动取消");
  }
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
  /** 本次消耗的积分（跑完才有值） */
  credits: number;
  /** 正在等待的上游节点 id。空数组 = 没在等待 */
  waitingOn: string[];
  jobs: {
    id: string;
    nodeId: string;
    batch: number;
    status: string;
    attempts: number;
    credits: number;
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
    credits: run.credits,
    waitingOn: parseWaitingOn(run.waitingOn),
    jobs: run.jobs.map((j) => ({
      id: j.id,
      nodeId: j.nodeId,
      batch: j.batch,
      status: j.status,
      attempts: j.attempts,
      credits: j.credits,
      lastError: j.lastError,
    })),
  };
}

/**
 * `Run.waitingOn` 存的是 JSON 字符串，读的时候永远走这一个函数。
 *
 * 为什么要包一层：这一列是可以被手工改、被旧版本写入的，格式坏掉时
 * 直接 `JSON.parse` 会让整条 run 的执行崩掉 —— 而它的语义只是
 * 「等几个节点」，读到空数组等于「不用等」，属于可接受的降级。
 */
export function parseWaitingOn(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 该项目最近一次运行。项目页打开时用它恢复上次的运行状态 */
export async function getLatestRun(projectId: string) {
  return db.run.findFirst({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
}
