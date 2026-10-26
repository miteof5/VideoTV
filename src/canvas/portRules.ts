import { nodeRegistry, type ProducedKind } from "@/canvas/nodeRegistry";

/**
 * 端口层 —— 一条线能不能接，由**产物种类**决定，不由节点类型决定。
 *
 * ### 为什么需要这一层
 *
 * 放开「一对多 / 多对一」之后，连线器只剩一条限制：不成环。
 * 于是「视频节点的产物」可以被拖进「图像节点」—— 连线器放行，
 * 执行时图像模型拿到一个视频文件，只能靠 Provider 自己忽略或报错。
 * 这类错误发生在几十秒的模型调用之后，且报错信息里看不到「你连错了」。
 *
 * 有了这一层，错误在**手指抬起的那一刻**就被挡住，而且能说清为什么。
 *
 * ### 判的是种类，不是类型
 *
 * 「图生视频还是文生视频」这条规则（modeRule）已经用产物种类判断了。
 * 如果这里改用节点类型判断，两套判据迟早会打架：
 * 用户上传的图片是 `media.asset` 而不是 `image.gen`，
 * 按类型比对会同时漏掉它和「从别处接来的图」。
 *
 * 所以两边用同一个词：**这个节点产出什么种类的东西**。
 */

/** 连线校验要用到的最小节点形状（不依赖 React Flow 的完整类型） */
export interface PortEndpoint {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
}

export type PortCheck = { ok: true } | { ok: false; reason: string };

const KIND_LABEL: Record<ProducedKind, string> = {
  image: "图片",
  video: "视频",
  text: "文字",
};

/** 这个节点会产出什么。没声明 producedKind = 什么都不产出 */
export function producedKindOf(node: PortEndpoint): ProducedKind | null {
  const def = nodeRegistry[node.type ?? ""];
  if (!def?.producedKind) return null;
  return def.producedKind(node.data ?? {});
}

/** 这个节点接受哪些种类。返回 null 表示「不限制」 */
export function acceptedKindsOf(
  type: string | undefined
): ProducedKind[] | null {
  const def = nodeRegistry[type ?? ""];
  if (!def) return null;
  return def.accepts;
}

/**
 * 校验一条连线。
 *
 * 返回 reason 而不是抛异常：拒绝连线是**正常交互**（用户手滑），
 * 要把它显示成一条提示，不是一次崩溃。
 */
export function checkPort(source: PortEndpoint, target: PortEndpoint): PortCheck {
  if (source.id === target.id) {
    return { ok: false, reason: "节点不能连到自己" };
  }

  const targetDef = nodeRegistry[target.type ?? ""];
  const sourceDef = nodeRegistry[source.type ?? ""];

  // 注册表里没有的类型：交给 React Flow 自己兜底，这里不添乱
  if (!targetDef || !sourceDef) return { ok: true };

  const accepts = targetDef.accepts;
  if (accepts.length === 0) {
    return { ok: false, reason: `「${targetDef.label}」不接受输入` };
  }

  const kind = producedKindOf(source);

  /*
   * 上游什么都不产出，就无从判断。
   *
   * 这种情况确实存在：一个还没跑过的图像节点，产物为空。
   * 此时应该允许接线 —— 线表达的是「将会从这里取东西」，
   * 而不是「这里已经有东西了」。要是在这里拦截，
   * 用户就必须先跑上游才能连线，顺序被彻底绑死。
   */
  if (!kind) return { ok: true };

  if (accepts.includes(kind)) return { ok: true };

  return {
    ok: false,
    reason: `「${KIND_LABEL[kind]}」不能接进「${targetDef.label}」，它只接受${accepts
      .map((k) => KIND_LABEL[k])
      .join(" / ")}`,
  };
}
