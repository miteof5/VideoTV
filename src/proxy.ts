import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Next 16 起，`middleware.ts` 改名叫 `proxy.ts`（文件名和导出函数名都变了），功能不变。
 *
 * ### 这里做的事只有一件：让「没登录的人别看到空画布」
 *
 * 它**只检查 cookie 在不在**，不查数据库、不验证 session 是否过期。
 * 这不是偷懒 —— 因为 proxy 跑在边缘运行时，拿不到数据库连接；
 * 更重要的是官方文档自己写着：proxy「不应当作完整的会话管理或授权方案」。
 *
 * 所以真正的安全边界在**数据访问层**：每个页面、每个接口自己去问「这条数据是不是你的」。
 * 这个文件被绕过（比如有人手工伪造 cookie 名字）也不会泄露任何东西，
 * 最坏结果是他看到一个空的项目列表。
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasCookie = Boolean(getSessionCookie(request));

  const isAuthPage = pathname === "/sign-in" || pathname === "/sign-up";

  // 已登录还去登录页 → 送回首页（否则容易在登录页里绕圈）
  if (hasCookie && isAuthPage) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // 没登录 → 去登录页
  if (!hasCookie && !isAuthPage) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  return NextResponse.next();
}

/**
 * 哪些路径不走这里：
 * - `api`    —— 接口自己返回 401/404，重定向到登录页对 fetch 调用方毫无意义
 * - `_next`  —— 构建产物和图片优化
 * - `share`  —— 分享链接本来就要给没登录的人看
 * - 带点的路径 —— favicon.ico、各种 svg
 */
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|share|.*\\..*).*)"],
};
