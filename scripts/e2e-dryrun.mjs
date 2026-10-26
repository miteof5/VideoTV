// 干跑验收：验证真模型链路拼出来的请求体长什么样，一张额度都不花。
//
// 为什么需要这个脚本：真跑一次要扣一张额度（总共只有个位数张），
// 而最容易错的地方恰恰在「发出去之前」——模型名拼错、size 算错、
// 上游那张图没变成 base64。这三样错了，真跑会失败或出一张无关的图，
// 而界面上完全看不出来。
//
// 前置条件：worker 必须以 PROVIDER_DRY_RUN=1 启动。
//   PROVIDER_DRY_RUN=1 npm run worker

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const PROJECT_NAME = "__dryrun_e2e__";

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `\n         ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rfc3339(d = new Date()) {
  // Prisma 在 SQLite 里存 "+00:00" 结尾的 RFC3339，不是 ISO 的 Z
  return d.toISOString().replace("Z", "+00:00");
}
function newId(p) {
  return `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function cleanup(db) {
  const old = db.prepare("select id from Project where name = ?").all(PROJECT_NAME);
  for (const { id } of old) {
    const assets = db
      .prepare(
        "select a.id, a.filePath from Asset a join Node n on n.'outputAssetId' = a.id where n.projectId = ?"
      )
      .all(id);
    for (const a of assets) {
      const p = path.join("storage", a.filePath);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      db.prepare("delete from Asset where id = ?").run(a.id);
    }
    db.prepare("delete from RunEvent where runId in (select id from Run where projectId = ?)").run(id);
    db.prepare("delete from Job where runId in (select id from Run where projectId = ?)").run(id);
    db.prepare("delete from Run where projectId = ?").run(id);
    db.prepare("delete from Edge where projectId = ?").run(id);
    db.prepare("delete from Node where projectId = ?").run(id);
    db.prepare("delete from Project where id = ?").run(id);
  }
}

/** 拿一张现成的 png 复制成测试资产，用来验证「上游图会不会变成 base64」 */
function seedAsset(db) {
  const src = fs
    .readdirSync("storage/assets/2026/10")
    .find((f) => f.endsWith(".png"));
  if (!src) throw new Error("storage 里没有可用的 png，先跑一次演示图像");

  const id = newId("drya");
  const rel = `assets/2026/10/dryrun-${id}.png`;
  fs.copyFileSync(
    path.join("storage/assets/2026/10", src),
    path.join("storage", rel)
  );
  const size = fs.statSync(path.join("storage", rel)).size;

  db.prepare(
    "insert into Asset (id, kind, mimeType, filePath, sizeBytes, createdAt) values (?,?,?,?,?,?)"
  ).run(id, "image", "image/png", rel, size, rfc3339());

  return { id, size };
}

