import "dotenv/config";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { JOB_STATUS, NODE_STATUS, RUN_STATUS } from "@/lib/constants";
import { buildPlan, type PlanStep } from "@/engine/plan";
import { executeNode } from "@/engine/executor";
import { emit, emitLog, EVENT_TYPE } from "@/lib/events";

// Worker：独立进程的调度循环。
//
// 为什么必须独立进程（而不是在 Route Handler 里跑）：
// Next.js 的 Route Handler 活在请求上下文里 —— 会被超时回收、会被打成多个
// 无状态实例、 dev 模式下一次热更新就没了。一段要跑三五分钟的视频生成
// 放在里面，等于把命运交给运行时。独立进程的生命周期由自己说了算。

const WORKER_ID = `${os.hostname()}#${process.pid}-${randomUUID().slice(0, 6)}`;

/** 空闲时的轮询间隔。没任务时不要空转烧 CPU */
const POLL_MS = 800;
/** 心跳间隔。刷新 lockedAt，告诉别的 worker "我还活着" */
const HEARTBEAT_MS = 5_000;
/**
 * 租约时长。心跳超过这么久没刷新，就认为持有者已经死了。
 * 必须显著大于 HEARTBEAT_MS（这里 12 倍），否则一次 GC 停顿或
 * 数据库抖动就会被误判成死亡，任务被抢走重复执行 —— 那是在重复扣费。
 */
const LEASE_MS = 60_000;
/** 每个 job 最多尝试次数。只重试限流/超时这类可恢复错误 */
const MAX_ATTEMPTS = 2;
/**
 * 同批次内的最大并发。
 * 真实模型 API 都有 QPS 限制，一个批次十个节点一起打过去，
 * 换来的不是快，是一串 429。宁可排队慢一点。
 */
const MAX_CONCURRENCY = 3;
/** 退出时最多等当前任务多久，超时就强退 */
const SHUTDOWN_GRACE_MS = 15_000;

