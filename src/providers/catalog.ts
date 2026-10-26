import type {
  ModelDescriptor,
  ModelOptions,
  ProviderCapability,
} from "@/providers/types";

/**
 * 模型清单 —— 「有哪些模型、各自支持什么」的唯一来源。
 *
 * ### 为什么它必须单独成一个模块
 *
 * 曾经把清单放在 registry.ts 里，结果 /api/models 这条路由顺着
 * registry → MockProvider → @ffmpeg-installer/ffmpeg 把 ffmpeg 也拖进了打包，
 * 而那个包用运行时的动态 require 去找平台二进制，打包器解析不了，
 * 整条路由直接 500。
 *
 * 教训：**接口要吐出去的数据，和实现这些数据的代码，不该在同一个 import 图上。**
 * 前端只需要「可 JSON 序列化的描述」，那就让描述自己待在一个没有任何
 * 重量级依赖的模块里。实现（以及它的 ffmpeg、SDK、API Key）留在外面。
 *
 * 真正实现模型的类从这里读描述来装配自己，所以两边不会走偏。
 */

/**
 * 百炼的图片模型按比例给出固定的像素尺寸。
 *
 * 为什么不直接传「16:9」：百炼的 size 参数只认 `宽*高`，
 * 而且输出总像素必须落在 512×512 ~ 2048×2048 之间。换算放在 Provider 里做，
 * 就意味着每个 Provider 各写一遍映射；声明在这里，加模型时不用碰代码。
 *
 * 取值都走 1K 档（总像素约 1.5M）而不是 2K：同一个模型 2K 的单价是 1K 的两倍，
 * 而画布上的预览卡片只有 400px 宽，2K 看不出来 —— 纯粹多花钱。
 */
const DASHSCOPE_SIZES: ModelOptions["resolutions"] = {
  "16:9": { width: 1664, height: 928 },
  "9:16": { width: 928, height: 1664 },
  "1:1": { width: 1328, height: 1328 },
  "4:3": { width: 1472, height: 1104 },
  "3:4": { width: 1104, height: 1472 },
};

const DASHSCOPE_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"];

