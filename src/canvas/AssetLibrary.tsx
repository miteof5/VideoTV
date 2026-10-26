"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * 资产库：一个项目一个，装这个项目里出现过的所有图片和视频。
 *
 * ## 为什么是抽屉而不是浮层
 *
 * 节点面板（composer）是浮层，因为它必须贴着节点；资产库不贴任何东西，
 * 它是「翻库存」的场景 —— 一屏能看见的越多越好。420px 宽的抽屉
 * 一次铺两列、滚起来不停，比一个受工具栏宽度限制的浮层实用得多。
 *
 * ## 为什么左键是预览、右键才是操作
 *
 * 人在 2026-10-26 定的：右键出「下载 / 删除 / 添加到画布」三项。
 * 那左键就必须给点反馈 —— 一个点下去什么都不发生的格子，会被当成坏了。
 * 预览是零成本的那个反馈：看得清才敢决定用不用。
 *
 * ## 为什么不用 <video> 自动播
 *
 * 一个项目攒到几十个视频时，几十个解码器同时跑会把画布拖到掉帧。
 * 用 `#t=0.1` 那个片段参数让浏览器只解码第一帧当封面，
 * `preload="metadata"` 保证不会提前下整个文件。
 */

export interface AssetItem {
  id: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  usedBy: number;
}

