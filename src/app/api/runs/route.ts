import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { createRun } from "@/lib/runService";

// 提交运行。
//
// 这个接口最重要的性质：**立即返回**。
// 整个设计的前提就是「模型调用不能发生在请求上下文里」——
// 一个视频生成可能要跑三五分钟，让 HTTP 请求挂在那里等，
// 网关会超时、连接会被回收、用户刷新页面就前功尽弃。
// 所以这里只做一件事：把计划写进数据库，然后马上把 runId 还回去。

const MODES = ["node", "branch"] as const;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    projectId?: string;
    mode?: string;
    targetId?: string;
    action?: string;
  };
  const projectId = body.projectId;

  if (!projectId) {
    return NextResponse.json({ error: "缺少 projectId" }, { status: 400 });
  }

  /*
   * mode 必须显式给，不再有默认值。
   *
   * 以前的 `body.mode ?? "all"` 是个隐患：任何调用方忘了传 mode，
   * 就会静默变成「跑全图」——最贵的那种执行方式，却没有一句提示。
   * 「运行全部」入口删掉之后，默认值也没有存在的理由了。
   */
  const mode = body.mode;
  if (!mode || !MODES.includes(mode as (typeof MODES)[number])) {
    return NextResponse.json(
      { error: `未知的执行方式：${mode ?? "(空)"}` },
      { status: 400 }
    );
  }
  // node / branch 都指向一个具体节点，缺了就无从下手。
  // 在入口挡掉，比让 buildPlan 抛一个更底层的信息更好读。
  if (!body.targetId) {
    return NextResponse.json(
      { error: `${mode} 模式必须指定 targetId` },
      { status: 400 }
    );
  }

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  try {
    const result = await createRun(projectId, {
      mode: mode as "node" | "branch",
      targetId: body.targetId,
      action: body.action,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 这里是真实的用户输入错误（空画布、图里有环），不是服务端故障。
    // 用 400 而不是 500：前端要把它原样显示给用户看。
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