export const MODEL_CATALOG: ModelDescriptor[] = [
  // ---- 阿里云百炼 · 文本模型（对话补全）----
  //
  // 四个模型走**同一套协议**（`/services/aigc/text-generation/generation`），
  // 所以共用 impl `dashscope.chat`，这里只是四条清单。
  // 这正是「Provider 粒度 = 模型而非供应商」的另一半用处：
  // 同一个 impl 能被多个模型复用，加模型真的只是加一条数据。
  //
  // 技能差异（选谁）：
  //   max   —— 改写质量最好，单价最高，适合正式出提示词
  //   flash —— 快且便宜，调参阶段来回试的默认选择
  //   kimi / deepseek —— 中文长句和"理解意图"强一些，风格与千问不同
  // 它们的提示词理解力不同，同一段 system 出来的结果也会不一样 ——
  // 这不是 bug，是用户该有的选择权。
  {
    id: "qwen3.8-max",
    label: "千问 3.8 Max",
    vendor: "阿里云百炼",
    requiresEnv: "DASHSCOPE_API_KEY",
    capabilities: ["text"],
    options: {},
    impl: "dashscope.chat",
  },
  {
    id: "qwen3.8-flash",
    label: "千问 3.8 Flash",
    vendor: "阿里云百炼",
    requiresEnv: "DASHSCOPE_API_KEY",
    capabilities: ["text"],
    options: {},
    impl: "dashscope.chat",
  },
  {
    id: "kimi-k3",
    label: "Kimi K3",
    vendor: "阿里云百炼",
    requiresEnv: "DASHSCOPE_API_KEY",
    capabilities: ["text"],
    options: {},
    impl: "dashscope.chat",
  },
  {
    id: "deepseek-v4.1-flash-1017",
    label: "DeepSeek V4.1 Flash",
    vendor: "阿里云百炼",
    requiresEnv: "DASHSCOPE_API_KEY",
    capabilities: ["text"],
    options: {},
    impl: "dashscope.chat",
  },

  // ---- 阿里云百炼 · 千问图像（同步接口）----
  //
  // 顺序即默认：同一能力下排第一的会被 `selectProvider` 选为默认模型
  // （`listProviders(cap)[0]`），前端 `effectiveModel` 也取 list[0]，
  // 两边一致。所以真模型必须排在 Mock 前面 —— 配了 key 就该用它。
  {
    id: "qwen-image-3.0-pro",
    label: "千问图像 3.0 Pro",
    vendor: "阿里云百炼",
    requiresEnv: "DASHSCOPE_API_KEY",
    capabilities: ["image"],
    // 限流 5 次/分钟，是这个模型唯一的脾气。并发超过它就是一串 429 ——
    // Worker 的 MAX_CONCURRENCY 是 3，刚好压得住。
    options: { aspectRatios: DASHSCOPE_RATIOS, resolutions: DASHSCOPE_SIZES },
    impl: "dashscope.qwen-image",
  },
  {
    id: "qwen-image-3.0",
    label: "千问图像 3.0",
    vendor: "阿里云百炼",
    requiresEnv: "DASHSCOPE_API_KEY",
    capabilities: ["image"],
    // 限流 20 次/分钟、单价约 Pro 的 3/4。日常调参用它，出片再用 Pro
    options: { aspectRatios: DASHSCOPE_RATIOS, resolutions: DASHSCOPE_SIZES },
    impl: "dashscope.qwen-image",
  },
  {
    id: "qwen-image-2.1-pro",
    label: "千问图像 2.1 Pro",
    vendor: "阿里云百炼",
    requiresEnv: "DASHSCOPE_API_KEY",
    capabilities: ["image"],
    options: { aspectRatios: DASHSCOPE_RATIOS, resolutions: DASHSCOPE_SIZES },
    impl: "dashscope.qwen-image",
  },
  {
    id: "qwen-image-2.1-turbo",
    label: "千问图像 2.1 Turbo",
    vendor: "阿里云百炼",
    requiresEnv: "DASHSCOPE_API_KEY",
    capabilities: ["image"],
    options: { aspectRatios: DASHSCOPE_RATIOS, resolutions: DASHSCOPE_SIZES },
    impl: "dashscope.qwen-image",
  },
  {
    id: "qwen-mt-image-2.0",
    label: "千问 MT 图像 2.0",
    vendor: "阿里云百炼",
    requiresEnv: "DASHSCOPE_API_KEY",
    capabilities: ["image"],
    /*
     * 这一条和上面四个共用 `dashscope.qwen-image`，但**没有验证过协议相同**。
     *
     * MT 是另一条产品线的代号，如果它的端点或参数名不一样，
     * 症状会是 400/404 而不是静默出错（好事）。真跑不通时改这一行的 impl，
     * 在 registry 里加一个新分支即可 —— 其余五个模型不受影响。
     * 这也说明为什么 impl 是**每条**清单自己声明的。
     */
    options: { aspectRatios: DASHSCOPE_RATIOS, resolutions: DASHSCOPE_SIZES },
    impl: "dashscope.qwen-image",
  },

  /*
   * 万相 2.5 文生图（`wan2.5-t2i-preview`）曾在这里，2026-10-25 按人要求撤掉 ——
   * 保留清单只放他指定的这几个模型。
   *
   * `providers/dashscope/wanImage.ts` 和 registry 里那个分支**没有删**：
   * 它实现的是「异步任务 + 轮询」那套协议，和千问的同步接口完全不是一回事。
   * 真正接视频模型时它是起点（wanVideo 就是照它的时序写的）。
   */

  // ---- 阿里云百炼 · 万相视频（异步任务）----
  //
  // 这是第一个**真**视频模型。它一上线，视频节点就从「做不成事的节点」
  // 变回正常节点 —— 之前那段「视频模型还没接入 + 生成按钮变灰」的降级
  // 呈现会自动让位（判据是「这个能力有没有可用模型」，不是写死的）。
  {
    id: "wan3.0-video",
    label: "万相 3.0 视频",
    vendor: "阿里云百炼",
    requiresEnv: "DASHSCOPE_API_KEY",
    capabilities: ["video"],
    /*
     * 时长给到 30 秒是因为这个模型真的支持 2~30（wan2.7 只到 15）。
     * 但**按秒计费**，30 秒一条片子的花费是 5 秒的六倍 —— 选项摆在这里，
     * 花多少由用户自己决定，不在代码里替他砍掉。
     *
     * 比例只列三个具体的，不放模型的 `adaptive`（跟随首帧）：
     * 那不是一个用户会主动选的"比例"，而是图生视频时的推荐行为，
     * 已经由 Provider 在接了首帧时自动采用（见 wanVideo.ts 文件头）。
     * 把它做成下拉项，用户会看到「16:9 / 9:16 / 1:1 / adaptive」而不知道最后一项是什么。
     */
    options: {
      aspectRatios: ["16:9", "9:16", "1:1"],
      durations: [2, 3, 5, 10, 30],
    },
    impl: "dashscope.wan-video",
  },

  // ---- 内置演示模型（默认不可见）----
  //
  // 2026-10-25 人拍板：「模型只保留我告诉你的这几个，演示什么的都去掉」。
  //
  // 所以它们现在**默认不出现在任何清单里** —— 界面上看不到、选不到，
  // 和删掉没有区别。判据在 `isUsable` 里：只有 `MODEL_PROVIDER=mock` 时才会启用。
  //
  // 为什么没有把这些条目和 MockProvider 一起删掉：
  // 它们是 E2E 的基座。200+ 条断言（落盘 → Asset → 卡片预览 → 刷新不丢 →
  // 连线端点跟随）全靠它产出**真 PNG / 真 MP4**，走的是和真模型完全一样的
  // 代码路径。换成真模型跑测试有三个问题：花钱、结果不可重复
  // （模型每次都出新图）、还可能被内容审核拦。
  //
  // 要用它们：给 dev 和 worker 都设 MODEL_PROVIDER=mock 再启动。
  // 那时真模型会反过来被屏蔽（同一套规则，见 isUsable）—— 这是有意的：
  // 两个世界不混着用，免得「明明设了 mock 怎么还在花钱」。
  {
    id: "mock.text.v1",
    label: "演示文本",
    vendor: "内置",
    capabilities: ["text"],
    options: {},
    demo: true,
    impl: "mock",
  },
  {
    id: "mock.image.v1",
    label: "演示图像",
    vendor: "内置",
    capabilities: ["image"],
    options: { aspectRatios: DASHSCOPE_RATIOS },
    demo: true,
    impl: "mock",
  },
  {
    id: "mock.image.fast",
    label: "演示图像·极速",
    vendor: "内置",
    capabilities: ["image"],
    // 故意只支持两种比例：把「比例选项必须跟随模型」变成可验证的
    options: { aspectRatios: ["16:9", "1:1"] },
    demo: true,
    impl: "mock",
  },
  {
    id: "mock.video.v1",
    label: "演示视频",
    vendor: "内置",
    capabilities: ["video"],
    options: {
      aspectRatios: ["16:9", "9:16", "1:1"],
      durations: [2, 3, 5],
    },
    demo: true,
    impl: "mock",
  },
];

