import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { guard, ownedProject } from "@/lib/authz";

/**
 * 这个项目跑过哪些次。
 *
 * 只读、只列最近 30 条：运行历史是给人翻的，不是导出工具。
 * 一条都不删 —— 删不删是以后单独的决定，不在这里顺手做掉。
 *
 * 为什么不像 `/api/runs/[id]` 那样分成两个接口：
 * 列表要的是「每次一行」，明细要的是「那次里面发生了什么」，
 * 两者的查询形状差很远（一次聚合 vs 逐个事件的 payload）。
 * 列表把明细一起带上，等于打开抽屉就拉了三十次运行的全部日志。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  // 先确认项目是他的，再查运行记录。
  // 反过来的话（先查 runs 再验证）即使最后返回 404，数据也已经读进内存了。
  const g = await guard();
  if (g.error) return g.error;
  const project = await ownedProject(projectId, g.user.id);
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const runs = await db.run.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      status: true,
      createdAt: true,
      endedAt: true,
      credits: true,
      targetId: true,
      jobs: { select: { status: true, lastError: true } },
    },
  });

  /*
   * 目标节点的名字要一起带回去。
   *
   * 不带的话，列表只能显示「3 个节点」——用户看不出这次跑的是画面上的哪个东西，
   * 而这恰恰是他翻历史时最想认出来的那个信息。
   * targetId 可能指向一个已经被删掉的节点，所以查完要允许对不上。
   */
  const targetIds = [...new Set(runs.map((r) => r.targetId).filter(Boolean))] as string[];
  const targets =
    targetIds.length > 0
      ? await db.node.findMany({
          where: { id: { in: targetIds } },
          select: { id: true, data: true },
        })
      : [];

  const labelOf = new Map<string, string>();
  for (const t of targets) {
    try {
      const data = JSON.parse(t.data) as { label?: unknown };
      labelOf.set(t.id, typeof data.label === "string" ? data.label : "");
    } catch {
      labelOf.set(t.id, "");
    }
  }

  return NextResponse.json({
    runs: runs.map((r) => {
      const failed = r.jobs.filter((j) => j.status === "failed");
      return {
        id: r.id,
        status: r.status,
        createdAt: r.createdAt,
        endedAt: r.endedAt,
        credits: r.credits,
        nodeCount: r.jobs.length,
        failedCount: failed.length,
        // 列表上直接给出第一条错误：翻历史时「那次为什么红」是第一问题，
        // 让他点进去再找会多一步，而且点进去看到的是一堆日志。
        error: failed[0]?.lastError ?? null,
        target: r.targetId
          ? { id: r.targetId, label: labelOf.get(r.targetId) ?? "" }
          : null,
      };
    }),
  });
}
