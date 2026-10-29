import fs from "node:fs/promises";
import {
  ProviderError,
  type GenerationOutput,
} from "@/providers/types";
import { renderPlaceholderPng } from "@/providers/mock/png";

/**
 * 百炼（DashScope）的 HTTP 薄封装。
 *
 * 把三件容易写歪的事收在一处：
 *   1. dry run —— 请求体拼好、发出去之前停住
 *   2. 错误分类 —— 哪些该重试、哪些重试也没用
 *   3. 本地图片转 base64 —— 上游产物的唯一可用输入形式
 *
 * 不引 SDK。官方只提供 Python / Java SDK，Node 侧只能走 HTTP，
 * 而且那点封装量（两个端点 + 轮询）不值得为它引入一个包。
 */

const DEFAULT_BASE = "https://dashscope.aliyuncs.com/api/v1";

/**
 * OpenAI 兼容模式的基址。
 *
 * ### 为什么它必须存在（2026-10-25 实测）
 *
 * 文本模型原本走原生端点 `/api/v1/services/aigc/text-generation/generation`，
 * 结果被拒：`InvalidParameter: url error, please check url！`
 * 同一个模型换到 `/compatible-mode/v1/chat/completions` 就正常返回。
 *
 * 也就是说：**图像和文本在百炼上是两种不同的接入方式** ——
 * 图像走 `/api/v1`（同步/异步任务），文本走 OpenAI 兼容层。
 * 四个文本模型（qwen3.8-max / flash / kimi-k3 / deepseek）全部只在后者可用。
 * 这条结论是逐个 curl 出来的，不是推断。
 */
const DEFAULT_COMPATIBLE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/**
 * 请求体里允许出现的最大原始字节数。
 *
 * 百炼对请求体有体积上限（约 10MB），base64 会让原图膨胀 4/3。
 * 取 6MB 是个留了余量的经验值：超过这个数的图，先不说能不能传上去，
 * 模型那边也基本不会更好——画布卡片只有 400px 宽。
 */
const MAX_INPUT_BYTES = 6 * 1024 * 1024;

export interface DashScopeConfig {
  apiKey: string;
  baseUrl: string;
  /** OpenAI 兼容模式（文本模型走这条） */
  compatibleBaseUrl: string;
}

export function readConfig(): DashScopeConfig {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!apiKey) {
    // 走到这里说明配置漏了。正常情况下这个模型根本不会进清单
    // （catalog 的 requiresEnv 已经过滤过），所以这属于内部错误。
    throw new ProviderError("未配置 DASHSCOPE_API_KEY", { retryable: false });
  }
  return {
    apiKey,
    // 允许切换到业务空间域名或测试用 mock server。
    // 默认用老的公共域名，它对所有地域的 key 都能用，不必先查 WorkspaceId。
    baseUrl: (process.env.DASHSCOPE_BASE_URL?.trim() || DEFAULT_BASE).replace(
      /\/+$/,
      ""
    ),
    compatibleBaseUrl: (
      process.env.DASHSCOPE_COMPATIBLE_BASE_URL?.trim() ||
      DEFAULT_COMPATIBLE_BASE
    ).replace(/\/+$/, ""),
  };
}

/** dry run 是否开启。每次调用都读一次环境变量，方便改了立刻生效（dev 下） */
export function isDryRun() {
  return process.env.PROVIDER_DRY_RUN === "1";
}

/** 一次「本来要发出去」的调用。dry run 时把它交出去，作为日志的证据 */
export interface DryRunCall {
  method: string;
  url: string;
  /** 已脱敏：Authorization 只留前缀 */
  headers: Record<string, string>;
  body: unknown;
}

/**
 * dry run 的终止信号。
 *
 * 为什么用异常而不是返回一个 `{ dryRun: true }` 的联合类型：
 * 返回联合类型意味着每个调用点都要写 `if (res.dryRun)`，
 * 而那个分支在真实运行时永远不成立 —— 它会被慢慢删掉，或者写错。
 * 异常只有一处抛出、每个 Provider 一处 catch，不会漏。
 */
export class DryRunAbort extends Error {
  constructor(readonly call: DryRunCall) {
    super("DRY_RUN：已拦截，未真实调用");
    this.name = "DryRunAbort";
  }
}

/** 脱敏请求头。key 一旦进了日志表就等于泄露，只留前 8 位用于确认「用的是哪把」 */
function maskHeaders(headers: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /authorization|api-key/i.test(k) ? `${v.slice(0, 15)}…` : v;
  }
  return out;
}

export interface CallArgs {
  method?: "GET" | "POST";
  /** 相对路径，如 /services/aigc/... */
  path: string;
  /**
   * 用哪个基址：
   *   native（缺省）—— /api/v1，图像与异步任务
   *   compatible    —— /compatible-mode/v1，文本模型唯一可用的那条
   */
  base?: "native" | "compatible";
  body?: unknown;
  /** 百炼用这个头声明异步任务 */
  async?: boolean;
  signal?: AbortSignal;
}

