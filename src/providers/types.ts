// Provider 抽象层 —— 整个项目最重要的一条边界。
//
// 核心约束：**业务代码永远不 import 任何具体模型的 SDK 或 URL**。
// 节点、执行引擎、Worker 只认下面这几个接口。
//
// 为什么必须这样：LibTV 这类产品的卖点就是「聚合 30+ 模型」。如果代码里
// 到处是 fetch("https://某家/api")，换模型就要改所有调用点，而且每家的
// 参数名、轮询方式、返回结构都不一样。抽象出接口后：
//   换模型 = 加一个实现类 + 注册一行
//   业务代码零改动
//
// 同时 Mock 实现让你在没有任何 API Key 的情况下跑通整条链路 ——
// 这不是"先凑合"，而是同一条流水线上的一个真实实现。

/** 一家模型能干什么。UI 靠它决定「这个节点能选哪些模型」，而不是硬编码判断。 */
export type ProviderCapability = "text" | "image" | "video";

/** 上游产物作为输入。注意给的是本地路径，Provider 只读不写。 */
export interface ProviderInput {
  kind: ProviderCapability;
  mimeType: string;
  /** 本地绝对路径 */
  filePath: string;
  /**
   * 这条输入接在哪个端口上：image（首帧）/ endImage（尾帧）/ in（默认）。
   *
   * 为什么 Provider 需要知道角色：
   * 图生视频时「首帧」和「尾帧」是两种完全不同的语义 —— 首帧决定起点构图，
   * 尾帧决定终点。模型 API 里它们通常是不同的字段名。
   * 只说"这里有张图"的话，接真模型时就得靠数组下标猜，迟早猜错。
   */
  role?: string;
}

/**
 * 一个模型支持哪些参数取值。
 *
 * 为什么要由 Provider 声明、而不是前端写死一份：
 * 可灵支持 16:9 / 9:16 / 1:1，另一家可能只支持 16:9。前端写死的后果是
 * 用户选中一个不支持的组合，点运行，等一分钟后收到一个 400。
 * 声明出来后，下拉框只会出现合法值 —— 从源头消除这类错误。
 */
export interface ModelOptions {
  /** 画面比例，如 ["16:9", "9:16", "1:1"] */
  aspectRatios?: string[];
  /** 支持的时长（秒） */
  durations?: number[];
  /** 比例 → 输出像素。缺省时由 Provider 自己按比例推 */
  resolutions?: Record<string, { width: number; height: number }>;
}

/**
 * 用哪种代码跑这个模型。
 *
 * 为什么把它放进描述里，而不是让 registry 维护一张「模型 id → 工厂」的映射表：
 * 那样就有了两个必须同步的地方 —— 加一个模型要同时改 catalog 和 registry，
 * 漏改一处的表现是模型出现在下拉框里、点运行报「未注册」，几十秒后才发现。
 * 声明在这里，registry 只按它分派，加模型仍然只改一个文件。
 */
export type ModelImpl =
  | "mock"
  | "dashscope.chat"
  | "dashscope.qwen-image"
  | "dashscope.wan-image"
  | "dashscope.wan-video";

/** 给前端用的模型描述。只包含能被 JSON 序列化的东西，不含 generate 方法 */
export interface ModelDescriptor {
  id: string;
  label: string;
  capabilities: ProviderCapability[];
  options: ModelOptions;
  /** 归属的供应商，下拉框按它分组。用户看到的是「阿里云百炼」而不是一串模型代号 */
  vendor?: string;
  /**
   * 需要哪个环境变量才算「配置好了」。
   *
   * 没配的模型直接从清单里消失，而不是留在下拉框里等人点了才失败 ——
   * 「能选但不灵」比「不能选」更让人困惑，而且失败发生在几十秒之后。
   */
  requiresEnv?: string;
  /**
   * 演示模型：产出的是占位内容，不是真模型的输出。
   *
   * 必须显式标出来。Mock 视频在界面上和真视频长得一模一样，
   * 不标的话用户会以为自己做的片子真的出来了。
   */
  demo?: boolean;
  /** 用哪套代码跑它。缺省视为没有实现，不进清单 */
  impl?: ModelImpl;
}

