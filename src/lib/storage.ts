import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// 存储层：只管「字节 ↔ 文件」，不认识数据库、不认识 Provider。
//
// 分层的意义：Provider 只产出字节（可能来自 API，也可能是远端 URL），
// 存储层只负责安全地写进 ./storage，assetService 才把两者和数据库串起来。
// 这样换存储后端（本地 → S3/R2）只改这一个文件。

/**
 * 二进制文件的根目录。
 *
 * 为什么读环境变量：验收入口（隔离库 verify.db + mock provider）跑出来的
 * 是一批假图假视频，它们不该混进真实资产目录 —— 没有这个开关时，
 * 「隔离验证」只能隔离数据库，文件照样落进 ./storage，跑几轮之后
 * 真实项目里就多出一堆没人认领的测试文件。
 *
 * 缺省仍是 ./storage，所有现有调用方行为不变。
 */
export const STORAGE_ROOT = process.env.STORAGE_DIR
  ? path.resolve(process.cwd(), process.env.STORAGE_DIR)
  : path.join(process.cwd(), "storage");

/**
 * 资产在 storage 下的相对路径。
 *
 * 为什么要按年月分目录，而不是全塞进 assets/ 一个文件夹：
 * 单目录文件数上万之后，ls、备份、同步都会明显变慢（ext4/NTFS 的目录索引压力），
 * 而按日期分片几乎零成本。S3 这类对象存储也是同样的思路 —— 用前缀打散。
 */
export function assetRelPath(assetId: string, ext: string, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return path.posix.join("assets", String(y), m, `${assetId}.${ext}`);
}

/**
 * 把相对路径解析成绝对路径，并确认没跑出 storage 根目录。
 *
 * 防路径穿越：如果哪天 filePath 来自用户输入（导入、API 参数），
 * `../../.env` 就能把服务端任意文件读出来。这里统一兜住，
 * 别指望每个调用方都记得校验。
 */
export function resolveInStorage(relPath: string) {
  const root = path.resolve(STORAGE_ROOT);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`非法存储路径：${relPath}`);
  }
  return abs;
}

export interface WrittenFile {
  relPath: string;
  absPath: string;
  sizeBytes: number;
}

/**
 * 原子写入：先写临时文件，再 rename 到最终路径。
 *
 * 为什么不能直接 writeFile 到目标路径：
 *   - rename 在同一文件系统内是**原子操作**，要么旧文件，要么完整的新文件，
 *     不存在"半个文件"的中间态。而 writeFile 不是原子的 ——
 *     进程被 kill（Worker 优雅退出超时、机器重启、容器 OOM）时，
 *     目标路径上会留下一个截断的文件。
 *   - 更隐蔽的后果：那个截断文件是"存在"的。前端会请求它、数据库里也有记录，
 *     于是表现为"图裂了 / 视频播不动"，而不是"生成失败"，极难归因。
 *
 * 临时文件名带 uuid：两个 Worker 并发写同一个 assetId 时，
 * 不会互相踩掉对方的临时文件（虽然正常情况下不该并发，但不该赌）。
 */
export async function writeFileAtomic(
  relPath: string,
  data: Buffer
): Promise<WrittenFile> {
  const absPath = resolveInStorage(relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });

  const tmpPath = `${absPath}.part-${randomUUID()}`;
  try {
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, absPath);
  } catch (err) {
    // 失败要自己清掉临时文件，否则 storage 里会堆满孤儿 .part 文件
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  return { relPath, absPath, sizeBytes: data.length };
}

export async function readFile(relPath: string) {
  return fs.readFile(resolveInStorage(relPath));
}

export async function statFile(relPath: string) {
  return fs.stat(resolveInStorage(relPath));
}

export async function removeFile(relPath: string) {
  await fs.rm(resolveInStorage(relPath), { force: true });
}

/**
 * 把远端 URL 下载进 storage。
 *
 * 真实视频模型（可灵、Seedance 等）几乎都不返回字节，而是一个**有效期很短的临时链接**。
 * 那类链接几小时后就会失效 —— 如果直接把 URL 存进数据库，几天后用户打开项目
 * 就全是裂图。所以必须在拿到 URL 的当下立刻下载归档，这也是 storage 层存在的理由。
 */
export async function downloadToStorage(
  relPath: string,
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}
) {
  const { timeoutMs = 120_000, maxBytes = 200 * 1024 * 1024, signal } = opts;

  const absPath = resolveInStorage(relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.part-${randomUUID()}`;

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);

  try {
    const res = await fetch(url, { signal: AbortSignal.any(signals) });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`产物超过上限（${buf.length} > ${maxBytes} 字节）`);
    }

    await fs.writeFile(tmpPath, buf);
    await fs.rename(tmpPath, absPath);
    return { relPath, absPath, sizeBytes: buf.length };
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
