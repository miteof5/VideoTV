import { db } from "@/lib/db";
import { NODE_STATUS, JOB_STATUS, CREDIT_COST } from "@/lib/constants";
import { resolveInStorage } from "@/lib/storage";
import { persistOutput } from "@/lib/assetService";
import { selectProvider } from "@/providers/registry";
import { ProviderError, type ProviderInput } from "@/providers/types";
import { emit, emitLog, EVENT_TYPE } from "@/lib/events";
import type { PlanStep } from "@/engine/plan";
import { parseNodeData } from "@/canvas/schemas/nodeData";

// 执行引擎：把「一个已被抢占的 job」跑完。
//
// 它是纯业务函数，不关心是谁在调度（Worker / 测试脚本 / API 都能直接调）。
// 抢占、并发、重试这些调度问题在 Worker 里，这里只管一次执行的成败。

export interface ExecuteContext {
  runId: string;
  jobId: string;
  step: PlanStep;
  /** 取消信号：用户点了停止，或 Worker 要退出 */
  signal: AbortSignal;
  /** 单个节点的总超时，防止一个卡死的模型把整条流水线挂住 */
  timeoutMs?: number;
}

export interface ExecuteResult {
  status: "succeeded" | "failed" | "cancelled";
  error?: string;
  assetId?: string;
  /** 可重试的失败（限流、超时），Worker 会再排一次 */
  retryable?: boolean;
  /**
   * 建议等多久再重试（毫秒）。限流时由 Provider 从 `Retry-After` 头取，
   * 或者按 429 推一个缺省值（见 http.ts 的 classify）。
   * 缺省表示"没意见"，Worker 用自己的退避策略。
   */
  retryAfterMs?: number;
}

/** 进度事件的最小间隔。Provider 每 200ms 回调一次，全落库会把事件表撑爆 */
const PROGRESS_THROTTLE_MS = 400;
/** 进度变化小于这个值就不发。0.01 的抖动用户根本看不出来 */
const PROGRESS_MIN_DELTA = 0.02;

