import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

// Prisma 7 的两处变化：
// 1. 不再内置数据库驱动，必须显式传 driver adapter（这里用 better-sqlite3）
// 2. schema.prisma 里不再写 url，运行时连接串从这里（环境变量）取
//
// 注意导入顺序：dotenv/config 要在读 process.env 之前执行。
// Next.js 自己会加载 .env，但独立的 Worker 进程不会，所以这里显式加载一次。

function createPrismaClient() {
  const adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL ?? "file:./dev.db",
  });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// 为什么挂到 globalThis：
// Next.js 开发模式的热更新(HMR)会反复重新执行模块文件。
// 如果每次都新建 PrismaClient，每轮热更新都会新建一个连接池，
// 很快就会把连接耗尽。缓存到 globalThis 上就能复用同一个实例。
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
