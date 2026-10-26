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