export async function executeNode(ctx: ExecuteContext): Promise<ExecuteResult> {
  const { runId, jobId, step, signal } = ctx;
  const { nodeId } = step;

  const node = await db.node.findUnique({ where: { id: nodeId } });
  if (!node) {
    return fail(ctx, "节点不存在（可能已被删除）", false);
  }

  // ---- 1. 标记 running ----
  await db.job.update({
    where: { id: jobId },
    data: { status: JOB_STATUS.RUNNING, attempts: { increment: 1 } },
  });
  await db.node.update({
    where: { id: nodeId },
    data: { status: NODE_STATUS.RUNNING, error: null },
  });
  await emit(runId, EVENT_TYPE.NODE_STATUS, {
    nodeId,
    status: NODE_STATUS.RUNNING,
  });

  // ---- 2. 纯输入节点：不需要模型，直接完成 ----
  //
  // 这一步的意义不只是"省一次调用"。如果 text.prompt 也去调模型，
  // 用户写好的剧本就会被模型改写一遍 —— 那不是"生成"，是"篡改"。
  // 节点要不要调模型由注册表的 capability 声明，引擎不认识任何具体类型。
  if (!step.capability) {
    await db.node.update({
      where: { id: nodeId },
      data: { status: NODE_STATUS.SUCCEEDED, error: null },
    });
    await db.job.update({
      where: { id: jobId },
      data: { status: JOB_STATUS.SUCCEEDED },
    });
    await emit(runId, EVENT_TYPE.NODE_STATUS, {
      nodeId,
      status: NODE_STATUS.SUCCEEDED,
    });
    return { status: "succeeded" };
  }

  // ---- 3. 收集上游产物 ----
  //
  // 只取**直接上游**：图生视频用的是"上一张图"，不是"所有祖先的图"。
  // 把爷爷辈的图也塞给模型，只会让它无所适从。
  const inputs = await collectInputs(step);

  await emitLog(runId, [
    {
      nodeId,
      level: "info",
      message: [
        `开始生成（${step.capability}`,
        step.params?.mode ? ` / ${String(step.params.mode)}` : "",
        inputs.length ? `，参考 ${inputs.length} 个上游产物` : "",
        "）",
      ].join(""),
    },
    {
      nodeId,
      level: "info",
      /*
       * 把**实际发给模型的提示词**记进日志。
       *
       * 「上游的文本有没有拼进来、拼了几段」在界面上完全看不出来 ——
       * 用户只能看到一条连线，然后对着一个和预期不符的产出猜测。
       * 这是唯一能核对的地方。
       *
       * 截断到 200 字：完整提示词可能很长（几段剧本），全塞进事件表
       * 会把日志面板冲垮，而且真要完整内容的人会去看节点本身。
       */
      message: `提示词：${truncate(step.prompt, 200)}`,
    },
  ]);

  // ---- 4. 调模型 ----
  const timeoutMs = ctx.timeoutMs ?? timeoutFor(step);
  const timer = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timer]);

  let lastEmit = 0;
  let lastPercent = -1;
  const onProgress = (percent: number) => {
    const p = Math.max(0, Math.min(1, percent));
    // 节流：既不刷屏事件表，也不让前端一秒收到五个进度更新
    if (p - lastPercent < PROGRESS_MIN_DELTA && p < 1) return;
    const now = Date.now();
    if (now - lastEmit < PROGRESS_THROTTLE_MS && p < 1) return;
    lastEmit = now;
    lastPercent = p;
    // 故意不 await：进度回调在 Provider 的循环里同步调用，
    // 等它落库会把模型调用拖慢。丢一两条进度不影响正确性。
    void emit(runId, EVENT_TYPE.NODE_PROGRESS, { nodeId, percent: p }).catch(
      () => {}
    );
  };

  /*
   * ---- 3.5 积分记账 ----
   *
   * ### 什么算「消耗了一次」
   *
   * **请求真的发出去了就算**，成败都算。这是真实世界的规则：对面已经
   * 开始计费了，我们这边返回失败并不退钱。所以：
   *   - 参数校验没过 / 没有可用模型 → 请求根本没出去，**不计**
   *   - dry run → 请求被拦在本地，**不计**
   *   - 发出去了，超时 / 429 / 内容审核拒绝 → **计**
   *
   * ### 为什么在「调之前」打标记，在「调之后」才写库
   *
   * 需要同时满足两件事：调用前不知道会不会 dry run，调用后可能直接抛异常。
   * 所以用一个 `dispatched` 标记表示「请求已发出」，成功分支和 catch 分支
   * 各自决定要不要落账，`charged` 保证同一次尝试只记一次 —— 否则
   * 「调用成功但落盘失败」会被记两遍。
   *
   * ### 重试要不要重复计
   *
   * 要。重试是又一次真实调用，钱又出去一次。`Job.credits` 是累计值，
   * 一次 429 后再成功，这条 job 就是 20 积分（图片）。
   * 这正是 A 阶段要让人看见的东西 —— 原来的表里根本没有这个字段。
   */
  const cost = step.capability ? CREDIT_COST[step.capability] : 0;
  let dispatched = false;
  let charged = false;

  const charge = async () => {
    if (charged || cost <= 0) return;
    charged = true;
    // updateMany 而不是 update：run 可能在被取消时被删掉，
    // update 会抛「记录不存在」，把一次普通的失败升级成崩溃。
    // 记账失败不该影响这次执行的结果 —— 积分少记一分，比任务报错强。
    await db.job
      .updateMany({ where: { id: jobId }, data: { credits: { increment: cost } } })
      .catch(() => {});
  };

  try {
    const provider = selectProvider(step.capability, step.modelId);

    // 最后一道防线：参数必须是这个模型真的支持的。
    // 前端会跟着模型过滤下拉框，但数据库是可以被手工改的（迁移、脚本、旧项目），
    // 到真正调用前再校一次，成本几乎为零。
    const invalid = checkOptions(provider, step.params);
    if (invalid) {
      return fail(ctx, invalid, false);
    }

    // 从这一行之后，请求就真的发出去了 —— 后面无论成败都要记账。
    dispatched = true;

    const output = await provider.generate({
      prompt: step.prompt,
      /*
       * 系统指令只有「动作」会带（来自 NodeAction.systemPrompt）。
       * 常规生成为 undefined，Provider 侧不会多发一条空 system ——
       * 空串会被某些模型当成一条空指令，行为变得不可预测。
       */
      system: step.systemPrompt,
      negativePrompt: step.negativePrompt,
      params: step.params,
      inputs,
      signal: combined,
      onProgress,
    });

    /*
     * dry run 的证词。
     *
     * 干跑的意义全在这一条日志上：请求体拼完就被拦下了，没有发出去。
     * 用户要核对的正是「模型名对不对、图片尺寸是多少、上游那张图
     * 有没有真的变成 base64 塞进去」—— 这三样只要错一样，真跑起来
     * 就会失败或出一张莫名其妙的图，而界面上完全看不出来。
     *
     * 放在落盘之前：万一是落盘出了问题，这条日志至少证明调用是对的。
     */
    if (output.meta?.dryRun) {
      // 干跑：请求被拦在本地，一分钱都没出去 —— 后面即使落盘失败也不该计
      dispatched = false;
      await emitLog(runId, [
        {
          nodeId,
          level: "info",
          message: `DRY RUN 未真实调用（不扣额度）。${describeCall(output.meta.dryRunCall)}`,
        },
      ]);
    } else {
      await charge();
    }

    // 取消要优先于成功判定：模型可能在最后一刻才被中断，
    // 这时候即使返回了产物也不该算成功。
    if (signal.aborted) {
      return fail(ctx, "已取消", false, true);
    }

    // ---- 4.5 节点动作：文本写回节点的 optimizedPrompt，不落盘 ----
    //
    // 「优化提示词」这类动作的产出是**一段文字**，它要回到节点里去，
    // 而不是存成一个可供下载的资产 —— 存成资产的话，用户还得点一下下载
    // 再把文字粘回节点，那这个功能等于没做。
    //
    // ### 为什么现在可以写回，而 2026-10-22 那条决策说不写回
    //
    // 当时节点只有 `prompt` 一个字段：改写结果覆盖上去，用户的原话就永久丢了，
    // 改坏了回不去。所以改成「另开一个节点放结果，原文一动不动」。
    //
    // 现在文本节点有两个字段：`prompt`（原始描述）和 `optimizedPrompt`（优化结果）。
    // 原文有独立住处，覆盖的是另一栏 —— 那条约束的前提消失了。
    // 这也才是用户按下「发送」时预期的事：我说一句话，卡片上出现它的改写版，
    // 而不是画布上凭空多出一张卡片。
    if (step.action) {
      const text = output.text?.trim();
      if (!text) {
        return fail(ctx, "模型没有返回文本", true);
      }

      /*
       * 读最新的 data 再合并。
       *
       * 不能直接用函数开头那份 `node`：它可能是几秒前读的，这期间用户
       * 完全可能在面板里改了原始描述。用旧快照整体覆盖，会把那次修改吞掉
       * （画面上表现为「我刚打的字自己变回去了」）。
       *
       * 按字段合并而不是替换整个 data，也是同一个道理：只碰优化的那一栏。
       * 读与写之间仍有几毫秒的窗口，但已经缩到最小 —— 没有 JSON 局部更新
       * 的 SQLite 上，这是能做到的最好程度。
       */
      const fresh = await db.node.findUnique({
        where: { id: nodeId },
        select: { data: true, type: true },
      });
      const merged = { ...readNodeData(fresh?.data, fresh?.type), optimizedPrompt: text };

      await db.node.update({
        where: { id: nodeId },
        data: {
          status: NODE_STATUS.SUCCEEDED,
          error: null,
          data: JSON.stringify(merged),
        },
      });
      await db.job.update({
        where: { id: jobId },
        data: { status: JOB_STATUS.SUCCEEDED },
      });
      await emit(runId, EVENT_TYPE.NODE_STATUS, {
        nodeId,
        status: NODE_STATUS.SUCCEEDED,
      });
      /*
       * payload 里那个 `prompt` 是「本动作产出的文本」的意思，不是
       * 节点上的 prompt 字段。前端收到后写进 optimizedPrompt
       * （见 runStore 的 node.text 分支）。
       *
       * 名字留着不改，是因为它只在这条事件链内部流通 —— 改名字要同步
       * 事件协议、类型表、前端 switch 三处，收益只是「读起来更顺」。
       */
      await emit(runId, EVENT_TYPE.NODE_TEXT, {
        nodeId,
        prompt: text,
        action: step.action,
      });
      await emitLog(runId, [
        {
          nodeId,
          level: "info",
          message: `动作「${step.action}」完成，${text.length} 字已写回卡片`,
        },
      ]);

      return { status: "succeeded" };
    }

    // ---- 5. 落盘 + 关联 ----
    //
    // 带上 node.projectId：产物要进**这个项目**的资产库。
    // 节点在函数开头读出来的，projectId 就在里面，不是额外一次查询。
    const asset = await persistOutput(output, node.projectId);

    await db.node.update({
      where: { id: nodeId },
      data: { status: NODE_STATUS.SUCCEEDED, error: null, outputAssetId: asset.id },
    });
    await db.job.update({
      where: { id: jobId },
      data: { status: JOB_STATUS.SUCCEEDED },
    });

    await emit(runId, EVENT_TYPE.NODE_STATUS, {
      nodeId,
      status: NODE_STATUS.SUCCEEDED,
    });
    await emit(runId, EVENT_TYPE.NODE_OUTPUT, {
      nodeId,
      assetId: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
    });

    return { status: "succeeded", assetId: asset.id };
  } catch (err) {
    /*
     * 记账放在最前面，连「已取消」也要过一遍。
     *
     * 用户点停止时，请求往往已经发出去几十秒了 —— 上游照跑、照收费。
     * 只有「请求没发出去就失败」才不该计费，而那种情况 dispatched 还是 false。
     */
    if (dispatched) await charge();

    if (signal.aborted) {
      return fail(ctx, "已取消", false, true);
    }
    if (isTimeout(timer, signal)) {
      /*
       * 超时**不重试**（2026-10-28 改，原来这里是 true）。
       *
       * 超时和其它可重试错误有一个本质差别：**请求已经发出去了，对面的账
       * 已经开始算**。重试等于让同一个任务在平台侧跑第二遍 —— 视频按秒计费，
       * 30 秒的片子重跑一次是六倍价钱，而第一遍很可能在平台那边还在跑。
       *
       * 真正还能重试的只剩「连接都没建立起来」那一类（DNS、代理、握手失败），
       * 那些由 providers/dashscope/http.ts 的 fetch catch 判成 retryable，
       * 根本到不了这里。
       *
       * 代价：如果超时其实是网络慢、请求没到，用户得手动再点一次。
       * 这是明确选择的 —— 宁可多一次手动，不静默多扣一次钱。
       */
      return fail(
        ctx,
        `执行超时（超过 ${formatTimeout(timeoutMs)}）`,
        false
      );
    }
    const retryable = err instanceof ProviderError ? err.retryable : false;
    // 限流建议等待时长由 Provider 给出（Retry-After 头，或按 429 推的 12 秒）。
    // 不带出去的话 Worker 只能退回 1 秒起步，而 1 秒对一个 5 次/分钟的
    // 模型等于没等 —— 必再撞一次，然后标红。
    const retryAfterMs =
      err instanceof ProviderError ? err.retryAfterMs : undefined;
    const message = err instanceof Error ? err.message : String(err);
    return fail(ctx, message, retryable, false, retryAfterMs);
  }
}

