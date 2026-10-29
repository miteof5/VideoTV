"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signInAction, type AuthState } from "@/app/actions/auth";
import { AuthCard, ErrorLine, Field, SubmitButton } from "@/app/_components/AuthCard";

export default function SignInPage() {
  const [state, formAction, pending] = useActionState<AuthState, FormData>(
    signInAction,
    null
  );

  return (
    <AuthCard
      title="登录"
      subtitle="用你的用户名和密码继续"
      footer={
        <>
          还没有账号？{" "}
          <Link href="/sign-up" className="text-[color:var(--ink-2)] underline-offset-4 hover:underline">
            注册一个
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
          placeholder="你的用户名"
        />
        <Field
          label="密码"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="至少 8 位"
        />

        <ErrorLine message={state?.error} />

        <SubmitButton pending={pending} label="登录" />
      </form>
    </AuthCard>
  );
}