/**
 * 发一次请求。
 *
 * dry run 只拦 **POST** —— GET 是查询任务进度，不花钱也没有副作用，
 * 拦它只会让 dry run 和真实运行的时序差得太远，验不出东西。
 */
export async function callDashScope<T>(args: CallArgs): Promise<T> {
  const cfg = readConfig();
  const method = args.method ?? "POST";
  const root = args.base === "compatible" ? cfg.compatibleBaseUrl : cfg.baseUrl;
  const url = `${root}${args.path}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
  };
  if (args.async) headers["X-DashScope-Async"] = "enable";

  if (isDryRun() && method === "POST") {
    throw new DryRunAbort({
      method,
      url,
      headers: maskHeaders(headers),
      body: args.body,
    });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: args.body === undefined ? undefined : JSON.stringify(args.body),
      signal: args.signal,
    });
  } catch (err) {
    if (args.signal?.aborted) {
      throw new ProviderError("已取消", { retryable: false, cause: err });
    }
    // 网络层失败（DNS、连接重置、代理）—— 等一会儿可能就好了。
    // 这类失败的共性是**请求没到服务端**，所以重试不会造成重复生成，
    // 和「超时」有本质区别（超时那条见 engine/executor.ts 的注释）。
    throw new ProviderError(
      `请求百炼失败：${err instanceof Error ? err.message : String(err)}`,
      { retryable: true, retryAfterMs: 2_000, cause: err }
    );
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // 返回非 JSON 通常是网关错误页（502/504），原文是 HTML
    if (!res.ok) {
      throw new ProviderError(
        `百炼返回 ${res.status}：${text.slice(0, 300)}`,
        { retryable: res.status >= 500 }
      );
    }
  }

  const d = (data ?? {}) as {
    code?: string;
    message?: string;
    /**
     * 兼容模式的错误是**嵌一层**的 OpenAI 风格：
     * `{ error: { message, type, code } }`，code 在 `error` 里面。
     * 原生模式是平铺的 `{ code, message }`。
     *
     * 两套都认。只认一种的后果很具体：classify 拿到 undefined，
     * 于是所有失败都变成「百炼拒绝请求：undefined」——
     * 重试判定全部落到「不可重试」，限流再也不会自动重试，而且用户看不懂。
     */
    error?: { code?: string; message?: string; type?: string };
    output?: { task_status?: string; message?: string };
  };
  const code = d.code ?? d.error?.code;
  const message = d.message ?? d.error?.message ?? d.output?.message;

  if (!res.ok || code) {
    throw classify(
      res.status,
      code,
      message,
      // 限流响应通常带 Retry-After。有就用它（服务端最清楚自己什么时候松口），
      // 没有就让 classify 按状态码给一个缺省值。
      parseRetryAfterMs(res.headers.get("retry-after"))
    );
  }

  return data as T;
}

/**
 * 解析 `Retry-After` 头。
 *
 * 两种格式都要认，这是 HTTP 的规定：
 *   - 秒数：`Retry-After: 12`
 *   - HTTP 日期：`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`
 *
 * 两种情况都夹一个 5 分钟上限。理由：这个值会被直接拿去 sleep，
 * 服务端一时抽风给个 `86400` 就等于把任务挂死一天 —— 而重试的目的
 * 是"尽快恢复"，不是"永远等下去"。真等不起的时候，让节点失败
 * 比让用户盯着一个永远转圈的卡片好。
 */
export function parseRetryAfterMs(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const MAX = 5 * 60_000;

  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(secs * 1000, MAX);
  }

  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    const delta = at - Date.now();
    return delta > 0 ? Math.min(delta, MAX) : 0;
  }

  return undefined;
}

/**
 * 把百炼的失败翻译成「该不该重试」。
 *
 * 这个判断决定 Worker 会不会再排一次。分错的代价是双向的：
 * 额度用尽判成可重试 → 白白重试一遍再失败，日志里还多一条误导信息；
 * 限流判成不可重试 → 明明等十秒就能过的任务直接标失败。
 */
export function classify(
  status: number,
  code?: string,
  message?: string,
  retryAfterMs?: number
) {
  const msg = message || code || `HTTP ${status}`;

  /*
   * 模型名不存在 / 账号无权访问（兼容模式 404 model_not_found）。
   *
   * 单独拎出来是因为它是**配置错误**，不是运行时故障：
   * 重试一百次也一样，而且真实原因往往就是 catalog 里写了一个
   * 这个账号用不了的模型名（比如拼错版本号）。
   * 报「百炼拒绝请求」的话，用户只会以为是网络问题。
   */
  if (code === "model_not_found" || /model.*not.*(exist|found)/i.test(msg)) {
    return new ProviderError(
      `模型不存在或账号无权限：${msg}`,
      { retryable: false }
    );
  }

  // 端点/协议不对。2026-10-25 踩过：文本模型打到图像那个端点时就是这个
  if (code === "InvalidParameter" && /url/i.test(msg)) {
    return new ProviderError(
      `请求地址与模型不匹配：${msg}。文本模型必须走 /compatible-mode/v1（见 chat.ts）`,
      { retryable: false }
    );
  }

  /*
   * 限流 / 服务端抖动：等一会儿真的会好。
   *
   * 这两类都"可重试"，但**该等多久差一个数量级**，所以必须分头给值：
   *   限流  —— 12 秒起步。千问图像 Pro 是 5 次/分钟，等于 12 秒才放一张。
   *            Worker 原来固定 1 秒退避，在 5 次/分钟面前几乎必然再撞一次，
   *            第二次就用光了尝试次数 → 节点标红 → 用户以为模型坏了。
   *   5xx  —— 2 秒。服务端抖动恢复得快，等太久反而拖慢整条流水线。
   */
  const throttled =
    status === 429 ||
    code === "Throttling" ||
    code?.startsWith("Throttling.");
  const serverFault = status >= 500 || code === "InternalError";

  if (throttled || serverFault) {
    return new ProviderError(
      `${throttled ? "百炼限流" : "百炼服务异常"}：${msg}`,
      {
        retryable: true,
        // 服务端给了 Retry-After 就听它的 —— 它比我们清楚什么时候松口
        retryAfterMs: retryAfterMs ?? (throttled ? 12_000 : 2_000),
      }
    );
  }

  // 内容审核：同一段提示词重试一百次也还是被拒，重试只是多花钱
  if (code === "DataInspectionFailed" || /inspection/i.test(code ?? "")) {
    return new ProviderError(
      `内容审核未通过：${msg}。换一种描述方式再试`,
      { retryable: false }
    );
  }

  // 额度 / 欠费：这是配置问题，不是运行时故障，报清楚比重试有用
  if (/arrearage|quota|freetier/i.test(code ?? "") || /余额|额度/.test(msg)) {
    return new ProviderError(`百炼额度不足：${msg}`, { retryable: false });
  }

  return new ProviderError(`百炼拒绝请求：${msg}`, { retryable: false });
}

/**
 * 本地文件 → `data:image/png;base64,...`
 *
 * 为什么必须这样传：百炼的 HTTP 接口只认公网 URL 或 base64，
 * `file://` 那种写法是 Python/Java SDK 自己读文件后转的，HTTP 层没有。
 * 而我们的上游产物全在本地磁盘上 —— 不转 base64 就根本传不进去。
 */
export async function fileToDataUrl(
  filePath: string,
  mimeType: string
): Promise<string> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(filePath);
  } catch (err) {
    throw new ProviderError(
      `读不到上游产物：${filePath}`,
      { retryable: false, cause: err }
    );
  }
  if (buf.byteLength > MAX_INPUT_BYTES) {
    throw new ProviderError(
      `上游图片 ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_INPUT_BYTES / 1024 / 1024}MB 上限`,
      { retryable: false }
    );
  }
  return `data:${mimeType};base64,${buf.toString("base64")}`;
}

