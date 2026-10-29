import "dotenv/config";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  JOB_STATUS,
  NODE_STATUS,
  RUN_STATUS,
  MAX_CONCURRENT_TASKS,
  MAX_CONCURRENT_PER_USER,
  WAIT_TIMEOUT_MS,
} from "@/lib/constants";
import { buildPlan, type PlanStep } from "@/engine/plan";
import { executeNode } from "@/engine/executor";
import { emit, emitLog, EVENT_TYPE } from "@/lib/events";
import { parseWaitingOn } from "@/lib/runService";
import { parseNodeData } from "@/canvas/schemas/nodeData";
import { availableModels, getModelDescriptor } from "@/providers/catalog";
import { MinuteLimiter } from "@/lib/minuteLimiter";

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
/**
 * 每个 job 最多尝试次数。只重试「请求没发出去 / 等一会儿真会好」这类错误。
 *
 * 超时**不算**可重试 —— 超时意味着对面可能已经在跑并且已经开始计费，
 * 重排一次就是再买一份（见 engine/executor.ts 的超时分支）。
 */
const MAX_ATTEMPTS = 2;
/**
 * 同时能推进几条 run。
 *
 * 原来这里是「每个 run 内部 3 条 lane」，作用域是一个 run 的一个批次 ——
 * 于是跑一个 10 分钟的视频时，整个 Worker 只服务那一条 run，
 * 别的节点提交上来只能排队（而且旧规则会直接把前一条取消）。
 *
 * 现在这个数是**全局**的：跨 run、跨项目共享，和 API 层拒绝新提交用的是
 * 同一个常量（MAX_CONCURRENT_TASKS）。一个数管两处，不会漂移。
 */
const MAX_RUNS_IN_FLIGHT = MAX_CONCURRENT_TASKS;
/** 退出时最多等当前任务多久，超时就强退 */
const SHUTDOWN_GRACE_MS = 15_000;

let stopping = false;
const abort = new AbortController();

/**
 * 正在被本进程推进的 run。
 *
 * 为什么必须有：tick 每 800ms 跑一次，如果某条 run 要跑五分钟，
 * 不给它做个记号，下一次 tick 会再启动一份同样的推进 ——
 * 两个循环同时抢同一批 job（靠 CAS 不会重复执行，但会互相把
 * 「失败传播」「收尾判定」搅乱）。内存里的 Set 是最轻的锁：
 * 单进程单 Worker，不需要跨进程语义（跨进程由 Job 的 CAS 兜底）。
 */
const inFlight = new Set<string>();

/**
 * 全局并发名额。
 *
 * 抢名额的时机是**真正调模型之前**，而不是抢到 job 之前 ——
 * 否则被抢到却在排队的 job 会一直标着 running，节点上显示「生成中」
 * 但其实一行代码都没跑，用户会以为卡住了。
 */
