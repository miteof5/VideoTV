import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

/**
 * Better Auth 的全部端点都挂在这一个路由下面：
 * /api/auth/sign-up/email、/api/auth/sign-in/username、/api/auth/sign-out、/api/auth/get-session …
 *
 * 为什么是一条通配路由而不是一个个手写：
 * 认证端点的路径、请求体、响应格式都是库的内部约定，手写等于把它抄一遍 ——
 * 库升级时抄的那份不会跟着变。让库自己挂，我们只负责把请求转过去。
 */
export const { GET, POST } = toNextJsHandler(auth);
