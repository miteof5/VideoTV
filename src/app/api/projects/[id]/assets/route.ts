import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { assetRelPath, writeFileAtomic } from "@/lib/storage";
import { ASSET_KIND } from "@/lib/constants";

// 素材上传。
//
// 只负责「文件 → Asset 记录 + 已落盘的文件」，**不创建节点**。
// 节点是画布的事：坐标、避让、落库都由前端 store 管，
// 服务端在这里建节点等于把画布布局knowledge 搬进后端，之后必然打架。
//
// 落盘顺序沿用 assetService 的约定：先定 id（文件名要用）→ 写文件 → 再写库。
// 反过来的话，中途崩了会留下一条指向不存在文件的记录，前端拿到 id 去请求
// 就是 404，表现为「图裂了」；而现在最坏只是留下一个孤儿文件。

/**
 * 大小上限。按种类分开定，因为两者的合理量级差一个数量级。
 *
 * 这是**本地单机**的务实上限，不是产品级的最终形态。
 * 现在的实现会把整个文件读进内存再落盘（Next 的 formData 就是这么工作的），
 * 所以视频定得保守一些。真做产品要换成「前端直传对象存储 + 服务端只收
 * 一个回调」的签名 URL 方案，那时这个上限由对象存储和后端策略决定。
 */
const MAX_BYTES = {
  [ASSET_KIND.IMAGE]: 20 * 1024 * 1024,
  [ASSET_KIND.VIDEO]: 150 * 1024 * 1024,
};

/**
 * mime → 存盘扩展名。
 *
 * 为什么**不**从用户给的文件名里取扩展名：
 * 文件名是用户完全可控的输入，而它会被拼进磁盘路径。虽然这里会做正则过滤，
 * 但「扩展名只由 mimeType 决定」这条规则更简单 —— 少一处需要论证安不安全的输入。
 */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

/**
 * 只收图片和视频。
 *
 * 明确排除 image/svg+xml：SVG 能内嵌 <script>，在 <img> 里不会执行，
 * 但用户完全可能把 /api/assets/<id> 直接贴到地址栏打开 ——
 * 那时它就是一个能跑脚本的页面。
 */
function kindOf(mime: string): string | null {
  if (mime === "image/svg+xml") return null;
  if (mime.startsWith("image/")) return ASSET_KIND.IMAGE;
  if (mime.startsWith("video/")) return ASSET_KIND.VIDEO;
  return null;
}

function formatMb(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/**
 * 列出这个项目的资产。
 *
 * ### 为什么在服务端算「被几个节点用着」
 *
 * 前端要这个东西才能拦下「删掉一个正在用的图」。但引用有两种存法：
 *   - 生成产物：`Node.outputAssetId`（独立的列）
 *   - 上传的素材：`Node.data.assetId`（JSON 里的一格）
 * 只认一种，就会有一半的资产显示「没被使用」，删下去画布上那张图变成空白。
 *
 * 所以这里一次把项目里的节点都读出来，两种引用都数一遍。
 * 项目级的节点量是几十到几百，一次全读远比分页查更简单、也不会错。
 *
 * 上限 500 条：资产库是给人翻的，不是导出工具。真要过千再谈分页。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  const [assets, nodes] = await Promise.all([
    db.asset.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 500,
      select: {
        id: true,
        kind: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
      },
    }),
    db.node.findMany({
      where: { projectId },
      select: { data: true, outputAssetId: true },
    }),
  ]);

  // assetId → 引用它的节点数
  const usedBy = new Map<string, number>();
  const bump = (id: string | null | undefined) => {
    if (!id) return;
    usedBy.set(id, (usedBy.get(id) ?? 0) + 1);
  };
  for (const n of nodes) {
    bump(n.outputAssetId);
    try {
      const data = JSON.parse(n.data) as { assetId?: unknown };
      if (typeof data.assetId === "string") bump(data.assetId);
    } catch {
      // data 坏了的节点不该让整个资产库打不开。跳过即可，
      // 它自己的问题在画布上已经表现出来了。
    }
  }

  return NextResponse.json({
    assets: assets.map((a) => ({
      id: a.id,
      kind: a.kind,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      createdAt: a.createdAt,
      usedBy: usedBy.get(a.id) ?? 0,
    })),
    totalBytes: assets.reduce((s, a) => s + a.sizeBytes, 0),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;

  // 项目必须存在。不校验的话，传错 id 也能成功，
  // 然后在 storage 里留下一堆没有任何项目引用的孤儿文件。
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) {
    return NextResponse.json({ error: "项目不存在" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "请求体不是合法的 multipart/form-data" },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "缺少 file 字段" }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "文件是空的" }, { status: 400 });
  }

  const kind = kindOf(file.type);
  if (!kind) {
    return NextResponse.json(
      { error: `不支持的文件类型：${file.type || "未知"}（只支持图片和视频）` },
      { status: 415 }
    );
  }

  const limit = MAX_BYTES[kind as keyof typeof MAX_BYTES];
  if (file.size > limit) {
    return NextResponse.json(
      {
        error: `文件太大（${formatMb(file.size)}，上限 ${formatMb(limit)}）`,
      },
      { status: 413 }
    );
  }

  const id = randomUUID();
  const ext = EXT_BY_MIME[file.type] ?? "bin";

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const written = await writeFileAtomic(assetRelPath(id, ext), buf);

    const asset = await db.asset.create({
      data: {
        id,
        /*
         * 归属这个项目。
         *
         * 这个 id 本来就在 URL 里（这条路由是 `/api/projects/<id>/assets`），
         * 上一版只拿它校验项目存在就丢掉了 —— 于是上传的素材落成一条无主资产，
         * 项目的资产库里看不到自己刚传的图。上下文白拿白丢，是这里最容易漏的一步。
         */
        projectId,
        kind,
        mimeType: file.type,
        filePath: written.relPath,
        sizeBytes: written.sizeBytes,
      },
    });

    return NextResponse.json({
      assetId: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      // 原文件名回给前端：画布上的卡片名字默认用它，
      // 用户一眼能认出「这是我传的那张图」。
      name: file.name,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "上传失败" },
      { status: 500 }
    );
  }
}