export function getModelDescriptor(id: string): ModelDescriptor | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function listModelsByCapability(
  capability?: ProviderCapability
): ModelDescriptor[] {
  return capability
    ? MODEL_CATALOG.filter((m) => m.capabilities.includes(capability))
    : [...MODEL_CATALOG];
}

/**
 * 真正可用的模型 = 有实现 + 依赖的环境变量配齐了 + 没被强制降级。
 *
 * 这道过滤是整个「模型管理」的核心：
 * `/api/models` 只吐这里的结果，于是**没配 key 的供应商在界面上根本不存在**。
 * 不是「能选但点了报错」，是选不到 —— 用户不会看到一堆自己用不了的东西。
 *
 * ### 这里的规则必须和 registry 的注册规则逐条相同
 *
 * 曾经漏了 MODEL_PROVIDER 这一条，症状很隐蔽：设了 MODEL_PROVIDER=mock 之后，
 * 注册表确实只装配了演示模型，但清单照旧把三个千问列出来 ——
 * 界面上能选，选了点运行，报「未注册的 Provider」。
 * 两个地方各写一遍过滤条件就一定会走偏，所以判定集中在这个函数里，
 * registry 那边也复用同一个条件（见 `isUsable`）。
 *
 * env 作为参数传进来而不是直接读 process.env：这样能单测，
 * 也能让 Worker / Route Handler 各自传入自己的环境。
 */
export function availableModels(
  capability?: ProviderCapability,
  env: Record<string, string | undefined> = process.env
): ModelDescriptor[] {
  return listModelsByCapability(capability).filter((m) => isUsable(m, env));
}

/**
 * 单个模型在当前环境下能不能用。registry 也调它，保证两边同一套规则。
 *
 * ### `MODEL_PROVIDER` 现在是一个「世界切换开关」
 *
 * 语义：`MODEL_PROVIDER=mock` 表示「这一轮只用演示模型」。
 *
 * 2026-10-25 之前它只是单向的 —— 设了 mock 就屏蔽真模型，
 * 但演示模型无论设不设都在清单里。现在两个方向都管：
 *
 * ```
 * 不设（默认）  → 只有真模型。演示模型完全不可见（人要求「都去掉」）
 * =mock         → 只有演示模型。真模型反过来被屏蔽（不误花钱）
 * ```
 *
 * 为什么做成交互而不是再加一个环境变量：两个变量就有四种组合，
 * 其中两种（都开 / 都关）含义暧昧。一个开关两个世界，没有中间态。
 */
export function isUsable(
  m: ModelDescriptor,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (!m.impl) return false;
  // 演示模型只在 mock 世界里存在
  if (m.demo && env.MODEL_PROVIDER !== "mock") return false;
  // 真模型在 mock 世界里不出现
  if (!m.demo && env.MODEL_PROVIDER === "mock") return false;
  if (m.requiresEnv && !env[m.requiresEnv]) return false;
  return true;
}