export interface GenerationRequest {
  prompt: string;
  /**
   * 系统指令，只有文本类模型会用到。
   *
   * 为什么单独一个字段而不是拼进 prompt：
   * 拼进去以后模型分不清「这是对我下的命令」和「这是我要处理的内容」——
   * 用户真写了一句「你是一个诗人」时，行为会变得不可预测。
   * chat 类协议本来就分 role，没有理由把它压平成一段文字。
   *
   * 内容由**节点的动作**声明（NodeAction.systemPrompt），不是 Provider 写死：
   * 「优化成文生图提示词」是这个产品的业务语义，不是模型的能力。
   * 换一个上游模型不该改变这段指令，换一个产品才该。
   */
  system?: string;
  negativePrompt?: string;
  /** 上游节点的产物。图生视频、首帧参考都从这里来 */
  inputs?: ProviderInput[];
  /** 模型私有参数（分辨率、时长、种子…）。故意不在这里穷举 */
  params?: Record<string, unknown>;
  /**
   * 取消信号。真正的模型调用要跑几十秒到几分钟，
   * 用户点「取消」或 Worker 要被回收时必须能真的停下来，
   * 否则既烧钱又占着并发名额。
   */
  signal?: AbortSignal;
  /** 0~1。Worker 会把它转成 SSE 事件推给前端 */
  onProgress?: (percent: number) => void;
}

/**
 * 生成结果。
 *
 * 关键设计：**Provider 只产出字节，不负责落盘、不碰数据库。**
 *
 * 如果让 Provider 自己写文件，每个实现类的存储路径规则都会不一样，
 * 换模型时历史资产就散落在不同地方了。落盘是 storage 层的事，
 * Provider 只管「拿到产物」。
 *
 * `buffer` 和 `remoteUrl` 二选一，是因为这两类 API 都真实存在：
 *   - 图像 API（如 SD 系）常常直接返回 base64 / 二进制
 *   - 视频 API（如可灵、Seedance）几乎都是异步任务 + 返回一个临时 OSS 链接
 * 接口必须同时容纳两者，否则接第一家真实模型时就得改接口。
 */
export interface GenerationOutput {
  kind: ProviderCapability;
  mimeType: string;
  /** 建议扩展名（不含点），由 storage 层决定最终文件名 */
  ext: string;
  /** 二进制产物 */
  buffer?: Buffer;
  /** 远端地址，由 storage 层负责下载进 ./storage */
  remoteUrl?: string;
  /** 纯文本产物（text 类节点用） */
  text?: string;
  /** 模型返回的原始信息，排查问题时很有用（耗时、模型版本、seed…） */
  meta?: Record<string, unknown>;
}

/**
 * 一个模型实现的全部契约。
 *
 * 为什么要 `capabilities` 数组而不是 `generateImage()` / `generateVideo()`
 * 这种一个大而全的类：
 *   1. 有些模型既能出图也能出视频，有些只能出图。数组能如实表达，
 *      而两个方法意味着每个实现都得写一堆 `throw new Error("不支持")`。
 *   2. 前端可以 `listProviders("video")` 直接拿到候选列表，
 *      不需要维护「哪个模型支持哪种能力」的映射表。
 *   3. 将来加音频、3D，只需要往这个联合类型里加一项，不改接口结构。
 */
export interface ModelProvider {
  /** 全局唯一，节点 param 里存它来指定模型。例：mock.image.v1 */
  readonly id: string;
  /** 展示给用户的名字 */
  readonly label: string;
  readonly capabilities: ProviderCapability[];
  /** 它接受哪些参数取值。前端据此过滤下拉框 */
  readonly options: ModelOptions;
  generate(req: GenerationRequest): Promise<GenerationOutput>;
}

/** Provider 可预期的失败（模型限流、内容审核、额度不足…），Worker 据此决定重试还是直接失败 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly options: {
      /** 可重试：限流、超时这类，等一会儿再来可能就好了 */
      retryable?: boolean;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = options.retryable ?? false;
    if (options.cause) this.cause = options.cause;
  }

  readonly retryable: boolean;
}