class Semaphore {
  private permits: number;
  private waiters: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  private async acquire() {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release() {
    const next = this.waiters.shift();
    // 直接把名额交给排队者，不先加回再被别人抢走 ——
    // 否则「后到的先拿到」会成为常态，长任务可能一直轮不上。
    if (next) next();
    else this.permits += 1;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

const slots = new Semaphore(MAX_CONCURRENT_TASKS);

/**
 * 每个用户的并发名额。懒创建：第一次见到这个人时建一个桶。
 *
 * ### 为什么叠在全局信号量之外还要一层
 *
 * 只有全局信号量时，一个人点满三个就把整台机器占完了 —— 别人点什么
 * 都只能排队，而他不需要知道那是别人的任务。这一层挡的是「一个人吃独食」；
 * 全局那层挡的是「我们把供应商打爆」。两件事，两个数。
 *
 * 先拿用户桶、再拿全局名额（见 processRun）。反过来的话，一个人可能
 * 攥着全局名额等自己的桶，别人连「进桶」的机会都没有。
 */
const userSlots = new Map<string, Semaphore>();

function userSlotsFor(userId: string) {
  let s = userSlots.get(userId);
  if (!s) {
    s = new Semaphore(MAX_CONCURRENT_PER_USER);
    userSlots.set(userId, s);
  }
  return s;
}

/**
 * 按模型的「每分钟最多提交几次」节流器。
 *
 * ### 为什么需要它，而信号量不够
 *
 * 千问图像的官方限制是「提交 5 次/分钟」，同时写明「同步接口并发不限」。
 * 也就是说 3 个请求在两秒内发完完全合法，但这一分钟内第 6 个必然 429。
 * 并发信号量管的是「同时几个」，对这件事完全无效。
 *
 * 而且配额**按模型独立**：3.0-pro 用掉的 5 次不影响 3.0 的 20 次，
 * 所以每个模型一个节流器，不是全局一个。
 *
 * 滑动窗口的实现本身在 `lib/minuteLimiter.ts` —— 那里是纯逻辑、有单测；
 * 这里只负责「哪个模型用哪个配额」和「等的时候怎么告诉用户」。
 */
const limiters = new Map<string, MinuteLimiter>();

/**
 * 这一次图片请求要不要排队等配额。
 *
 * 返回 null 表示「这个模型没有已知的分钟级限制」（或者压根不是图片），
 * 直接调就行。
 */
function limiterFor(modelId: string | undefined): MinuteLimiter | null {
  // 没指定模型时，用的就是该能力的默认模型（和 selectProvider 同一套规则）
  const id = modelId ?? availableModels("image", process.env)[0]?.id;
  if (!id) return null;

  const perMinute = getModelDescriptor(id)?.rateLimitPerMinute;
  if (!perMinute) return null;

  let l = limiters.get(id);
  if (!l) {
    l = new MinuteLimiter(perMinute);
    limiters.set(id, l);
  }
  return l;
}

/**
 * 等一次图片提交配额，等的时候告诉用户为什么在等。
 *
 * 「排队等配额」和「模型在生成」在界面上原本都只是「生成中」，
 * 但前者可能要等满 60 秒，用户会以为卡死了。所以第一条日志必须说清
 * 是哪个模型、每分钟只能几次 —— 这是他唯一能理解这个延迟的线索。
 *
 * 只在第一次说，之后每 5 秒静默重试：刷屏的日志等于没有日志。
 */
async function waitForImageQuota(
  limiter: MinuteLimiter,
  runId: string,
  nodeId: string,
  modelId: string
) {
  let notified = false;

  for (;;) {
    if (stopping) return;

    const wait = limiter.tryAcquire();
    if (wait === 0) return;

    if (!notified) {
      notified = true;
      await emitLog(runId, [
        {
          nodeId,
          level: "info",
          message: `${modelId} 每分钟最多提交 ${limiter.perMinute} 次，这一张要等约 ${formatWait(wait)}`,
        },
      ]);
    }
    // 分段睡：既不会等过头，也让 Ctrl+C 最多 5 秒内能退出
    await sleep(Math.min(wait, 5_000));
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 把毫秒说成人话。日志里写「12000ms」等于让用户在脑子里再除一次 1000 */
function formatWait(ms: number) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`;
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

/**
 * 捞一次活。返回 false 表示这一轮什么也没做。
 *
 * ### 为什么不再 `await processRun(...)`
 *
 * 原来这里是一条 run 走完全程才回来，等于 Worker 只有一个槽位：
 * 一条 30 秒的视频（5–10 分钟）会把整个队列顶住。
 * 现在最多同时推进 MAX_RUNS_IN_FLIGHT 条，各自跑各自的批次；
 * 真正调用模型前的并发限制交给全局信号量（slots）。
 *
 * ### 等待中的 run 在这里结算，而不是在 processRun 里面
 *
 * 因为它们**不占并发名额**，也不该让 tick 空转。放在这里结算：
 * 还等着的 → 直接跳过（既不标记 inFlight 也不算干过活，于是可以正常睡 800ms）；
 * 等到了 → 清掉 waitingOn，下面照常启动；
 * 等不到（上游失败 / 负责它的 run 没了 / 超时）→ 当场判失败。
 */
async function tick(): Promise<boolean> {
  await reclaimOrphanJobs();

  const runs = await db.run.findMany({
    where: { status: { in: [RUN_STATUS.PENDING, RUN_STATUS.RUNNING] } },
    orderBy: { createdAt: "asc" },
  });

  let started = false;

  for (const run of runs) {
    if (stopping) break;
    if (inFlight.has(run.id)) continue;
    if (inFlight.size >= MAX_RUNS_IN_FLIGHT) break;

    if (run.waitingOn) {
      const state = await resolveWait(run);
      if (state !== "ready") continue;
    }

    inFlight.add(run.id);
    started = true;

    // 故意不 await：三条 run 要能同时推进。错误在这里收口，
    // 不能让它变成 unhandled rejection 把整个进程带走。
    void processRun(run.id, run.projectId, run.status, run.userId)
      .catch((err) => {
        console.error(`[worker] run ${run.id} 执行异常：`, err);
      })
      .finally(() => {
        inFlight.delete(run.id);
      });
  }

  return started;
}

/**
 * 结算一条挂起的 run。
 *
 * 三种结局：
 *   ready   —— 等的东西都有了，清掉标记，可以开跑
 *   waiting —— 还在跑，什么都不改（这次 tick 就当它不存在）
 *   failed  —— 等不到结果了，整条 run 判失败并说清原因
 *
 * 判据是**节点的实时状态**，不是「谁承诺会跑它」—— 因为那个承诺会过期：
 * 对方被用户取消、它的 Worker 挂了、它自己失败，都得让这条 run 知道。
 * 所以除了看状态，还要问一句「现在还有 job 在负责它吗」。
 */
async function resolveWait(run: {
  id: string;
  waitingOn: string | null;
  waitingSince: Date | null;
  targetId: string | null;
}): Promise<"ready" | "waiting" | "failed"> {
  const ids = parseWaitingOn(run.waitingOn);
  if (ids.length === 0) return "ready";

  const rows = await db.node.findMany({
    where: { id: { in: ids } },
    select: { id: true, type: true, data: true, status: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    await failWaitingRun(
      run.id,
      run.targetId,
      `等待的节点已被删除（${missing.length} 个），这次运行无法继续`
    );
    return "failed";
  }

  const broken = ids
    .map((id) => byId.get(id)!)
    .find(
      (n) => n.status === NODE_STATUS.FAILED || n.status === NODE_STATUS.SKIPPED
    );
  if (broken) {
    await failWaitingRun(
      run.id,
      run.targetId,
      `等待的上游节点「${nodeLabel(broken)}」没有产出（${
        broken.status === NODE_STATUS.SKIPPED ? "它的上游失败，被跳过" : "执行失败"
      }），这次运行无法继续`
    );
    return "failed";
  }

  const unfinished = ids.filter(
    (id) => byId.get(id)!.status !== NODE_STATUS.SUCCEEDED
  );
  if (unfinished.length === 0) {
    await db.run.update({
      where: { id: run.id },
      data: { waitingOn: null, waitingSince: null },
    });
    return "ready";
  }

  // 还有人负责这些节点吗？
  //
  // 没有 = 等下去永远不会有人来。最典型的两种：对方那条 run 被用户取消了
  // （cancelRun 把没跑完的节点复位成 idle），或者对方的 Worker 挂了。
  // 不判这一条，用户会对着「排队中」等满 10 分钟才看到失败。
  const owners = await db.job.count({
    where: {
      nodeId: { in: unfinished },
      status: { in: [JOB_STATUS.PENDING, JOB_STATUS.RUNNING] },
      runId: { not: run.id },
      run: { status: { in: [RUN_STATUS.PENDING, RUN_STATUS.RUNNING] } },
    },
  });
  if (owners === 0) {
    await failWaitingRun(
      run.id,
      run.targetId,
      "负责生成上游产物那次运行已经结束，但它没有产出，这次运行无法继续"
    );
    return "failed";
  }

  if (
    run.waitingSince &&
    Date.now() - run.waitingSince.getTime() > WAIT_TIMEOUT_MS
  ) {
    await failWaitingRun(
      run.id,
      run.targetId,
      `等待上游超过 ${Math.round(WAIT_TIMEOUT_MS / 60_000)} 分钟，已放弃`
    );
    return "failed";
  }

  return "waiting";
}

/**
 * 把一条还在等待的 run 判失败。
 *
 * 与普通失败的区别：这条 run 一个节点都还没跑，所以没有「正在进行的调用」
 * 需要中断，要做的只是把库里的状态收干净，并且**说清为什么**——
 * 用户看到的会是「等待的节点没产出」，而不是一句莫名的「运行失败」。
 */
async function failWaitingRun(
  runId: string,
  targetId: string | null,
  message: string
) {
  const jobs = await db.job.findMany({
    where: { runId, status: { in: [JOB_STATUS.PENDING, JOB_STATUS.RUNNING] } },
    select: { id: true, nodeId: true },
  });

  await db.job.updateMany({
    where: { runId, status: { in: [JOB_STATUS.PENDING, JOB_STATUS.RUNNING] } },
    data: { status: JOB_STATUS.SKIPPED, lastError: message },
  });

  // 目标节点标红并写上原因：用户是在这个节点上点下去的，
  // 错误必须出现在他看的那个地方。其余节点从「排队中」退回 idle ——
  // 它们只是被牵连，并没有失败。
  if (targetId) {
    await db.node.updateMany({
      where: { id: targetId, status: { not: NODE_STATUS.SUCCEEDED } },
      data: { status: NODE_STATUS.FAILED, error: message },
    });
    await emit(runId, EVENT_TYPE.NODE_STATUS, {
      nodeId: targetId,
      status: NODE_STATUS.FAILED,
      error: message,
    });
  }
  const others = jobs
    .map((j) => j.nodeId)
    .filter((id) => id !== targetId);
  if (others.length > 0) {
    await db.node.updateMany({
      where: { id: { in: others }, status: { not: NODE_STATUS.SUCCEEDED } },
      data: { status: NODE_STATUS.IDLE, error: null },
    });
  }

  await db.run.update({
    where: { id: runId },
    data: {
      status: RUN_STATUS.FAILED,
      endedAt: new Date(),
      waitingOn: null,
      waitingSince: null,
    },
  });

  await emit(runId, EVENT_TYPE.RUN_STATUS, {
    status: RUN_STATUS.FAILED,
    error: message,
  });
  await emitLog(runId, [{ nodeId: null, level: "error", message }]);
  console.log(`[worker] run ${runId} 等待失败：${message}`);
}

/** 节点在错误信息里怎么称呼自己。读不出名字就退回 id 前 6 位 */
function nodeLabel(node: { id: string; type: string; data: string }) {
  const label = parseNodeData(node.type, node.data).label;
  return typeof label === "string" && label.trim()
    ? label.trim()
    : node.id.slice(0, 6);
}

async function processRun(
  runId: string,
  projectId: string,
  currentStatus: string,
  userId: string | null
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

    /*
     * 同批次的 job 全部发起来，让**两道闸门**决定谁先真的调模型。
     *
     * 原来是 `runWithConcurrency(jobs, 3, ...)` —— 三道 lane 只属于这一条
     * run 的这一批。并发放开之后那样写等于每条 run 各自 3 个并发，
     * 三条 run 就是 9 个，直接打爆限流。名额必须是全局的。
     *
     * 现在是两层：
     *   1. 这个人自己的桶（MAX_CONCURRENT_PER_USER）—— 不让他一个人吃独食
     *   2. 全局名额（MAX_CONCURRENT_TASKS）—— 不让我们把供应商打爆
     *
     * **顺序不能反**：先拿自己的桶再等全局。反过来会让一个人先攥着全局
     * 名额、再等自己的桶，别人连进桶的机会都没有。而且这两层都是
     * 「拿到就跑、跑完就放」，不存在互相等待，所以不会死锁。
     */
    const userBucket = userId ? userSlotsFor(userId) : null;

    await Promise.all(
      jobs.map((job) => {
        const task = () =>
          slots.run(async () => {
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

        return userBucket ? userBucket.run(task) : task();
      })
    );
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

  /*
   * 结算积分。
   *
   * 汇总口径是 **Job.credits 求和**，而不是「节点数 × 单价」：
   * 同一个节点重试两次就是两次真实调用，钱真的花了两份，
   * 按节点数算会低估。这也是 Job.credits 存在的意义。
   */
  const jobCount = await db.job.count({ where: { runId } });
  const runSum = await db.job.aggregate({
    _sum: { credits: true },
    where: { runId },
  });
  const credits = runSum._sum.credits ?? 0;

  // 项目累计：这一列此时还是 0（下面才写），所以要把本次加回去
  const projectSum = await db.run.aggregate({
    _sum: { credits: true },
    where: { projectId },
  });
  const projectCredits = (projectSum._sum.credits ?? 0) + credits;

  await db.run.update({
    where: { id: runId },
    data: { status: finalStatus, endedAt: new Date(), credits },
  });

  await emitLog(runId, [
    {
      nodeId: null,
      level: "info",
      message: `本次 ${jobCount} 个节点，消耗 ${credits} 积分（该项目累计 ${projectCredits} 积分）`,
    },
  ]);

  await emit(runId, EVENT_TYPE.RUN_STATUS, {
    status: finalStatus,
    error:
      failed.length > 0
        ? `${failed.length} 个节点失败：${failed
            .slice(0, 2)
            .map((f) => f.lastError ?? "未知错误")
            .join("；")}`
        : null,
    credits,
    nodeCount: jobCount,
    projectCredits,
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

    /*
     * 图片要按模型的分钟配额排队，而且**每一次尝试都要重新拿**。
     *
     * 放在 attempt 里而不是循环外，是因为重试也是一次真实的提交 ——
     * 5 次/分钟的额度不会因为「这次是重试」就放行。这也正是原来
     * 最容易 429 的地方：第一次被 429，退避 12 秒重试，又撞上同一分钟的
     * 额度，两次机会用光，节点标红。
     *
     * 位置选在「已经拿到全局名额之后」：配额最多等 60 秒，
     * 这期间占着一个全局名额，会拖慢别人。但反过来先拿配额再等全局，
     * 配额会被白白攥着（可能攥好几分钟），实际提交时早就过期了，
     * 那时候反而更容易真的超限。宁可慢一点，也不要假配额。
     */
    if (step.capability === "image") {
      const limiter = limiterFor(step.modelId);
      if (limiter) {
        const modelId =
          step.modelId ?? availableModels("image", process.env)[0]?.id ?? "图片模型";
        await waitForImageQuota(limiter, runId, step.nodeId, modelId);
      }
    }

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

    /*
     * 退避时长优先听 Provider 的。
     *
     * 限流时它从 Retry-After 拿到了准确值，或者按模型的 RPM 推了一个
     * （千问图像 Pro：12 秒）。原来固定 `1000 * attempt`，在 5 次/分钟的
     * 限额面前等于没等 —— 第二次照样 429，然后尝试次数就用光了，
     * 节点标红，用户看到"限流"以为是模型坏了。
     *
     * 没给值才退回这个朴素的退避 —— 那是给"说不清多久会好"的错误兜底的。
     */
    const backoff = result.retryAfterMs ?? 1000 * attempt;
    await emitLog(runId, [
      {
        nodeId: step.nodeId,
        level: "warn",
        message: `第 ${attempt} 次尝试失败（${result.error}），${formatWait(backoff)}后重试`,
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

/**
 * 优雅退出。
 *
 * 注意 abort 会让**所有**在飞的 run 一起中断 —— 它们的 job 会被下面的
 * updateMany 还回 pending，下次启动继续。这正是多 run 并行之后必须的：
 * 只还自己组的那几条，剩下的会等到租约过期才被回收。
 */
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
