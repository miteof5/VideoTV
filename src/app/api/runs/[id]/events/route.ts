import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { guard } from "@/lib/authz";

/**
 * 一次运行的逐条记录。
 *
 * RunEvent 本来就是按 seq 自增写的，读出来天然有序 —— 不需要再排序，
 * 也不该按 createdAt 排（同一毫秒内会并列，顺序就变成随机的）。
 *
 * 为什么解析 payload 再返回：payload 在库里是 JSON 字符串，
 * 让前端自己 JSON.parse 等于把「什么格式」这件事复制到第二个地方，
 * 将来加一种事件类型就要改两处。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: runId } = await params;

  const g = await guard();
  if (g.error) return g.error;

  // 归属条件直接写进查询：别人的 run 和不存在，在这里是同一件事
  const run = await db.run.findFirst({
    where: { id: runId, project: { ownerId: g.user.id } },
    select: { id: true, status: true, createdAt: true, endedAt: true, credits: true },
  });
  if (!run) {
    return NextResponse.json({ error: "运行不存在" }, { status: 404 });
  }

  const events = await db.runEvent.findMany({
    where: { runId },
    orderBy: { seq: "asc" },
    take: 500,
    select: { seq: true, type: true, payload: true },
  });

  return NextResponse.json({
    run,
    events: events.map((e) => ({
      seq: e.seq,
      type: e.type,
      payload: safeParse(e.payload),
    })),
  });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // 一条坏掉的事件不该让整个历史打不开。原样给出，前端当字符串显示。
    return { message: raw };
  }
}
