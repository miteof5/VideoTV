import { describe, it, expect } from "vitest";
import { MinuteLimiter } from "./minuteLimiter";

// 这个节流器决定「一张图是马上发出去，还是等 60 秒再发」。
//
// 判错的两个方向都不好找原因：
//   放得太松 → provider 回 429，用户看到「百炼限流」，节点可能标红
//   收得太紧 → 明明还有额度却干等，三张图要跑三分钟
//
// 而且它有一个很容易写错的地方：固定窗口 vs 滑动窗口。「59 秒发 5 次、
// 61 秒再发 5 次」在固定窗口下完全合法，在真实限流面前是 10 次/两秒。
// 下面有一条专门钉这个。

/** 可手动推进的假时钟。测试里绝不真的等 60 秒 */
function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("MinuteLimiter", () => {
  it("配额内直接放行，不要求等待", () => {
    const clock = fakeClock();
    const l = new MinuteLimiter(5, clock.now);

    for (let i = 0; i < 5; i++) {
      expect(l.tryAcquire()).toBe(0);
    }
    expect(l.used()).toBe(5);
  });

  it("第 6 次要等（Pro 是 5 次/分钟）", () => {
    const clock = fakeClock();
    const l = new MinuteLimiter(5, clock.now);

    for (let i = 0; i < 5; i++) l.tryAcquire();
    const wait = l.tryAcquire();

    expect(wait).toBeGreaterThan(0);
    // 5 次都是「现在」提交的，所以第一次滑出窗口要等满一分钟
    expect(wait).toBeGreaterThan(59_000);
    expect(wait).toBeLessThanOrEqual(60_050);
  });

  it("等够时间后放行，且不会多算一次", () => {
    const clock = fakeClock();
    const l = new MinuteLimiter(2, clock.now);

    expect(l.tryAcquire()).toBe(0);
    expect(l.tryAcquire()).toBe(0);
    expect(l.tryAcquire()).toBeGreaterThan(0);

    clock.advance(60_100);
    expect(l.tryAcquire()).toBe(0);
    expect(l.used()).toBe(1);
  });

  it("被拒的那次不算用掉配额", () => {
    const clock = fakeClock();
    const l = new MinuteLimiter(1, clock.now);

    expect(l.tryAcquire()).toBe(0);
    // 后面十次都会被拒 —— 但它们不该把窗口撑满
    for (let i = 0; i < 10; i++) expect(l.tryAcquire()).toBeGreaterThan(0);

    clock.advance(60_100);
    // 如果被拒的次数被记进了 hits，这里 still 会 > 0
    expect(l.tryAcquire()).toBe(0);
  });

  it("滑动窗口：跨窗口边界的两次突发不能都算合法", () => {
    const clock = fakeClock();
    const l = new MinuteLimiter(5, clock.now);

    // 第 0 秒打满 5 次
    for (let i = 0; i < 5; i++) l.tryAcquire();

    // 第 59 秒还想打 —— 仍然在「最近 60 秒」窗口里，必须被拦下。
    // 固定窗口的实现会在这里放行（因为它认为「新的一分钟开始了」），
    // 于是 59 秒 5 次 + 61 秒 5 次 = 两秒 10 次，真实世界里就是 429。
    clock.advance(59_000);
    expect(l.tryAcquire()).toBeGreaterThan(0);

    // 再等到第 61 秒，第一批已经滑出窗口，才该放行
    clock.advance(1_100);
    expect(l.tryAcquire()).toBe(0);
  });

  it("available() 和 tryAcquire() 的判断一致", () => {
    const clock = fakeClock();
    const l = new MinuteLimiter(3, clock.now);

    while (l.available()) {
      expect(l.tryAcquire()).toBe(0);
    }
    expect(l.available()).toBe(false);
    expect(l.tryAcquire()).toBeGreaterThan(0);
  });

  it("每分钟次数必须为正 —— 0 会让它永远拒绝，且没人看得出为什么", () => {
    expect(() => new MinuteLimiter(0, Date.now)).toThrow();
    expect(() => new MinuteLimiter(-1, Date.now)).toThrow();
  });
});
