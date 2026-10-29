// 把某个账号提成管理员。
//
//   npm run make-admin -- <用户名>
//
// 为什么不用「环境变量里写管理员用户名」：用户名谁都能先注册，
// 把管理员身份绑在一个可被抢注的标识上，等于把后门钥匙挂在门口。
// 也不用「第一个注册的人」—— 那取决于谁先注册，不受控制。
// 提权只能由能在这台机器上敲命令的人发起，这才对。
//
// 为什么不用「手机号匹配」：这个站没有手机号（见 spec §7.1）。

import { db } from "../src/lib/db";

async function main() {
  const rawName = process.argv[2];
  if (!rawName) {
    console.error("用法：npm run make-admin -- <用户名>");
    process.exit(1);
  }

  const username = rawName.trim().toLowerCase();

  const user = await db.user.findFirst({
    where: { username },
    select: { id: true, username: true, role: true },
  });
  if (!user) {
    console.error(`找不到用户：${username}`);
    process.exit(1);
  }

  if (user.role === "admin") {
    console.log(`${user.username} 已经是管理员了，没改动`);
    return;
  }

  await db.user.update({ where: { id: user.id }, data: { role: "admin" } });

  console.log(`✓ ${user.username} 已提为管理员（role: ${user.role} → admin）`);
  console.log(`  下一步：npm run claim-orphans  把无主项目挂到这个账号下`);
}

main().finally(() => process.exit(0));
