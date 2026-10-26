import { NextResponse } from "next/server";
import { cancelRun } from "@/lib/runService";

// 取消运行。
//
// 这里**不直接杀进程**，只把 Run 标成 cancelled：
// 真正在跑的 Provider 由 Worker 的 AbortSignal 去中断。
// 这个分工很重要 —— API 层不知道有哪些任务在跑（它们不在请求上下文里），
// 唯一能沟通的地方就是数据库。
//
// 也正因如此，取消不是瞬时的：Worker 最多 800ms 后才会看到标记。
// 前端点了取消要立刻把状态改掉（乐观更新），不能干等服务端回话。

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  await cancelRun(id);
  return NextResponse.json({ ok: true });
}
