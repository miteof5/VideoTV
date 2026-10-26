import Link from "next/link";
import { Suspense } from "react";
import { db } from "@/lib/db";
import { createProject, deleteProject } from "@/app/actions/projects";

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
  // Server Component 里直接查库，这段代码只在服务端执行
  const projects = await db.project.findMany({
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
      <header className="mb-10">
        <h1 className="text-2xl font-medium tracking-tight">VideoTV</h1>
        <p className="mt-1.5 text-sm text-[color:var(--ink-2)]">
          无限画布 + 节点式工作流的 AI 视频生产平台
        </p>
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
