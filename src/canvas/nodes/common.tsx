"use client";

/**
 * 两种节点外壳（卡片 / 裸图）共用的东西。
 *
 * 为什么要有这个文件：外壳拆开之后，连线端点、状态点文案、参数面板、
 * 各种输入控件两边都要用。各写一份的话，改一次配色要改两处，
 * 而漏掉一处**不会报错** —— 症状是「文本节点的面板是新的、图片节点的还是旧的」。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, useReactFlow, useStore } from "@xyflow/react";
import { NODE_STATUS, RUN_STATUS } from "@/lib/constants";
import type { NodeDefinition } from "@/canvas/nodeRegistry";
import { effectiveModel, optionsOf, paramSetOf, type ParamDef } from "@/canvas/params";
import { useDebouncedCommit } from "@/hooks/useDebouncedCommit";
import { useCanvasStore } from "@/stores/canvasStore";
import { useRunStore } from "@/stores/runStore";
import { useModels } from "@/hooks/useModels";
import { startRun } from "@/canvas/runActions";

/**
 * 连线端点（Handle）的样式，左右各一个，复用同一份。
 *
 * 尺寸：h-10 w-10 = 40px。演进是 10 → 20 → 40。
 *
 * 为什么最后翻到 40：Handle 的尺寸是**画布坐标**，屏幕上要乘 zoom。
 * 实测多节点项目首屏 zoom 0.173 时，20px 的 Handle 在屏幕上只有 **3.5px**
 * （项目里量过），那不是「小一点」而是点不中。40px 在同一个缩放下是 6.9px，
 * 单节点项目（zoom 0.455）下是 18.2px。
 * 描边同步 3px → 6px：两者之比保持 15%（环宽 / 直径），否则放大后
 * 中间的实心圆占比变大，看起来会从「挖出来的孔」变成「一颗实心球」。
 *
 * 别用 padding 去撑命中区——Handle 是绝对定位在节点边缘的小方块，
 * 靠 transform 居中，padding 只会让它偏移。要更大就直接改宽高。
 *
 * 注意 React Flow 的默认 handle 样式里有 width/height: 6px，
 * 所以必须用 Tailwind 的 !important 变体（!h-10 !w-10）才盖得住。
 *
 * ### `!z-10` 是必须的，不是装饰
 *
 * Handle 骑在节点边界上：一半在节点外、一半在节点内（transform: translate(-50%)）。
 * 而「节点内」那一半会不会被挡住，取决于它和主体内容的**绘制顺序** ——
 * CSS 规则是「同为定位元素（position 非 static）且 z-index 都是 auto 时，
 * 按 DOM 顺序绘制，后画的盖住先画的」。
 *
 * 裸图形态里两端的 handle 分别写在主体前后（输入端在外壳最上面、
 * 输出端在最下面），于是出现一个非常迷惑的现象：
 * **左边只能看见外面半圆，右边是完整的圆**。同一个样式、同一张节点，
 * 只因为兄弟节点的书写顺序不同。
 *
 * 所以给一个明确的 z-index，让绘制顺序不再依赖 DOM 位置。
 * 值取 10：高于产物层和空态层，低于选中才浮现的操作按钮与参数面板（z-50）。
 * 不会外溢到别的节点 —— 节点根元素带 transform（React Flow 用 translate 定位），
 * 天然形成堆叠上下文，子元素的 z-index 只在这个节点内部比较。
 */
export const HANDLE_CLS =
  /* 连接点：描边用卡片的表面色（--surface-1）而不是白色 —— 白描边在黑底上
     会亮成一圈光，反而看不出它是「挖」在卡片边上的一个点 */
  "!z-10 !h-10 !w-10 !border-[6px] !border-[color:var(--surface-1)] !bg-[color:var(--line-3)] transition-colors hover:!bg-[color:var(--ink-2)]";

/** 状态 → 那个小圆点的颜色和文字。裸图形态下它挂在节点外侧的标签行上 */
export const statusStyle: Record<string, { dot: string; text: string }> = {
  [NODE_STATUS.IDLE]: { dot: "bg-[color:var(--line-3)]", text: "待运行" },
  [NODE_STATUS.QUEUED]: { dot: "bg-amber-400", text: "排队中" },
  [NODE_STATUS.RUNNING]: { dot: "bg-blue-500 animate-pulse", text: "运行中" },
  [NODE_STATUS.SUCCEEDED]: { dot: "bg-emerald-500", text: "已完成" },
  [NODE_STATUS.FAILED]: { dot: "bg-red-500", text: "失败" },
  [NODE_STATUS.SKIPPED]: { dot: "bg-[color:var(--line-3)]", text: "已跳过" },
};

