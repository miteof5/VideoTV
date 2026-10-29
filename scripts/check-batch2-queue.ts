// 批 2 的服务端验收：并发名额、幂等、重叠等待、积分。
//
// 为什么必须在**隔离库**里跑：它会真的调（mock）模型、真的写 Job / Run / 资产。
// 指到 dev.db 上就等于往用户的项目里塞测试节点和产物。
// 所以开头先校验 DATABASE_URL 指向 verify 库，不满足直接退出（退出码 2）。
//
// 跑法：
//   DATABASE_URL="file:./verify.db" STORAGE_DIR="./.verify-storage" \
//   MODEL_PROVIDER=mock npx tsx scripts/check-batch2-queue.ts
//
// 前置：先把库建出来 `DATABASE_URL="file:./verify.db" npx prisma migrate deploy`，
// 再起一个同 env 的 worker（可加 MOCK_LATENCY_SCALE=8 让并发更好观察）。
import "dotenv/config";
import { db } from "@/lib/db";
import { createRun } from "@/lib/runService";
import { NODE_TYPE } from "@/lib/constants";

let bad = 0;
const ck = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) bad++;
  console.log(
    `${ok ? "✓" : "✗"} ${name}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`
  );
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitIdle(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = await db.run.count({
      where: { status: { in: ["pending", "running"] } },
    });
    if (active === 0) return true;
    await sleep(150);
  }
  return false;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("verify")) {
    console.error(`拒绝在非隔离库上跑：DATABASE_URL=${url}`);
    process.exit(2);
  }

  const project = await db.project.create({ data: { name: "__verify-batch2" } });

  // ---------- 场景一：3 条并行 + 第 4 条被拒 + 幂等 ----------
  const imgs = [];
  for (let i = 0; i < 4; i++) {
    imgs.push(
      await db.node.create({
        data: {
          projectId: project.id,
          type: NODE_TYPE.IMAGE_GEN,
          data: JSON.stringify({
            label: `测试图${i + 1}`,
            prompt: `第 ${i + 1} 张测试图`,
            aspectRatio: "16:9",
            status: "idle",
          }),
        },
      })
    );
  }

  let peak = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const n = await db.job.count({ where: { status: "running" } });
      peak = Math.max(peak, n);
      await sleep(60);
    }
  })();

  const r1 = await createRun(project.id, { mode: "node", targetId: imgs[0].id });
  const r2 = await createRun(project.id, { mode: "node", targetId: imgs[1].id });
  const r3 = await createRun(project.id, { mode: "node", targetId: imgs[2].id });
  ck(
    "三个不同节点各建一条 run",
    new Set([r1.runId, r2.runId, r3.runId]).size === 3,
    [r1.runId, r2.runId, r3.runId]
  );

  const dup = await createRun(project.id, { mode: "node", targetId: imgs[0].id });
  ck(
    "同一节点重复提交 → 返回同一条 run（幂等）",
    dup.runId === r1.runId && dup.reusedExisting === true,
    dup
  );

  let rejected = "";
  try {
    await createRun(project.id, { mode: "node", targetId: imgs[3].id });
  } catch (err) {
    rejected = err instanceof Error ? err.message : String(err);
  }
  ck("第 4 个任务被明确拒绝（不静默排队）", rejected.includes("已经有 3 个"), rejected);

  const finished = await waitIdle();
  sampling = false;
  await sampler;
  ck("三条 run 都跑完", finished);

  ck("确实并行推进过（同时在跑的 job 峰值 ≥ 2）", peak >= 2, { peak });

  const doneRuns = await db.run.findMany({
    where: { id: { in: [r1.runId, r2.runId, r3.runId] } },
  });
  ck(
    "每条 run 都结算了积分（图片 10 分/条）",
    doneRuns.every((r) => r.credits === 10),
    doneRuns.map((r) => r.credits)
  );
  ck(
    "三条 run 全部成功",
    doneRuns.every((r) => r.status === "succeeded"),
    doneRuns.map((r) => r.status)
  );

  // ---------- 场景二：同一张图 + 两个不同提示词 ----------
  const src = await db.node.create({
    data: {
      projectId: project.id,
      type: NODE_TYPE.IMAGE_GEN,
      data: JSON.stringify({
        label: "共用起点图",
        prompt: "雨夜街角，霓虹反光",
        aspectRatio: "16:9",
        status: "idle",
      }),
    },
  });

  const mkVideo = async (label: string, prompt: string) =>
    db.node.create({
      data: {
        projectId: project.id,
        type: NODE_TYPE.VIDEO_GEN,
        data: JSON.stringify({
          label,
          prompt,
          mode: "auto",
          aspectRatio: "16:9",
          duration: "3",
          status: "idle",
        }),
      },
    });

  const v1 = await mkVideo("视频A", "镜头缓慢推进");
  const v2 = await mkVideo("视频B", "镜头快速拉远");
  for (const v of [v1, v2]) {
    await db.edge.create({
      data: { projectId: project.id, source: src.id, target: v.id, targetHandle: "" },
    });
  }

  const a = await createRun(project.id, { mode: "node", targetId: v1.id });
  // 立刻点第二个：此刻 src 正被第一条 run 跑着（或至少已排进它的 job）
  const b = await createRun(project.id, { mode: "node", targetId: v2.id });

  ck("第二个 run 挂起等待上游（不是各跑一遍）", b.waitingCount === 1, b);

  const bRow = await db.run.findUnique({
    where: { id: b.runId },
    include: { jobs: true },
  });
  ck(
    "挂起的 run 没有为上游图建 job",
    bRow !== null && bRow.jobs.every((j) => j.nodeId !== src.id),
    bRow?.jobs.map((j) => j.nodeId)
  );
  ck(
    "waitingOn 记下了那个节点",
    Boolean(bRow?.waitingOn?.includes(src.id)),
    bRow?.waitingOn
  );

  const finished2 = await waitIdle();
  ck("两条 run 都结束", finished2);

  const srcJobs = await db.job.count({ where: { nodeId: src.id } });
  ck("上游图在整个过程中只跑了一次", srcJobs === 1, srcJobs);

  const finalNodes = await db.node.findMany({
    where: { id: { in: [src.id, v1.id, v2.id] } },
  });
  const byId = new Map(finalNodes.map((n) => [n.id, n]));
  ck(
    "两个视频都成功",
    byId.get(v1.id)?.status === "succeeded" &&
      byId.get(v2.id)?.status === "succeeded",
    [byId.get(v1.id)?.status, byId.get(v2.id)?.status]
  );
  ck(
    "两个视频都拿到了同一个上游产物",
    Boolean(byId.get(src.id)?.outputAssetId) &&
      Boolean(byId.get(v1.id)?.outputAssetId) &&
      Boolean(byId.get(v2.id)?.outputAssetId),
    {
      src: byId.get(src.id)?.outputAssetId,
      v1: byId.get(v1.id)?.outputAssetId,
      v2: byId.get(v2.id)?.outputAssetId,
    }
  );

  const runA = await db.run.findUnique({ where: { id: a.runId } });
  const runB = await db.run.findUnique({ where: { id: b.runId } });
  ck(
    "积分按条算：A=110（图 10 + 视频 100），B=100（只跑视频）",
    runA?.credits === 110 && runB?.credits === 100,
    [runA?.credits, runB?.credits]
  );

  console.log(bad === 0 ? "\n全部通过" : `\n${bad} 条不符`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
