import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { assetRelPath, downloadToStorage, writeFileAtomic } from "@/lib/storage";
import type { GenerationOutput } from "@/providers/types";

// assetService：把「Provider 产出的字节」变成「一条 Asset 记录 + 一个已落盘的文件」。
//
// 这一层把 storage（文件）和 db（元数据）缝在一起。
// 顺序是刻意安排的：
//   1. 先定 id（文件名要用它）
//   2. 写文件（原子）
//   3. 再写数据库
//
// 为什么不是反过来：如果先落库再写文件，中间崩了就会留下一条**指向不存在文件**的记录，
// 前端拿到 id 去请求就是一个 404，表现为"图裂了"。
// 反过来最坏只是留下一个孤儿文件，没有任何东西引用它，随时可以清理。
// 一致性问题上，永远让"有引用无实体"不发生。

export interface PersistedAsset {
  id: string;
  kind: string;
  mimeType: string;
  filePath: string;
  sizeBytes: number;
}

/**
 * 把产物落成 Asset。
 *
 * `projectId` 是**必填**的：每个项目一个资产库，产物必须能追溯到它属于哪部片子。
 * 调用方手里一定有 —— 执行器读节点时连 projectId 一起拿到了，
 * 传不下来只可能是漏了，那时宁可编译报错，也不要悄悄落成一条无归属的资产
 * （无归属的资产不会出现在任何资产库里，等于用户生成了东西却找不到）。
 */
export async function persistOutput(
  output: GenerationOutput,
  projectId: string
): Promise<PersistedAsset> {
  const id = randomUUID();
  const relPath = assetRelPath(id, output.ext);

  let sizeBytes: number;

  if (output.buffer) {
    const written = await writeFileAtomic(relPath, output.buffer);
    sizeBytes = written.sizeBytes;
  } else if (typeof output.text === "string") {
    // 文本产物也落成文件：让「所有 Asset 都有实体文件」成立，
    // 读取路径就只有一条，不用为文本单开分支。
    const written = await writeFileAtomic(
      relPath,
      Buffer.from(output.text, "utf8")
    );
    sizeBytes = written.sizeBytes;
  } else if (output.remoteUrl) {
    // 真实视频模型通常只给一个几小时后过期的临时链接，
    // 必须当场下载归档，否则用户过几天再打开项目就全是裂图。
    const written = await downloadToStorage(relPath, output.remoteUrl);
    sizeBytes = written.sizeBytes;
  } else {
    throw new Error("Provider 返回了空产物：buffer / text / remoteUrl 至少要有其一");
  }

  const asset = await db.asset.create({
    data: {
      id,
      projectId,
      kind: output.kind,
      mimeType: output.mimeType,
      filePath: relPath,
      sizeBytes,
    },
  });

  return asset;
}

/** 前端拿到的统一地址。走 Route Handler 而不是直接暴露 storage 目录 */
export function assetUrl(assetId: string) {
  return `/api/assets/${assetId}`;
}