/** 字节数 → 人能读的大小。只用于素材信息那一行 */
export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 节点的输入端口。三种情况：
 *
 * ① accepts 为空（上传素材）→ 不渲染输入点。
 *    它是线的起点，不是终点。画一个永远接不上的点，是在邀请用户犯错。
 * ② 声明了具名端口 → 每个端口一个点（目前没有节点用到，留给将来的首尾帧）
 * ③ 其余 → 单个默认端口
 *
 * 端口标签放在节点**外面**（左侧）：卡片内部已经被填满，塞进去必然重叠。
 * 放外面也符合直觉 ——「这条线接的是首帧」本来就是关于线的事，不是关于卡片的事。
 */
export function NodeInputHandles({ def }: { def: NodeDefinition }) {
  if (def.accepts.length === 0) return null;

  if (!def.inputs?.length) {
    return <Handle type="target" position={Position.Left} className={HANDLE_CLS} />;
  }

  return (
    <>
      {def.inputs.map((port, i, all) => {
        const pct = ((i + 1) / (all.length + 1)) * 100;
        return (
          <div key={port.key}>
            <Handle
              id={port.key}
              type="target"
              position={Position.Left}
              style={{ top: `${pct}%` }}
              className={HANDLE_CLS}
              data-port={port.key}
            />
            <span
              data-port-label={port.key}
              className="pointer-events-none absolute whitespace-nowrap text-[length:var(--fs-meta)] text-[color:var(--ink-3)]"
              style={{ top: `calc(${pct}% - 10px)`, right: "calc(100% + 14px)" }}
            >
              {port.label}
            </span>
          </div>
        );
      })}
    </>
  );
}

export function NodeOutputHandle() {
  return <Handle type="source" position={Position.Right} className={HANDLE_CLS} />;
}

/**
 * 删除节点：右上角**外侧**的圆形叉号。
 *
 * 2026-10-26 抽成共用组件。起因是文本卡片原先在底栏里放了个方形叉号
 * （为了让它「大一点」，底栏还被加高到 88，正文少了一整行），
 * 人的评价是「太丑了」，要求「改成和图片节点、视频节点一样的在右上角的叉号」。
 *
 * 抽出来的目的不是省几行代码，是**让「一样」变成编译期保证**：
 * 两处各写一份的话，改了图片节点那份、忘了文本卡片这份，
 * 肉眼要摆在一起看才看得出来，而且没有任何报错。
 *
 * 位置与尺寸都是**画布坐标**，屏幕大小 = 设计 × zoom：
 *   64px 在 zoom 0.267 下屏幕上 17px（原来是底栏里 32px → 屏幕 8.6px）
 *   right: -64 让按钮左边缘正好贴在节点右边界上，整块浮在节点外，不压内容
 *   top: -28 是为了「圆心在节点顶边下方 4px」（-28 + 32 = 4）
 *
 * 只在**选中且没在拖动**时渲染：同时出现的东西越多，画布越像工具栏。
 * 拖拽时收起是因为它跟着节点平移会晃眼，松手自己回来。
 */
export function NodeDeleteButton({ nodeId }: { nodeId: string }) {
  const deleteElements = useReactFlow().deleteElements;
  return (
    <button
      type="button"
      title="删除节点"
      data-action="delete"
      onClick={() => deleteElements({ nodes: [{ id: nodeId }] })}
      className="nodrag nopan absolute -right-16 -top-7 z-10 flex h-16 w-16 items-center justify-center rounded-full border-2 border-[color:var(--line-2)] bg-[color:var(--surface-1)] text-[length:var(--fs-bare-hint)] leading-none text-[color:var(--ink-3)] shadow-[0_4px_20px_rgba(0,0,0,0.5)] transition-colors hover:border-red-800 hover:text-red-400"
    >
      ×
    </button>
  );
}

/**
 * 提示词编辑区（只出现在选中后浮出的面板里）。
 *
 * 走 useDebouncedCommit 而不是受控绑 store：
 * 每敲一个字符都写 store 会让整张画布重渲染，而且外部数据回灌
 * （保存完成、SSE 推送）会打断光标、吞字。
 *
 * resize-none 是必须的：textarea 默认右下角有拖拽手柄，
 * 一拖就改变尺寸，而节点尺寸不能被随手改。长文靠内部滚动。
 *
 * ### fieldKey 为什么是参数
 *
 * 同一个控件要能写进不同字段：文本节点面板里写的是 `prompt`（原始描述），
 * 图像 / 视频节点面板里写的是它们唯一的 `prompt`。
 * 早先这里硬编码 `{ prompt: v }` 和 `data-field="prompt"`，
 * 一旦出现第二个 prompt 类字段（比如文本节点的 optimizedPrompt），
 * 面板里的框就会悄悄写错地方 —— 打字有反应、保存也成功，只是写到了别处。
 */
