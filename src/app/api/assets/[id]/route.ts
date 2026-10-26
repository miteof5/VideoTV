import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { readFile, removeFile } from "@/lib/storage";

/**
 * 删掉一个资产：先删文件，再删记录。
 *
 * ### 顺序和落盘时**相反**，但道理是同一条
 *
 * 落盘是「先文件后记录」，因为怕出现「有引用无实体」（图裂了）。
 * 删除时反过来想这个问题：先删记录的话，中间崩了会留下一个没人引用的文件
 * ——那只是垃圾，看得见、能清；先删文件的话，中间崩了会留下一条指向
 * 不存在文件的记录 ——那是**每条打开都 404** 的裂图，用户查不出原因。
 * 所以删除也要「先删实体，再删引用」。
 *
 * ### 正在被节点使用就拒绝，不静默清引用
 *
 * `Node.outputAssetId` 在数据库层是 SetNull：删了产物，节点会退回「没产物」。
 * 但上传的素材存在 `Node.data.assetId`（JSON 里一格），数据库管不到它 ——
 * 那条引用会变成悬空，画布上就是一张打不开的裂图，且**没有任何提示**。
 *
 * 与其为一种引用做清理、另一种做悬空，不如两种都拒绝：
 * 409 + 一句话告诉用户「先把它从画布上删掉」。失败得清楚，比成功得莫名好。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const asset = await db.asset.findUnique({ where: { id } });
  if (!asset) {
    return NextResponse.json({ error: "资产不存在" }, { status: 404 });
  }

  // 两种引用一起数：产物列 + 素材节点 JSON 里那一格
  const [asOutput, asInput] = await Promise.all([
    db.node.count({ where: { outputAssetId: id } }),
    db.node.count({ where: { data: { contains: id } } }),
  ]);
  const usedBy = Math.max(asOutput, asInput);
  if (usedBy > 0) {
    return NextResponse.json(
      {
        error: `这个资产正被 ${usedBy} 个节点使用，先从画布上删掉那些节点再删它`,
        usedBy,
      },
      { status: 409 }
    );
  }

  await removeFile(asset.filePath);
  await db.asset.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}

// 资产读取端点。M6 的节点预览、下载都走这里。
//
// 为什么不让浏览器直接访问 ./storage 里的文件：
//   1. `public/` 下的东西会被原样暴露，没有任何权限判断，将来加多用户就穿帮了；
//   2. 路径规则、按 id 查元数据、统计下载量、签名 URL，都需要一个统一入口。
//
// 这里实现了 Range 请求支持，这不是可选项：
//   <video> 要从任意位置拖动播放、Safari 甚至要求必须支持 Range 才肯播，
//   否则表现为"视频加载不出来"或"进度条拖不动"。

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const asset = await db.asset.findUnique({ where: { id } });
  if (!asset) {
    return new NextResponse("Not Found", { status: 404 });
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(asset.filePath);
  } catch {
    // 元数据在、文件不在 —— 说明落盘那一步出了问题。
    // 明确报 410 而不是 404，排查时能一眼区分"没这个资产"和"资产丢了"
    return new NextResponse("Asset file missing", { status: 410 });
  }

  const total = buffer.length;
  const rangeHeader = req.headers.get("range");

  const baseHeaders: Record<string, string> = {
    "Content-Type": asset.mimeType,
    // 资产 id 是随机 uuid，内容永不变，可以长缓存
    "Cache-Control": "public, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
    /*
     * 禁止浏览器「猜」类型。
     *
     * 我们按库里存的 mimeType 返回，但如果没有这个头，某些浏览器会
     * 嗅探内容后按自己认的类型渲染 —— 一个被声明成 image/png 的文件
     * 如果其实是 HTML，就可能被当成页面执行。
     * 上传入口已经拒了 SVG，这个头是第二道。
     */
    "X-Content-Type-Options": "nosniff",
  };

  // ?dl=1 → 下载而不是预览。
  // 少了这个头，点「下载」按钮浏览器会直接在标签页里打开图片/视频，
  // 用户还得再右键另存一次 —— 那等于按钮没作用。
  // filename* 用 RFC 5987 编码，否则中文文件名会变成一串问号。
  if (req.nextUrl.searchParams.get("dl") === "1") {
    baseHeaders["Content-Disposition"] =
      `attachment; filename*=UTF-8''${encodeURIComponent(downloadName(asset))}`;
  }

  // 没有 Range：整份返回
  if (!rangeHeader) {
    return new NextResponse(toBody(buffer), {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(total) },
    });
  }

  // 形如 "bytes=0-1023" / "bytes=1024-" / "bytes=-512"（最后 N 字节）
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return new NextResponse("Bad Range", {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` },
    });
  }

  const [, startRaw, endRaw] = match;
  let start: number;
  let end: number;

  if (startRaw === "") {
    // 后缀范围：最后 endRaw 个字节
    const suffix = Number(endRaw);
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? total - 1 : Math.min(Number(endRaw), total - 1);
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
    return new NextResponse("Range Not Satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` },
    });
  }

  const chunk = buffer.subarray(start, end + 1);

  return new NextResponse(toBody(chunk), {
    status: 206, // Partial Content
    headers: {
      ...baseHeaders,
      "Content-Length": String(chunk.length),
      "Content-Range": `bytes ${start}-${end}/${total}`,
    },
  });
}

// Buffer 直接当 body 在部分运行时会有类型/兼容问题，转成 Uint8Array 最稳
function toBody(buf: Buffer) {
  return new Uint8Array(buf);
}

/**
 * 下载时的文件名。
 * Asset 表里没有 fileName 列（M4 定表时只存了元数据），
 * 所以从 filePath 的 basename 拼：形如 2026/10/<uuid>.mp4。
 * 拿不到扩展名时按 mimeType 兜一个，避免出现没有后缀的文件。
 */
function downloadName(asset: { id: string; filePath: string; mimeType: string }) {
  const base = asset.filePath.split(/[\\/]/).pop() ?? asset.id;
  if (base.includes(".")) return base;

  const ext =
    {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "video/mp4": "mp4",
      "video/webm": "webm",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "text/plain": "txt",
    }[asset.mimeType] ?? "bin";

  return `${base}.${ext}`;
}
