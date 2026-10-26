import { NextResponse } from "next/server";
import { getRunSnapshot } from "@/lib/runService";

// 运行快照：给前端首屏用的「当前状态」。
// 之后的变化全走 SSE 增量 —— 快照 + 增量是实时界面的标准组合：
// 只靠增量，刷新页面就丢了历史；只靠轮询快照，又要承受无谓的请求压力。

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const snapshot = await getRunSnapshot(id);
  if (!snapshot) {
    return NextResponse.json({ error: "运行不存在" }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}
