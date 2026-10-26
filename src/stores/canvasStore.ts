"use client";

import { create } from "zustand";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import type { CanvasNode, CanvasNodeData } from "@/canvas/types";
import { nodeRegistry } from "@/canvas/nodeRegistry";
import { checkPort } from "@/canvas/portRules";
import { wouldCreateCycle } from "@/engine/cycleDetect";

// 为什么用 Zustand 而不是 React useState：
// 1. 拖拽时 React Flow 每秒派发几十次 position change，用 useState 会让整棵画布树反复重渲染；
//    Zustand 支持按选择器订阅，只让真正变化的组件更新。
// 2. store 可以在组件外读写（getState/setState），保存逻辑不必塞进 React 生命周期。
// 3. 它天然把「内存态」和「持久态」分开了 —— 内存高频更新，落库低频防抖。

interface CanvasState {
  projectId: string;
  nodes: CanvasNode[];
  edges: Edge[];
  dirty: boolean;
  /**
   * 结构性改动的版本号，每次改动自增。
   *
   * 这是为了解决一个真实的竞态：保存请求是异步的，请求飞在路上时用户
   * 可能又拖了一下节点。如果响应回来时无条件把 dirty 清掉，
   * 这次新改动就被误判成「已保存」而永久丢失（定时器也被清掉了，不会再重试）。
   *
   * 有了版本号，保存成功时先比对：版本没变才敢清 dirty；变过就保持脏，
   * 让防抖逻辑再存一次。
   */
  revision: number;
  lastError: string | null;

  init: (projectId: string, nodes: CanvasNode[], edges: Edge[]) => void;
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (
    type: string,
    position: { x: number; y: number },
    overrides?: Record<string, unknown>
  ) => void;
  /** 改某个节点的参数（data）。只动 data，位置和运行时状态不受影响 */
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void;
  setError: (msg: string | null) => void;
  /** 仅当传入的版本仍是最新版本时才清除 dirty */
  markSaved: (revision: number) => void;
}

/**
 * 老数据的边没有 targetHandle（加端口之前存的）。
 *
 * 不补的话，视频节点上那两条历史连线会找不到归属的 handle ——
 * React Flow 会把它挂到第一个同名上或者干脆不画，表现是「线凭空消失」。
 * 这里统一归到目标节点的第一个具名端口上，也就是它的主输入。
 */
function normalizeEdgeHandles(edges: Edge[], nodes: CanvasNode[]): Edge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return edges.map((e) => {
    const ports = nodeRegistry[byId.get(e.target)?.type ?? ""]?.inputs ?? [];

    // 单端口节点：任何具名 targetHandle 都归到默认端口
    if (ports.length === 0) {
      return e.targetHandle ? { ...e, targetHandle: "" } : e;
    }

    const key = e.targetHandle ?? "";
    // 老数据没写端口 → 归到主输入
    if (!key) return { ...e, targetHandle: ports[0].key };

    /**
     * 端口已经不存在了（视频的「尾帧」被取消就是这种情况）→ 归到主输入。
     *
     * 不这么做的话 React Flow 找不到这个 handle，那条线会**凭空消失** ——
     * 数据库里还在、界面上没有了，用户会以为上游没接上，反复重连。
     */
    if (!ports.some((p) => p.key === key)) {
      return { ...e, targetHandle: ports[0].key };
    }

    return e;
  });
}

