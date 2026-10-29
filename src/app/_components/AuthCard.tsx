import type { InputHTMLAttributes, ReactNode } from "react";

/**
 * 登录 / 注册共用的外壳。
 *
 * 抽出来不是为了少写几行 —— 是为了两个页面的输入框、错误提示、间距**永远一致**。
 * 它们本来就该长得一样（用户在这两个页面之间来回跳），各写一份之后必然慢慢长歪。
 */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-medium tracking-tight">VideoTV</h1>
        <p className="mt-1.5 text-sm text-[color:var(--ink-2)]">{subtitle}</p>

        <div className="mt-8 rounded-xl border border-[color:var(--line-1)] bg-[color:var(--surface-1)] p-6">
          <h2 className="mb-5 text-sm font-medium">{title}</h2>
          {children}
        </div>

        <div className="mt-5 text-center text-xs text-[color:var(--ink-3)]">{footer}</div>
      </div>
    </main>
  );
}

export function Field({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-[color:var(--ink-3)]">{label}</span>
      <input
        {...props}
        className="h-10 w-full rounded-lg border border-[color:var(--line-2)] bg-[color:var(--surface-2)] px-3 text-sm text-[color:var(--ink-1)] outline-none transition-colors placeholder:text-[color:var(--ink-3)] focus:border-[color:var(--line-3)]"
      />
      {hint ? (
        <span className="mt-1.5 block text-[11px] text-[color:var(--ink-3)]">{hint}</span>
      ) : null}
    </label>
  );
}

export function SubmitButton({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-10 w-full rounded-lg border border-[color:var(--line-3)] bg-[color:var(--btn-bg)] text-sm font-medium text-white transition-colors hover:bg-[color:var(--btn-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "请稍候…" : label}
    </button>
  );
}

export function ErrorLine({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-red-900/70 bg-red-950/40 px-3 py-2 text-xs leading-relaxed text-red-300"
    >
      {message}
    </p>
  );
}
