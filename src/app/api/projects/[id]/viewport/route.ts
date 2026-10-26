import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";

// 保存视野（相机）。与 graph 分开一条路由，理由有三：
//
// 1. **频率不同**。拖一次画布、滚一次滚轮都会写一次；而图的结构性改动
//    （加节点、连线、改参数）远没这么频繁。混在一起写，等于每拖一下画布
//    就把整张图重传一遍。
// 2. **状态机不同**。`/graph` 会推进 canvasStore 的 dirty/revision，
//    右上角因此跳「保存中…」。视野变化不该让用户看到「你的项目没保存」——
//    它不是内容，看一眼不算改。
// 3. **失败无所谓**。写图失败必须让用户知道（否则丢内容）；写视野失败
//    最多是下次打开回到稍早一点的视角，不值得打断任何操作，所以这里
//    不返回给界面任何提示。
//
// 用 PUT 而不是 PATCH：语义上是「把视野整体替换成这三个数」，不是打补丁。

interface ViewportBody {
  centerX?: unknown;
  centerY?: unknown;
  span?: unknown;
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  let body: ViewportBody;
  try {
    body = (await req.json()) as ViewportBody;
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const { centerX, centerY, span } = body ?? {};
  if (!finite(centerX) || !finite(centerY) || !finite(span)) {
    return NextResponse.json(
      { error: "centerX / centerY / span 必须都是有限数字" },
      { status: 400 }
    );
  }
  // span 是除数（zoom = 画布宽 / span），0 会让还原时除出 Infinity，
  // 负数是没有任何物理意义的存档 —— 都当脏数据拒掉，而不是「顺手修正」，
  // 修正过的数会静默改变用户的构图。
  if (!(span > 0)) {
    return NextResponse.json({ error: "span 必须大于 0" }, { status: 400 });
  }

  // 用 updateMany 而不是 update：update 在记录不存在时抛 P2025，
  // 要另外 import Prisma 的错误类型来判断；updateMany 直接返回 count，
  // 少一层异常分支，也少一次「catch 到什么才算 404」的猜测。
  const r = await db.project.updateMany({
    where: { id: projectId },
    data: { viewCenterX: centerX, viewCenterY: centerY, viewSpan: span },
  });

  if (r.count === 0) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