/**
 * 收集上游产物，并带上「接在哪个端口上」。
 *
 * 只取**直接上游**：图生视频用的是「上一张图」，不是「所有祖先的图」。
 * 把爷爷辈的图也塞给模型，只会让它无所适从。
 *
 * role 必须传下去：首帧和尾帧在模型 API 里通常是两个不同的字段，
 * 只说「这里有张图」的话，接真模型时就得靠数组下标猜。
 */
async function collectInputs(step: PlanStep): Promise<ProviderInput[]> {
  const entries = Object.entries(step.inputs ?? {});

  /**
   * 展开成 [端口, 上游 id] 的扁平列表。
   *
   * 一个端口可以挂多个上游（多对一），所以要 flatMap 而不是直接取值 ——
   * 早先 inputs 是 Record<string, string> 时这里天然只有一个，
   * 改成数组后如果忘了展开，连了三条线也只会取到第一个。
   */
  const pairs: [string, string][] =
    entries.length > 0
      ? entries.flatMap(([role, ids]) => ids.map((id) => [role, id] as [string, string]))
      : step.upstreamIds.map((id) => ["", id] as [string, string]);

  if (pairs.length === 0) return [];

  const uniqueIds = [...new Set(pairs.map(([, id]) => id))];
  const nodes = await db.node.findMany({
    where: { id: { in: uniqueIds } },
    include: { outputAsset: true },
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  /*
   * 上传素材没有 outputAssetId —— 它的资产引用存在节点 params 的 assetId 里
   * （为什么存那里，见 nodeRegistry 的 assetInData）。
   *
   * 只从 outputAsset 取的话，用户上传的图接给视频节点会是
   * 「界面上有连线、模型却收不到图」：视频照样跑，只是文生视频，
   * 出来的东西和那张图毫无关系，而且不报任何错。
   * 批量查一次，避免每个上游各查一遍。
   */
  const refIds = nodes
    .map((n) => assetRefInData(n.data))
    .filter((x): x is string => Boolean(x));
  const refAssets =
    refIds.length > 0
      ? await db.asset.findMany({ where: { id: { in: [...new Set(refIds)] } } })
      : [];
  const refById = new Map(refAssets.map((a) => [a.id, a]));

  const out: ProviderInput[] = [];
  for (const [role, id] of pairs) {
    const n = byId.get(id);
    if (!n) continue;

    const asset = n.outputAsset ?? refById.get(assetRefInData(n.data) ?? "");
    if (!asset) continue;

    out.push({
      kind: asset.kind as ProviderInput["kind"],
      mimeType: asset.mimeType,
      filePath: resolveInStorage(asset.filePath),
      role: role || undefined,
    });
  }
  return out;
}

/**
 * 把 Node.data 的 JSON 字符串读成对象。
 *
 * 读不出来就返回空对象，不抛 —— 这一列是用户可改、老版本可写的，
 * 遇到一条坏数据时让整次执行崩掉，比丢一个字段严重得多。
 * 现在使用 schema 验证以提高类型安全性。
 */
function readNodeData(raw: string | null | undefined, type?: string): Record<string, unknown> {
  if (!raw) return {};
  if (type) {
    return parseNodeData(type, raw);
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** 从节点 params 里读资产引用（上传素材走这条路）。读不出来返回 null */
function assetRefInData(raw: string): string | null {
  const assetId = readNodeData(raw).assetId;
  return typeof assetId === "string" && assetId ? assetId : null;
}

/**
 * 默认执行超时（没显式传 timeoutMs 时用）。
 *
 * 原来所有能力统一 5 分钟。那是在演示模型时代定的：mock 出图几十毫秒，
 * 出视频也就编码几秒，5 分钟纯粹是个「肯定够用」的上限。
 *
 * 真视频模型把这个假设打破了 —— 它是**按秒生成**的：3 秒的片子一到两分钟，
 * 30 秒的片子五到十分钟。写死 5 分钟会出两个错，而且都很贵：
 *   1. 长视频还在跑就报「执行超时」，用户以为模型坏了
 *   2. 那条错误标了可重试 → Worker 再排一次 → **再扣一次额度**
 *     （30 秒视频重跑一次就是六倍价钱）
 *
 * 所以按能力分开：视频按时长放大，其余保持原样。
 * 数字是「上限」不是「预期」—— 正常片子远远用不到，它只在卡死时兜底。
 *
 * 注意它必须比 Provider 自己的等待上限更大：Provider 那边先超时会报
 * 「任务等待超时（任务号 xxx）」，能看出是上游没跑完；这里先超时的话
 * 报出来的是「已取消」/「执行超时」，丢掉了任务号，排查时少一条线索。
 */
function timeoutFor(step: PlanStep): number {
  if (step.capability === "video") {
    const secs = Number(step.params?.duration) || 5;
    return Math.max(10 * 60_000, secs * 45_000);
  }
  return 5 * 60_000;
}

/** 参数是否落在模型声明的合法区间里。返回错误信息，合法则返回 null */
function checkOptions(
  provider: { label: string; options: { aspectRatios?: string[]; durations?: number[] } },
  params: Record<string, unknown> | undefined
): string | null {
  const ratio = String(params?.aspectRatio ?? "");
  const ratios = provider.options.aspectRatios;
  if (ratio && ratios?.length && !ratios.includes(ratio)) {
    return `模型「${provider.label}」不支持比例 ${ratio}，可选：${ratios.join(" / ")}`;
  }

  const duration = Number(params?.duration);
  const durations = provider.options.durations;
  if (duration && durations?.length && !durations.includes(duration)) {
    return `模型「${provider.label}」不支持 ${duration} 秒，可选：${durations.join(" / ")} 秒`;
  }

  return null;
}

/** 超时时长说成人话。真实值都是分钟级，但测试里会传 200ms —— 那不该显示成「0 秒」 */
function formatTimeout(ms: number) {
  const secs = ms / 1000;
  return secs >= 1 ? `${Math.round(secs)} 秒` : `${ms} 毫秒`;
}

/**
 * 这次失败算不算「超时」。
 *
 * 判据是 `timer.aborted && !external.aborted` —— 看信号，**不去猜错误消息**。
 *
 * 原来靠 `/abort|timeout|cancel/` 匹配 message，看着能用，漏得很具体：
 * `sleepAbortable` 取消时抛的是中文「已取消」，一个关键词都不匹配。
 * 于是红线触发的超时被当成普通取消，用户在节点底部读到"已取消"，
 * 而他从没点过取消；更要紧的是它绕过了"超时不重试"那条判断。
 * 这类「文案一改就静默失效」的判断不该出现在钱的路径上。
 *
 * 两个信号的职责很清楚：timer 只在 executor 自己 `AbortSignal.timeout()`
 * 到点时 aborted，external 只在用户取消 / worker 退出时 aborted。
 */
function isTimeout(timer: AbortSignal, external: AbortSignal): boolean {
  return timer.aborted && !external.aborted;
}

/** 超长文本截断，用于日志。换行压成 ` / `，否则一行日志会变成一片空白墙 */
function truncate(s: string | undefined, max: number) {
  const flat = String(s ?? "").replace(/\s*\n+\s*/g, " / ").trim();
  if (!flat) return "（空）";
  return flat.length > max ? `${flat.slice(0, max)}…（共 ${flat.length} 字）` : flat;
}

/**
 * 把「本该发出去的请求」压成一行能看的文本。只在 dry run 时用。
 *
 * 两个处理是必需的：
 *  1. 去掉域名，只留路径 —— 排查时关心的是「打到哪个端点」，
 *     域名部分每次都一样，纯占地方。
 *  2. 截断超长字符串 —— base64 的 data URL 动辄几十万字符，
 *     原样打进事件表会把整张日志面板撑成一堵墙。但**长度必须留着**：
 *     「上游那张图到底塞进来了没有」唯一能看出来的地方就是这个字符数。
 */
function describeCall(call: unknown): string {
  const c = call as
    | { method?: string; url?: string; body?: unknown }
    | undefined;
  if (!c) return "（没有记录到请求）";
  const path = String(c.url ?? "").replace(/^https?:\/\/[^/]+/, "");
  return `${c.method ?? "POST"} ${path}\n请求体：${squashJson(c.body)}`;
}

function squashJson(value: unknown, max = 500): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_k, v) =>
      typeof v === "string" && v.length > 120
        ? `${v.slice(0, 48)}…（共 ${v.length} 字符）`
        : v
    );
  } catch {
    return "（无法序列化）";
  }
  if (text === undefined) return "（空）";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 统一收口失败：写状态、记错误、发事件。
 *
 * `cancelled` 单独处理：取消是用户主动的，不该被记成 error 吓人，
 * 也不该被当成失败去重试。
 */
async function fail(
  ctx: ExecuteContext,
  message: string,
  retryable: boolean,
  cancelled = false,
  retryAfterMs?: number
): Promise<ExecuteResult> {
  const { runId, jobId, step } = ctx;
  const status = cancelled ? NODE_STATUS.IDLE : NODE_STATUS.FAILED;

  // 用 updateMany 而不是 update：节点可能在执行过程中被用户删掉了，
  // update 会抛 "record not found"，把一次普通的失败变成崩溃。
  await db.node.updateMany({
    where: { id: step.nodeId },
    data: { status, error: cancelled ? null : message },
  });
  await db.job.update({
    where: { id: jobId },
    data: {
      status: cancelled ? JOB_STATUS.PENDING : JOB_STATUS.FAILED,
      lastError: message,
    },
  });
  await emit(runId, EVENT_TYPE.NODE_STATUS, {
    nodeId: step.nodeId,
    status,
    error: cancelled ? null : message,
  });
  await emitLog(runId, [
    {
      nodeId: step.nodeId,
      level: cancelled ? "info" : "error",
      message: cancelled ? "已取消" : `失败：${message}`,
    },
  ]);

  return {
    status: cancelled ? "cancelled" : "failed",
    error: message,
    retryable,
    retryAfterMs,
  };
}
