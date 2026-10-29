// 命令行重置某人密码。
//
//   npm run reset-password -- <用户名> <新密码>
//
// 为什么需要它：这个站没有邮箱也没有手机号，账号和人之间没有可验证的联系，
// 所以「忘记密码」这件事没有自助路径。这是选「唯一用户名 + 密码」时明确接受的代价
// （见 specs/C-用户体系与上线.spec.md §7.1）。
//
// 重置后会把该用户所有 session 删掉 —— 改密码却不踢掉旧会话，
// 等于「密码换了，但已经登进去的人还能继续用」，那这次重置就白做了。

import { db } from "../src/lib/db";
import { hashPassword } from "better-auth/crypto";

async function main() {
  const [rawName, newPassword] = process.argv.slice(2);

  if (!rawName || !newPassword) {
    console.error("用法：npm run reset-password -- <用户名> <新密码>");
    process.exit(1);
  }
  if (newPassword.length < 8) {
    console.error("密码至少 8 位（和注册时的规则一致）");
    process.exit(1);
  }

  // username 插件在落库时做了小写归一化，这里跟着走
  const username = rawName.trim().toLowerCase();

  const user = await db.user.findFirst({ where: { username } });
  if (!user) {
    console.error(`找不到用户：${username}`);
    process.exit(1);
  }

  const account = await db.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
    select: { id: true },
  });
  if (!account) {
    console.error(`用户 ${username} 没有密码账号（account 表里没有 credential 记录）`);
    process.exit(1);
  }

  // 用 Better Auth 自己的哈希函数，不要自己写 scrypt 参数 ——
  // 参数和库内的校验逻辑必须严格一致，否则新密码永远验不过。
  const hash = await hashPassword(newPassword);

  await db.account.update({ where: { id: account.id }, data: { password: hash } });
  const killed = await db.session.deleteMany({ where: { userId: user.id } });

  console.log(`✓ 已重置 ${user.username} 的密码`);
  console.log(`✓ 已让 ${killed.count} 个已登录会话失效`);
}

main().finally(() => process.exit(0));
