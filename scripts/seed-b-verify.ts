// 临时验收种子（B 阶段）。跑完可删。
//
// 作用：在一个**隔离库**里造出一个带产物的项目，让真浏览器验收不必真跑模型。
//
//   DATABASE_URL="file:./verify.db" STORAGE_DIR="./.verify-storage" \
//   npx tsx scripts/seed-b-verify.ts
//
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { STORAGE_ROOT, assetRelPath } from "@/lib/storage";

const SOURCE = path.join(process.cwd(), "storage");

/** 从真实资产目录里找一个 png 复制过来当产物 */
function pickPng(): string | null {
  const dir = path.join(SOURCE, "assets");
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const name of fs.readdirSync(cur)) {
      const full = path.join(cur, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (name.endsWith(".png")) return full;
    }
  }
  return null;
}

async function main() {
  if (!process.env.DATABASE_URL?.includes("verify")) {
    throw new Error("只允许在 verify.db 里播种，拒绝跑在真实库上");
  }

  const png = pickPng();
  if (!png) throw new Error("找不到可复制的 png，先在真实环境里生成一张");

  const now = new Date();
  const project = await db.project.create({ data: { name: "B 验收项目" } });

  const mkAsset = async (id: string) => {
    const rel = assetRelPath(id, "png", now);
    const abs = path.join(STORAGE_ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(png, abs);
    return db.asset.create({
      data: {
        id,
        projectId: project.id,
        kind: "image",
        mimeType: "image/png",
        filePath: rel,
        sizeBytes: fs.statSync(abs).size,
      },
    });
  };

  const a1 = await mkAsset("asset_seed_one");
  const a2 = await mkAsset("asset_seed_two");

  const n1 = await db.node.create({
    data: {
      id: "node_seed_one",
      projectId: project.id,
      type: "image.gen",
      positionX: 0,
      positionY: 0,
      data: JSON.stringify({
        label: "会被删掉的图",
        prompt: "雨夜的街道，霓虹倒影",
        aspectRatio: "16:9",
        status: "succeeded",
        naturalW: 1024,
        naturalH: 576,
      }),
      status: "succeeded",
      outputAssetId: a1.id,
    },
  });

  const n2 = await db.node.create({
    data: {
      id: "node_seed_two",
      projectId: project.id,
      type: "image.gen",
      positionX: 1400,
      positionY: 0,
      data: JSON.stringify({
        label: "留下的图",
        prompt: "雪地里的红伞",
        aspectRatio: "16:9",
        status: "succeeded",
        naturalW: 1024,
        naturalH: 576,
      }),
      status: "succeeded",
      outputAssetId: a2.id,
    },
  });

  /* ---- 历史：一条成功 + 一条失败，带事件 ---- */
  const ok = await db.run.create({
    data: {
      projectId: project.id,
      status: "succeeded",
      startedAt: new Date(Date.now() - 3600_000),
      endedAt: new Date(Date.now() - 3600_000 + 20_000),
      credits: 20,
      targetId: n1.id,
    },
  });
  await db.job.createMany({
    data: [
      { runId: ok.id, nodeId: n1.id, batch: 0, status: "succeeded", credits: 10 },
      { runId: ok.id, nodeId: n2.id, batch: 1, status: "succeeded", credits: 10 },
    ],
  });

  const bad = await db.run.create({
    data: {
      projectId: project.id,
      status: "failed",
      startedAt: new Date(Date.now() - 600_000),
      endedAt: new Date(Date.now() - 600_000 + 8_000),
      credits: 10,
      targetId: n2.id,
    },
  });
  await db.job.createMany({
    data: [
      {
        runId: bad.id,
        nodeId: n2.id,
        batch: 0,
        status: "failed",
        attempts: 2,
        lastError: "百炼限流或服务异常：Throttling.RateQuota",
        credits: 10,
      },
    ],
  });
  await db.runEvent.createMany({
    data: [
      {
        runId: bad.id,
        type: "log",
        payload: JSON.stringify({
          nodeId: n2.id,
          level: "warn",
          message: "第 1 次尝试失败（百炼限流），12000ms 后重试",
        }),
      },
      {
        runId: bad.id,
        type: "node.status",
        payload: JSON.stringify({ nodeId: n2.id, status: "failed", error: "限流" }),
      },
      {
        runId: bad.id,
        type: "run.status",
        payload: JSON.stringify({
          status: "failed",
          error: "1 个节点失败：限流",
          credits: 10,
          nodeCount: 1,
        }),
      },
    ],
  });
  await db.runEvent.createMany({
    data: [
      {
        runId: ok.id,
        type: "log",
        payload: JSON.stringify({
          nodeId: null,
          level: "info",
          message: "本次 2 个节点，消耗 20 积分（该项目累计 20 积分）",
        }),
      },
    ],
  });

  console.log(
    JSON.stringify(
      {
        projectId: project.id,
        nodes: [n1.id, n2.id],
        runs: { ok: ok.id, bad: bad.id },
      },
      null,
      2
    )
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
