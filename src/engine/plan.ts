import { db } from "@/lib/db";
import { topoSortBatches, buildAdjacency, type GraphEdge } from "@/engine/cycleDetect";
import { nodeRegistry } from "@/canvas/nodeRegistry";
import { mainText } from "@/canvas/promptText";
import { parseNodeData } from "@/canvas/schemas/nodeData";

// 执行计划：把「画布上的一张图」翻译成「一批可以按顺序执行的步骤」。
//
// 计划是**静态**的（提交运行那一刻算一次），执行时的输入是**动态**的
// （上游产物要等上游跑完才存在）。这个分离很重要：
//   静态部分现在就能算，出错可以在提交时直接拒绝；
//   动态部分只能在 Worker 跑到那一批时才知道。

export interface PlanStep {
  nodeId: string;
  batch: number;
  /** null = 纯输入节点，不调模型 */
  capability: "text" | "image" | "video" | null;
  /**
   * 这一步要执行的节点动作（润色 / 拆分镜）。null = 常规生成。
   * 有值时 capability 来自动作定义，而不是节点类型的默认能力。
   */
  action?: string;
  /**
   * 这一步要送给文本模型的系统指令，来自动作定义（NodeAction.systemPrompt）。
   *
   * 为什么由 plan 带下来、而不是在执行时再查一次注册表：
   * plan 是不可变快照，Worker 在另一个进程里重算它。执行阶段能少一次
   * 「按 node.type 查注册表」就少一次对注册表现状的依赖 ——
   * 用户在执行中途升级了节点定义，也不会让同一批任务前后行为不一致。
   */
  systemPrompt?: string;
  /** 直接上游的文字 + 自己的提示词（顺序见 composePrompt） */
  prompt: string;
  negativePrompt?: string;
  /** 节点参数整体传递给 Provider，由它挑自己认识的键 */
  params: Record<string, unknown>;
  /** 用户指定的模型 id，没有就由 registry 按能力选默认 */
  modelId?: string;
  /** 直接上游，执行时从这里取产物 */
  upstreamIds: string[];
  /**
   * 具名输入：端口名 → 该端口上的上游节点 id 列表。
   * 默认端口用空字符串作键（老数据、单输入节点都落在这里）。
   *
   * **为什么值是数组而不是单个 id**：
   * 画布上早就允许「一个端口接多条线」（多对一），
   * 但这里是 Record<string, string> 时，同一个端口只能存下一个上游 ——
   * 于是用户连了三段文字、界面上三条线都在，执行时只有第一条生效，
   * 而且没有任何提示。这是「连线放开了、数据没放开」的典型裂缝。
   */
  inputs: Record<string, string[]>;
}

/**
 * 用户能发起的两种执行语义。
 *
 * 曾经有第三种 "all"（跑遍全图），2026-10-25 按人的要求连同右上角按钮一起删掉了：
 * 「全部运行」和这个产品的形态是冲突的 —— 创作台的价值在单个产物，
 * 一键跑全图意味着用户要等着一堆他不关心的节点跑完。
 *
 * 注意 `PlanOptions.mode` 仍然可以**不传**，那不是第三种模式，
 * 而是 Worker 重算计划时用的「全图范围」，见 selectRunScope 里的说明。
 */
export type RunMode = "node" | "branch";

export interface PlanOptions {
  mode?: RunMode;
  /** node / branch 模式下必填：点的是哪个节点 */
  targetId?: string;
  /**
   * 对目标节点发起一个临时动作（如 optimize）。
   *
   * 它只在这一次执行里生效，不写进节点参数 —— 否则下次常规运行时
   * 还会带着这个动作，用户会莫名其妙每次都被改写一遍。
   */
  action?: string;
}

export interface RunPlan {
  /**
   * 每个元素是一个批次，同批次内互不依赖，可以并行。
   *
   * **注意这是全图的批次，不是本次要跑的批次。**
   * Worker 需要全图的 step 元数据（提示词、上游、能力），
   * 而且它会用「job 的 batch 号」去捞任务 —— 只要批次编号与全图一致，
   * 没有 job 的批次自然会捞到空，不需要在 Worker 里做任何特判。
   */
  batches: string[][];
  steps: Map<string, PlanStep>;
  /** 全图节点（没有注册类型的节点会被忽略） */
  nodeIds: string[];
  /** 本次真正要建 Job 的节点。node/branch 模式下是 nodeIds 的子集 */
  runIds: string[];
  /**
   * 直接复用已有产物、不重跑的节点。
   * 它们不建 Job，执行时由下游从数据库读 outputAssetId。
   */
  reusedIds: string[];
  /**
   * 正向邻接表。
   *
   * 只有一个用处：**跳过下游**。某个节点失败后，它的下游拿不到输入，
   * 硬跑一定是更奇怪的错误。必须明确标成"跳过"，否则用户看到的是
   * 一堆莫名失败的下游，而真正的元凶藏在中间某一层。
   */
  downstream: Map<string, string[]>;
}

