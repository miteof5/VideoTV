// 真实调用一次百炼，验证 key / 端点 / 响应解析这条真链路。
//
// 这一步会**消耗 1 张额度**。为什么还要做：dry run 只能证明请求体拼对了，
// 证明不了 key 有效、端点没变、返回结构和文档一致。这三样只要错一样，
// 「接真模型」就是没接上，而界面上看起来一切正常。
//
// 失败的调用不占免费额度（官方规则），所以真有问题是安全的。

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const PROJECT_NAME = "__dryrun_e2e__";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = new Database("dev.db");
  const project = db.prepare("select id from Project where name = ?").get(PROJECT_NAME);
  if (!project) throw new Error(`找不到测试项目 ${PROJECT_NAME}，先跑 e2e-dryrun.mjs`);

  const node = db
    .prepare("select id, data from Node where projectId = ? and type = 'image.gen'")
    .get(project.id);
  if (!node) throw new Error("测试项目里没有 image.gen 节点");

  // 重置节点，让它能再跑一次。产物留着不影响 —— 成功后会覆盖
  db.prepare("update Node set status = 'idle', error = null where id = ?").run(node.id);
  db.close();

  const data = JSON.parse(node.data);
  console.log(`模型=${data.modelId} 比例=${data.aspectRatio} 提示词=${data.prompt}\n`);

  const res = await fetch(`${BASE}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: project.id, mode: "node", targetId: node.id }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  const runId = body.runId;

  const db2 = new Database("dev.db", { readonly: true });
  let status = "";
  const t0 = Date.now();
  for (let i = 0; i < 180; i++) {
    await sleep(500);
    status = db2.prepare("select status from Run where id = ?").get(runId)?.status ?? "";
    process.stdout.write(`\r等待中… ${((Date.now() - t0) / 1000).toFixed(0)}s  ${status}   `);
    if (status && status !== "running" && status !== "queued") break;
  }
  console.log("");

  const events = db2
    .prepare("select type, payload from RunEvent where runId = ? order by seq")
    .all(runId)
    .map((r) => ({ type: r.type, ...JSON.parse(r.payload) }));
  const after = db2
    .prepare("select status, error, outputAssetId from Node where id = ?")
    .get(node.id);
  const asset = after?.outputAssetId
    ? db2.prepare("select kind, mimeType, filePath, sizeBytes from Asset where id = ?")
        .get(after.outputAssetId)
    : null;
  db2.close();

  console.log("\n─── 运行日志 ───");
  for (const e of events) {
    if (e.type === "log") console.log("  " + String(e.message).replace(/\n/g, "\n  "));
  }
  console.log("───────────────\n");

  console.log(`终态：${status}   耗时：${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (after?.error) {
    console.log(`错误：${after.error}`);
  }
  if (asset) {
    console.log(
      `产物：${asset.kind} ${asset.mimeType} ${(asset.sizeBytes / 1024).toFixed(1)}KB  ${asset.filePath}`
    );

    // 从 PNG 的 IHDR 读真实像素尺寸 —— 这是「模型真的按 9:16 出图」的唯一硬证据
    const abs = path.join("storage", asset.filePath);
    if (fs.existsSync(abs)) {
      const buf = fs.readFileSync(abs);
      if (buf.slice(1, 4).toString() === "PNG") {
        const w = buf.readUInt32BE(16);
        const h = buf.readUInt32BE(20);
        console.log(`实际像素：${w}×${h}  （期望 928×1664）`);
        console.log(
          w === 928 && h === 1664 ? "  ✓ 尺寸与请求一致" : "  ✗ 尺寸和请求对不上"
        );
      }
    }
    console.log(`\n看图：${BASE}/api/assets/${after.outputAssetId}`);
    console.log(`看画布：${BASE}/projects/${project.id}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
