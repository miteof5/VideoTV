// C 阶段 · 批 2：每用户并发名额
//
//   npx tsx scripts/check-per-user-quota.ts
//
// 前置：dev 跑在 3000；**worker 必须停着**（这里会真的建 run，
// 有 worker 在就会真的去调模型，花钱）。
//
// 验的是三件事，缺一条这个改动就是没做完：
//
//   1. 一个人点满 3 个之后，第 4 个被明确拒绝（不是静默排队）
//   2. **别人不受影响** —— A 占满 3 个时 B 仍然能起任务
//      （这条是批 2 的全部意义。改之前 B 会被拒，而且他完全不知道为什么）
//   3. 拒绝的文案说的是「你」，不是「已经有 3 个任务」
//
// 反向验证：把 runService 里那个 userId 条件摘掉，第 2 条必须变红。

import { db } from "../src/lib/db";

const BASE = "http://127.0.0.1:3000";
const PASS = "quota-pass-1234";
const stamp = Date.now().toString().slice(-7);
const USER_A = `quotaa${stamp}`;
const USER_B = `quotab${stamp}`;

let failed = 0;
function ck(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}` + (detail === undefined ? "" : `  → ${detail}`));
  if (!ok) failed++;
}

async function signUp(username: string) {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({
      email: `${username}@local.invalid`,
      password: PASS,
      name: username,
      username,
    }),
  });
  if (!res.ok) throw new Error(`注册 ${username} 失败：${res.status} ${await res.text()}`);
  const token = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("better-auth.session_token="));
  if (!token) throw new Error("注册成功但没拿到 session cookie");
  const body = await res.json();
  return { cookie: token, userId: body.user.id as string };
}

/**
 * 造一个「点了就能跑」的图片节点。
 *
 * 为什么要 prompt：buildPlan 会把没有提示词的节点当成「无事可做」跳过，
 * 于是 plan.runIds 为空，createRun 抛「这次执行没有需要运行的节点」——
 * 那条错误和并发无关，会把我真正想验的东西盖掉。
 */
async function makeProjectWithNodes(
  ownerId: string,
  label: string,
  count: number
) {
  const project = await db.project.create({
    data: { name: `${label}-${stamp}`, ownerId },
  });

  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = await db.node.create({
      data: {
        projectId: project.id,
        type: "image.gen",
        positionX: i * 400,
        positionY: 0,
        data: JSON.stringify({ prompt: `quota test ${i}`, label: `图片${i}` }),
      },
    });
    ids.push(n.id);
  }
  return { project, nodeIds: ids };
}

async function postRun(cookie: string, projectId: string, targetId: string) {
  const res = await fetch(`${BASE}/api/runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: BASE,
      Cookie: cookie,
    },
    body: JSON.stringify({ projectId, mode: "node", targetId }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    runId?: string;
    error?: string;
  };
  return { status: res.status, ...body };
}