export async function buildPlan(
  projectId: string,
  opts: PlanOptions = {}
): Promise<RunPlan> {
  const [nodes, edges] = await Promise.all([
    /*
     * 显式排序：提示词拼接要按「上游在图里的先后」来，而这个先后
     * 不能靠数据库的返回顺序碰运气 —— SQLite 通常按 rowid 给，
     * 但那是实现细节、不是保证。同一个图跑两次必须得到逐字节相同的
     * 提示词，否则失败后无法复现。
     */
    db.node.findMany({
      where: { projectId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.edge.findMany({
      where: { projectId },
      // Edge 没有 createdAt 列。cuid 的前缀是按时间递增的，
      // 所以按 id 字典序排就等价于「按创建先后」——
      // 前端每条边的 id 也是 cuid 风格（e_xxx 或 cuid），同样成立。
      orderBy: { id: "asc" },
    }),
  ]);

  const byId = new Map(nodes.map((n) => [n.id, { ...n, data: JSON.stringify(parseNodeData(n.type, n.data)) }]));
  // 带上 targetHandle：端口信息是「这条线接的是首帧还是尾帧」的唯一来源
  const graphEdges: (GraphEdge & { targetHandle?: string | null })[] = edges.filter(
    (e) => byId.has(e.source) && byId.has(e.target)
  );

  // 只保留注册过的节点类型。画布上可能残留旧类型的节点，
  // 让它们参与运行只会产生一堆"未知类型"的失败。
  const known = nodes.filter((n) => nodeRegistry[n.type]);
  const knownIds = known.map((n) => n.id);

  const batches = topoSortBatches(knownIds, graphEdges);

  // 排序后节点数对不上 ⇒ 图里有环。正常情况下连线时就被拦了，
  // 但数据库是可以直接被改的（迁移、手工修复），这里必须兜住，
  // 否则 Worker 会静默少跑几个节点，用户根本不知道少了。
  const planned = new Set(batches.flat());
  if (planned.size !== knownIds.length) {
    const stuck = knownIds.filter((id) => !planned.has(id));
    throw new Error(
      `画布里存在循环依赖，无法运行（涉及 ${stuck.length} 个节点：${stuck.slice(0, 3).join(", ")}）`
    );
  }

  const adjacency = buildAdjacency(graphEdges);
  const reverse = new Map<string, string[]>();
  for (const e of graphEdges) {
    const list = reverse.get(e.target);
    if (list) list.push(e.source);
    else reverse.set(e.target, [e.source]);
  }

  const batchOf = new Map<string, number>();
  batches.forEach((ids, i) => ids.forEach((id) => batchOf.set(id, i)));

  // 端口 → 上游节点。按端口声明顺序排，Provider 拿输入时顺序才是确定的
  // （图生视频的「首帧」必须排在第一张图，不能靠边的插入顺序碰运气）。
  const portInputs = collectPortInputs(graphEdges, byId);

  const steps = new Map<string, PlanStep>();

  for (const node of known) {
    const def = nodeRegistry[node.type];
    const data = parseData(node.data);

    // 动作只作用于目标节点，且只在这这一次执行里生效。
    // 动作自己声明要调哪种能力 —— 所以 text.prompt 平时 capability 是 null，
    // 执行「润色」时临时变成 text。这不违反「能力是节点类型的属性」：
    // 能力映射仍然全部来自注册表，引擎依然不认识任何具体类型。
    let capability = def.capability;
    let action: string | undefined;
    let systemPrompt: string | undefined;

    if (opts.action && node.id === opts.targetId) {
      const actionDef = def.actions?.find((a) => a.id === opts.action);
      if (!actionDef) {
        throw new Error(
          `节点「${data.label || node.id}」不支持动作：${opts.action}`
        );
      }
      capability = actionDef.capability;
      action = actionDef.id;
      // 动作自带指令，plan 原样带下去。没有 systemPrompt 的动作照常跑
      // （Mock 不读它，真模型则退化成「普通对话」—— 见 nodeRegistry 里
      // storyboard 那个 ⚠️ 注释，那是已知的、尚未决定格式的地方）。
      systemPrompt = actionDef.systemPrompt;
    }

    const inputMap = portInputs.get(node.id) ?? {};

    // 生成方式：auto 时由「有没有接首帧图」推出来。
    // 显式选了某种模式却缺对应输入端口的，直接拒 —— 不能等到模型返回空视频
    // 才让用户去猜哪里错了。
    const params: Record<string, unknown> = { ...data };
    if (def.modeRule) {
      const rule = def.modeRule;
      const current = String(params[rule.param] ?? rule.auto);
      const atPort = inputMap[rule.port] ?? [];

      /**
       * 「接上了」不只看有没有线，还要看接进来的是不是它要的那种东西。
       *
       * 判的是**产物种类**，不是节点类型。
       * 视频节点只有一个输入端口，接进来的可能是图片、视频或一段文字；
       * 光判断「有连线」的话，「剧本 → 视频」会被推成图生视频，
       * 而模型拿不到图 —— 生成出来的东西和用户预期毫无关系，
       * 且报错发生在几十秒之后，非常难归因。
       *
       * 早先这里比对的是节点 type（只认 image.gen），但用户上传的图片
       * 是 media.asset 类型 —— 明明接了图却被判成文生视频。
       * 种类这件事只有节点自己知道，所以问注册表的 producedKind。
       */
      const kinds = atPort.map((id) => {
        const up = byId.get(id);
        if (!up) return null;
        return nodeRegistry[up.type]?.producedKind?.(parseData(up.data)) ?? null;
      });

      const matched = rule.sourceKind
        ? kinds.includes(rule.sourceKind)
        : atPort.length > 0;

      const effective =
        current === rule.auto
          ? matched
            ? rule.whenPresent
            : rule.whenAbsent
          : current;

      // 显式选了某种模式却缺对应输入，直接拒 —— 不能等到模型返回空视频
      // 才让用户去猜哪里错了。
      if (effective === rule.whenPresent && !matched) {
        throw new Error(
          `节点「${data.label || node.id}」的生成方式是「${effective}」，但上游没有接${
            rule.sourceKind ? PRODUCED_KIND_LABEL[rule.sourceKind] : "对应输入"
          }`
        );
      }
      params[rule.param] = effective;
    }

    steps.set(node.id, {
      nodeId: node.id,
      batch: batchOf.get(node.id) ?? 0,
      capability,
      action,
      systemPrompt,
      /*
       * 送进模型的文字。两种执行语义取不同的字段，**这不是细节，是语义**：
       *
       *   优化动作（action 有值）→ 取 `data.prompt`，也就是用户的**原始描述**。
       *     优化器要改的是「人写的那句话」。拿优化结果再去优化，等于把
       *     上一版改写二次改写，越改越偏离原意，而且用户完全看不出发生了什么。
       *
       *   常规生成 / 下游拼词 → 取 `mainText(data)`，即优化结果优先、没有则原文。
       *     这才是主内容（见 canvas/promptText.ts）。
       */
      prompt: composePrompt(
        action ? String(data.prompt ?? "") : mainText(data),
        inputMap,
        byId
      ),
      /*
       * 不传 negativePrompt 是有意的，不是漏了。
       *
       * 2026-10-24 面板改成单一输入框后，负面提示词失去了 UI 入口。
       * 没有入口的字段如果还在传，症状是「结果里总有些东西说不清哪来的」——
       * 用户改什么都不会影响它，也看不到它。所以这里一起断开。
       * 存量节点 data 里的 negativePrompt 仍留在库里（不删数据），只是不再生效。
       *
       * 恢复方式见 canvas/params.ts 里同一段说明。
       */
      params,
      modelId: data.modelId,
      upstreamIds: reverse.get(node.id) ?? [],
      inputs: inputMap,
    });
  }

  const { runIds, reusedIds } = selectRunScope(known, reverse, opts);

  return {
    batches,
    steps,
    nodeIds: knownIds,
    runIds,
    reusedIds,
    downstream: adjacency,
  };
}

/**
 * 算出「本次要跑哪些节点」。
 *
 * - all    ：全图
 * - branch ：目标 + 全部上游（"运行到此处"，无条件重跑这一支）
 * - node   ：目标 + **缺产物的**上游（"只跑这一个"）
 *
 * ### 为什么 node 模式要自动补齐上游，而不是直接报错
 *
 * 如果上游还没跑过，单节点运行必然拿不到输入，只能失败。
 * 报错「请先运行上游」听起来严谨，实际是把调度问题推给用户。
 * 自动补齐则永远能跑出结果，而且跑完的状态和 branch 模式完全一样 ——
 * 两者的差别只在「上游已经有产物时要不要重跑」。
 *
 * ### 复用的判定条件
 *
 * 必须是「成功过 **且** 有产物」。只看 status 不够：节点可能先成功、
 * 后来重跑失败，status 变成 failed 但旧产物还在。那种情况下复用它，
 * 用户会看到一个失败的节点却在给下游供料，非常费解。
 */
function selectRunScope(
  nodes: {
    id: string;
    type: string;
    status: string;
    outputAssetId: string | null;
  }[],
  reverse: Map<string, string[]>,
  opts: PlanOptions
): { runIds: string[]; reusedIds: string[] } {
  const mode = opts.mode;

  /*
   * 没有 mode = 算全图。
   *
   * 这**不是**一种用户模式（「运行全部」已经删了，前端不会再这样调）。
   * 现在只有 Worker 走这条路：它在独立进程里，拿不到 API 那次调用的上下文，
   * 必须用全图拓扑重算一遍 batches，然后只执行 Job 表里仍为 pending 的那几条。
   * 所以这是「计划范围的缺省值」，别当成用户能选的东西 —— 缺了它，
   * 队列会因为「缺少目标节点」整条卡住，而界面上只会显示排队中。
   */
  if (!mode) {
    return { runIds: nodes.map((n) => n.id), reusedIds: [] };
  }

  const targetId = opts.targetId;
  if (!targetId) {
    throw new Error("缺少目标节点：单节点运行必须指定 targetId");
  }
  const target = nodes.find((n) => n.id === targetId);
  if (!target) {
    throw new Error("目标节点不存在，或它的类型没有注册");
  }

  // 祖先闭包（含目标自己）。用 Set 兜住菱形依赖，否则会重复入栈
  const scope = new Set<string>([targetId]);
  const stack = [...(reverse.get(targetId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (scope.has(id)) continue;
    scope.add(id);
    stack.push(...(reverse.get(id) ?? []));
  }

  // 按全图节点顺序输出，保证同一个图跑两次得到完全一样的 Job 集合
  const ordered = nodes.filter((n) => scope.has(n.id));

  if (mode === "branch") {
    return { runIds: ordered.map((n) => n.id), reusedIds: [] };
  }

  const runIds: string[] = [];
  const reusedIds: string[] = [];
  for (const n of ordered) {
    // 纯输入节点（capability 为 null）永远可以复用，**不能**要求它有产物 ——
    // 它本来就不产出资产，内容在算计划的这一刻就已经拼进下游提示词了。
    // 按「有没有 outputAssetId」判它，会导致每次单节点运行都把上游的
    // 文本节点白跑一遍：不花钱，但画布上会闪一串 queued → succeeded，
    // 用户会以为「我只点了一个节点，怎么三个都在动」。
    const pureInput = nodeRegistry[n.type]?.capability === null;

    const reusable =
      n.id !== targetId &&
      (pureInput || (n.status === "succeeded" && Boolean(n.outputAssetId)));

    if (reusable) reusedIds.push(n.id);
    else runIds.push(n.id);
  }
  return { runIds, reusedIds };
}

/**
 * 把边归到各自的输入端口上。
 *
 * 结果形如 { "image": ["n_a"], "endImage": ["n_b"] }，
 * 单输入节点是 { "": ["n_a", "n_b"] }（多对一时一个端口可以挂多个上游）。
 *
 * 老数据的边没有 targetHandle（加端口之前存的），统一归到目标节点声明的
 * 第一个端口上 —— 那是它的主输入，语义上等于「以前那条默认连线」。
 */
function collectPortInputs(
  edges: (GraphEdge & { targetHandle?: string | null })[],
  byId: Map<string, { id: string; type: string }>
): Map<string, Record<string, string[]>> {
  const out = new Map<string, Record<string, string[]>>();

  for (const e of edges) {
    const targetNode = byId.get(e.target);
    if (!targetNode) continue;

    const ports = nodeRegistry[targetNode.type]?.inputs ?? [];
    const port = ports.length > 0 ? e.targetHandle || ports[0].key : "";

    const bucket = out.get(e.target) ?? {};
    /*
     * 同一个端口可以挂多个上游 —— 这正是画布上「多对一」的语义：
     * 几段文字一起喂给一个生成节点，或者一张图既当首帧又当参考。
     *
     * 早先这里是 `if (!(port in bucket))`，也就是只保留先到的那一条。
     * 界面上三条线都在、执行时只有一条生效，而且完全没有提示 ——
     * 用户会以为另外两段文字没用（事实上确实没用，但他不知道）。
     */
    (bucket[port] ??= []).push(e.source);
    out.set(e.target, bucket);
  }

  // 按端口声明顺序重排。Provider 拿到的输入顺序必须稳定：
  // 图生视频的「首帧」得排在第一张，不能靠边的插入顺序碰运气。
  //
  // 端口内部也要排：同一个端口接了多条线时，谁在前面取决于边的遍历顺序，
  // 而边的 id 是 React Flow 生成的字符串（xy-edge__...），排序毫无意义。
  // 按「上游节点在库里的先后」排 —— byId 的 key 顺序来自上面按 createdAt
  // 排序的查询，所以它就是节点的创建顺序，稳定且符合直觉。
  const nodeOrder = new Map<string, number>();
  let n = 0;
  for (const id of byId.keys()) nodeOrder.set(id, n++);

  for (const [nodeId, bucket] of out) {
    const ports = nodeRegistry[byId.get(nodeId)?.type ?? ""]?.inputs ?? [];
    const ordered: Record<string, string[]> = {};
    for (const p of ports) {
      if (bucket[p.key]) ordered[p.key] = sortByNodeOrder(bucket[p.key], nodeOrder);
    }
    if (bucket[""]) ordered[""] = sortByNodeOrder(bucket[""], nodeOrder);
    out.set(nodeId, ordered);
  }

  return out;
}

function sortByNodeOrder(ids: string[], order: Map<string, number>) {
  return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** ProducedKind 的中文名。只用于错误提示，不参与任何判断 */
const PRODUCED_KIND_LABEL: Record<string, string> = {
  image: "图片",
  video: "视频",
  text: "文本",
};

/**
 * 组装提示词：**直接上游**的文字 + 自己的。
 *
 * ### 为什么只取直接上游，不递归祖先
 *
 * 早先这里是递归收集「所有祖先」的提示词，理由是「剧本节点 → 分镜节点」
 * 这条链上，分镜节点往往只写"镜头缓慢推进"，主体和风格都在上游剧本里。
 *
 * 但那个理由在**一对多 / 多对一**放开之后就不成立了，反倒是它的三个问题
 * 变得很刺眼：
 *   1. 菱形依赖（A→B、A→C、B&C→D）下 D 会收到两份 A，得靠去重兜；
 *   2. 一条长链的末端节点会收到前面所有人的文字拼成的一大坨，
 *      模型被塞进互相矛盾的描述（"白天"和"雨夜"同时出现）；
 *   3. 用户看不出这段话是哪来的 —— 界面上只有一条线，
 *      实际却拼了五个节点的内容。
 *
 * 现在语义很直接：**这条线连进来的，才会出现在我的提示词里**。
 * 想让它进，就连一条线（多对一已经允许了）。依赖全部在图里，
 * 改哪个上游一目了然 —— 这也符合「输入关系必须在图里」那条原则。
 *
 * ### 顺序
 *
 * 按上游节点在库里的先后（createdAt, id）排，自己的放最后。
 * 不按边的插入顺序：那样同一个图重连一次线，送给模型的字符串就变了，
 * 失败后无法复现。
 */
function composePrompt(
  ownPrompt: string | undefined,
  inputMap: Record<string, string[]>,
  byId: Map<string, { id: string; data: string }>
): string {
  /*
   * 只看**默认端口**。具名端口（将来的首帧 / 尾帧）是「数据输入」：
   * 那张图是拿去当参考图的，它的提示词不该混进我的文字描述里。
   */
  const upstream = [...(inputMap[""] ?? [])];

  const order = new Map<string, number>();
  let i = 0;
  for (const id of byId.keys()) order.set(id, i++);
  upstream.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const parts = upstream
    .map((id) => {
      const raw = byId.get(id)?.data;
      /*
       * 取上游的**主文本**，不是它的 `prompt` 字段。
       *
       * 文本节点有两段字：原始描述（prompt）和 AI 优化结果（optimizedPrompt）。
       * 下游该拿到的是优化过的那份 —— 那才是「给模型看的」。
       * 这里直接读 `.prompt` 的话，用户明明点了优化、卡片上也显示了新词，
       * 下游生成的画面却还是按原话来的，而且没有任何提示。
       */
      return raw ? mainText(parseData(raw)).trim() : "";
    })
    .filter(Boolean);

  const own = String(ownPrompt ?? "").trim();
  if (own) parts.push(own);

  return parts.join("\n");
}

function parseData(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
