// 把「无主项目」（ownerId 为 null）挂到管理员名下。
//
//   npm run claim-orphans
//
// 什么时候需要：认证功能上线之前建的项目，ownerId 是空的。
// 空着不是「安全地藏起来」，是「谁都看不见但数据还在」—— 对用户来说跟丢了一样，
// 只不过还能捞回来。
//
// 规矩：DELETE / UPDATE 之前先把将被改的行 SELECT 出来打印。
// 这条来自 2026-10-26 的教训（`name like '__%'` 因为 `_` 是单字符通配符，
// 误删了两个真实项目）。UPDATE 的杀伤力不比 DELETE 小，一样要先把清单亮出来。

import { db } from "../src/lib/db";

async function main() {
  // --dry-run：只打印会动哪些行，不真的更新。
  // 为什么需要：这个脚本会改所有 ownerId 为 null 的项目，
  // 想先确认「选中范围对不对」的时候，必须有一个不动数据的方式。
  const dryRun = process.argv.includes("--dry-run");

  const admin = await db.user.findFirst({
    where: { role: "admin" },
    select: { id: true, username: true },
    orderBy: { createdAt: "asc" },
  });

  if (!admin) {
    console.error("还没有管理员。先提一个：npm run make-admin -- <用户名>");
    process.exit(1);
  }

  const orphans = await db.project.findMany({
    where: { ownerId: null },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (orphans.length === 0) {
    console.log("没有无主项目，什么也没做");
    return;
  }

  console.log(`管理员：${admin.username} (${admin.id})`);
  console.log(`将挂到管理员名下的项目（${orphans.length} 个）：`);
  for (const p of orphans) {
    console.log(`  - ${p.name} | ${p.id} | ${p.createdAt.toISOString()}`);
  }

  if (dryRun) {
    console.log("\n[dry-run] 没有改动任何数据。确认清单无误后去掉 --dry-run 再跑一次。");
    return;
  }

  const r = await db.project.updateMany({
    where: { ownerId: null },
    data: { ownerId: admin.id },
  });

  console.log(`\n✓ 已更新 ${r.count} 个项目`);

  const left = await db.project.count({ where: { ownerId: null } });
  console.log(`剩余无主项目：${left}`);
}

main().finally(() => process.exit(0));
