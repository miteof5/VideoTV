// 防环检测。
// 为什么必须做：创作流程是 DAG，环意味着「镜头 A 等镜头 B，镜头 B 又等镜头 A」，
// 拓扑排序会永远卡死。而且必须在用户连线的瞬间就拦掉，
// 等到运行期才发现，用户已经搭了半天工作流了。

export interface GraphEdge {
  source: string;
  target: string;
}

/**
 * 判断新增一条 source -> target 的边是否会形成环。
 *
 * 原理：新边闭合出环，当且仅当**从 target 出发，沿已有边能走回 source**。
 * 因为新边会把 source 接到 target 前面，而 target 本来就已经能到达 source，
 * 于是一进一出正好绕成一圈。
 */
export function wouldCreateCycle(
  edges: GraphEdge[],
  source: string,
  target: string
): boolean {
  // 自环：直接拒绝
  if (source === target) return true;

  const adjacency = buildAdjacency(edges);

  const visited = new Set<string>();
  const stack: string[] = [target];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const nexts = adjacency.get(current);
    if (nexts) stack.push(...nexts);
  }

  return false;
}

/** source -> 它直接指向的所有 target */
export function buildAdjacency(edges: GraphEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.source);
    if (list) list.push(edge.target);
    else adjacency.set(edge.source, [edge.target]);
  }
  return adjacency;
}

/**
 * 给一批节点按依赖分批（Kahn 拓扑排序）。
 * M2 暂不使用，M5 执行引擎会用它决定哪些节点可以并行跑。
 * 返回值：每个元素是一个批次，同批次内互不依赖；长度不足节点总数说明图里有环。
 */
export function topoSortBatches(
  nodeIds: string[],
  edges: GraphEdge[]
): string[][] {
  const indegree = new Map<string, number>();
  for (const id of nodeIds) indegree.set(id, 0);

  const adjacency = buildAdjacency(edges);
  for (const edge of edges) {
    // 只统计图内存在的节点
    if (indegree.has(edge.target)) {
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    }
  }

  const batches: string[][] = [];
  let frontier = nodeIds.filter((id) => (indegree.get(id) ?? 0) === 0);

  while (frontier.length > 0) {
    batches.push(frontier);
    const next: string[] = [];

    for (const id of frontier) {
      for (const downstream of adjacency.get(id) ?? []) {
        if (!indegree.has(downstream)) continue;
        const left = (indegree.get(downstream) ?? 0) - 1;
        indegree.set(downstream, left);
        if (left === 0) next.push(downstream);
      }
    }

    frontier = next;
  }

  return batches;
}