export function PromptEditor({
  nodeId,
  fieldKey,
  value,
  className = "h-full",
  placeholder = "描述你要生成的内容…",
  plain = false,
  fontSize,
}: {
  nodeId: string;
  fieldKey: string;
  value: string;
  /** 高度由调用方决定：卡片主体用 h-full 撑满，浮出面板里用固定高度 */
  className?: string;
  /** 提示语由 Params 声明，不同能力的节点可以不一样 */
  placeholder?: string;
  /**
   * 覆盖字号，传 CSS 值（如 `14px`）。
   *
   * 2026-10-24 面板脱离画布缩放之后必须能覆盖：卡片正文是 `--fs-body`（30px），
   * 那 30 在画布 zoom 0.567 下屏幕上才 17px；面板现在不缩放了，
   * 30px 就是实打实的 30px —— 会把面板撑成一堵墙。
   *
   * 和 TextField 用同一套办法：inline style，不接第二个 className。
   * 两个同级 `text-[...]` 任意值类谁赢取决于 Tailwind 的生成顺序，冲突是静默的。
   */
  fontSize?: string;
  /**
   * plain = 不带自己的边框和底色，让它「融进」外层容器。
   *
   * 2026-10-24 面板改成一体式 composer 之后需要这个：容器的边框就是
   * 输入框的边框，textarea 再画一圈就成了「盒子里的盒子」——
   * 参照 ActionAgent 的 composer（`.chat-input` 带框、里面的 textarea
   * 是 `border:none; background:transparent`）。
   *
   * 卡片主体不用它：那里没有外层容器，textarea 自己就是主体。
   */
  plain?: boolean;
}) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const commit = useCallback(
    (v: string) => updateNodeData(nodeId, { [fieldKey]: v }),
    [nodeId, fieldKey, updateNodeData]
  );
  const { draft, onChange, flush, focusedRef } = useDebouncedCommit(value, commit);

  return (
    <textarea
      value={draft}
      data-field={fieldKey}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        flush();
      }}
      /*
       * 滚动条藏掉，和卡片里那个正文编辑器保持一致。
       *
       * 高度固定（h-20）时，滚动条一出现就占掉十几像素宽，
       * 文字会在「刚好写满」的那一刻整体横向跳一下 —— 正在打字的人
       * 会以为光标跑了。藏掉之后溢出是「悄悄能滚」。
       *
       * 必须用 inline style：globals.css 里的 `.no-scrollbar` 会被
       * 构建期的 Lightning CSS 按浏览器目标裁掉（详见 CanvasNode 里 BodyEditor 的注释）。
       */
      style={{
        scrollbarWidth: "none",
        msOverflowStyle: "none",
        ...(fontSize ? { fontSize } : null),
      }}
      className={[
        "no-scrollbar nodrag nopan nowheel w-full resize-none text-[length:var(--fs-body)] leading-relaxed outline-none transition-colors placeholder:text-[color:var(--ink-3)]",
        plain
          ? /*
             * 无框版：padding 4px 与参照物一致（`padding: 4px 4px`），
             * 加上容器的 p-3，文字距面板边缘 16px。
             * 这里**不写任何 focus 样式** —— 聚焦反馈由容器的
             * focus-within 统一负责，否则会出现「文本框亮了一圈、
             * 外面的容器没反应」这种内外两套反馈。
             */
            "rounded-none border-0 bg-transparent p-1 text-[color:var(--ink-1)]"
          : "rounded-lg border border-[color:var(--line-2)] bg-[color:var(--surface-2)] px-2.5 py-2 text-[color:var(--ink-1)] focus:border-[color:var(--line-3)] focus:bg-[color:var(--surface-1)]",
        className,
      ].join(" ")}
    />
  );
}

