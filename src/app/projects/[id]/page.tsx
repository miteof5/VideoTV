import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { Canvas } from "@/canvas/Canvas";
import type { CanvasNode, CanvasNodeData } from "@/canvas/types";
import type { NodeRuntime } from "@/stores/runStore";

// 阻塞式渲染：项目不存在时要返回真正的 404 状态码（详见 ARCHITECTURE.md）
export const instant = false;

function parseData(raw: string): CanvasNodeData {
  try {
    return JSON.parse(raw) as CanvasNodeData;
  } catch {
    return { label: "", prompt: "", status: "idle" };
  }
}

export default async function ProjectPage({
  params,
}: PageProps<"/projects/[id]">) {
  const { id } = await params;

  // 连 outputAsset 一起查出来：刷新页面后要能把上次生成的图/视频直接显示出来
  const project = await db.project.findUnique({
    where: { id },
    include: { nodes: { include: { outputAsset: true } }, edges: true },
  });

  if (!project) notFound();

  // 数据库行 → React Flow 节点。注意 data 在库里是 JSON 字符串
  const initialNodes: CanvasNode[] = project.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.positionX, y: n.positionY },
    data: parseData(n.data),
  }));

  const initialEdges = project.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    // 端口要带回前端：视频节点的首帧/尾帧靠它区分。
    // legacy 数据是空串，canvasStore.init 会把它归到默认端口上。
    targetHandle: e.targetHandle,
  }));

  // 服务端状态 → 运行态 store。
  // 不做这一步，节点状态就只是内存里的东西，刷新页面一切归零，
  // 明明产物还在磁盘上，用户却以为白跑了。
  const initialRuntime: Record<string, NodeRuntime> = {};
  for (const n of project.nodes) {
    initialRuntime[n.id] = {
      status: n.status,
      progress: n.status === "succeeded" ? 1 : 0,
      error: n.error,
      output: n.outputAsset
        ? {
            assetId: n.outputAsset.id,
            kind: n.outputAsset.kind,
            mimeType: n.outputAsset.mimeType,
            sizeBytes: n.outputAsset.sizeBytes,
          }
        : undefined,
    };
  }

  // 上次离开时的视野。三列必须同时有值才算有效存档 ——
  // 只校验 viewSpan 就够了吗？不够：早期写入若中断，可能只留下一部分。
  // 三列一起判，宁可退回自动取景，也不要拿半个坐标去还原出一个歪掉的视野。
  const initialViewport =
    project.viewSpan !== null &&
    project.viewCenterX !== null &&
    project.viewCenterY !== null
      ? {
          centerX: project.viewCenterX,
          centerY: project.viewCenterY,
          span: project.viewSpan,
        }
      : null;

  return (
    <main className="flex h-screen flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-[color:var(--line-1)] bg-[color:var(--surface-1)] px-6 py-3">
        <Link
          href="/"
          className="text-[length:var(--fs-meta)] text-[color:var(--ink-2)] transition-colors hover:text-[color:var(--ink-1)]"
        >
          ← 返回
        </Link>
        <h1 className="text-[length:var(--fs-title)] font-medium">{project.name}</h1>
        <span className="text-[length:var(--fs-meta)] text-[color:var(--ink-3)]">
          {project.nodes.length} 个节点 · {project.edges.length} 条连线
        </span>
      </header>

      <div className="min-h-0 flex-1">
        <Canvas
          projectId={project.id}
          initialNodes={initialNodes}
          initialEdges={initialEdges}
          initialRuntime={initialRuntime}
          initialViewport={initialViewport}
        />
      </div>
    </main>
  );
}
