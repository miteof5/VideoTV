import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { RUN_STATUS } from "@/lib/constants";
import { readSince } from "@/lib/events";

// SSE 进度推送。
//
// 关键点：**这里不产生任何状态，只转述**。
// 状态是 Worker 写进 RunEvent 表的，本路由只是按 seq 游标把增量读出来。
// 之所以必须绕这一圈，是因为 Worker 是独立进程，和 Next 不共享内存 ——
// 在 API 里放一个 EventEmitter 是收不到 Worker 的事件的。
//
// SSE（而不是 WebSocket）的理由：只需要服务端→客户端这一个方向，
// 浏览器原生支持自动重连，还会自动带上 Last-Event-ID。
// 用 WebSocket 得自己写心跳、重连、断线补发，全是重复劳动。

/** 轮询间隔。事件是落库的，这里只能是拉；600ms 在跟手和开销之间比较平衡 */
const POLL_MS = 600;
/** 心跳间隔。中间设备（代理、网关）常常掐掉长时间没字节流动的连接 */
const HEARTBEAT_MS = 15_000;

// 显式标成 string[]：不加标注会被推导成字面量联合，
// 而数据库里读出来的 status 是 string，两者对不上。
const TERMINAL: string[] = [
  RUN_STATUS.SUCCEEDED,
  RUN_STATUS.FAILED,
  RUN_STATUS.CANCELLED,
];

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: runId } = await params;

  const run = await db.run.findUnique({
    where: { id: runId },
    select: { id: true, status: true },
  });
  if (!run) {
    return new Response(JSON.stringify({ error: "运行不存在" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  // 断线重连的入口：浏览器重连时会把收到的最后一个 id 带回来，
  // 从它之后开始读，既不会重复也不会漏。这是把事件落库的直接收益。
  const headerSeq = Number(req.headers.get("last-event-id"));
  let cursor = Number.isFinite(headerSeq) && headerSeq > 0 ? headerSeq : 0;

  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let beatTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          // 客户端已经走了，再写会抛。这里不能让异常冒到轮询循环里
          cleanup();
          return false;
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (beatTimer) clearInterval(beatTimer);
        try {
          controller.close();
        } catch {
          // 已经关了，忽略
        }
      };

      // 客户端断开（关标签页、刷新、网络切换）必须清理定时器。
      // 不清理的话每刷新一次页面就漏一个 600ms 的循环，
      // 跑一天就能攒出成千上万个还在查数据库的定时器。
      req.signal.addEventListener("abort", cleanup, { once: true });

      safeEnqueue(`retry: 3000\n\n`);

      beatTimer = setInterval(() => {
        // 注释行：浏览器不会派发事件，但连接上有字节流动，代理就不会掐断
        safeEnqueue(`: ping ${Date.now()}\n\n`);
      }, HEARTBEAT_MS);

      const pump = async () => {
        if (closed) return;

        try {
          const events = await readSince(runId, cursor, 300);

          for (const e of events) {
            const ok = safeEnqueue(
              `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`
            );
            if (!ok) return;
            cursor = e.seq;
          }

          // 终态判定要放在推完事件之后：
          // 顺序反了的话，最后几条事件（尤其是产物挂载）会被漏掉，
          // 表现为"所有节点都绿了，但最后一个没有图"。
          const current = await db.run.findUnique({
            where: { id: runId },
            select: { status: true },
          });
          if (current && TERMINAL.includes(current.status)) {
            safeEnqueue(`event: end\ndata: {"status":"${current.status}"}\n\n`);
            cleanup();
          }
        } catch (err) {
          console.error("[sse] 读取事件失败：", err);
        }
      };

      pollTimer = setInterval(() => void pump(), POLL_MS);
      // 立刻跑一次：新订阅者不用等 600ms 才看到第一条
      void pump();
    },

    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (beatTimer) clearInterval(beatTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-cache 是必须的，否则中间的缓存可能把整条流攒起来一次性给你
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // nginx 默认会缓冲响应，缓冲一开 SSE 就变成了"全部结束后一次性收到"
      "X-Accel-Buffering": "no",
    },
  });
}
