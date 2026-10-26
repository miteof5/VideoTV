/**
 * 节点上「两段文字」的语义边界 —— 全项目只在这里解释一次。
 *
 * ## 两个字段，两种身份
 *
 *   `prompt`           用户自己写的那句话。原始想法，人话，可能有错别字。
 *                      它住在**选中后浮出的面板**里，点一下就能改（像对话框）。
 *
 *   `optimizedPrompt`  AI 把上面那句话改写成「更适合喂给模型」的版本。
 *                      它住在**卡片主体**里，双击才能改（像记事本）。
 *
 * 为什么主内容（下游读到的、真正送去生成的那份）是 `optimizedPrompt`：
 * 用户写「雨夜街头一个女孩回头」，优化后可能是
 * 「cinematic shot, young woman turning back, rain-soaked neon street,
 *  shallow depth of field, 35mm」。后者才是模型要的，前者是给人看的。
 * 让两段话并存，用户既能回看自己的原意，又能用上改写结果。
 *
 * ## 为什么要有 mainText() 这个函数，而不是各处在用的时候写 `||`
 *
 * 主内容的取值点至少有三处：生成时（engine/plan）、下游拼提示词时
 * （engine/plan 的 composePrompt）、卡片显示时（CanvasNode）。
 * 三处各写一次 `optimizedPrompt || prompt`，迟早会漂移成
 * 「卡片显示优化版、下游却拿原文」，而且**不会有任何报错** ——
 * 症状只是生成出来的东西和画面上看到的文字对不上。
 *
 * ## 回退为什么必须存在
 *
 * 存量节点只有 `prompt`。严格只读 `optimizedPrompt` 的话，老项目里
 * 每个文本节点会瞬间变成空卡片，下游也拿不到字 —— 一次纯粹的「升级即数据丢失」。
 * 回退的语义正好也是对的：**没优化过，你写的就是最终版**。
 *
 * 不要 trim 返回值：这个字符串会进编辑器，首尾的空行是用户自己敲的，
 * 悄悄抹掉会让人以为光标位置乱了。（判空时才 trim。）
 */
export function mainText(data: Record<string, unknown> | null | undefined): string {
  const optimized = String(data?.optimizedPrompt ?? "");
  if (optimized.trim()) return optimized;
  return String(data?.prompt ?? "");
}

/**
 * 这段主文本是不是 AI 改过的。
 *
 * 判据是「和原文不一样」，不是「字段有值」。理由：用户双击卡片手改之后，
 * 内容已经全是自己写的了，再挂一个「已优化」标签是撒谎。
 * 手改回与原文相同也一样 —— 一样就谈不上改写。
 */
export function isOptimized(data: Record<string, unknown> | null | undefined): boolean {
  const optimized = String(data?.optimizedPrompt ?? "").trim();
  if (!optimized) return false;
  return optimized !== String(data?.prompt ?? "").trim();
}