/** 右键菜单在屏幕上的位置 + 它作用在谁身上 */
interface MenuState {
  x: number;
  y: number;
  asset: AssetItem;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

export function AssetLibrary({
  projectId,
  open,
  onClose,
  onAddToCanvas,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  onAddToCanvas: (asset: AssetItem) => void;
}) {
  const [items, setItems] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [preview, setPreview] = useState<AssetItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/assets`, {
        cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `加载失败（HTTP ${res.status}）`);
      setItems(body.assets ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  /*
   * 每次打开都重新拉。
   *
   * 不做缓存的原因：生成产物是在**另一个进程**（worker）里落库的，
   * 前端没有任何事件能知道「刚刚新出了一张图」。
   * 缓存一次就变成「跑完生成，打开资产库，里面没有刚生成的图」——
   * 用户会以为生成失败了。几百条记录的请求，重拉比缓存划算。
   */
  useEffect(() => {
    if (open) void load();
    else {
      setMenu(null);
      setPreview(null);
    }
  }, [open, load]);

  // Esc 逐层退出：先关右键菜单，再关预览，最后才关抽屉
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menu) setMenu(null);
      else if (preview) setPreview(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, menu, preview, onClose]);

  const remove = async (asset: AssetItem) => {
    setMenu(null);
    try {
      const res = await fetch(`/api/assets/${asset.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `删除失败（HTTP ${res.status}）`);
      setItems((list) => list.filter((a) => a.id !== asset.id));
      if (preview?.id === asset.id) setPreview(null);
      setError(null);
    } catch (err) {
      // 409（正在被节点使用）就走这里：把那句话原样显示给用户，
      // 不要换成「删除失败」，那句话里写了该怎么做。
      setError(err instanceof Error ? err.message : "删除失败");
    }
  };

  const download = (asset: AssetItem) => {
    setMenu(null);
    // ?dl=1 让服务端补 Content-Disposition，否则浏览器会直接在标签页里打开
    window.location.href = `/api/assets/${asset.id}?dl=1`;
  };

  if (!open) return null;

  return (
    <>
      {/* 抽屉本体。z-40 压住左上工具栏（z-10）和底部 + 号（z-20） */}
      <div
        data-asset-library
        className="absolute right-0 top-0 z-40 flex h-full w-[min(420px,90vw)] flex-col border-l border-[color:var(--line-1)] bg-[color:var(--surface-1)] shadow-[-16px_0_40px_rgba(0,0,0,0.45)]"
      >
        <div className="flex items-center justify-between border-b border-[color:var(--line-1)] px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[length:var(--fs-control)] font-medium text-[color:var(--ink-1)]">
              资产库
            </span>
            <span
              data-asset-count
              className="text-[length:var(--fs-meta)] text-[color:var(--ink-3)]"
            >
              {loading ? "加载中…" : `${items.length} 个`}
            </span>
          </div>
          <button
            type="button"
            data-action="close-assets"
            onClick={onClose}
            title="收起资产库（Esc）"
            className="rounded-md px-2 py-1 text-[length:var(--fs-meta)] text-[color:var(--ink-2)] transition-colors hover:bg-[color:var(--surface-3)] hover:text-[color:var(--ink-1)]"
          >
            收起
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {error && (
            <div
              data-asset-error
              className="mb-3 rounded-md border border-red-900 bg-red-950/60 px-3 py-2 text-[length:var(--fs-meta)] leading-relaxed text-red-300"
            >
              {error}
            </div>
          )}

          {!loading && items.length === 0 && (
            <p className="px-1 py-8 text-center text-[length:var(--fs-meta)] leading-relaxed text-[color:var(--ink-3)]">
              这个项目还没有图片或视频。
              <br />
              上传素材、或运行一次生成，产物会出现在这里。
            </p>
          )}

          <div className="grid grid-cols-2 gap-2">
            {items.map((a) => (
              <button
                key={a.id}
                type="button"
                data-asset-id={a.id}
                data-asset-kind={a.kind}
                onClick={() => setPreview(a)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // 夹在视口内：贴右边右键时菜单会跑出屏幕，
                  // 越界的那一半点不到（它不在任何可点区域的上面）。
                  setMenu({
                    x: Math.min(e.clientX, window.innerWidth - 168),
                    y: Math.min(e.clientY, window.innerHeight - 132),
                    asset: a,
                  });
                }}
                title={`${a.kind === "video" ? "视频" : "图片"} · ${formatSize(
                  a.sizeBytes
                )} · 左键预览，右键更多`}
                className="group relative overflow-hidden rounded-lg border border-[color:var(--line-1)] bg-[color:var(--surface-2)] text-left transition-colors hover:border-[color:var(--line-3)]"
              >
                <div className="relative aspect-video w-full overflow-hidden bg-black">
                  {a.kind === "video" ? (
                    <video
                      src={`/api/assets/${a.id}#t=0.1`}
                      preload="metadata"
                      muted
                      playsInline
                      className="h-full w-full object-cover opacity-90"
                    />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/assets/${a.id}`}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  )}
                  {a.kind === "video" && (
                    <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[11px] leading-4 text-white">
                      ▶
                    </span>
                  )}
                  {a.usedBy > 0 && (
                    <span
                      data-asset-used={a.usedBy}
                      className="pointer-events-none absolute left-1 top-1 rounded bg-black/70 px-1 text-[11px] leading-4 text-[color:var(--ink-2)]"
                    >
                      画布上 {a.usedBy}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between px-2 py-1.5 text-[11px] text-[color:var(--ink-3)]">
                  <span>{formatSize(a.sizeBytes)}</span>
                  <span>{formatTime(a.createdAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="border-t border-[color:var(--line-1)] px-4 py-2 text-[11px] text-[color:var(--ink-3)]">
          左键预览 · 右键可下载、删除、添加到画布
        </div>
      </div>

      {/* 右键菜单 */}
      {menu && (
        <>
          {/* 铺一层透明遮罩负责「点别处关掉菜单」。
              用 fixed 而不是监听 document click：后者会先吃到格子自己的点击，
              表现为「点另一个格子，菜单没关，还顺手打开了预览」。 */}
          <div
            className="fixed inset-0 z-40"
            onPointerDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            data-asset-menu
            style={{ left: menu.x, top: menu.y }}
            className="fixed z-50 w-40 overflow-hidden rounded-lg border border-[color:var(--line-2)] bg-[color:var(--surface-1)] py-1 shadow-[0_10px_30px_rgba(0,0,0,0.6)]"
          >
            <button
              type="button"
              data-menu-action="add"
              onClick={() => {
                onAddToCanvas(menu.asset);
                setMenu(null);
              }}
              className="block w-full px-3 py-2 text-left text-[length:var(--fs-meta)] text-[color:var(--ink-1)] hover:bg-[color:var(--surface-3)]"
            >
              添加到画布
            </button>
            <button
              type="button"
              data-menu-action="download"
              onClick={() => download(menu.asset)}
              className="block w-full px-3 py-2 text-left text-[length:var(--fs-meta)] text-[color:var(--ink-1)] hover:bg-[color:var(--surface-3)]"
            >
              下载
            </button>
            <button
              type="button"
              data-menu-action="delete"
              onClick={() => void remove(menu.asset)}
              className="block w-full px-3 py-2 text-left text-[length:var(--fs-meta)] text-red-400 hover:bg-[color:var(--surface-3)]"
            >
              删除
            </button>
          </div>
        </>
      )}

      {/* 预览 */}
      {preview && (
        <div
          data-asset-preview
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-8"
          onClick={() => setPreview(null)}
        >
          {preview.kind === "video" ? (
            <video
              src={`/api/assets/${preview.id}`}
              controls
              autoPlay
              className="max-h-[80vh] max-w-full rounded-lg bg-black"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`/api/assets/${preview.id}`}
              alt=""
              className="max-h-[80vh] max-w-full rounded-lg object-contain"
            />
          )}
          <p className="mt-3 text-[length:var(--fs-meta)] text-[color:var(--ink-2)]">
            {formatSize(preview.sizeBytes)} · {formatTime(preview.createdAt)} ·
            点任意处关闭
          </p>
        </div>
      )}
    </>
  );
}
