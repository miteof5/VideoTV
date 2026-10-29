"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 运行历史抽屉。
 *
 * ### 为什么这件事现在才有
 *
 * `RunEvent` 表一直在写（Worker 跑完会落一条「本次 N 个节点，消耗 X 积分」），
 * 但前端从来没有组件读过它 —— 数据一直在，只是没人看。
 * 这个抽屉是它第一个读者。
 *
 * ### 为什么列表和明细分两次请求
 *
 * 列表要的是「每次一行」（一次聚合），明细是「那次里面逐条发生了什么」。
 * 一次带上的话，打开抽屉就要拉三十次运行的全部日志，
 * 而其中二十九次的日志他根本不会看。
 *
 * 明细只在第一次展开时拉，之后缓存在内存里 —— 反复折叠展开不该反复请求。
 */

interface RunItem {
  id: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
  credits: number;
  nodeCount: number;
  failedCount: number;
  error: string | null;
  target: { id: string; label: string } | null;
}

interface RunEventItem {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "排队中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};

const STATUS_CLS: Record<string, string> = {
  succeeded: "bg-emerald-950 text-emerald-300",
  failed: "bg-red-950 text-red-300",
  cancelled: "bg-[color:var(--surface-3)] text-[color:var(--ink-3)]",
  running: "bg-sky-950 text-sky-300",
  pending: "bg-[color:var(--surface-3)] text-[color:var(--ink-2)]",
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

/** 一次运行花了多久。没跑完 / 没记录就给空 */
function formatDuration(start: string, end: string | null) {
  if (!end) return "";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms < 60_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`;
}

/**
 * 把一条事件变成一行能读的话。
 *
 * 返回 null = 这类事件不进历史面板（进度的每一帧都刷一条，
 * 全放进来会把真正有用的那几行埋掉）。
 */
function describe(
  e: RunEventItem,
  labelOf: Record<string, string>
): { level: string; text: string; time: string } | null {
  const p = e.payload ?? {};
  const nodeId = typeof p.nodeId === "string" ? p.nodeId : null;
  const who = nodeId ? `「${labelOf[nodeId] || "已删除的节点"}」` : "";

  if (e.type === "log") {
    return {
      level: typeof p.level === "string" ? p.level : "info",
      text: `${who}${String(p.message ?? "")}`,
      time: "",
    };
  }

  if (e.type === "node.status") {
    const status = String(p.status ?? "");
    const error = typeof p.error === "string" ? `：${p.error}` : "";
    return {
      level: status === "failed" ? "error" : status === "skipped" ? "warn" : "info",
      text: `${who}${STATUS_LABEL[status] ?? status}${error}`,
      time: "",
    };
  }

  if (e.type === "run.status") {
    const status = String(p.status ?? "");
    return {
      level: status === "failed" ? "error" : status === "cancelled" ? "warn" : "info",
      text: `运行${STATUS_LABEL[status] ?? status}`,
      time: "",
    };
  }

  if (e.type === "node.output") {
    return { level: "info", text: `${who}产物已落库`, time: "" };
  }

  // node.progress / node.text 之类的过程事件不进来
  return null;
}

export function RunHistory({
  projectId,
  onClose,
  labelOf,
}: {
  projectId: string;
  onClose: () => void;
  /** 节点 id → 名字。用来把事件里的 nodeId 说成人话 */
  labelOf: Record<string, string>;
}) {
  const [items, setItems] = useState<RunItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [openId, setOpenId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEventItem[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  /** 已经拉过明细的运行，避免反复折叠展开反复请求 */
  const cache = useRef(new Map<string, RunEventItem[]>());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/runs`, {
        cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `加载失败（HTTP ${res.status}）`);
      setItems(body.runs ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  /*
   * 进来就拉一次。
   *
   * 抽屉是「打开才挂载」的（父组件条件渲染），所以卸载即复位 ——
   * 不需要在关闭时手动清 openId / events，也不会出现
   * 「打开时还停在上次展开的那一条」。
   *
   * 那次 `await Promise.resolve()` 不是装饰：抽屉刚挂载的那一帧里
   * 同步 setState 会触发级联渲染（lint 也会拦），先让出一拍再进异步流程。
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (alive) await load();
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = async (runId: string) => {
    if (openId === runId) {
      setOpenId(null);
      return;
    }
    setOpenId(runId);
    setEventsError(null);

    const cached = cache.current.get(runId);
    if (cached) {
      setEvents(cached);
      return;
    }

    setEventsLoading(true);
    setEvents([]);
    try {
      const res = await fetch(`/api/runs/${runId}/events`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `加载失败（HTTP ${res.status}）`);
      const list: RunEventItem[] = body.events ?? [];
      cache.current.set(runId, list);
      setEvents(list);
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setEventsLoading(false);
    }
  };

  return (
    <div
      data-run-history
      className="absolute right-0 top-0 z-40 flex h-full w-[min(420px,90vw)] flex-col border-l border-[color:var(--line-1)] bg-[color:var(--surface-1)] shadow-[-16px_0_40px_rgba(0,0,0,0.45)]"
    >
      <div className="flex items-center justify-between border-b border-[color:var(--line-1)] px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[length:var(--fs-control)] font-medium text-[color:var(--ink-1)]">
            运行历史
          </span>
          <span
            data-run-count
            className="text-[length:var(--fs-meta)] text-[color:var(--ink-3)]"
          >
            {loading ? "加载中…" : `最近 ${items.length} 次`}
          </span>
        </div>
        <button
          type="button"
          data-action="close-runs"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-[length:var(--fs-meta)] text-[color:var(--ink-3)] transition-colors hover:bg-[color:var(--surface-3)] hover:text-[color:var(--ink-1)]"
        >
          关闭
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="m-4 rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-[length:var(--fs-meta)] leading-relaxed text-red-200">
            {error}
            <button
              type="button"
              onClick={() => void load()}
              className="ml-2 underline underline-offset-2"
            >
              重试
            </button>
          </div>
        ) : null}

        {!error && !loading && items.length === 0 ? (
          <p className="m-4 text-[length:var(--fs-meta)] leading-relaxed text-[color:var(--ink-3)]">
            这个项目还没跑过。点节点上的「生成 ↑」之后，这里会记下每一次。
          </p>
        ) : null}

        {items.map((run) => {
          const expanded = openId === run.id;
          const rows = expanded
            ? events
                .map((e) => {
                  const d = describe(e, labelOf);
                  return d ? { ...d, seq: e.seq } : null;
                })
                .filter((x): x is { level: string; text: string; time: string; seq: number } =>
                  Boolean(x)
                )
            : [];

          return (
            <div
              key={run.id}
              data-run-row
              data-run-status={run.status}
              className="border-b border-[color:var(--line-1)]"
            >
              <button
                type="button"
                data-run-toggle
                onClick={() => void toggle(run.id)}
                className="flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-[color:var(--surface-2)]"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[length:var(--fs-meta)] font-medium ${
                      STATUS_CLS[run.status] ?? STATUS_CLS.pending
                    }`}
                  >
                    {STATUS_LABEL[run.status] ?? run.status}
                  </span>
                  <span className="text-[length:var(--fs-meta)] text-[color:var(--ink-2)]">
                    {formatTime(run.createdAt)}
                  </span>
                  <span className="text-[length:var(--fs-meta)] text-[color:var(--ink-3)]">
                    {run.nodeCount} 个节点
                    {run.credits > 0 ? ` · ${run.credits} 积分` : ""}
                    {formatDuration(run.createdAt, run.endedAt)
                      ? ` · ${formatDuration(run.createdAt, run.endedAt)}`
                      : ""}
                  </span>
                </div>

                {run.target ? (
                  <span className="text-[length:var(--fs-meta)] text-[color:var(--ink-3)]">
                    点的节点：{run.target.label || "（未命名）"}
                  </span>
                ) : null}

                {run.error ? (
                  <span className="truncate text-[length:var(--fs-meta)] text-red-300">
                    {run.error}
                  </span>
                ) : null}
              </button>

              {expanded ? (
                <div className="bg-[color:var(--surface-2)]/40 px-4 pb-3">
                  {eventsLoading ? (
                    <p className="pt-1 text-[length:var(--fs-meta)] text-[color:var(--ink-3)]">
                      加载中…
                    </p>
                  ) : eventsError ? (
                    <p className="pt-1 text-[length:var(--fs-meta)] text-red-300">
                      {eventsError}
                    </p>
                  ) : rows.length === 0 ? (
                    <p className="pt-1 text-[length:var(--fs-meta)] text-[color:var(--ink-3)]">
                      这次运行没有留下记录。
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1 pt-1">
                      {rows.map((r) => (
                        <li
                          key={r.seq}
                          data-run-event={r.level}
                          className={[
                            "whitespace-pre-wrap break-words text-[length:var(--fs-meta)] leading-relaxed",
                            r.level === "error"
                              ? "text-red-300"
                              : r.level === "warn"
                                ? "text-amber-300"
                                : "text-[color:var(--ink-2)]",
                          ].join(" ")}
                        >
                          {r.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
