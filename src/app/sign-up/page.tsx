"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signUpAction, type AuthState } from "@/app/actions/auth";
import { AuthCard, ErrorLine, Field, SubmitButton } from "@/app/_components/AuthCard";

export default function SignUpPage() {
  const [state, formAction, pending] = useActionState<AuthState, FormData>(
    signUpAction,
    null
  );

  return (
    <AuthCard
      title="注册"
      subtitle="起一个用户名，记住它 —— 它是你在这里的唯一身份"
      footer={
        <>
          已经有账号了？{" "}
          <Link href="/sign-in" className="text-[color:var(--ink-2)] underline-offset-4 hover:underline">
            去登录
          </Link>
        </>
      }
    >
      <form action={formAction} className="space-y-4">
        <Field
          label="用户名"
          name="username"
          autoComplete="username"
          autoFocus
          required
          minLength={3}
          maxLength={20}
          placeholder="3–20 个字符"
          hint="可以是中文、字母、数字、下划线。注册后不能改，也不区分大小写。"
        />
        <Field
          label="密码"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="至少 8 位"
        />
        <Field
          label="确认密码"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="再输一次"
        />

        <ErrorLine message={state?.error} />

        <SubmitButton pending={pending} label="注册并进入" />
      </form>
    </AuthCard>
  );
}