async function main() {
  const db = new Database("dev.db");
  cleanup(db);

  const now = rfc3339();
  const projectId = newId("dryp");
  db.prepare("insert into Project (id,name,createdAt,updatedAt) values (?,?,?,?)").run(
    projectId,
    PROJECT_NAME,
    now,
    now
  );

  const asset = seedAsset(db);
  const assetNodeId = newId("dryn");
  const genNodeId = newId("dryn");

  const insertNode = db.prepare(
    `insert into Node (id, projectId, type, positionX, positionY, data, status, createdAt, updatedAt)
     values (?,?,?,?,?,?,?,?,?)`
  );

  // 上游：一张"用户上传"的素材
  insertNode.run(
    assetNodeId, projectId, "media.asset", 0, 0,
    JSON.stringify({
      label: "测试素材",
      prompt: "",
      status: "idle",
      assetId: asset.id,
      assetKind: "image",
      assetMime: "image/png",
      assetName: "dryrun.png",
    }),
    "idle", now, now
  );

  // 下游：用最省的那个真模型，选 9:16 验证尺寸换算不是硬编码 16:9
  insertNode.run(
    genNodeId, projectId, "image.gen", 600, 0,
    JSON.stringify({
      label: "干跑图片",
      prompt: "一只橘猫坐在窗台上",
      negativePrompt: "模糊，低质量",
      modelId: "qwen-image-3.0",
      aspectRatio: "9:16",
      status: "idle",
    }),
    "idle", now, now
  );

  db.prepare(
    "insert into Edge (id, projectId, source, target, targetHandle) values (?,?,?,?,'')"
  ).run(newId("drye"), projectId, assetNodeId, genNodeId);

  db.close();

  // ---- 触发运行 ----
  const res = await fetch(`${BASE}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, mode: "node", targetId: genNodeId }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`提交运行失败：${JSON.stringify(body)}`);
  const runId = body.runId;

  // ---- 等结束 ----
  const db2 = new Database("dev.db", { readonly: true });
  let status = "";
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const row = db2.prepare("select status from Run where id = ?").get(runId);
    status = row?.status ?? "";
    if (status && status !== "running" && status !== "queued") break;
  }

  const events = db2
    .prepare("select type, payload from RunEvent where runId = ? order by seq")
    .all(runId)
    .map((r) => ({ type: r.type, ...JSON.parse(r.payload) }));

  const logs = events.filter((e) => e.type === "log").map((e) => e.message ?? "");
  const node = db2
    .prepare("select status, error, outputAssetId from Node where id = ?")
    .get(genNodeId);
  const jobCount = db2
    .prepare("select count(*) c from Job where runId = ?")
    .get(runId).c;
  db2.close();

  fs.mkdirSync(".e2e-tmp", { recursive: true });
  fs.writeFileSync(".e2e-tmp/dryrun-logs.txt", logs.join("\n---\n"), "utf8");

  console.log(`\nrun=${runId} 终态=${status}\n`);
  console.log("─── 运行日志 ───");
  for (const l of logs) console.log("  " + l.replace(/\n/g, "\n  "));
  console.log("───────────────\n");

  const dryLine = logs.find((m) => m.includes("DRY RUN")) ?? "";

  check("运行结束", status === "succeeded", `终态 ${status}`);
  check("节点没有报错", !node?.error, node?.error ?? "");
  check("出现了 DRY RUN 日志", Boolean(dryLine));

  // 请求体三件事：模型名、尺寸、上游图
  check("请求体里的模型名正确", dryLine.includes("qwen-image-3.0"));
  check(
    "9:16 换算成 928*1664（不是硬编码 16:9）",
    dryLine.includes("928*1664"),
    dryLine.match(/"size":"[^"]*"/)?.[0] ?? "没找到 size"
  );
  check(
    "上游那张图变成了 base64 data URL",
    /data:image\/png;base64/.test(dryLine),
    dryLine.match(/data:image\/png;base64[^"]*/)?.[0]?.slice(0, 40) ?? "没找到 data URL"
  );
  check("负向提示词进了请求体", dryLine.includes("模糊，低质量"));
  check("提示词进了请求体", dryLine.includes("一只橘猫坐在窗台上"));

  // dry run 也要真的落盘一张图，否则「链路跑通」是假的
  const assetId = node?.outputAssetId;
  check("产物已落盘并关联到节点", Boolean(assetId), "dry run 走完整链路才会产生 outputAssetId");

  // node 模式只跑目标节点，不该把上游素材也排进去
  check("只排了 1 个 job（上游素材直接复用）", jobCount === 1, `实际 ${jobCount} 个`);

  // 演示项目不能被污染
  const db3 = new Database("dev.db", { readonly: true });
  const stray = db3.prepare("select count(*) c from Project where name = ?").get(PROJECT_NAME);
  db3.close();

  console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}（${passed} 通过）`);
  console.log(`测试项目 ${PROJECT_NAME} 保留在库里，方便打开界面看：${BASE}/projects/${projectId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