async function main() {
  // 这个脚本会造出真的 pending run。worker 在跑的话会真的开始生成 ——
  // 那是真钱。宁可停下来让他自己开，也不要「顺便花掉他几块钱」。
  const running = await db.job.count({
    where: { status: { in: ["pending", "running"] } },
  });
  if (running > 0) {
    console.log(`\n✗ 库里有 ${running} 个未完成的 job —— worker 可能正在跑。`);
    console.log("  先停掉 worker 再跑这个脚本（它会造真的 pending run）。\n");
    process.exit(2);
  }

  const a = await signUp(USER_A);
  const b = await signUp(USER_B);
  console.log(`A=${USER_A}  B=${USER_B}\n`);

  const pa = await makeProjectWithNodes(a.userId, "A 的项目", 4);
  const pb = await makeProjectWithNodes(b.userId, "B 的项目", 1);

  console.log("── A 连点 4 个节点（上限 3）");
  const results = [];
  for (const nodeId of pa.nodeIds) {
    results.push(await postRun(a.cookie, pa.project.id, nodeId));
  }

  const accepted = results.filter((r) => r.status === 200);
  const rejected = results.filter((r) => r.status !== 200);

  ck("前 3 个被接受", accepted.length === 3, `实际 ${accepted.length}`);
  ck("第 4 个被拒绝", rejected.length === 1, `实际 ${rejected.length}`);
  ck(
    "拒绝是 400（用户输入错误），不是 500",
    rejected[0]?.status === 400,
    `实际 ${rejected[0]?.status}`
  );
  ck(
    "文案对「你」说，而不是说机器满了",
    /你已经有 3 个任务/.test(rejected[0]?.error ?? ""),
    rejected[0]?.error
  );

  console.log("\n── A 占满 3 个名额时，B 还能不能跑");
  const bRes = await postRun(b.cookie, pb.project.id, pb.nodeIds[0]);
  ck(
    "B 能起自己的任务（这是批 2 的意义）",
    bRes.status === 200,
    bRes.status === 200 ? `runId=${bRes.runId?.slice(0, 8)}` : bRes.error
  );

  console.log("\n── B 也点满 3 个后，B 的第 4 个被拒");
  /*
   * 必须是 4 个**不同**的节点。
   *
   * 用同一个节点点第二次会先撞上 createRun 的幂等分支（同一个 target
   * 已有活跃 run → 直接复用，返回 200）。那条分支在并发检查之前，
   * 所以用一个节点点两次，看到的是「复用」而不是「名额满了」——
   * 断言「被拒」就会莫名其妙地红，而实现其实是对的。
   */
  const extra = await makeProjectWithNodes(b.userId, "B 第二项目", 3);
  const bRes2 = await postRun(b.cookie, extra.project.id, extra.nodeIds[0]);
  const bRes3 = await postRun(b.cookie, extra.project.id, extra.nodeIds[1]);
  ck(
    "B 的第 2、3 个被接受",
    bRes2.status === 200 && bRes3.status === 200,
    `${bRes2.status} / ${bRes3.status}`
  );

  const bFourth = await postRun(b.cookie, extra.project.id, extra.nodeIds[2]);
  ck(
    "B 的第 4 个被拒（两个人各自计数，不互相影响）",
    bFourth.status === 400 && /你已经有 3 个任务/.test(bFourth.error ?? ""),
    `http ${bFourth.status} ${bFourth.error ?? ""}`
  );

  console.log("\n── A 仍然只有 3 个在跑（B 的任务没算进 A 的名额）");
  const activeA = await db.run.count({
    where: {
      userId: a.userId,
      status: { in: ["pending", "running"] },
      waitingOn: null,
    },
  });
  ck("A 的活跃 run 数是 3", activeA === 3, `实际 ${activeA}`);

  const activeB = await db.run.count({
    where: {
      userId: b.userId,
      status: { in: ["pending", "running"] },
      waitingOn: null,
    },
  });
  ck("B 的活跃 run 数是 3", activeB === 3, `实际 ${activeB}`);

  /*
   * ── 积分按人算 ────────────────────────────────────────────────
   *
   * 直接造两条「已结算」的 run，而不是真跑一遍：真跑要调模型、要花钱，
   * 而这里要验的是「首页那个数字按不按 userId 过滤」，跟模型没关系。
   *
   * 数值故意取得能区分：A=100、B=10。如果实现漏了 userId 过滤，
   * A 会看到 110 —— 一个既不是他也说不出是谁的数。
   */
  await db.run.create({
    data: {
      projectId: pa.project.id,
      userId: a.userId,
      status: "succeeded",
      credits: 100,
      endedAt: new Date(),
    },
  });
  await db.run.create({
    data: {
      projectId: pb.project.id,
      userId: b.userId,
      status: "succeeded",
      credits: 10,
      endedAt: new Date(),
    },
  });

  const homeA = await (
    await fetch(`${BASE}/`, { headers: { Cookie: a.cookie } })
  ).text();

  // React 会在文本插值两侧塞 <!-- -->，所以不能匹配「累计 100 积分」这种连写
  const showsOwn = /累计[\s\S]{0,40}?100[\s\S]{0,40}?积分/.test(homeA);
  const showsSum = /累计[\s\S]{0,40}?110[\s\S]{0,40}?积分/.test(homeA);

  ck("首页显示 A 自己的累计 100 积分", showsOwn);
  ck("首页不显示 A+B 的合计 110（说明按人过滤了）", !showsSum);

  // 清理：删两个用户，级联带走项目 / 节点 / run / job
  await db.user.deleteMany({ where: { id: { in: [a.userId, b.userId] } } });
  console.log("\n已清理测试账号与其数据");

  console.log(
    failed === 0 ? "\n全部通过" : `\n${failed} 条失败`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
