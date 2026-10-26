"use client";

import { useCallback, useEffect, useState } from "react";
import { useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { NODE_STATUS } from "@/lib/constants";
import type { NodeDefinition } from "@/canvas/nodeRegistry";
import { displaySize } from "@/canvas/nodeSize";
import { effectiveModel } from "@/canvas/params";
import { useCanvasStore } from "@/stores/canvasStore";
import { useUiStore } from "@/stores/uiStore";
import { useRunStore } from "@/stores/runStore";
import { useModels } from "@/hooks/useModels";
import type { CanvasNode } from "@/canvas/types";
import {
  NodeDeleteButton,
  NodeInputHandles,
  NodeOutputHandle,
  NodePanel,
  TextField,
  formatBytes,
  statusStyle,
} from "@/canvas/nodes/common";

/**
 * 「裸」形态的节点：图 / 视频 / 上传素材。
 *
 * ### 为什么要脱掉外壳
 *
 * 原来的卡片是「头部 40 + 预览 172 + 底栏 36 + 边框 2 = 250」。
 * 一张 9:16 的竖图按 contain 塞进 172px 高的横框里，只剩 90px 宽 ——
 * 用户看不清自己生成了什么，而这个产品的整个价值就是「看见产物」。
 * 真正吃掉空间的不是图片，是那 78px 的框和标题。
 *
 * 所以这里只剩产物本身：没有边框、没有标题栏、没有底栏。
 * 节点尺寸按产物自己的比例走（长边封顶 720，见 canvas/nodeSize.ts）。
 *
 * ### 原来住在底栏的三样东西去哪了
 *
 *   运行按钮   → **删掉**。它和面板里的「生成」做的是同一件事
 *                （都是 startRun(node)），两个入口只会让人选错。
 *   下载       → 选中时浮在节点正上方
 *   删除       → 选中时浮在节点的右上角外侧（圆形叉号）
 *   状态点     → 挪到节点左上角外侧的标签行上，hover / 选中时可见
 *   失败提示   → 直接盖在产物底部（不改变尺寸）
 *
 * 为什么操作要「浮」而不是留一条底栏：底栏会重新引入那 36px，
 * 「节点大小 = 产物大小」就不成立了 —— 竖直方向的每一像素都该是图片。
 *
 * ### 尺寸为什么会变一次
 *
 * 图片的像素尺寸只有浏览器解码后才知道。所以：加载完成 → 把 naturalW/H
 * 写进节点 data（落库）→ 节点按新尺寸重排。**只发生一次**，
 * 第二次打开就是一次到位的。
 *
 * 这一步会让 React Flow 重新测量节点，连线端点跟着重算。
 * 这是「按产物比例显示」必须付的代价，无法避免 —— 只能让它只发生一次。
 *
 * ### 为什么标签在节点**外面**
 *
 * 用户明确要求「没有标题命名」，指的是卡片内部不要那条标题栏。
 * 但节点在画布上总得能被指认，而且改名需要入口（面板里的名称框早就删了）。
 * 折中：标签悬在节点左上角**外侧**，平时淡出、hover / 选中时出现，
 * 双击它改名。它不占产物一个像素。
 */
export function MediaNode({
  id,
  data,
  type,
  selected,
  def,
}: NodeProps<CanvasNode> & { def: NodeDefinition }) {
  // 按 id 单独订阅：任何节点的状态变化都会重建 runtime 对象，
  // 但只有 id 命中的那个引用变了，其余节点不会重渲染。
  const rt = useRunStore((s) => s.runtime[id]);
  const statusKey = rt?.status ?? data.status ?? NODE_STATUS.IDLE;
  const status = statusStyle[statusKey] ?? statusStyle[NODE_STATUS.IDLE];

  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const dragging = useUiStore((s) => s.draggingId === id);
  const updateNodeInternals = useUpdateNodeInternals();

  /*
   * 这个节点现在会用哪个模型，以及它是不是演示模型。
   *
   * 角标必须挂在节点上，而不是只写在参数面板里 ——
   * 面板只有选中时才浮出来，而节点是画布上唯一一直可见的东西。
   * 不选中看不见「演示」二字，用户就会以为那产出是真的。
   */
  const models = useModels();
  const activeModel = def.capability
    ? effectiveModel(data, models, def.capability)
    : undefined;
  const isDemo = Boolean(activeModel?.demo);

  /**
   * 节点要显示什么。产物有两个来源：
   *
   *   1. **运行产物** —— 跑模型得到的东西，标识在 outputAssetId（runtime.output）
   *   2. **上传素材** —— 素材是节点自带的输入，标识存在节点参数里（assetInData）
   *
   * 为什么素材不能也走 outputAssetId：保存接口为了不覆盖运行时状态，
   * 是不碰那一列的。素材写进去的话，刷新页面后就会消失，
   * 而它明明是用户自己传上来的东西。
   */
  const fromData = def.assetInData;
  const previewAsset = fromData
    ? data.assetId
      ? {
          assetId: String(data.assetId),
          kind: String(data.assetKind ?? "image"),
        }
      : null
    : (rt?.output ?? null);

  const { w, h } = displaySize(def, data);
  const [editingLabel, setEditingLabel] = useState(false);

  /**
   * 把产物的像素尺寸记进节点数据。
   *
   * 只在**和已存的值不同**时写：否则每次挂载都标脏一次，
   * 刷新一个项目就会莫名其妙弹出「未保存」。
   */
  const measure = useCallback(
    (nw: number, nh: number) => {
      if (!(nw > 0 && nh > 0)) return;
      if (Number(data.naturalW) === nw && Number(data.naturalH) === nh) return;
      updateNodeData(id, { naturalW: nw, naturalH: nh });
    },
    [data.naturalW, data.naturalH, id, updateNodeData]
  );

  /**
   * 尺寸变了就通知 React Flow 重算端点位置。
   *
   * React Flow v12 自己也会用 ResizeObserver 测到尺寸变化，但那只保证
   * 「它知道节点变大了」；handle 的坐标缓存要这一步才会刷新。
   * 漏掉它的症状是「图片变大了，连线还插在原来那个高度」—— 不报错。
   *
   * 放在 effect 里而不是 measure 里：measure 里调用时 DOM 还是旧尺寸，
   * 通知得太早。
   */
  useEffect(() => {
    updateNodeInternals(id);
  }, [w, h, id, updateNodeInternals]);

  const enterEdit = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("textarea, input, select, button, a")) return;
    // 只有双击标签才改名：双击图片本身没有意义（不提供放大，那是另一个能力）
    if (target.closest("[data-node-label]")) setEditingLabel(true);
  };

  /** 焦点离开整个节点才算退出改名。理由同卡片形态 —— 中间态会让点击落空 */
  const exitLabelEdit = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!editingLabel) return;
    const next = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(next)) setEditingLabel(false);
  };

  return (
    <div
      data-node-id={id}
      data-node-type={type}
      data-status={statusKey}
      data-editing={editingLabel ? "label" : "0"}
      data-shell="bare"
      style={{ width: w, height: h }}
      onDoubleClick={enterEdit}
      onBlur={exitLabelEdit}
      /*
       * 没有 border / bg / shadow —— 这整块就是那张图。
       *
       * `nopan` 仍然必须有：React Flow 的「双击放大」挂在画布容器上
       * （d3-zoom），双击节点会冒泡上去把画布放大一级，而且**没有任何报错**。
       * d3-zoom 的 filter 只认 nopan / nowheel，不认 nodrag。
       * 副作用为零：节点上本来就不该平移画布，滚轮缩放不受影响。
       *
       * 也绝不能加 overflow-hidden：具名端口的标签定位在节点**左外侧**，
       * 会被整个裁掉（handle 还在，字不见了，极难归因）。
       */
      className="group relative nopan"
    >
      <NodeInputHandles def={def} />

      {/*
        标签行：状态点 + 名字。挂在节点左上角**外面**，不占产物一个像素。
        平时淡出，hover 或选中时出现 —— 用户明确说了卡片里不要标题栏，
        但节点在画布上总得能被指认，改名也得有个入口。

        位置用 `bottom-full + mb-1.5` 而不是 `-top-6`：
        前者把「底边贴在节点顶边上方 6px」写成约束，改字号不用重算偏移；
        后者写死了 24px，字号一旦从 18 涨到 36，标签会压到产物上。
        （2026-10-26 放大字号时正是这条救了它。）
      */}
      <div
        data-node-label="1"
        className={[
          "absolute bottom-full left-0 mb-3 flex max-w-full items-center gap-4 whitespace-nowrap text-[length:var(--fs-bare-label)] leading-none transition-opacity",
          /*
           * 只输出一个 opacity 类。
           * 写成 `selected ? "opacity-100" : "..."` 再拼一个 `dragging ? "opacity-0"`，
           * 两个类会同时存在，谁赢取决于 Tailwind 生成 CSS 的先后顺序 ——
           * 那是一个看不见、改一次依赖就变的 bug。
           */
          dragging
            ? "opacity-0"
            : selected
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100",
        ].join(" ")}
      >
        <span className={`h-8 w-8 shrink-0 rounded-full ${status.dot}`} />
        {editingLabel ? (
          <div className="w-[340px]">
            <TextField
              nodeId={id}
              fieldKey="label"
              value={String(data.label ?? "")}
              placeholder="节点名称"
              plain
              focusOnMount
              /*
               * 字号必须跟着标签走。不传的话会退回组件的默认
               * `--fs-title`（18px），双击改名那一刻字会突然缩小一半 ——
               * 「编辑时变小」比「一直很小」更像 bug。
               */
              fontSize="var(--fs-bare-label)"
              /*
               * 退出靠两条路：Esc，或者焦点离开整个节点（见 exitLabelEdit）。
               * 不要「提交后自动退出」—— 防抖每 400ms 提交一次，
               * 那样打字打到第二个词，输入框就自己消失了。
               */
              onEscape={() => setEditingLabel(false)}
            />
          </div>
        ) : (
          <span
            className="cursor-text truncate text-[color:var(--ink-2)]"
            /*
             * 素材的原文件名和体积**曾经**在节点下方的面板里（一行只读小字），
             * 面板整个删掉之后（2026-10-26，素材没有可编辑参数，浮窗是空的）
             * 挪到标签的悬停提示里。
             *
             * 为什么补这一步：排查「我传的是不是那张图」时只有它给得出答案，
             * 而标签本来就要 hover/选中才浮现，挂在这里不额外占任何视觉空间。
             */
            title={
              def.assetInData
                ? `${String(data.assetName || "未命名文件")}${
                    Number(data.assetSize ?? 0) > 0
                      ? ` · ${formatBytes(Number(data.assetSize))}`
                      : ""
                  }\n双击改名`
                : "双击改名"
            }
          >
            {data.label || "未命名节点"}
          </span>
        )}
      </div>

      {/* 产物本体。圆角只在这一层，边框/背景一概没有 */}
      <div
        className={[
          "relative h-full w-full overflow-hidden rounded-3xl bg-[color:var(--surface-2)] transition-shadow",
          selected
            // 选中/悬停的高亮圈：原来是深色（黑圈压在白底上），
            // 暗色下必须反过来用白色半透明，否则压在图上完全看不见
            ? "ring-[4px] ring-white/45"
            : "group-hover:ring-2 group-hover:ring-white/20",
        ].join(" ")}
      >
        {previewAsset?.kind === "video" ? (
          <video
            src={`/api/assets/${previewAsset.assetId}`}
            controls
            muted
            loop
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              measure(v.videoWidth, v.videoHeight);
            }}
            className="h-full w-full bg-black object-contain"
          />
        ) : previewAsset?.kind === "image" ? (
          <img
            src={`/api/assets/${previewAsset.assetId}`}
            alt={String(data.label ?? "素材")}
            loading="lazy"
            // 解码完成才知道像素尺寸。这是「按图片大小定节点大小」的
            // 唯一信息来源 —— 服务端存了 Asset 表，但没有宽高列，
            // 也不值得为这件事加一列（浏览器本来就要解码一次）。
            onLoad={(e) => {
              const img = e.currentTarget;
              measure(img.naturalWidth, img.naturalHeight);
            }}
            className="h-full w-full object-contain"
          />
        ) : (
          <div
            data-empty="1"
            className="flex h-full w-full flex-col items-center justify-center gap-8 text-[color:var(--ink-3)]"
          >
            {/*
              空态不放「尝试：图生图 / 图片高清」这类引导。
              那需要真的模板能力，没有就是四个点了没反应的假按钮。

              图标和文字比 400×250 时代大了两号：占位框现在是 1280×720，
              64px 的图标扔进去只有一个点那么大，看起来像渲染失败。

              2026-10-26 人要求「尚未生成这四个字以及它的图标」变大，
              两样一起按 2 倍走：图标 80→160，文字 16→32，间距 16→32。
              **两者比例必须同时变**（80:16 = 160:32 = 5:1）——
              图标和文字的比例一旦失衡，界面会显得像「图标没加载出来」。
              strokeWidth 不用动：它写在 24 单位的 viewBox 里，
              跟着图标整体缩放，屏幕上看到的线宽比例本来就是恒定的。
            */}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.25}
              className="h-40 w-40"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <circle cx="8.5" cy="9.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <span className="text-[length:var(--fs-bare-hint)]">
              {/* 上传节点不会「生成」，说「尚未生成」会让人等它 */}
              {fromData
                ? "素材缺失"
                : statusKey === NODE_STATUS.RUNNING
                  ? "生成中…"
                  : "尚未生成"}
            </span>
          </div>
        )}

        {/*
          演示模型角标。绝对定位，不参与布局。
          位置在产物左上角：既醒目，又不压底部的错误条。
        */}
        {isDemo && (
          <span
            data-demo-badge="1"
            title="当前用的是内置演示模型，产出是占位内容，不是真实模型生成的结果"
            className="pointer-events-none absolute left-6 top-6 z-10 rounded-lg bg-amber-950/90 px-3 py-1.5 text-[length:var(--fs-meta)] font-medium leading-none text-amber-300"
          >
            演示
          </span>
        )}

        {/*
          失败信息直接盖在产物底部（用户要求「直接显示在节点上」）。
          不占文档流 —— 若插进布局，节点会为了这一条长高，
          而节点高度此刻正等于图片高度，长高就等于图片被压扁。
        */}
        {(statusKey === NODE_STATUS.FAILED ||
          statusKey === NODE_STATUS.SKIPPED ||
          rt?.error) && (
          <div
            data-error-on-node="1"
            className={[
              "absolute inset-x-0 bottom-0 px-3 py-2 text-[length:var(--fs-meta)] leading-relaxed",
              // 跳过用中性色：一片红里要能一眼挑出真正的元凶，
              // 被连坐的节点不配占用「失败」的视觉权重
              statusKey === NODE_STATUS.SKIPPED
                ? "bg-[color:var(--surface-2)] text-[color:var(--ink-2)]"
                : "bg-red-950 text-red-300",
            ].join(" ")}
          >
            {rt?.error ?? "执行失败"}
          </div>
        )}

        {statusKey === NODE_STATUS.RUNNING && (
          <div
            data-progress={Math.round((rt?.progress ?? 0) * 100)}
            className="absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-[color:var(--surface-2)]"
          >
            <div
              className="h-full bg-blue-500 transition-[width] duration-200 ease-out"
              style={{ width: `${Math.round((rt?.progress ?? 0) * 100)}%` }}
            />
          </div>
        )}
      </div>

      {/*
        选中时才出现的两个操作。放在节点**外面**：
        产物里每一个像素都属于图片本身，按钮压上去就是遮挡内容。

          下载 —— 正上方居中（用户指定的位置）
          删除 —— 右上角外侧，圆形叉号（用户指定的位置）
      */}
      {selected && !dragging && (
        <>
          {rt?.output && (
            <a
              href={`/api/assets/${rt.output.assetId}?dl=1`}
              download
              title="下载产物"
              data-action="download"
              /*
               * 2026-10-26 跟叉号一起按 2 倍放大（32→64 高，14→32 字）。
               * 只放大叉号会让两个按钮一大一小 —— 同一组操作按钮不同倍，
               * 看起来像其中一个没加载样式。
               *
               * 位置从 -top-12 改 -top-20 不是拍脑袋：原来按钮底边离节点顶边
               * 16px（-48 + 32 = -16），要保住这个间隙，64 高的按钮就得放 -80。
               */
              className="nodrag nopan absolute -top-20 left-1/2 z-10 flex h-16 -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border-[3px] border-[color:var(--line-2)] bg-[color:var(--surface-1)] px-6 text-[length:var(--fs-bare-hint)] font-medium text-[color:var(--ink-1)] shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-colors hover:border-[color:var(--line-3)]"
            >
              ↓ 下载
            </a>
          )}
          <NodeDeleteButton nodeId={id} />
        </>
      )}

      {/*
        参数面板：形态和卡片节点完全一致（浮在节点下方）。
        编辑名称时收起 —— 正在打字时把参数摊在下面既挤视线又诱人分心。
      */}
      {selected && !dragging && !editingLabel && <NodePanel nodeId={id} def={def} data={data} />}

      <NodeOutputHandle />
    </div>
  );
}
