// 按「每分钟最多提交几次」节流。
//
// 为什么这是一个独立模块，而不是塞在 worker 里：
// 它是纯逻辑（没有数据库、没有网络），可以单测；而 worker 是进程编排，
// 没法在测试里跑整条链路。混在一起的结果就是这段逻辑只能靠「用户用了
// 之后发现 429」来验证。
//
// 使用场景只有一个：千问图像的同步接口。官方限制是「提交 5 次/分钟」，
// 同时写明「同步接口并发不限」—— 也就是说并发信号量对它完全无效，
// 真正的门是分钟级的提交次数。

/**
 * 滑动窗口节流器。
 *
 * ### 为什么必须是滑动窗口
 *
 * 固定窗口（每 60 秒清零）有一个经典漏洞：在第 59 秒发 5 次、
 * 第 61 秒再发 5 次 —— 两秒内实际过了 10 次，两次「各自合法」，
 * 但对供应商来说是 10 次/两秒，照样 429。
 *
 * 滑动窗口记下每次提交的时刻，判断依据是「最近 60 秒内提交了几次」，
 * 无论怎么跨窗口都对得上。
 */
export class MinuteLimiter {
  /** 最近一分钟内每次提交的时刻（毫秒时间戳），升序 */
  private hits: number[] = [];

  /**
   * @param perMinute 一分钟内最多放行几次
   * @param clock     取时间的函数，测试时可以换成假的
   */
  constructor(
    public readonly perMinute: number,
    private readonly clock: () => number = Date.now
  ) {
    if (perMinute <= 0) {
      throw new Error("每分钟次数必须大于 0");
    }
  }

  /** 最近 60 秒内已经用掉几次（给 UI / 日志看） */
  used(): number {
    this.evict(this.clock());
    return this.hits.length;
  }

  private evict(now: number) {
    // 一分钟窗口。用 filter 而不是逐个 shift：数组最多 perMinute 个元素，
    // 重建一次的成本可以忽略，而少一层下标运算就少一处 off-by-one。
    this.hits = this.hits.filter((t) => now - t < 60_000);
  }

  /** 现在能不能立刻拿一次配额（调用方用来决定「要不要提示用户在等」） */
  available(): boolean {
    return this.used() < this.perMinute;
  }

  /**
   * 拿一次配额。拿不到就返回需要等待的毫秒数（调用方自己决定怎么等）。
   *
   * ### 为什么不在这里 sleep
   *
   * 这个模块要在两个世界里都能用：worker（可以 sleep）和测试（不想真等
   * 60 秒）。把「等」交给调用方，测试就能用一个假时钟把整分钟瞬间走完，
   * 而生产代码仍然老老实实等。
   *
   * @returns 0 表示拿到了；> 0 表示现在拿不到，等这么久再来
   */
  tryAcquire(): number {
    const now = this.clock();
    this.evict(now);

    if (this.hits.length < this.perMinute) {
      this.hits.push(now);
      return 0;
    }

    // 最早那次滑出窗口的那一刻就是可以再提交的时候，加 50ms 缓冲 ——
    // 时间戳取整和网络时钟误差都可能让边界那一下判定抖动。
    const earliest = this.hits[0];
    return Math.max(0, 60_000 - (now - earliest) + 50);
  }
}
