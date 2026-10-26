import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma 7 的新配置文件（项目根目录）。
// 两个变化：
// 1. datasource.url 从 schema.prisma 挪到了这里
// 2. CLI 不再自动加载 .env，必须自己 import "dotenv/config"
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
  migrations: {
    path: "prisma/migrations",
  },
});