let stopping = false;
const abort = new AbortController();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`[worker] ${WORKER_ID} 启动，轮询间隔 ${POLL_MS}ms`);

  await reclaimOrphanJobs();

  const heartbeat = setInterval(() => {
    void db.job
      .updateMany({
        where: { lockedBy: WORKER_ID, status: JOB_STATUS.RUNNING },
        data: { lockedAt: new Date() },
      })
      .catch(() => {});
  }, HEARTBEAT_MS);

  try {
    while (!stopping) {
      try {
        const worked = await tick();
        // 没活干才睡。刚跑完一轮立刻睡 800ms 会让流水线看起来一顿一顿的
        if (!worked) await sleep(POLL_MS);
      } catch (err) {
        console.error("[worker] tick 出错：", err);
        await sleep(POLL_MS);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  console.log("[worker] 已停止");
}

/** 捞一次活。返回 false 表示这一轮什么也没做 */
async function tick(): Promise<boolean> {
  await reclaimOrphanJobs();

  const run = await db.run.findFirst({
    where: { status: { in: [RUN_STATUS.PENDING, RUN_STATUS.RUNNING] } },
    orderBy: { createdAt: "asc" },
  });
  if (!run) return false;

  await processRun(run.id, run.projectId, run.status);
  return true;
}

async function processRun(
  runId: string,
  projectId: string,
  currentStatus: string
) {
  if (stopping) return;

  // Worker 是独立进程，拿不到 API 那次调用的上下文，必须自己重算计划。
  // 但「这次运行其实是一个节点动作」这件事只存在 Job 表里 —— 不还原它，
  // buildPlan 就不知道要临时给目标节点加上 text 能力，于是退化成
  // 「纯输入节点直接完成」，动作静默失效：状态一路 succeeded，什么都没发生。
  // （2026-10-22 修：这正是 M6c 一直验不过的真正原因）
  const actionJob = await db.job.findFirst({
    where: { runId, action: { not: null } },
    select: { nodeId: true, action: true },
  });

  const plan = await buildPlan(
    projectId,
    actionJob?.action
      ? { mode: "node", targetId: actionJob.nodeId, action: actionJob.action }
      : {}
  );

  if (currentStatus === RUN_STATUS.PENDING) {
    await db.run.update({
      where: { id: runId },
      data: { status: RUN_STATUS.RUNNING, startedAt: new Date() },
    });
    await emit(runId, EVENT_TYPE.RUN_STATUS, { status: RUN_STATUS.RUNNING });
  }

  /** 这些节点的后代要被跳过 */
  const blocked = new Set<string>();
  const failedNodes = new Set<string>();

  for (let batch = 0; batch < plan.batches.length; batch++) {
    if (stopping || (await isCancelled(runId))) return;

    const jobs = await db.job.findMany({
      where: { runId, batch, status: JOB_STATUS.PENDING },
    });
    if (jobs.length === 0) continue;

    await runWithConcurrency(jobs, MAX_CONCURRENCY, async (job) => {
      if (stopping) return;

      const upstreams = plan.steps.get(job.nodeId)?.upstreamIds ?? [];
      if (upstreams.some((u) => blocked.has(u))) {
        await markSkipped(runId, job.id, job.nodeId);
        blocked.add(job.nodeId);
        return;
      }

      // ---- 乐观锁抢占 ----
      //
      // 这是整个队列最关键的一行。为什么不能直接 update 成 running：
      // 两个 worker 同时捞到同一个 job 时，两边都会认为自己抢到了，
      // 于是同一个节点被调两次模型 —— 用户被扣两次钱，节点状态还会互相覆盖。
      //
      // 把「当前状态是 pending」写进 where，让数据库来做裁判：
      // updateMany 返回受影响行数，只有把它从 pending 改成 running 的那一个
      // 进程会得到 count === 1。这就是 CAS（compare-and-swap）。
      const claimed = await db.job.updateMany({
        where: { id: job.id, status: JOB_STATUS.PENDING },
        data: {
          status: JOB_STATUS.RUNNING,
          lockedBy: WORKER_ID,
          lockedAt: new Date(),
        },
      });
      if (claimed.count !== 1) return; // 被别人抢走了，安静退出

      const step = plan.steps.get(job.nodeId);
      if (!step) return;

      const result = await runWithRetry(runId, job.id, step);

      if (result === "failed") {
        failedNodes.add(job.nodeId);
        // 失败要传播：自己和所有后代都进 blocked。
        //
        // 失败节点本身也必须进去，不能只加后代 ——
        // 否则它的**直接下游**判断"上游在 blocked 里吗"时会漏判，
        // 照样跑一遍，然后报一个和真正原因无关的错误。
        //
        // 不传播的话，下游会因为"拿不到输入"各自报一个莫名其妙的错，
        // 用户在一片红里根本找不到真正的故障点。
        blocked.add(job.nodeId);
        for (const d of descendants(job.nodeId, plan.downstream)) {
          blocked.add(d);
        }
      }
    });
  }

  if (stopping || (await isCancelled(runId))) return;

  // 收尾前再查一次：可能有重试后仍失败的 job
  const notSucceeded = await db.job.findMany({
    where: {
      runId,
      status: { in: [JOB_STATUS.FAILED, JOB_STATUS.PENDING, JOB_STATUS.RUNNING] },
    },
  });

  const failed = notSucceeded.filter((j) => j.status === JOB_STATUS.FAILED);
  const finalStatus = failed.length > 0 ? RUN_STATUS.FAILED : RUN_STATUS.SUCCEEDED;

  await db.run.update({
    where: { id: runId },
    data: { status: finalStatus, endedAt: new Date() },
  });

  await emit(runId, EVENT_TYPE.RUN_STATUS, {
    status: finalStatus,
    error:
      failed.length > 0
        ? `${failed.length} 个节点失败：${failed
            .slice(0, 2)
            .map((f) => f.lastError ?? "未知错误")
            .join("；")}`
        : null,
  });
}

/** 执行 + 可重试错误的退避重试 */
async function runWithRetry(
  runId: string,
  jobId: string,
  step: PlanStep
): Promise<"succeeded" | "failed" | "cancelled"> {
  let attempt = 0;

  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    if (stopping) return "cancelled";

    const result = await executeNode({
      runId,
      jobId,
      step,
      signal: abort.signal,
    });

    if (result.status === "succeeded") return "succeeded";
    if (result.status === "cancelled") return "cancelled";

    // 只有可重试的错误才重试。提示词为空、模型不支持这类错误
    // 重试一百次也是同样的结果，反而让用户多等。
    if (!result.retryable || attempt >= MAX_ATTEMPTS) {
      return "failed";
    }

    const backoff = 1000 * attempt;
    await emitLog(runId, [
      {
        nodeId: step.nodeId,
        level: "warn",
        message: `第 ${attempt} 次尝试失败（${result.error}），${backoff}ms 后重试`,
      },
    ]);
    await sleep(backoff);
  }

  return "failed";
}

async function markSkipped(runId: string, jobId: string, nodeId: string) {
  await db.job.update({
    where: { id: jobId },
    data: { status: JOB_STATUS.SKIPPED, lastError: "上游节点失败，已跳过" },
  });
  await db.node.updateMany({
    where: { id: nodeId },
    data: { status: NODE_STATUS.SKIPPED, error: "上游失败，已跳过" },
  });
  await emit(runId, EVENT_TYPE.NODE_STATUS, {
    nodeId,
    status: NODE_STATUS.SKIPPED,
    error: "上游失败，已跳过",
  });
}

async function isCancelled(runId: string) {
  const run = await db.run.findUnique({
    where: { id: runId },
    select: { status: true },
  });
  return !run || run.status === RUN_STATUS.CANCELLED;
}

/**
 * 回收孤儿任务。
 *
 * Worker 被 kill（Ctrl+C、部署、OOM）时，它正在跑的 job 会永远停在 running：
 * 没有任何进程会再去动它，用户只能看到「一直在转」。
 *
 * 判定依据是心跳时间而不是"进程是否还在" —— 后者在单机上可以查，
 * 但一旦 worker 跑到别的机器上就失效了。心跳 + 租约是分布式下的通用解法。
 */
async function reclaimOrphanJobs() {
  const deadline = new Date(Date.now() - LEASE_MS);

  const stale = await db.job.findMany({
    where: { status: JOB_STATUS.RUNNING, lockedAt: { lt: deadline } },
    select: { id: true, runId: true, nodeId: true, attempts: true },
  });
  if (stale.length === 0) return;

  console.log(`[worker] 回收 ${stale.length} 个超时任务`);

  for (const job of stale) {
    if (job.attempts >= MAX_ATTEMPTS) {
      await db.job.update({
        where: { id: job.id },
        data: { status: JOB_STATUS.FAILED, lastError: "执行超时且重试次数已用尽" },
      });
      await db.node.updateMany({
        where: { id: job.nodeId },
        data: { status: NODE_STATUS.FAILED, error: "执行超时且重试次数已用尽" },
      });
      await emit(job.runId, EVENT_TYPE.NODE_STATUS, {
        nodeId: job.nodeId,
        status: NODE_STATUS.FAILED,
        error: "执行超时且重试次数已用尽",
      });
    } else {
      // 放回 pending，让下一轮重新捞起。不清空 attempts —— 它是一次真实的尝试
      await db.job.update({
        where: { id: job.id },
        data: {
          status: JOB_STATUS.PENDING,
          lockedBy: null,
          lockedAt: null,
        },
      });
      await db.node.updateMany({
        where: { id: job.nodeId },
        data: { status: NODE_STATUS.QUEUED },
      });
    }
  }
}

/** 收集一个节点的所有后代（用于失败传播） */
function descendants(
  nodeId: string,
  downstream: Map<string, string[]>
): string[] {
  const out: string[] = [];
  const visited = new Set([nodeId]);
  const stack = [...(downstream.get(nodeId) ?? [])];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    out.push(current);
    stack.push(...(downstream.get(current) ?? []));
  }
  return out;
}

/** 固定并发地跑一批任务。不做并发控制的话，一个大批次会把模型 API 打爆 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  const queue = [...items];
  const lanes = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        await fn(item);
      } catch (err) {
        console.error("[worker] 任务执行异常：", err);
      }
    }
  });
  await Promise.all(lanes);
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[worker] 收到 ${signal}，正在停止…`);
  abort.abort();

  // 给正在跑的任务一点收尾时间，超时就强退
  const timer = setTimeout(() => {
    console.log("[worker] 优雅退出超时，强制退出");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  timer.unref?.();

  // 把自己持有的 running job 还回队列。
  // 不这么做，这些任务要等 LEASE_MS 之后才被回收 —— 用户会看到
  // 一段莫名其妙的"卡住"，而原因只是我们重启了一次 worker。
  await db.job
    .updateMany({
      where: { lockedBy: WORKER_ID, status: JOB_STATUS.RUNNING },
      data: { status: JOB_STATUS.PENDING, lockedBy: null, lockedAt: null },
    })
    .catch(() => {});

  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((err) => {
  console.error("[worker] 崩溃：", err);
  process.exit(1);
});