/** 可中断的等待。轮询和重试都要用，且必须能响应取消 —— 否则用户点了停止还在耗额度 */
export function sleepAbortable(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError("已取消", { retryable: false }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError("已取消", { retryable: false }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * dry run 的产物：一张占位图 + 完整的「本该发出去的请求」。
 *
 * 为什么不用抛错的方式收场：dry run 的目的是验证整条链路
 * （落盘 → Asset → 卡片预览 → 刷新不丢），抛错的话链路只走了一半，
 * 前面的验证就没意义了。
 *
 * 尺寸从请求体里读，所以「选 9:16 出来的图是不是竖的」这种问题
 * 在 dry run 下也能验 —— 而那正是最容易拼错的地方。
 */
export function dryRunImageOutput(call: DryRunCall): GenerationOutput {
  const { width, height } = sizeFromCall(call);
  return {
    kind: "image",
    mimeType: "image/png",
    ext: "png",
    buffer: renderPlaceholderPng({ width, height, seed: "dry-run" }),
    meta: { dryRun: true, dryRunCall: call },
  };
}

function sizeFromCall(call: DryRunCall) {
  const size = (call.body as { parameters?: { size?: string } } | undefined)
    ?.parameters?.size;
  const m = /^(\d+)\*(\d+)$/.exec(String(size ?? ""));
  if (!m) return { width: 1024, height: 1024 };
  return { width: Number(m[1]), height: Number(m[2]) };
}
