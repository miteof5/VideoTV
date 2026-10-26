import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";

// 画布整体保存（全量同步）。
// 为什么用 Route Handler 而不是 Server Action：
// 这是前端程序化、高频（防抖后仍可能每秒一次）、需要拿 JSON 响应的调用，
// Server Action 那种「提交表单 + 自动 revalidate」的模型并不合适。
//
// 为什么不用 incremental diff：画布改动密集且交叉，
// 全量同步（前端给最新全图，后端对齐）逻辑最简单、最不容易出不一致。

interface PayloadNode {
  id: string;
  type: string;
  positionX: number;
  positionY: number;
  data: Record<string, unknown>;
}

interface PayloadEdge {
  id: string;
  source: string;
  target: string;
  /** "" | image | endImage。缺省视为默认端口 */
  targetHandle?: string;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  const body = (await req.json()) as {
    nodes?: PayloadNode[];
    edges?: PayloadEdge[];
  };

  const nodes = body.nodes ?? [];
  const nodeIds = nodes.map((n) => n.id);

  // 丢弃指向不存在节点的边（例如前端删了节点但边还残留）
  const idSet = new Set(nodeIds);
  const edges = (body.edges ?? []).filter(
    (e) => idSet.has(e.source) && idSet.has(e.target)
  );

  const ops = [];

  // 边：没有运行时状态，全量替换最省事
  ops.push(db.edge.deleteMany({ where: { projectId } }));
  if (edges.length > 0) {
    ops.push(
      db.edge.createMany({
        data: edges.map((e) => ({
          id: e.id,
          projectId,
          source: e.source,
          target: e.target,
          // 空字符串而不是 null：SQLite 里 NULL 互不相等，
          // 唯一约束 @@unique([source, target, targetHandle]) 会对 NULL 失效
          targetHandle: e.targetHandle ?? "",
        })),
      })
    );
  }

  // 节点：不能全量替换！status / outputAssetId 是运行时状态，
  // 删了重建会把「已完成」清成「待运行」。所以走 upsert，只更新结构和参数。
  ops.push(
    nodeIds.length > 0
      ? db.node.deleteMany({ where: { projectId, id: { notIn: nodeIds } } })
      : db.node.deleteMany({ where: { projectId } })
  );

  for (const n of nodes) {
    ops.push(
      db.node.upsert({
        where: { id: n.id },
        update: {
          type: n.type,
          positionX: n.positionX,
          positionY: n.positionY,
          data: JSON.stringify(n.data ?? {}),
        },
        create: {
          id: n.id,
          projectId,
          type: n.type,
          positionX: n.positionX,
          positionY: n.positionY,
          data: JSON.stringify(n.data ?? {}),
        },
      })
    );
  }

  await db.$transaction(ops);

  return NextResponse.json({
    ok: true,
    saved: { nodes: nodes.length, edges: edges.length },
  });
}
