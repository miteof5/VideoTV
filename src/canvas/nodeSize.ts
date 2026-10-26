import type { NodeDefinition } from "@/canvas/nodeRegistry";

/**
 * 产物在画布上的最长边上限（画布单位）。
 *
 * 为什么需要一个上限，而不是严格的「按图片本身大小」：
 * 生成图常见 1280×720，1:1 铺在画布上正好能看清；但手机原图能到 4000×3000，
 * 1:1 就是一个占满七八个屏幕的巨无霸，用户必须缩到 20% 才看得全。
 * 更麻烦的是「画布缩放比例」从此取决于每张图的像素数 —— 同样两倍缩放，
 * 在一张 400px 的图旁边和一张 4000px 的图旁边，看到的实物大小完全不同。
 *
 * ### 为什么是 1280，而不是别的数
 *
 * 1280 = 1280×720 的宽边，也就是注册表里图 / 视频 / 素材的**占位尺寸**。
 * 两者取同一个数，才能保证「标准 16:9 产物在画布上正好 1:1 显示」——
 * 空态框多大，生成完还是多大，节点不跳。
 *
 * 如果上限小于占位尺寸（曾经是 720），就会出现「生成好了反而变小一半」，
 * 而且图越大缩得越狠；如果上限更大，占位框就会小于产物框，生成完节点往外长一截。
 * 所以这两个数必须一起改 —— 它们是一对，不是一个独立的选择。
 *
 * 上限之外仍然**不放大**（scale 取 min(1, ...)）：一张 200×150 的缩略图
 * 铺成 1280 宽只会变糊，那不是「看清楚了」，是把小图拉成马赛克。
 */
export const MAX_ASSET_EDGE = 1280;

/**
 * 一个节点在画布上占多大。
 *
 * 两种来源，由注册表声明：
 *   固定尺寸（文本卡片）      → 永远返回 def.size
 *   跟产物走（图 / 视频 / 素材）→ 用产物像素尺寸等比缩到长边 ≤ MAX_ASSET_EDGE
 *
 * 为什么「跟产物走」需要把 measured 值存进 data：
 * 图片的像素尺寸只有浏览器解码后才知道。如果只在内存里存，
 * 每次刷新页面都会先按 400×250 渲染、图片加载完再跳一次最终尺寸 ——
 * 那一下跳变会让所有连线端点重算，视觉上整张图抖一下。
 * 存进 data 之后，第二次打开就是一次到位的。
 *
 * 注意这**收窄了**「尺寸恒定」那条老约束：现在是「每个节点的尺寸在产物确定后不变」，
 * 而不是「所有同类型节点一样大」。代价是产物变化时（换图、重新生成）
 * 会重测量一次；收益是图片终于能按自己的比例被看见。
 */
export function displaySize(
  def: Pick<NodeDefinition, "size" | "sizeFromAsset">,
  data: Record<string, unknown>
): { w: number; h: number } {
  if (!def.sizeFromAsset) return def.size;

  const nw = Math.round(Number(data.naturalW));
  const nh = Math.round(Number(data.naturalH));

  // 还没测出来（新节点 / 图片没加载成功 / 老数据）→ 用注册表里的占位尺寸。
  // 这是「安全的失败方式」：宁可先显示一个方框，也不要算出 NaN 宽高
  // 让节点在画布上直接消失。
  if (!Number.isFinite(nw) || !Number.isFinite(nh) || nw <= 0 || nh <= 0) {
    return def.size;
  }

  const scale = Math.min(1, MAX_ASSET_EDGE / Math.max(nw, nh));
  return {
    // 取整，避免 403.2px 这种亚像素宽度让 handle 落在半格上
    w: Math.max(1, Math.round(nw * scale)),
    h: Math.max(1, Math.round(nh * scale)),
  };
}
