import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { guard, ownedProject } from "@/lib/authz";
import { NODE_STATUS } from "@/lib/constants";

/** 允许从客户端写回的节点状态。只用于「撤销把节点放回来」那一种情况 */
const ALLOWED_STATUS = new Set<string>([
  NODE_STATUS.IDLE,
  NODE_STATUS.QUEUED,
  NODE_STATUS.RUNNING,
  NODE_STATUS.SUCCEEDED,
  NODE_STATUS.FAILED,
  NODE_STATUS.SKIPPED,
]);

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
  /**
   * 这个节点身上的产物。
   *
   * **只在「这一行不存在、要新建」的时候才会被采用**（见下面 upsert 的 create 分支）。
   * 用途只有一个：撤销把删掉的节点放回来时，产物引用要跟着回来 ——
   * 否则节点是回来了，图却没了，刷新之后更看不出来它曾经有图。
   *
   * 已有行永远由 Worker 写这两列，保存请求碰不到它们 ——
   * 那是一条比「撤销」重要得多的边界：保存一次画布不该改变运行结果。
   */
  outputAssetId?: string | null;
  status?: string | null;
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

  /*
   * 这里的校验顺序很关键：**在读 body 之前**。
   *
   * 画布保存的 body 可以很大（整张图的节点 + 边）。如果先解析再鉴权，
   * 就等于允许任何人对任何项目 id 发起一次几十 MB 的 JSON 解析 ——
   * 白送的内存和 CPU 消耗。先挡人，再看东西。
   */
  const g = await guard();
  if (g.error) return g.error;
  const owned = await ownedProject(projectId, g.user.id);
  if (!owned) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

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

  /*
   * 撤销回来的节点要带着产物。先把「这些产物到底存不存在、属不属于这个项目」
   * 查清楚 —— 用户可能已经在资产库里把那张图真删了，这时写进去是一个外键错误，
   * 整个保存会失败（连结构和位置都存不下），那就从一个「图没了」的小问题
   * 升级成「整个画布存不上」的大问题。
   */
  const wanted = nodes
    .map((n) => n.outputAssetId)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  const ownAssets =
    wanted.length > 0
      ? await db.asset.findMany({
          where: { id: { in: [...new Set(wanted)] }, projectId },
          select: { id: true },
        })
      : [];
  const ownAssetIds = new Set(ownAssets.map((a) => a.id));

  for (const n of nodes) {
    const restoreAsset =
      typeof n.outputAssetId === "string" && ownAssetIds.has(n.outputAssetId)
        ? n.outputAssetId
        : null;

    ops.push(
      db.node.upsert({
        where: { id: n.id },
        update: {
          type: n.type,
          positionX: n.positionX,
          positionY: n.positionY,
          data: JSON.stringify(n.data ?? {}),
          // 更新分支**不碰** status / outputAssetId：那是运行时状态，
          // 由 Worker 和撤销时的重建负责写（这条边界比撤销重要得多）
        },
        create: {
          id: n.id,
          projectId,
          type: n.type,
          positionX: n.positionX,
          positionY: n.positionY,
          data: JSON.stringify(n.data ?? {}),
          /*
           * 新建时才接受运行态。唯一会走到这里的业务场景就是「撤销把删掉的
           * 节点放回来」—— 那时这两列已经被删掉了，不写回去就会变成
           * 「节点在、图不在」，而用户按撤销的初衷正是不想重跑生成。
           */
          ...(restoreAsset
            ? {
                outputAssetId: restoreAsset,
                status: ALLOWED_STATUS.has(n.status ?? "")
                  ? (n.status as string)
                  : NODE_STATUS.SUCCEEDED,
              }
            : {}),
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
