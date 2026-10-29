import { describe, it, expect } from "vitest";
import { classify, parseRetryAfterMs } from "./http";

// 这两个函数决定「失败之后要不要再花钱跑一次」，以及「等多久」。
//
// 它们没有 UI 可看：判错了的表现是「某个节点莫名其妙红了」或者
// 「同一个任务被跑了两遍、额度扣了两次」，两种都很难从现象倒推到这一行。
// 所以要在这里钉住。

describe("parseRetryAfterMs", () => {
  it("秒数", () => {
    expect(parseRetryAfterMs("12")).toBe(12_000);
  });

  it("HTTP 日期（相对现在）", () => {
    const at = new Date(Date.now() + 8_000).toUTCString();
    const ms = parseRetryAfterMs(at);
    expect(ms).toBeGreaterThan(5_000);
    expect(ms).toBeLessThanOrEqual(9_000);
  });

  it("荒谬的大值被夹到 5 分钟，不会把任务挂死一天", () => {
    expect(parseRetryAfterMs("86400")).toBe(5 * 60_000);
  });

  it("过去的日期当成 0", () => {
    expect(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it("认不出来返回 undefined", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("soon")).toBeUndefined();
  });
});

describe("classify", () => {
  it("429 → 可重试，且默认等 12 秒（图像 Pro 是 5 次/分钟）", () => {
    const e = classify(429, "Throttling", "Requests rate limit exceeded");
    expect(e.retryable).toBe(true);
    // 12 秒是这个模型两次请求的真实间隔。等 1 秒等于没等，必再撞一次。
    expect(e.retryAfterMs).toBe(12_000);
  });

  it("429 带 Retry-After → 听服务端的", () => {
    const e = classify(429, undefined, "too many", 3_000);
    expect(e.retryAfterMs).toBe(3_000);
  });

  it("5xx → 可重试，只等 2 秒（服务端抖动恢复快）", () => {
    const e = classify(500, "InternalError", "boom");
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(2_000);
  });

  it("内容审核 → 不可重试（重试一百次还是被拒，只是多花钱）", () => {
    const e = classify(400, "DataInspectionFailed", "inspection failed");
    expect(e.retryable).toBe(false);
  });

  it("模型名不存在 → 不可重试（这是配置错，不是抖动）", () => {
    const e = classify(404, "model_not_found", "model not found");
    expect(e.retryable).toBe(false);
  });

  it("额度不足 → 不可重试", () => {
    const e = classify(400, "Arrearage", "余额不足");
    expect(e.retryable).toBe(false);
  });

  it("认不出来的错误 → 不可重试（保守：不乱花钱）", () => {
    const e = classify(400, "Unknown", "???");
    expect(e.retryable).toBe(false);
  });
});
