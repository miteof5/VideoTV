// 状态常量。SQLite 不支持 enum，用字符串常量 + 类型别名来约束。
// 所有状态流转都必须引用这里的常量，不要在代码里写裸字符串。

export const NODE_STATUS = {
  IDLE: "idle",
  QUEUED: "queued",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  /**
   * 上游失败导致它没机会跑。
   * 跟 JOB_STATUS.SKIPPED 是同一条理由：failed 是"它自己错了"，
   * skipped 是"它没机会跑"。显示成一样的红，用户会在一片红里找不到元凶。
   */
  SKIPPED: "skipped",
} as const;
export type NodeStatus = (typeof NODE_STATUS)[keyof typeof NODE_STATUS];

export const RUN_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;
export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

export const JOB_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  /**
   * 因为上游失败而没跑。
   * 和 failed 的区别很重要：failed 是"它自己错了"，skipped 是"它没机会跑"。
   * 混在一起的话，用户会在一片红里找不到真正的故障点。
   */
  SKIPPED: "skipped",
} as const;
export type JobStatus = (typeof JOB_STATUS)[keyof typeof JOB_STATUS];

export const ASSET_KIND = {
  IMAGE: "image",
  VIDEO: "video",
  AUDIO: "audio",
} as const;
export type AssetKind = (typeof ASSET_KIND)[keyof typeof ASSET_KIND];

/**
 * 一条任务消耗多少积分。
 *
 * ### 为什么是「按条」而不是「按秒 × 单价」
 *
 * 现在还没上线，没有真实收费依据。编一张「每秒多少钱 / 每张高清多少钱」
 * 的表，等于给用户一个看着精确、实际是虚构的数字 —— 比不给还糟。
 * 按条计只表达一件事：哪种操作更贵。文本 < 图片 << 视频，这个量级关系
 * 是真的，具体数值随时可以改。
 *
 * 所以**视频不按时长**：2 秒和 30 秒都是 100（人 2026-10-28 拍板）。
 * 也**不按模型区分**：千问图像 3.0 和 Pro 都是 10。
 */
export const CREDIT_COST = {
  text: 1,
  image: 10,
  video: 100,
} as const;
export type CreditCapability = keyof typeof CREDIT_COST;

/**
 * 全局同时最多跑几个任务（跨 run、跨用户共享）。
 *
 * ### 它保护的是 provider，不是公平性
 *
 * 这个数对齐的是「我们愿意同时向供应商打几个请求」。百炼给的额度是
 * 视频同时 5 个、图片同步接口并发不限（但每分钟提交次数有限制，
 * 由 catalog 里的 `rateLimitPerMinute` 单独节流）。
 *
 * 理论上这个数可以到 5，2026-10-29 人拍板**保持 3 不动** —— 理由是
 * 当前只有一个用户，调大碰不到收益；而一旦改错（比如图片按并发限流）
 * 反而更糟。后果是记在案的：**第二个用户出现时，他的第一个任务就要排队**。
 * 要改的时候只改这一个数，另见 MAX_CONCURRENT_PER_USER。
 */
export const MAX_CONCURRENT_TASKS = 3;

/**
 * 每个人同时最多跑几个任务。
 *
 * 和上面那个不是一回事：
 *   MAX_CONCURRENT_TASKS  —— 「整台机器愿意同时打几个请求」，保护供应商
 *   MAX_CONCURRENT_PER_USER —— 「一个人最多占几个名额」，保护其他人不被挤死
 *
 * 两个都是 3 纯属巧合，语义完全不同。改的时候想清楚在改哪个：
 * 只改全局 = 所有人一起变快/变慢；只改每用户 = 单个人能占多少不变，
 * 但总闸门变宽。两层同时生效，真正的上限是两者的较小值。
 */
export const MAX_CONCURRENT_PER_USER = 3;

/**
 * 挂起等待上游产物的上限。
 *
 * 等的是另一个 run 正在生成的图/视频，正常情况下几十秒到几分钟。
 * 超过这个时间还没结果，说明上游卡死或已经没人负责它了 ——
 * 继续占着这条 run 只会让用户对着「排队中」干等。
 */
export const WAIT_TIMEOUT_MS = 10 * 60_000;


// 节点类型。M1 只注册占位，M2 起由 nodeRegistry 接管
export const NODE_TYPE = {
  TEXT_PROMPT: "text.prompt",
  IMAGE_GEN: "image.gen",
  VIDEO_GEN: "video.gen",
  /**
   * 用户上传的素材（图片或视频）。
   *
   * 为什么图片和视频共用一个类型、而不是拆成 image.input / video.input：
   * 它们在画布上的行为完全一致（纯输入、不调模型、产物就是自己），
   * 唯一的差别是浏览器用 <img> 还是 <video> 渲染 —— 那是产物 kind 的事，
   * 不是节点类型的事。拆成两个类型只会让连线校验多两行重复代码。
   */
  MEDIA_ASSET: "media.asset",
} as const;
export type NodeType = (typeof NODE_TYPE)[keyof typeof NODE_TYPE];
