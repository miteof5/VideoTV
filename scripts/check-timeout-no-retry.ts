// 验证：执行超时**不会被标成可重试**，也不会被说成"已取消"。
//
// 为什么值得单独一个脚本：`retryable` 这一个布尔值决定 Worker 会不会再跑
// 一次，而视频是按秒计费的 —— 判错一次就是再买一份。这条链路没有 UI 可看，
// 只能在这里断言。
//
// 跑法：`MODEL_PROVIDER=mock npx tsx scripts/check-timeout-no-retry.ts`
// 退出码 1 = 判定错了。不联网、不花钱。
//
// 做法：建一次性的项目 + 视频节点 + run + job，用 200ms 的超时去跑
// mock 视频（它固定要等 1000ms），必然撞红线。看它怎么判。
import "dotenv/config";
import { db } from "@/lib/db";
import { executeNode } from "@/engine/executor";
import { NODE_TYPE } from "@/lib/constants";
import type { PlanStep } from "@/engine/plan";

let bad = 0;
const ck = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) bad++;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
};

async function main() {
  const project = await db.project.create({
    data: { name: "__check-timeout-no-retry" },
  });
  const node = await db.node.create({
    data: {
      projectId: project.id,
      type: NODE_TYPE.VIDEO_GEN,
      data: JSON.stringify({ prompt: "超时验证", duration: 2 }),
    },
  });
  const run = await db.run.create({
    data: { projectId: project.id, status: "running" },
  });
  const job = await db.job.create({
    data: { runId: run.id, nodeId: node.id, batch: 0 },
  });

  const step: PlanStep = {
    nodeId: node.id,
    batch: 0,
    capability: "video",
    prompt: "超时验证",
    params: { duration: 2, aspectRatio: "16:9" },
    upstreamIds: [],
    inputs: {},
  };

  const result = await executeNode({
    runId: run.id,
    jobId: job.id,
    step,
    signal: new AbortController().signal,
    // 200ms 必撞 mock 的 1000ms 等待 —— 这是故意造的超时，不是慢
    timeoutMs: 200,
  });

  const after = await db.job.findUnique({ where: { id: job.id } });
  const nodeAfter = await db.node.findUnique({ where: { id: node.id } });

  console.log("--- 实际结果 ---");
  console.log({
    status: result.status,
    error: result.error,
    retryable: result.retryable,
    attempts: after?.attempts,
    nodeStatus: nodeAfter?.status,
  });

  ck("判成失败（不是成功）", result.status === "failed", result.status);
  ck(
    "retryable === false（Worker 不会重跑，不会重复计费）",
    result.retryable === false,
    result.retryable
  );
  ck(
    "错误说的是「执行超时」而不是「已取消」",
    /执行超时/.test(result.error ?? ""),
    result.error
  );
  ck("节点标记为 failed", nodeAfter?.status === "failed", nodeAfter?.status);

  // 清理：只删自己建的那个项目，级联带走 node / run / job / event
  await db.project.delete({ where: { id: project.id } });

  console.log(bad === 0 ? "\n全部通过" : `\n${bad} 条不符`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("脚本崩溃：", err);
  process.exit(1);
});
