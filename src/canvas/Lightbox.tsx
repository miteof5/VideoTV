"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * 全屏看大图 / 看视频。
 *
 * ### 为什么必须 portal 到 document.body
 *
 * 画布上的节点住在 `.react-flow__viewport` 里，那一层带着
 * `transform: translate(...) scale(...)`。CSS 里 `position: fixed` 的包含块是
 * **最近的 transform 祖先**，不是视口 —— 直接写在节点里，这个「全屏」浮层
 * 会被画布缩放一起缩掉，位置也会跟着相机跑。
 *
 * 症状很难归因：明明是 `inset-0`，看起来却只铺满了一小块，而且点到画布上
 * 还能拖动画布（因为浮层实际只有那么点大）。
 *
 * 所以挂到 body 上，脱离画布坐标系。
 *
 * ### 为什么 Esc 走 window
 *
 * 浮层是全屏的，但焦点可能还在画布或某个输入框里。挂在 window 上才能
 * 在「焦点不在浮层里」时也关掉。用户按 Esc 的意图是明确的：关掉最上面这层。
 */
export function Lightbox({
  assetId,
  kind,
  caption,
  onClose,
}: {
  assetId: string;
  kind: string;
  /** 一行小字（体积 / 时间）。没有就不渲染 */
  caption?: string;
  onClose: () => void;
}) {
  /*
   * 用 ref 存 onClose，effect 依赖才可以是空的。
   *
   * 父组件每次渲染都会传一个新的箭头函数，把它写进依赖的话，
   * 这个 effect 会跟着父组件的每一次重渲染反复解绑/重绑 keydown 监听。
   * 画布上父组件的重渲染频率是「拖一下就几十次」—— 那时正按着 Esc，
   * 恰好落在解绑和重绑之间，这一次按键就丢了。
   */
  const closeRef = useRef(onClose);
  // 在 effect 里同步，不在渲染期间写 ref（渲染期间写 ref 会被 React 的
  // 新规则判为错误，而且它本身就意味着「渲染有副作用」）。
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      data-lightbox
      role="dialog"
      aria-modal="true"
      aria-label={kind === "video" ? "查看视频" : "查看图片"}
      // 点任意处关闭（和资产库原来那套手感一致）。媒体本身除外 ——
      // 看视频时想在画面上点播放/暂停，那一下不该把浮层关掉。
      onClick={onClose}
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-black/90 p-8"
    >
      {kind === "video" ? (
        <video
          data-lightbox-media
          src={`/api/assets/${assetId}`}
          controls
          autoPlay
          loop
          playsInline
          onClick={(e) => e.stopPropagation()}
          className="max-h-[86vh] max-w-full rounded-lg bg-black shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          data-lightbox-media
          src={`/api/assets/${assetId}`}
          alt=""
          onClick={(e) => e.stopPropagation()}
          className="max-h-[86vh] max-w-full rounded-lg object-contain shadow-[0_20px_60px_rgba(0,0,0,0.6)]"
        />
      )}

      <div
        className="flex items-center gap-4 text-[length:var(--fs-meta)] text-[color:var(--ink-2)]"
        onClick={(e) => e.stopPropagation()}
      >
        {caption ? <span>{caption}</span> : null}
        <a
          href={`/api/assets/${assetId}?dl=1`}
          download
          data-lightbox-download
          className="rounded-md border border-[color:var(--line-2)] px-3 py-1 text-[color:var(--ink-1)] transition-colors hover:border-[color:var(--line-3)] hover:bg-[color:var(--surface-2)]"
        >
          ↓ 下载
        </a>
        <span className="text-[color:var(--ink-3)]">Esc 或点空白处关闭</span>
      </div>
    </div>,
    document.body
  );
}
