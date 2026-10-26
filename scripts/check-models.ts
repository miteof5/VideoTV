// 模型清单的三种环境自检。
//
// 目的是把「配了 key 但清单没变」这类问题在浏览器之外先排除掉 ——
// 那种故障的表现是界面上一片正常，只是真模型永远不出现。
//
// 用法（分别在三种 env 下跑）：
//   npx tsx scripts/check-models.ts
//   DASHSCOPE_API_KEY=sk-fake npx tsx scripts/check-models.ts
//   DASHSCOPE_API_KEY=sk-fake MODEL_PROVIDER=mock npx tsx scripts/check-models.ts

import { listModels, listProviders } from "@/providers/registry";

const all = listModels();
const real = all.filter((m) => !m.demo);
const demo = all.filter((m) => m.demo);

console.log("环境：", {
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY ? "已配置" : "未配置",
  MODEL_PROVIDER: process.env.MODEL_PROVIDER || "(空)",
  PROVIDER_DRY_RUN: process.env.PROVIDER_DRY_RUN || "(空)",
});

console.log(`\n清单共 ${all.length} 项：真实 ${real.length} / 演示 ${demo.length}`);
for (const m of all) {
  const caps = m.capabilities.join("+");
  const ar = m.options.aspectRatios?.join(" ") ?? "-";
  console.log(
    `  ${m.demo ? "演示" : "真实"}  ${m.id.padEnd(24)} ${m.label.padEnd(14)} ${caps.padEnd(6)} 比例[${ar}]`
  );
}

// 注册表里必须和清单逐条对齐。对不上说明 ensureRegistered 过滤规则
// 和 availableModels 的规则不一致 —— 那会导致「清单里有、跑起来说未注册」
const registered = new Set(listProviders().map((p) => p.id));
const missing = all.filter((m) => !registered.has(m.id));
console.log(`\n注册表实例 ${registered.size} 个，清单里缺实例：${missing.length ? missing.map((m) => m.id).join(", ") : "无"}`);

// 各能力的默认模型是谁 —— 这个决定「用户什么都不选时会用哪个」
for (const cap of ["text", "image", "video"] as const) {
  const first = listProviders(cap)[0];
  console.log(`默认 ${cap}：${first ? `${first.id}（${first.label}）` : "无"}`);
}

process.exit(missing.length > 0 ? 1 : 0);
