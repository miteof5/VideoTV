import type { NodeTypes } from "@xyflow/react";
import { nodeRegistry } from "@/canvas/nodeRegistry";
import { CanvasNode } from "@/canvas/nodes/CanvasNode";

// 传给 React Flow 的 nodeTypes 映射。
//
// 为什么从 nodeRegistry 里挪出来：nodeRegistry 是「元数据」，
// CanvasNode 是「渲染组件」，把两者放在同一个文件会让 CanvasNode
// （它要读注册表拿 label/配色）和注册表形成循环 import。
// 这里做「装配层」，单向依赖两边，环就断了。
//
// ### 为什么用注册表推导，而不是手写三条
//
// 手写过一版：每加一种节点都得记得来这里补一行。加「素材」节点时就漏了，
// 症状是 React Flow 打一行「Node type "media.asset" not found」然后
// 用兜底渲染 —— 节点在画布上长得像一张白纸，既不报错也不崩，
// 排查时得去翻浏览器控制台才看得到。
//
// 从注册表推导后，加类型的动作只剩「注册表加一项」，
// 而这本来就必须做（不然引擎也不认识它）。
//
// 将来某类节点需要**专属 UI** 时，在这里按类型覆盖即可 ——
// 推导出来的默认值全是 CanvasNode，覆盖一行就够。
const shared: NodeTypes = Object.freeze(
  Object.fromEntries(Object.keys(nodeRegistry).map((type) => [type, CanvasNode]))
) as NodeTypes;

export const reactFlowNodeTypes: NodeTypes = Object.freeze({
  ...shared,
  // 例：将来 image.gen 有自己的组件时写在这里
  // [NODE_TYPE.IMAGE_GEN]: ImageNode,
}) as NodeTypes;