/** 单行文本字段（负面提示词、节点名称）。同样走防抖，理由同 PromptEditor。 */
export function TextField({
  nodeId,
  fieldKey,
  value,
  placeholder,
  plain = false,
  focusOnMount = false,
  onEscape,
  fontSize,
}: {
  nodeId: string;
  fieldKey: string;
  value: string;
  placeholder: string;
  /**
   * plain = 只显文字、不显边框（悬停/聚焦才显形）。
   *
   * 用于节点名称：它在一堆输入框里如果也画个框，看起来就像"第二个输入框"，
   * 用户会分不清哪个是要发出去的内容。视觉上它该是一条标题。
   */
  plain?: boolean;
  /** 挂载即聚焦并把光标放到末尾。给「双击标题/标签改名」这种按需出现的输入框用 */
  focusOnMount?: boolean;
  /** Esc 的出口。不传就没有（常驻字段不需要自己处理退出） */
  onEscape?: () => void;
  /**
   * 覆盖字号，传 CSS 值（如 `var(--fs-card-name)`）。
   *
   * 为什么用 inline style 而不是再接一个 className：
   * 两个 `text-[length:var(--x)]` 是同一优先级的任意值类，谁赢取决于
   * Tailwind 生成 CSS 的顺序，不是 DOM 顺序 —— 而且**冲突是静默的**，
   * 表现成"改了没反应"。inline style 一定压过类名，没有这个不确定性。
   *
   * 需要它的场景：卡片头部的名字（--fs-card-name 20px）和裸节点的标签
   * （--fs-title 18px）共用这个组件，但字号必须不同 —— 人明确说过
   * 「图像生成 / 视频生成」那些标签不要动。
   */
  fontSize?: string;
}) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const commit = useCallback(
    (v: string) => updateNodeData(nodeId, { [fieldKey]: v }),
    [nodeId, fieldKey, updateNodeData]
  );
  const { draft, onChange, flush, focusedRef } = useDebouncedCommit(value, commit);
  const ref = useRef<HTMLInputElement>(null);

  /*
   * 光标放到**末尾**，不要全选。
   * 全选的话下一次击键会把整段替换掉 —— 双击的直觉是「我要在这个位置写字」，
   * 不是「我要重写一切」。真想全选，用户会按 Ctrl+A。
   */
  useEffect(() => {
    if (!focusOnMount) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusOnMount]);

  return (
    <input
      ref={ref}
      value={draft}
      data-field={fieldKey}
      placeholder={placeholder}
      style={fontSize ? { fontSize } : undefined}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        // 失焦立即补写：标签/标题的改名框在失焦那一刻就会被卸载，
        // 等 400ms 防抖的话那次改动会跟着组件一起消失。
        focusedRef.current = false;
        flush();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && onEscape) {
          e.preventDefault();
          onEscape();
        }
      }}
      className={
        plain
          ? "nodrag nopan nowheel w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-[length:var(--fs-title)] font-medium text-[color:var(--ink-1)] outline-none transition-colors placeholder:font-normal placeholder:text-[color:var(--ink-3)] hover:border-[color:var(--line-2)] focus:border-[color:var(--line-3)]"
          : "nodrag nopan nowheel w-full rounded-md border border-[color:var(--line-2)] bg-[color:var(--surface-2)] px-2 py-1.5 text-[length:var(--fs-control)] text-[color:var(--ink-1)] outline-none transition-colors placeholder:text-[color:var(--ink-3)] focus:border-[color:var(--line-3)] focus:bg-[color:var(--surface-1)]"
      }
    />
  );
}

/**
 * 下拉的样式。高度 32 和按钮同高（参照物是 30/32，我们取齐整）；
 * 字号 13px 是屏幕值 —— 面板脱离画布缩放之后不能再用 `--fs-control`（16px），
 * 那个变量是给界面工具栏用的，两者不再同尺度。
 */
const PANEL_SELECT_CLS =
  "nodrag nopan nowheel h-8 min-w-0 shrink-0 cursor-pointer rounded-lg border border-[color:var(--line-2)] bg-[color:var(--surface-2)] px-3 text-[13px] text-[color:var(--ink-1)] outline-none transition-colors hover:border-[color:var(--line-3)] focus:border-[color:var(--line-3)]";

/**
 * 面板里的下拉框。
 *
 * 当前值不在选项里时单独补一项并标注「当前模型不支持」，而不是悄悄回落 ——
 * 回落的话用户看着「16:9」却生成出别的东西，无从排查。
 */