let seq = 0;
function nextNodeId() {
  // id 由前端生成：React Flow 需要稳定 id，
  // 保存时后端又用它当 upsert 的主键，一举两得。
  return `n_${Date.now().toString(36)}${(seq++).toString(36)}`;
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  projectId: "",
  nodes: [],
  edges: [],
  dirty: false,
  revision: 0,
  lastError: null,

  init: (projectId, nodes, edges) =>
    set({
      projectId,
      nodes,
      edges: normalizeEdgeHandles(edges, nodes),
      dirty: false,
      revision: 0,
      lastError: null,
    }),

  // 拖拽期间这里会被高频调用。只更新内存，绝不发请求。
  onNodesChange: (changes) => {
    const nodes = applyNodeChanges(changes, get().nodes);
    // 纯选中（select）和首次测量尺寸（dimensions）不算改动，不该触发保存
    const structural = changes.some(
      (c) => c.type !== "select" && c.type !== "dimensions"
    );
    if (!structural) {
      set({ nodes });
      return;
    }
    set({ nodes, dirty: true, revision: get().revision + 1 });
  },

  onEdgesChange: (changes) => {
    set({
      edges: applyEdgeChanges(changes, get().edges),
      dirty: true,
      revision: get().revision + 1,
    });
  },

  // 连线入口：成环一律拒绝
  onConnect: (connection) => {
    const { source, target, targetHandle } = connection;
    if (!source || !target) return;

    if (wouldCreateCycle(get().edges, source, target)) {
      set({ lastError: "这条连线会形成循环依赖，已阻止" });
      return;
    }

    /*
     * 端口层校验：种类对不上就当场拒绝，并说清为什么。
     *
     * 这里必须查，不能指望执行引擎兜 —— 引擎拿到一个用不了的输入时
     * 只能静默忽略或者报一个看不懂的错，而那时已经过了几十秒的模型调用。
     * 手指抬起的那一刻拦下来，用户还连着因果。
     */
    const byId = new Map(get().nodes.map((n) => [n.id, n]));
    const verdict = checkPort(byId.get(source) ?? { id: source }, byId.get(target) ?? { id: target });
    if (!verdict.ok) {
      set({ lastError: verdict.reason });
      return;
    }

    /*
     * 不做任何去重：一个节点可以连出去多条（一对多），也可以被多条连进来（多对一）。
     *
     * 曾经这里有个「同一端口只能接一条，新线顶掉旧线」的规则 ——
     * 那是给「首帧 / 尾帧」设计的，首帧确实不可能有两个。
     * 但端口统一成单个之后，这条规则只剩下伤害：
     * 「多段文字一起喂给一个生成节点」「一张图同时给两个视频当首帧」
     * 这些用法全被它砍掉了。用户想换掉某条线，自己删就行。
     *
     * 唯一保留的限制是成环（上面那句 wouldCreateCycle）：
     * 那不是偏好问题，是 DAG 的定义，环会让拓扑排序无从下手。
     */
    /*
     * 不加 animated：那是 React Flow 的「流动虚线」，语义是"数据正在传输"。
     * 这里的线表示"这块素材从哪来"，是静态的归属关系 ——
     * 让整张画布的线一直在流动，只会把注意力从产物上抢走。
     *
     * 更关键的是它无法保持一致：数据库不存这个字段，
     * 刷新后从库里读回来的边就没有 animated —— 于是"刚连的线在动、老线不动"。
     * 一个刷新就变样的样式，说明它当初就是随手加的，不值得留。
     */
    set({
      edges: addEdge(connection, get().edges),
      dirty: true,
      revision: get().revision + 1,
      lastError: null,
    });
  },

  addNode: (type, position, overrides) => {
    const def = nodeRegistry[type];
    if (!def) return;
    set({
      nodes: [
        ...get().nodes,
        {
          id: nextNodeId(),
          type,
          position,
          // overrides 用于「带内容出生」的节点：文本动作的结果不是空白卡片，
          // 它一出生就带着模型产出的那段文字。先建后改会闪一下空卡片。
          data: { ...def.defaultData(), ...(overrides ?? {}) },
        } as CanvasNode,
      ],
      dirty: true,
      revision: get().revision + 1,
    });
  },

  // 节点参数编辑（M3）。
  // 和 onNodesChange 一样只改内存，落库交给 Canvas 的防抖。
  // 节点不存在时直接忽略 —— 面板卸载时会 flush 一次草稿，
  // 而此时节点可能已经被删掉了，不能因此把画布标脏。
  updateNodeData: (id, patch) => {
    const { nodes } = get();
    const target = nodes.find((n) => n.id === id);
    if (!target) return;

    set({
      nodes: nodes.map((n) =>
        n.id === id
          ? ({ ...n, data: { ...n.data, ...patch } } as CanvasNode)
          : n
      ),
      dirty: true,
      revision: get().revision + 1,
    });
  },

  // 这里刻意不提供 removeNode / removeSelected。
  // 删除统一走 React Flow 的 deleteElements：它会自动把挂在节点上的边一起删掉，
  // 再把 change 回灌给 onNodesChange / onEdgesChange，store 只是被动同步。
  // 自己再写一套删除逻辑，很容易出现「节点没了、悬空边还留在库里」的不一致。

  setError: (msg) => set({ lastError: msg }),

  markSaved: (revision) => {
    if (get().revision !== revision) {
      // 保存期间又有改动：保持 dirty，让防抖逻辑再存一次
      return;
    }
    set({ dirty: false });
  },
}));
