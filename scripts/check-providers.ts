// 不调用模型，只验证「每个 impl 都能装配出 Provider」。
// 覆盖的是 registry.build() 的 switch 分支 —— 写错一个 case 名
// 的表现是「清单里有、点运行报未注册」，而那一刻才发现在几十秒之后。
import { availableModels } from "@/providers/catalog";
import { getProvider } from "@/providers/registry";

const all = availableModels(undefined, process.env);
let bad = 0;
for (const m of all) {
  try {
    const p = getProvider(m.id);
    const ok = p.capabilities.join(",") === m.capabilities.join(",");
    console.log(`${ok ? "OK  " : "MISMATCH"}  ${m.id.padEnd(28)} ${p.capabilities.join(",")}  options=${JSON.stringify(m.options.aspectRatios ?? [])}`);
    if (!ok) bad++;
  } catch (e) {
    bad++;
    console.log(`FAIL  ${m.id.padEnd(28)} ${e instanceof Error ? e.message : e}`);
  }
}
console.log(`\n${all.length} 个模型，${bad} 个装配失败`);
process.exit(bad ? 1 : 0);
