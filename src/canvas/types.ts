import type { Node } from "@xyflow/react";

// 为什么把类型单独抽一个文件：
// 之前 CanvasNodeData / CanvasNode 定义在 nodes/CanvasNode.tsx 里，
// 而 nodeRegistry 既要拿到这些类型、又要 import CanvasNode 组件本身，
// 于是形成 nodeRegistry ↔ CanvasNode 的循环 import。
//
// 循环依赖在 ESM 里「有时能用」是因为函数声明会被提升、且两边都只在
// 运行时才真正取对方的绑定。但只要哪天有一方在模块顶层就取值
// （比如 const X = nodeRegistry[...] 写在组件外面），就会拿到 undefined，
// 而且报错信息极其难懂。类型单独成文件后，类型那一路是 type-only、
// 编译期就被擦除，运行时依赖变成单向的，环自然消失。
//
// 规则：types.ts 只放类型，不 import 任何组件或注册表。

/**
 * 节点参数。
 * 必须有索引签名，才能满足 React Flow v12 对 Record<string, unknown> 的约束；
 * 同时它保证加新参数不必改 schema —— 参数整体以 JSON 存在 Node.data 列里。
 */
export type CanvasNodeData = {
  label: string;
  prompt: string;
  status: string;
  [key: string]: unknown;
};

export type CanvasNode = Node<CanvasNodeData>;
