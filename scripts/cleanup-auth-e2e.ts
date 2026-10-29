// 清理认证 E2E 产生的一次性用户。跑完即可删。
// 规矩：DELETE 前先把将被删的行打印出来。
import { db } from "../src/lib/db";

// 这些是本次 E2E / curl 反验里造出来的，全部带可识别前缀或精确名字
const EXACT = ["tester001", "张三丰"];
const PREFIXES = ["e2e", "测试", "revtest", "weakpw", "ops"];

async function main() {
  const all = await db.user.findMany({
    select: { id: true, username: true, displayUsername: true, email: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`库里共 ${all.length} 个用户：`);
  for (const u of all) {
    console.log(`  ${u.username} | ${u.email} | ${u.createdAt.toISOString()}`);
  }

  const doomed = all.filter((u) => {
    const name = u.username ?? "";
    return EXACT.includes(name) || PREFIXES.some((p) => name.startsWith(p));
  });

  console.log(`\n将被删除 ${doomed.length} 个：`);
  for (const u of doomed) console.log(`  - ${u.username} (${u.id})`);

  if (doomed.length === 0) {
    console.log("没有要删的");
    return;
  }

  const ids = doomed.map((u) => u.id);
  // session / account 有 onDelete: Cascade，删 user 会一起走
  const res = await db.user.deleteMany({ where: { id: { in: ids } } });
  console.log(`\n已删除 ${res.count} 行 user`);

  const left = await db.user.findMany({ select: { username: true } });
  console.log(`剩余用户：${left.length === 0 ? "（空）" : left.map((u) => u.username).join(", ")}`);

  // 顺带核对级联真的发生了
  const [sessions, accounts] = await Promise.all([db.session.count(), db.account.count()]);
  console.log(`剩余 session=${sessions} account=${accounts}`);
}

main().finally(() => process.exit(0));