function PanelSelect({
  value,
  options,
  title,
  onChange,
  maxWidth,
  emptyText = "暂无可用模型",
}: {
  value: string;
  options: { value: string; label: string }[];
  title: string;
  onChange: (v: string) => void;
  maxWidth: number;
  emptyText?: string;
}) {
  /*
   * 「没选过」和「选了一个已经不存在的模型」是两件事，必须分开。
   *
   * 空字符串是前者：节点新建时 data.modelId 还不存在，界面显示当前能力的
   * 第一个模型（和引擎的 selectProvider 一致）。这种情况**不该**提示「不支持」。
   *
   * 曾经把两者合并判断（`shown && !known`），后果很难看：
   * 每个新建的视频节点，下拉里都并列着一行
   *   `mock.video.v1（当前模型不支持）` 和 `演示视频`
   * 两项的值还完全相同。用户看到的是一脸茫然的「哪来的野模型」。
   */
  const dangling = Boolean(value) && !options.some((o) => o.value === value);
  const shown = value || (options[0]?.value ?? "");

  /*
   * 一个选项都没有时**不要渲染 <select>**。
   *
   * 2026-10-25 删掉演示模型后出现这个状态：视频节点没有任何可用模型
   * （视频 API 还没接），于是底栏是一个空白下拉 —— 点开什么都没有。
   * 它不报错，但看起来像坏了：用户分不清「这个功能还没做」和「这里出错了」。
   *
   * 用一段静止文字代替，把「为什么没有」写在 title 里。
   * 高度沿用 h-8 与下拉对齐，否则底栏会矮一截、整块控件错位。
   *
   * ⚠️ 第一次写这段时它是**死代码**：调用方 `renderInlineParam` 在前面
   * 就 `opts.length === 0 → return null` 了，这条分支永远走不到。
   * 症状是「改了、截图里没有、又不报错」—— 现在由调用方按参数类型放行：
   * 模型这一项即使为空也要渲染（能力整个没模型），比例/时长仍按旧规则藏起来。
   */
  if (options.length === 0) {
    return (
      <span
        data-field={title}
        title={
          dangling
            ? `当前选的「${value}」已不可用，这个能力暂时也没有别的模型`
            : `这个能力暂时没有可用的模型（${title}）`
        }
        style={{ maxWidth }}
        className="inline-flex h-8 items-center px-1 text-[13px] text-[color:var(--ink-3)]"
      >
        {dangling ? `${value}（不可用）` : emptyText}
      </span>
    );
  }

  return (
    <select
      value={shown}
      title={title}
      data-field={title}
      style={{ maxWidth }}
      onChange={(e) => onChange(e.target.value)}
      className={PANEL_SELECT_CLS}
    >
      {dangling && <option value={shown}>{shown}（当前模型不支持）</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/**
 * 浮层面板的尺寸，单位全部是**屏幕像素**，不是画布坐标。
 *
 * 2026-10-24 起面板不再随画布缩放 —— 这两个数就是人眼看到的大小，
 * 不需要再乘 zoom。规格抄自 ActionAgent 的 `.chat-input`：
 * 容器 padding `12 / 12 / 10`、圆角 16、控件行 gap 10。
 *
 * 宽度 726 的来历：**等于默认打开项目时图像卡片在屏幕上的宽度**
 * （设计宽 1280 × zoom 0.5667 = 725.3）。人先选了照参照物的 996，
 * 看过实物之后要求「收窄到和默认图像卡片一样的宽度」——
 * 996 比卡片宽 270，居中后左右各溢 135，看着像一块横条贴在卡片下面。
 *
 * 代价（不可消除，只能选择接受哪一侧）：卡片宽度**是随 zoom 变的**，
 * 面板不是。所以「边对边对齐」只在 zoom ≈ 0.567（3 节点项目的默认 fitView）
 * 这一个缩放比下成立：放大画布时面板比卡片窄，缩小画布时面板比卡片宽。
 * 想让它永远等宽，就只能让宽度跟着 zoom 走 —— 那就等于回到「随画布缩放」，
 * 和上面那条需求直接冲突。
 */
const PANEL_W = 726;
const PANEL_GAP = 8;

/**
 * 选中后浮出的参数面板。两种外壳共用，外观一致。
 *
 * ### 为什么它是「浮在节点外面」而不是「节点变高」
 *
 * 节点尺寸一变，React Flow 就要重新测量，连线端点会滞后一帧（「甩」一下）。
 * 面板用 absolute + top:100% 挂在节点下方，是渲染上的浮层，不参与布局。
 *
 * 代价：它会盖住下方的节点；靠近画布底部时可能被视口裁掉。
 * 这是「面板换尺寸恒定」这笔交易的固定价格。
 *
 * 层叠靠 React Flow 的 elevateNodesOnSelect（默认开）：选中节点的 z-index 会被抬高，
 * 面板作为它的子元素一起置顶，不需要手写 z-index 抢层级。
 *
 * ### 不随缩放：三层分工（2026-10-24）
 *
 * 节点自己的 CSS transform 会把**所有**子元素一起缩放，面板长在节点里，
 * 所以默认跟着 zoom 变小 —— 放大画布时面板的字跟着变大，缩小画布时糊成一团。
 * 面板是「操作界面」不是「素材」，它该像工具栏一样恒定。
 *
 * 反算是 `scale(1/zoom)`：节点把面板压到 zoom 倍，面板自己再放大 1/zoom 倍，
 * 最终视觉正好 1:1，写死的 px 就是屏幕上的 px。三层各管一件事：
 *
 * | 层 | 缩放 | 负责 |
 * |---|---|---|
 * | 外层 wrapper | 不缩放（跟着节点） | 定位、居中、与卡片的间距 |
 * | 内层 panel | `scale(1/zoom)` | 尺寸、字号、圆角、边框 |
 *
 * 两个容易写错的点：
 *
 * 1. **间距必须除以 zoom**：外层不缩放，它的 `padding-top` 落在画布坐标系里，
 *    视觉高度是 `padding × zoom`。写 `8px` 在 zoom 0.567 下只剩 4.5px，
 *    所以写 `GAP / zoom`，乘回去正好 8。
 * 2. **居中不能靠 `translateX(-50%)`**：`transform` 只有一个，`scale` 已经占了；
 *    硬塞进同一个属性里，百分比位移会先于缩放执行、位移量再被自己放大，算错一拍。
 *    现在把「居中」交给外层 flex（布局问题），`transform` 只负责缩放，
 *    两件事分开就没有顺序问题。`transform-origin: top center` 保证缩放时
 *    顶边和中心点不动 —— 否则面板会从左上角开始长，往右下歪出去。
 *
 * ### 副作用（已知，不是 bug）
 *
 * - 画布缩得很小时（zoom 0.2），面板在视觉上会比卡片大好几倍。屏幕恒定就是这个意思：
 *   它不跟着画布「一起远」，因为它不是画在纸上的东西。
 * - 反过来，放大画布时面板会比卡片窄。「和卡片等宽」只在 zoom ≈ 0.567 下成立，
 *   详见 `PANEL_W` 的注释。
 */
/**
 * 能力的中文名，只用于「XX模型还没接入」这类说明。
 *
 * 不叫「生成」之类的动词：能力是「能产出哪种东西」，和节点名（图像生成 /
 * 视频生成）不是一回事 —— 一个能力将来可能挂在好几种节点上。
 */
const CAP_LABEL: Record<"text" | "image" | "video", string> = {
  text: "文本",
  image: "图像",
  video: "视频",
};

export function NodePanel({
  nodeId,
  def,
  data,
}: {
  nodeId: string;
  def: NodeDefinition;
  data: Record<string, unknown>;
}) {
  /*
   * 画布缩放比。用 selector 只取 transform 的第三个数，viewport 平移时
   * （transform[0]/[1] 变）面板不会跟着重渲染 —— 拖画布时省一点。
   * 兜底 1 是防 transform 还没初始化时拿到 0，除出 Infinity。
   */
  const zoom = useStore((s) => s.transform[2]) || 1;
  const projectId = useCanvasStore((s) => s.projectId);
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const setError = useCanvasStore((s) => s.setError);
  const runStatus = useRunStore((s) => s.status);
  const rt = useRunStore((s) => s.runtime[nodeId]);
  const models = useModels();
  const [sending, setSending] = useState(false);

  const cap = def.capability;
  /**
   * 文本节点的面板走的是动作那条路：它自己是纯输入（capability 为 null），
   * 但它的「发送」等于发起一次文本改写，动作声明了要调哪种能力。
   * 所以模型清单按动作的 capability 取，而不是按节点类型的 capability。
   */
  const primaryAction = def.actions?.[0];
  const panelCap = cap ?? primaryAction?.capability ?? null;
  const model = panelCap ? effectiveModel(data, models, panelCap) : undefined;
  /**
   * 用哪套参数 —— 和卡片主体（可编辑参数）共用同一个函数。
   *
   * 「没有 capability 就看第一个动作的能力」这个回退只写一遍是有原因的：
   * 写两遍就会漂移，某天卡片还在按 text 渲染、面板已经不认识 text 了，
   * 症状是「正文在卡里能改，模型下拉却不见了」，而两边代码看着都对。
   */
  const paramSet = paramSetOf(def);

  const busy = runStatus === RUN_STATUS.PENDING || runStatus === RUN_STATUS.RUNNING;
  const running = rt?.status === NODE_STATUS.RUNNING || rt?.status === NODE_STATUS.QUEUED;

  /**
   * 竖排控件（提示词、负面提示词）。
   * 位置固定：永远在上面，一块一块排。加参数只会往下多一行，不会重排别的。
   */
  const renderBodyParam = (p: ParamDef) => {
    switch (p.control) {
      case "prompt":
        return (
          <PromptEditor
            key={p.key}
            nodeId={nodeId}
            // 字段名由参数层声明，不在这里写死 —— 文本节点面板里写的是
            // prompt（原始描述），图像 / 视频节点写的也是各自的 prompt。
            fieldKey={p.key}
            value={String(data[p.key] ?? "")}
            placeholder={p.placeholder}
            /*
             * 高度和字号从 2026-10-24 起都是**屏幕像素**（面板不再随画布缩放）。
             *
             * 14px × 行高 1.625（leading-relaxed）= 22.75px 一行，和参照物的 14px/1.6 基本同高。
             * 78px 装 3 行（内容高 70px ÷ 22.75 = 3.07）：
             * 一句典型提示词（20–60 字）在 694px 可用宽里一行约 49 字，
             * 两行就够，三行留给改写到 100 来字的情况。
             *
             * **不做高度自适应**（人已拍板）：面板高度固定，盖住下方节点的范围
             * 就不会随打字变来变去。
             *
             * plain：容器的边框就是输入框的边框，不要「盒子里的盒子」。
             */
            plain
            fontSize="14px"
            className="h-[78px]"
          />
        );
      case "text":
        return (
          <TextField
            key={p.key}
            nodeId={nodeId}
            fieldKey={p.key}
            value={String(data[p.key] ?? "")}
            placeholder={p.placeholder ?? ""}
          />
        );
      default:
        return null;
    }
  };

  /**
   * 横排控件（模型、比例、时长），和「生成」按钮同一行。
   *
   * 选项为空就不渲染：模型不支持这个参数时，给一个空下拉只是噪音。
   * 这也是「比例跟着模型变」的落点 —— 换了只支持 16:9 的模型，9:16 就消失。
   *
   * **唯一的例外是「模型」这一项自己**：它空了不代表「这个参数不适用」，
   * 而代表「这个能力整个还没有模型」。两者必须分开显示，否则用户看到的是
   * 一个只有「生成 ↑」的面板，点下去才在节点底部读到一句给开发者看的话。
   */
  const renderInlineParam = (p: ParamDef) => {
    if (!panelCap) return null;
    const opts = optionsOf(p, models, panelCap, model);
    const isModelParam = p.from === "models";
    if (opts.length === 0 && !isModelParam) return null;
    return (
      <PanelSelect
        key={p.key}
        title={p.key}
        value={String(data[p.key] ?? "")}
        options={opts}
        maxWidth={p.width ?? 160}
        emptyText={`${CAP_LABEL[panelCap]}模型还没接入`}
        onChange={(v) => updateNodeData(nodeId, { [p.key]: v })}
      />
    );
  };

  /**
   * 这个能力一个可用模型都没有。
   *
   * 用来把「生成 ↑」变灰 —— 否则点下去必然在节点底部显示
   * 「没有支持 video 的 Provider，请先注册一个（见 src/providers/registry.ts）」，
   * 那是写给开发者的，用户读到只会以为坏了。
   */
  const noModel = panelCap ? !models.some((m) => m.capabilities.includes(panelCap)) : false;

  /*
   * 一行可编辑的东西都没有 → 整个面板**不渲染**。
   *
   * 触发它的只有素材节点（media.asset）：纯输入、不调模型，
   * 所以没有提示词、没有模型下拉，也不带任何动作。它原本只剩一行
   * 「文件名 + 体积」的只读信息 —— 于是一个什么都不填的浮窗挂在素材下面，
   * 选中时冒出来，手一松又消失。人报的就是这个（2026-10-26）。
   *
   * 只删那一行不行：面板的边框、圆角、阴影在这层容器上，
   * 内容删空了会剩下一个空盒子，比原来更莫名其妙。
   *
   * 判据用「实际会渲染的项」而不是「paramSet 是否存在」：
   * 将来某个能力只声明了 place:"card" 的参数时，它同样不该浮出面板。
   */
  const bodyParams = paramSet?.body.filter((p) => p.place !== "card") ?? [];
  const inlineParams = paramSet?.inline ?? [];
  if (bodyParams.length === 0 && inlineParams.length === 0) return null;

  const send = async () => {
    if (!projectId || sending) return;
    setSending(true);
    try {
      // 带动作 id：文本节点靠它走「改写」那条执行分支。
      // 不带的话它会被当成纯输入节点，45 毫秒直接完成，什么都没发生。
      await startRun(projectId, "node", nodeId, primaryAction?.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败");
    } finally {
      setSending(false);
    }
  };

  return (
    /*
     * 外层：定位 + 居中，**不缩放**（跟着节点走的那一层）。
     *
     * `w-full` 撑满卡片宽度，flex 居中把内层对准卡片中轴 —— 所以面板是
     * 「卡片居中正下方」，不是「卡片左边缘对齐」。
     *
     * `paddingTop: GAP / zoom`：这一层不缩放，它的 padding 落在画布坐标系里，
     * 视觉高度 = padding × zoom。除以 zoom 之后视觉上才恒定是 8px。
     *
     * `pointerEvents: none` 只关掉**这一层**的命中（左右对称的溢出区、8px 间隙），
     * 点那些地方等于点画布 —— 否则一个看不见的透明盒子会把下方节点的拖动吃掉。
     * 内层自己恢复成 auto。
     */
    <div
      className="nodrag nopan nowheel absolute left-0 top-full z-50 flex w-full justify-center"
      style={{ paddingTop: PANEL_GAP / zoom, pointerEvents: "none" }}
    >
      <div
        data-node-panel={nodeId}
        /*
         * 一体式 composer（2026-10-24 改版）。
         *
         * 设计语言来自 ActionAgent 的 `.chat-input`：**容器带框、控件不带框**。
         * 面板本身就是那个「输入框」，不是「一堆输入框的容器」——
         * 所以边框、圆角、阴影、聚焦反馈全部只出现在这一层，
         * 里面的 textarea 是透明的（见 PromptEditor 的 plain）。
         *
         * 三处**没有**照搬参照物：
         *   1. 阴影仍是浮层量级（0 8px 30px 12%）。参照物是 0 2px 8px 4%，
         *      那是页内卡片的量级 —— 面板是从节点上浮出来的，阴影一轻就「贴不住」，
         *      和下方的节点糊在一起。
 *   2. 聚焦高亮走中性灰，不用它的蓝色 #4d6bfe。项目是黑白灰的（人已拍板），
 *      再引入一个蓝会把注意力劈成两半。「运行全部」那个黑主按钮虽然已经删了，
 *      这条结论反而更成立 —— 画布上已经没有一个「重点色」需要去平衡了。
         *   3. 圆角 16（rounded-2xl）比卡片 12 更圆：这是有意的，
         *      面板是浮层，比它所依附的卡片软一档，视觉上才「浮」得起来。
         *
         * focus-within 而不是 focus：焦点落在里面任何一个控件（含下拉）上，
         * 整个面板都该亮 —— 用户感知的单位是「这个面板」，不是那个 textarea。
         * 两个 box-shadow 必须写成一条：Tailwind 的 shadow-* 和 ring-* 是
         * 独立的 box-shadow 声明，同时存在时后者会盖掉前者（浮层阴影会消失）。
         *
         * 尺寸全部是屏幕像素，靠 `scale(1/zoom)` 抵消画布缩放（见函数头注释）。
         * 所以这里写的 12px、16px、13px 就是屏幕上真实的 12/16/13。
         * `shrink-0` 不能省：内层是固定宽度，flex 在容器不够宽时会把它压扁，
         * 而压扁之后 scale 仍按 zoom 放大 —— 面板会比 PANEL_W 窄，且没有报错。
         */
        style={{
          width: PANEL_W,
          transform: `scale(${1 / zoom})`,
          transformOrigin: "top center",
          pointerEvents: "auto",
        }}
        className="nodrag nopan nowheel shrink-0 rounded-2xl border border-[color:var(--line-2)] bg-[color:var(--surface-1)] px-3 pb-2.5 pt-3 shadow-[0_8px_30px_rgba(0,0,0,0.6)] transition-[border-color,box-shadow] duration-150 focus-within:border-[color:var(--line-3)] focus-within:[box-shadow:0_0_0_3px_rgba(255,255,255,0.07),0_8px_30px_rgba(0,0,0,0.6)]"
      >
        <div className="space-y-1.5">
          {/*
            这里**曾经**有个节点名称输入框，已经删掉。
            改名挪到了「双击节点标签」—— 和「双击主体编辑正文」是同一个手势。
            面板里放一个标题样式的输入框，看起来像"还有一项参数要填"，
            而它其实和下面那些参数不是一类东西。

            现在面板第一行就是真正的参数。
          */}
          {bodyParams.map(renderBodyParam)}
        </div>

        {/*
          底部操作行。控件集合来自 Params（按能力派生），
          这里只负责「横排 + 把按钮推到最右」这一件布局上的事。

          所以：加一个参数（比如视频的「生成方式」）不会碰这个文件，
          也不会改变已有的排列 —— 新控件插在按钮左边的空位上。

          间距 10px 同参照物的 `.input-bar { gap: 10px }`。
        */}
        {inlineParams.length > 0 ? (
          <div className="mt-2 flex items-center gap-2.5">
            {inlineParams.map(renderInlineParam)}

            <button
              type="button"
              data-action="send"
              disabled={busy || running || sending || noModel}
              title={
                noModel && panelCap
                  ? `${CAP_LABEL[panelCap]}模型还没接入，暂时不能生成`
                  : cap
                    ? "用当前参数生成这一个节点"
                    : "把原始描述发给 AI 优化，结果写回节点"
              }
              onClick={send}
              className="nodrag nopan ml-auto flex h-8 shrink-0 items-center gap-1 rounded-lg border border-[color:var(--line-3)] bg-[color:var(--btn-bg)] px-4 text-[13px] font-medium text-white transition-colors hover:bg-[color:var(--btn-bg-hover)] disabled:cursor-not-allowed disabled:border-[color:var(--line-1)] disabled:bg-[color:var(--btn-disabled-bg)] disabled:text-[color:var(--btn-disabled-ink)]"
            >
              {running
                ? cap
                  ? "生成中…"
                  : "优化中…"
                : sending
                  ? "提交中…"
                  : cap
                    ? "生成 ↑"
                    : "发送 ↑"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 注册表兜底取值。节点类型不在注册表里时用，避免组件直接崩掉 */
