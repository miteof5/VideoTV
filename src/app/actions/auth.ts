"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { APIError } from "better-auth/api";
import { auth, placeholderEmail, USERNAME_PATTERN } from "@/lib/auth";

/**
 * 注册 / 登录 / 登出。
 *
 * ### 为什么注册走 Server Action，而不是让浏览器直接调 authClient.signUp
 *
 * 因为 email 是服务端派生的占位值，不能由前端决定。
 * 前端决定的话，谁都能塞一个真实邮箱进来（虽然不参与逻辑，但那是脏数据）。
 * 服务端生成 + `databaseHooks` 再强制覆盖一遍，两道。
 *
 * ### 为什么登录也走 Server Action
 *
 * 一致性。而且错误消息的中文化只写一份，不需要前端再解析一遍 API 错误码。
 */

export type AuthState = { error: string } | null;

/** 把库的错误码翻成人话。翻不出来就原样返回 —— 开发期能看见原文比看见「未知错误」有用 */
function describe(error: unknown): string {
  if (error instanceof APIError) {
    const code = error.body?.code ?? "";
    if (/ALREADY_EXISTS|ALREADY_TAKEN|USERNAME_IS_TAKEN/i.test(code)) {
      return "这个用户名已经有人用了，换一个吧";
    }
    if (/PASSWORD_TOO_SHORT/i.test(code)) {
      return "密码至少 8 位";
    }
    if (/PASSWORD_TOO_LONG/i.test(code)) {
      return "密码太长了，120 位以内";
    }
    // 这一条必须排在 INVALID_USERNAME 之前：
    // 登录失败返回的是 INVALID_USERNAME_OR_PASSWORD，而它是 INVALID_USERNAME 的超串，
    // 顺序反了就会把「密码不对」显示成「用户名格式不对」。
    if (/INVALID_USERNAME_OR_PASSWORD|INVALID_USERNAME_OR_EMAIL/i.test(code)) {
      return "用户名或密码不对";
    }
    if (/CREDENTIALS|INVALID_PASSWORD|INVALID_EMAIL|USER_NOT_FOUND/i.test(code)) {
      return "用户名或密码不对";
    }
    if (/INVALID_USERNAME/i.test(code)) {
      return "用户名只能用中文、字母、数字、下划线，3–20 个字符";
    }
    return error.body?.message || error.message;
  }
  return "出了点问题，稍后再试";
}

/** 只接受站内路径，挡住 `//evil.com` 这类开放重定向 */
function safeNext(value: FormDataEntryValue | null): string {
  const raw = typeof value === "string" ? value : "";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export async function signUpAction(
  _prev: AuthState,
  formData: FormData
): Promise<AuthState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  // 服务端重新校验一遍。前端那些 required / minLength 只是体验，
  // 绕过表单直接 POST 是零成本的，所以真正的校验只能在这里。
  if (!USERNAME_PATTERN.test(username)) {
    return { error: "用户名只能用中文、字母、数字、下划线，3–20 个字符" };
  }
  if (password.length < 8) {
    return { error: "密码至少 8 位" };
  }
  if (password !== confirm) {
    return { error: "两次输入的密码不一样" };
  }

  try {
    await auth.api.signUpEmail({
      body: {
        email: placeholderEmail(username),
        password,
        name: username,
        username,
      },
    });
  } catch (error) {
    return { error: describe(error) };
  }

  // redirect 必须在 try 之外：它靠抛出一个特殊错误来跳转，被 catch 住就跳不动了
  redirect("/");
}

export async function signInAction(
  _prev: AuthState,
  formData: FormData
): Promise<AuthState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));

  if (!username || !password) {
    return { error: "用户名和密码都要填" };
  }

  try {
    await auth.api.signInUsername({ body: { username, password } });
  } catch (error) {
    return { error: describe(error) };
  }

  redirect(next);
}

export async function signOutAction() {
  // 必须把当前请求的 headers 传进去 —— signOut 要靠它找到是哪个 session 要删
  await auth.api.signOut({ headers: await headers() });
  redirect("/sign-in");
}
