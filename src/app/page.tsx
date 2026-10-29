import Link from "next/link";
import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { createProject, deleteProject } from "@/app/actions/projects";
import { signOutAction } from "@/app/actions/auth";

// Next 16 的 Cache Components 把缓存模型反过来了：
// 「默认动态，用 "use cache" 显式声明缓存」，且页面外壳会先被预渲染。
// 因此凡是 await 数据库的部分，必须包在 <Suspense> 里流式补齐，
// 否则构建期就会报 "encountered uncached or runtime data during prerendering"。
// 好处是：页面骨架立刻可见，列表数据稍后流式到达（Partial Prerendering）。

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

async function ProjectList() {
  // 拿 session 的地方就是「安全边界」。proxy 只挡了没有 cookie 的人，
  // cookie 有但 session 已过期（被登出、被撤销、30 天到期）只能在这里发现。
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  // Server Component 里直接查库，这段代码只在服务端执行
  // 归属过滤就写在 where 里 —— 不是查完再筛，是**根本查不出来**
  const projects = await db.project.findMany({
    where: { ownerId: session.user.id },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { nodes: true } } },
  });

  if (projects.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[color:var(--line-2)] bg-transparent px-6 py-16 text-center">
        <p className="text-sm text-[color:var(--ink-2)]">还没有项目，先建一个吧。</p>
      </div>
    );
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {projects.map((project) => (
        <li
          key={project.id}
          className="group relative rounded-xl border border-[color:var(--line-1)] bg-[color:var(--surface-1)] p-4 transition-colors hover:border-[color:var(--line-2)]"
        >
          <Link href={`/projects/${project.id}`} className="block">
            <h2 className="truncate pr-14 text-sm font-medium">
              {project.name}
            </h2>
            <p className="mt-1.5 text-xs text-[color:var(--ink-3)]">
              {project._count.nodes} 个节点 ·{" "}
              {timeFormatter.format(project.updatedAt)}
            </p>
          </Link>

          <form
            action={deleteProject}
            className="absolute right-3 top-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
          >
            <input type="hidden" name="id" value={project.id} />
            <button
              type="submit"
              className="rounded-md px-2 py-1 text-xs text-[color:var(--ink-3)] transition-colors hover:bg-red-950/60 hover:text-red-300"
            >
              删除
            </button>
          </form>
        </li>
      ))}
    </ul>
  );
}

async function UserBadge() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;

  const name = session.user.displayUsername ?? session.user.name;

  /*
   * 这个人**总共**花了多少积分 —— 跨所有项目，不是某一个项目的。
   *
   * 和项目页那个「本项目累计」是两件事：那个回答「这一集花了多少」，
   * 这个回答「我到现在花了多少」。多用户之后只有后者是真的按人算的，
   * 前者会变成「这个项目上所有人加起来」。
   *
   * 用 Run.credits 求和而不是 Job：Run 是一次运行的账本，Job 以后会被清理。
   * 按 userId 过滤 —— 批 1 之前的历史 run 没有 userId，那些不计入任何人。
   */
  const creditSum = await db.run.aggregate({
    _sum: { credits: true },
    where: { userId: session.user.id },
  });
  const totalCredits = creditSum._sum.credits ?? 0;

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <form action={signOutAction} className="flex items-center gap-1.5">
        <span className="max-w-[12rem] truncate text-xs text-[color:var(--ink-3)]">{name}</span>
        <button
          type="submit"
          className="rounded-md px-2 py-1 text-xs text-[color:var(--ink-3)] transition-colors hover:bg-[color:var(--surface-2)] hover:text-[color:var(--ink-1)]"
        >
          退出
        </button>
      </form>
      {/* 一分都没花过时不显示 —— 一个「累计 0 积分」只是噪音 */}
      {totalCredits > 0 && (
        <span className="text-[length:var(--fs-meta)] text-[color:var(--ink-3)]">
          累计 {totalCredits} 积分
        </span>
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-[74px] animate-pulse rounded-xl bg-[color:var(--surface-2)]" />
      ))}
    </div>
  );
}

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-14">
      <header className="mb-10 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">VideoTV</h1>
          <p className="mt-1.5 text-sm text-[color:var(--ink-2)]">
            无限画布 + 节点式工作流的 AI 视频生产平台
          </p>
        </div>

        {/* 单独一个 Suspense：用户信息要查库，不能拖住整个页面外壳的预渲染 */}
        <Suspense fallback={null}>
          <UserBadge />
        </Suspense>
      </header>

      <form action={createProject} className="mb-10 flex gap-2">
        <input
          name="name"
          placeholder="新项目名称，例如：都市情感短片 第 01 集"
          className="h-10 flex-1 rounded-lg border border-[color:var(--line-2)] bg-[color:var(--surface-1)] px-3 text-sm text-[color:var(--ink-1)] outline-none transition-colors placeholder:text-[color:var(--ink-3)] focus:border-[color:var(--line-3)]"
        />
        <button
          type="submit"
          className="h-10 shrink-0 rounded-lg border border-[color:var(--line-3)] bg-[color:var(--btn-bg)] px-4 text-sm font-medium text-white transition-colors hover:bg-[color:var(--btn-bg-hover)]"
        >
          新建项目
        </button>
      </form>

      <Suspense fallback={<ListSkeleton />}>
        <ProjectList />
      </Suspense>
    </main>
  );
}
