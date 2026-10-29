// C 阶段 · 越权横扫
//
//   node --import tsx scripts/check-authz.ts
//   或：npx tsx scripts/check-authz.ts
//
// 前置：dev 跑在 3000；**worker 必须停着**（这个脚本会故意尝试往别人的项目里
// 提交运行，万一某条校验失效，有 worker 在就会真的去调模型花钱）。
//
// 造两个账号 A、B，A 有项目/资产/一次运行。然后用 B 的身份把**所有**接口
// 对着 A 的资源打一遍，期望全部 404（不是 403 —— 403 等于承认「这东西存在」）。
// 再用未登录身份打一遍，期望 401。
//
// 跑完自动清理：删 A、B 两个用户，级联带走项目/资产/运行。

import { db } from "../src/lib/db";

const BASE = "http://127.0.0.1:3000";
const PASS = "authz-pass-1234";
const stamp = Date.now().toString().slice(-7);
const USER_A = `authza${stamp}`;
const USER_B = `authzb${stamp}`;

let failed = 0;
function ck(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✓" : "✗"} ${name}` + (detail === undefined ? "" : `  → ${detail}`));
  if (!ok) failed++;
}

/** 注册并拿到 session cookie 与 userId */
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

  const cookies = res.headers.getSetCookie();
  const token = cookies
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("better-auth.session_token="));
  if (!token) throw new Error("注册成功但没拿到 session cookie");

  const body = await res.json();
  return { cookie: token, userId: body.user.id };
}

/** 发一个请求，返回状态码 */
async function hit(
  method: string,
  path: string,
  cookie?: string,
  body?: unknown
) {
  const headers: Record<string, string> = { Origin: BASE };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  // 页面路由被 notFound() 时返回 404；被 redirect() 时是 307
  return res.status;
}

async function main() {
  const a = await signUp(USER_A);
  const b = await signUp(USER_B);
  console.log(`A=${USER_A}  B=${USER_B}\n`);

  // 用 db 直接造 A 的资源（不走接口，免得为了造数据把真实上传/运行跑一遍）
  const project = await db.project.create({
    data: { name: "越权测试项目", ownerId: a.userId },
  });
  const asset = await db.asset.create({
    data: {
      id: `authz-asset-${stamp}`,
      projectId: project.id,
      kind: "image",
      mimeType: "image/png",
      filePath: `missing/authz-${stamp}.png`,
      sizeBytes: 1,
    },
  });
  const run = await db.run.create({
    data: { projectId: project.id, userId: a.userId, status: "pending" },
  });

  const cases: [string, string, number, string][] = [
    ["GET", `/api/projects/${project.id}/assets`, 404, "读别人项目的资产库"],
    ["POST", `/api/projects/${project.id}/assets`, 404, "往别人项目上传资产"],
    ["PUT", `/api/projects/${project.id}/graph`, 404, "改别人项目的画布"],
    ["PUT", `/api/projects/${project.id}/viewport`, 404, "改别人项目的相机"],
    ["GET", `/api/projects/${project.id}/runs`, 404, "看别人项目的运行历史"],
    ["POST", `/api/runs`, 404, "在别人项目里发起运行（最贵的一条）"],
    ["GET", `/api/assets/${asset.id}`, 404, "下载别人的产物"],
    ["DELETE", `/api/assets/${asset.id}`, 404, "删别人的产物"],
    ["GET", `/api/runs/${run.id}`, 404, "看别人的运行详情"],
    ["GET", `/api/runs/${run.id}/events`, 404, "看别人的运行事件"],
    ["GET", `/api/runs/${run.id}/stream`, 404, "订阅别人的运行进度（SSE）"],
    ["POST", `/api/runs/${run.id}/cancel`, 404, "取消别人的运行"],
    ["GET", `/projects/${project.id}`, 404, "打开别人的项目页"],
  ];

  console.log("── B 打 A 的资源（期望 404）");
  for (const [method, path, expect, label] of cases) {
    const body = method === "POST" && path === "/api/runs" ? { projectId: project.id, mode: "node", targetId: "x" } : undefined;
    const status = await hit(method, path, b.cookie, body);
    ck(`${label} [${method} ${path}]`, status === expect, `实际 ${status}，期望 ${expect}`);
  }

  console.log("\n── 未登录打（期望 401）");
  const anonCases: [string, string][] = [
    ["GET", `/api/projects/${project.id}/assets`],
    ["POST", "/api/runs"],
    ["GET", `/api/assets/${asset.id}`],
    ["GET", `/api/runs/${run.id}`],
    ["POST", `/api/runs/${run.id}/cancel`],
  ];
  for (const [method, path] of anonCases) {
    const status = await hit(method, path, undefined, method === "POST" && path === "/api/runs" ? { projectId: project.id } : undefined);
    ck(`未登录 ${method} ${path}`, status === 401, `实际 ${status}，期望 401`);
  }

  console.log("\n── A 打自己的资源（期望不是 404，证明校验不是「谁都拒绝」）");
  const selfStatus = await hit("GET", `/api/projects/${project.id}/assets`, a.cookie);
  ck("A 能读自己的资产库", selfStatus === 200, `实际 ${selfStatus}`);

  // 清理：删两个用户，级联带走项目 / 资产 / 运行
  await db.user.deleteMany({ where: { id: { in: [a.userId, b.userId] } } });
  const left = await Promise.all([
    db.project.count({ where: { ownerId: { in: [a.userId, b.userId] } } }),
    db.run.count({ where: { id: run.id } }),
    db.asset.count({ where: { id: asset.id } }),
  ]);
  ck("清理干净（项目/运行/资产都为 0）", left.every((n) => n === 0), `剩余 ${left.join("/")}`);

  console.log(failed === 0 ? "\n全部通过" : `\n${failed} 条失败`);
}

main()
  .catch((e) => {
    console.error("执行中断：", e.message);
    failed++;
  })
  .finally(() => process.exit(failed === 0 ? 0 : 1));
