/**
 * 跑生成类 E2E 之前的「世界检查」。
 *
 * ## 为什么需要它
 *
 * 2026-10-25 删掉演示模型清单之后，这些套件全都会红，而代码是对的：
 *   · 夹具把图像/视频节点钉在 `mock.image.v1` / `mock.video.v1`
 *     （不花钱、验证的是拼接与布局，与模型真假无关）
 *   · 断言里还有「优化结果必须带着原文」这类只有演示模型才成立的话
 * 症状是 `下游 failed` + `未注册的 Provider：mock.image.v1`，
 * 看着像功能坏了，实际是「跑了另一套世界」。
 *
 * 与其让人对着看不懂的红去猜，不如在这里停下，把跑法说清楚。
 *
 * ## 退出码
 *
 *   2 = 环境不对（不是断言失败，重跑没用）
 *   1 = 断言失败
 *
 * ## 用法
 *
 *     import { requireMockWorld } from "./_preflight.mjs";
 *     await requireMockWorld();
 */
const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:3000";

export async function requireMockWorld() {
  let models;
  try {
    const res = await fetch(`${BASE}/api/models`);
    models = (await res.json()).models ?? [];
  } catch (err) {
    console.error(`连不上 dev（${BASE}）：${err.message}`);
    console.error("先 `npm run dev` 和 `npm run worker` 再跑。");
    process.exit(2);
  }

  if (models.some((m) => m.demo)) return;

  console.error(
    [
      "",
      "这一套需要演示模型（夹具钉在 mock.* 上，断言也假设演示模型的确定性输出）。",
      "现在清单里一个演示模型都没有 —— 说明 dev/worker 起在真模型世界。",
      "",
      "跑法：两件事都要做，缺一不可（两个进程各自读环境变量）",
      "  MODEL_PROVIDER=mock npm run dev",
      "  MODEL_PROVIDER=mock npm run worker",
      "",
      "真模型世界该验的：scripts/probe-video-empty.mjs、scripts/check-*.ts，",
      "或者人手点一遍。",
      "",
    ].join("\n")
  );
  process.exit(2);
}
