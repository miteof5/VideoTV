import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "./auth";
import { db } from "./db";

/**
 * 归属校验的唯一入口。
 *
 * ### 为什么集中在这里，而不是每个 route 里写三行
 *
 * 越权漏洞的来源从来不是「不会写」，是「有一个接口忘了写」。
 * 集中成几个函数之后，新增接口只有两种写法：调这里，或者明显看得出没调。
 *
 * ### 为什么不属于你返回 404 而不是 403
 *
 * 403 的意思是「这东西存在，但你不能看」—— 那本身就是信息泄露：
 * 拿 id 挨个试，能数出别人有多少项目、什么时候建的。
 * 404 的意思是「我不知道你在说什么」，对方除了「猜错了」得不到任何东西。
 * 这是 OWASP 对 IDOR 的推荐处理方式。
 */

export interface AuthedUser {
  id: string;
  username: string;
  role: string;
}

/** 页面 / Server Component 用：没登录就返回 null，由调用方决定是跳转还是渲染 */
export async function getUser(): Promise<AuthedUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  return {
    id: session.user.id,
    username: session.user.username ?? session.user.name,
    role: (session.user as { role?: string }).role ?? "user",
  };
}

export type GuardResult =
  | { user: AuthedUser; error: null }
  | { user: null; error: NextResponse };

/**
 * Route Handler 用。
 *
 * 用法：
 *   const guardResult = await guard();
 *   if (guardResult.error) return guardResult.error;
 *   const { user } = guardResult;
 */
export async function guard(): Promise<GuardResult> {
  const user = await getUser();
  if (!user) {
    return { user: null, error: NextResponse.json({ error: "未登录" }, { status: 401 }) };
  }
  return { user, error: null };
}

/** 属于这个人的项目，不属于就返回 null */
export async function ownedProject(projectId: string, userId: string) {
  return db.project.findFirst({ where: { id: projectId, ownerId: userId } });
}

/**
 * 属于这个人的运行。
 *
 * 走 project.ownerId 而不是 Run.userId：run 的 userId 是后加的列，
 * 存量 run 可能是 null；项目归属是权威来源，两条路径不该有两套判据。
 */
export async function ownedRun(runId: string, userId: string) {
  return db.run.findFirst({
    where: { id: runId, project: { ownerId: userId } },
  });
}

/** 属于这个人的资产（经由它所属的项目） */
export async function ownedAsset(assetId: string, userId: string) {
  return db.asset.findFirst({
    where: { id: assetId, project: { ownerId: userId } },
  });
}
