"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow, type NodeProps } from "@xyflow/react";
import { NODE_STATUS } from "@/lib/constants";
import { nodeRegistry, type NodeDefinition } from "@/canvas/nodeRegistry";
import { displaySize } from "@/canvas/nodeSize";
import { paramSetOf } from "@/canvas/params";
import { useDebouncedCommit } from "@/hooks/useDebouncedCommit";
import { isOptimized, mainText } from "@/canvas/promptText";
import { useCanvasStore } from "@/stores/canvasStore";
import { useUiStore } from "@/stores/uiStore";
import { useRunStore } from "@/stores/runStore";
import { NODE_HEIGHT, NODE_WIDTH } from "@/canvas/layout";
import type { CanvasNode } from "@/canvas/types";
import {
  NodeDeleteButton,
  NodeInputHandles,
  NodeOutputHandle,
  NodePanel,
  statusStyle,
} from "@/canvas/nodes/common";
import { MediaNode } from "@/canvas/nodes/MediaNode";

/**
 * 节点渲染入口。**按注册表声明的 `shell` 分派**，不按类型名判断。
 *
 *   bare —— 图 / 视频 / 素材：没有边框、没有标题栏，节点就是产物本身
 *   card —— 文本：带边框和标题栏的卡片（正文要能读、要能双击编辑）
 *
 * 为什么分派放在这里而不是在一个组件里写两套 JSX：
 * 两套外壳从结构到交互都不一样（一个双击改名在标签上，一个在头部；
 * 一个操作浮在节点外，一个住在底栏）。塞进同一个组件的话，
 * 每加一种形态就要在那条 if 链上再接一层，最终没人敢动它。
 *
 * 加第三种形态 = 注册表加一个枚举值 + 这里加一行分派。
 */
export function CanvasNode(props: NodeProps<CanvasNode>) {
  const def = nodeRegistry[props.type ?? ""];

  // 类型不在注册表里时不渲染裸图 —— 它需要 def 的 accepts / capability。
  // 落到卡片形态会显示成一个空卡片，至少能看见并删掉它。
  if (def?.shell === "bare") {
    return <MediaNode {...props} def={def} />;
  }

  return <CardNode {...props} def={def} />;
}

/**
 * 卡片形态：带边框、标题栏、底栏。目前只有文本节点用。
 *
 * ### 形态：创作台素材卡，不是工作流节点卡
 *
 * 差别不在配色，在**主体是什么**：
 *   编排器（扣子 / n8n）：节点是函数，价值在流程 → 卡片上是名字 + 状态点，
 *     参数统统进面板，有明确的开始 / 结束，主角是调试日志。
 *   创作台（LibTV）：节点是素材，价值在**单个产物** → 卡片主体是产物预览。
 *
 * 图 / 视频已经不在这条路上了（它们脱掉了外壳，见 MediaNode）。
 * 这里只剩文本：它的「产物」就是可读的一段字，卡片形态反而更合适 ——
 * 字需要留白和行宽，不能像图片那样撑到任意尺寸。
 */
function CardNode({
  id,
  data,
  type,
  selected,
  def,
}: NodeProps<CanvasNode> & { def?: NodeDefinition }) {
  // 按 id 单独订阅：任何节点的状态变化都会重建 runtime 对象，
  // 但只有 id 命中的那个引用变了，其余节点不会重渲染。
  // 这里绝不能写成 useRunStore((s) => s.runtime) —— 那会让所有节点每秒重渲染好几次。
  const rt = useRunStore((s) => s.runtime[id]);
  const statusKey = rt?.status ?? data.status ?? NODE_STATUS.IDLE;
  const status = statusStyle[statusKey] ?? statusStyle[NODE_STATUS.IDLE];

  // 正在拖的是不是**这个**节点。只订阅布尔值，别的节点拖拽不会让它重渲染
  const dragging = useUiStore((s) => s.draggingId === id);

  const { w, h } = def ? displaySize(def, data) : { w: NODE_WIDTH, h: NODE_HEIGHT };

  /**
   * 卡片主体里可编辑的那个参数（文本节点的优化结果 optimizedPrompt）。
   *
   * 它由 Params 的 `place: "card"` 声明，不是这里 `if (type === "...")` 判断出来的。
   * 想让图像节点的提示词也在卡上直接写，改 params.ts 一行即可，这个组件不动。
   *
   * 注意文本节点现在有**两个** prompt 类参数：`prompt`（原始描述，在面板里）
   * 和 `optimizedPrompt`（优化结果，在卡上）。这里 find 到的是后者 ——
   * 两个都声明成 card 的话，前一个会赢、后一个静默消失，所以参数层注释里写了这条限制。
   */
  const paramSet = def ? paramSetOf(def) : null;
  const bodyParam = paramSet?.body.find((p) => p.place === "card");

  /**
   * 卡片主体显示 / 编辑什么文字。
   *
   * 用 mainText 而不是直接读 bodyParam.key，是因为「没优化过时卡片显示原文」
   * 这条回退必须和引擎取值同源（见 canvas/promptText.ts）：
   * 否则出现「卡片上是原文、下游拼的是空字符串」。
   */
  const bodyText = mainText(data as Record<string, unknown>);
  /** 这段主文本是不是 AI 改过的。决定底栏那个低调的「已优化」标记 */
  const optimized = isOptimized(data as Record<string, unknown>);

  /**
   * 是否处在「卡内编辑」状态，以及正在改哪一个字段。
   *
   * 为什么是局部 state 而不是进 uiStore：
   * 它只被这一个组件读，没有第二处需要知道，进全局反而要处理清理时机。
   * 而 draggingId 必须进 uiStore，是因为节点和面板两处都要读。
   *
   * 三个值：`label`（双击头部）、`body`（双击主体）。
   * 名称框从浮层面板里删掉之后，双击标题就是**唯一**的改名入口。
   *
   * 叫 body 而不是 prompt：现在卡片主体里放的是 optimizedPrompt，
   * 而 `prompt` 是面板里那个框的键名。用同一个词会让后来人以为
   * 「双击编辑的是面板里那段原文」，正好相反。
   */
  /**
   * 是否处在「卡内编辑」状态。
   *
   * 为什么是局部 state 而不是进 uiStore：
   * 它只被这一个组件读，没有第二处需要知道，进全局反而要处理清理时机。
   * 而 draggingId 必须进 uiStore，是因为节点和面板两处都要读。
   *
   * 2026-10-26 起只剩一个值：`body`（双击正文进入）。
   * 原来的 `label` 分支随「头部只留一个词」一起删掉了 —— 头部没有名字，
   * 也就没有可改名的东西。保留 `null | "body"` 而不是改成 boolean，
   * 是为了和 `data-editing` 属性、退出逻辑（`!editing`）保持同一套读法，
   * 将来再加一种卡内可编辑字段时不用重写这些判断。
   */
  const [editing, setEditing] = useState<null | "body">(null);

  /**
   * 双击进正文编辑。
   *
   * 2026-10-26 之前这里按位置分叉：头部 → 改名，主体 → 改正文。
   * 头部不再显示节点名之后，那个分叉整个删掉了 —— 现在**双击卡片任何位置**
   * 都是进正文编辑（包括头部）。这不是「顺手多给的功能」，而是分叉的必然结果：
   * 头部已经没有自己的可编辑对象，再拦一道只会让双击头部变成无反应。
   */
  const enterEdit = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // 已经在编辑某个字段时，双击输入框是「选中一个词」，不该被当成重新进入
    if (target.closest("textarea, input, select")) return;
    if (bodyParam) setEditing("body");
  };

  /**
   * 焦点离开**整张卡片**才退出编辑。
   *
   * 不能用 textarea 自己的 onBlur：从正文点到底栏按钮、或者点到面板里，
   * 都会先触发一次 blur，那一刻组件一卸载，点击就落空了。
   * 用卡片根的 onBlur 配合 relatedTarget 判断，就不存在这个中间态。
   *
   * relatedTarget 为 null（点到不可聚焦的地方 —— 卡片留白、画布空白）视为退出。
   */
  const exitEditIfOutside = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!editing) return;
    const next = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(next)) setEditing(null);
  };

  return (
    <div
      // data-* 属性是给自动化验收和调试用的。
      // 靠 class 名去断言状态会很脆（改一次样式测试就挂），
      // 显式暴露语义化的状态属性，测试和实现就解耦了。
      data-node-id={id}
      data-node-type={type}
      data-status={statusKey}
      data-editing={editing ?? "0"}
      data-shell="card"
      style={{ width: w, height: h }}
      onDoubleClick={enterEdit}
      onBlur={exitEditIfOutside}
      // 这里绝不能加 overflow-hidden：具名端口的标签定位在节点**左外侧**，
      // 会被整个裁掉 —— 表现是「首帧 / 尾帧」四个字凭空消失，
      // 而 Handle 还在，极难归因。圆角靠子元素各自处理。
      //
      // `nopan` 不是为了禁拖拽（那是 nodrag 的活），是为了挡住 d3-zoom：
      // 「双击放大画布」的监听挂在画布容器上，双击节点会冒泡上去，顺带把画布
      // 放大一级。而 d3-zoom 的 filter 只认 nopan/nowheel 两个类，不认 nodrag。
      className={[
        "group relative flex flex-col rounded-3xl border-2 bg-[color:var(--surface-1)] transition-colors nopan",
        // 选中态：边框提亮到 --line-3 + 一圈白 10% 的 ring。
        // 原来用的是「黑边 + 淡黑 ring」—— 在近黑背景上这两种深浅都看不见。
        selected
          ? "border-[color:var(--line-3)] ring-2 ring-white/10"
          : "border-[color:var(--line-1)]",
      ].join(" ")}
    >
      <NodeInputHandles def={def ?? emptyDef} />

      {/* 头部：类型名 + 状态。高度写死 40px，是三段式里唯一不伸缩的一段 */}
      <div
        data-card-header="1"
        className="flex h-16 shrink-0 items-center gap-2 border-b border-[color:var(--line-1)] px-9"
      >
        <span
          className={`shrink-0 rounded-lg px-3 py-1 text-[length:var(--fs-card-chrome)] font-medium leading-none ${def?.badge ?? "bg-[color:var(--surface-2)] text-[color:var(--ink-2)]"}`}
        >
          {def?.label ?? type}
        </span>
        {/*
          这里原来还有两样东西，2026-10-26 一起删了：

          ① **节点名**（「剧本描述」）—— 它和类型徽标并排放着，等于头部两个词。
             人的原话是「把『文本提示词』『剧本描述』这一块改为『提示词优化』」，
             选的是「只留一个词」。所以名字连同它的输入框一起消失了，
             **双击头部改名这个能力也随之删掉**（这是他明确选过的后果，
             不是遗漏）。数据里的 data.label 仍保留：引擎的报错要靠它
             （plan.ts 里「节点『…』的生成方式是…」），只是不再显示。

          ② **状态文字**（「待运行」）—— 见下面那段条件渲染。
        */}
        {/*
          状态区只在**有事发生**时出现。

          人要求删掉右上角的「待运行」。如果只删文字留那个点，一个永远在的
          灰点会变成新的噪音；如果连运行中/失败也一起删，用户点了运行就
          完全不知道在跑还是挂了。所以判据是「状态不是 idle」：
          待运行什么都不显示，运行中/失败/跳过照旧。

          `ml-auto` 让它靠右 —— 头部现在只有一个左对齐的徽标，
          去掉名字之后它是唯一会占据横向空间的元素。
        */}
        {statusKey !== NODE_STATUS.IDLE && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[length:var(--fs-card-chrome)] text-[color:var(--ink-3)]">
            <span className={`h-8 w-8 rounded-full ${status.dot}`} />
            {status.text}
          </span>
        )}
      </div>

      {editing === "body" && bodyParam ? (
        <BodyEditor
          nodeId={id}
          fieldKey={bodyParam.key}
          /*
           * 初值用 bodyText 而不是 data[bodyParam.key]：
           * 节点还没优化过时 optimizedPrompt 是空的，而卡片上显示的是原文
           * （回退，见 promptText.ts）。直接用字段值会让双击进去一片空白 ——
           * 「我看到的字，双击就没了」，这是最让人不敢继续编辑的那种体验。
           */
          value={bodyText}
          placeholder={bodyParam.placeholder}
          onExit={() => setEditing(null)}
        />
      ) : (
        /*
         * 只读正文。这里**不做滚动**，用 line-clamp 截断。
         *
         * 理由是滚轮：卡片没带 nowheel，鼠标在卡片上滚轮就是缩放画布。
         * 要让这块区域自己滚，就得给它 nowheel，代价是整张卡片上的滚轮
         * 都不再缩放画布 —— 那更烦。所以只读态按「摘要」处理，
         * 想看全文双击进去，那里是真正的 textarea，自带 nowheel 和滚动。
         *
         * clamp 取 12 行：主体 636px（768 减头部 64、底栏 64、上下边框 4）
         * 减去上下 padding 48px 得 588px，30px 字号配 1.625 行高（48.75px）
         * 装得下 12 行（585px），第 13 行（633.75px）会溢出，截断点落在卡片边缘上。
         *
         * 这个数字和头 / 底栏高度是**绑死的**：2026-10-26 底栏曾为了装一个 72px 的
         * 方形叉号加高到 88（正文降到 12 行），当晚叉号搬到右上角后底栏回到 40。
         * 同日按 UI 军规把头部 / 底栏一起提到 64（32px 字在 40 里只上下各留 4px，
         * 太挤），正文 clamp 相应降到 12 行。改任何一边都要同步改另一边，
         * 否则症状是「最后一行被从半个字处切断」，而 clamp 值看着毫无问题。
         *
         * 字号调过六轮：12 → 15 → 28 → 22 → 26 → 30。判据也换了两次：
         * 一开始只看「设计值一行装几个字」，后来改成看**屏幕上**多大。
         * 26px 在 zoom ≈ 0.56 下落成 14.7px（和首页正文 14px 齐平），
         * 30px 落成 17px，比首页正文大一号 —— 这是人肉眼对过之后的定档。
         *
         * 代价是行数与容量一路缩：22px 时 18 行 810 字 → 26px 时 15 行 570 字
         * → 30px 时 13 行约 430 字（33 字/行）。超过的部分只读态被截断，
         * 双击进编辑态仍能滚。**这是「字大」必须付的价**，不是 bug。
         */
        <div data-card-body="1" className="relative min-h-0 flex-1 overflow-hidden px-9 py-6">
          <p
            className={[
              "whitespace-pre-wrap text-[length:var(--fs-body)] leading-relaxed",
              /*
               * 必须用任意值语法 `line-clamp-[13]`。
               *
               * Tailwind 内置的 line-clamp-1..6 是有限的几个数字，写成
               * `line-clamp-18` 不会报错、也不会生成任何样式 —— 症状是
               * 正文一路写到卡片底边、被 overflow-hidden 从半行处切断，
               * 还没有省略号。看起来像「风格问题」，其实是类名根本不存在。
               */
              bodyText ? "line-clamp-[12] text-[color:var(--ink-1)]" : "text-[color:var(--ink-3)]",
            ].join(" ")}
          >
            {bodyText || "双击这里写内容"}
          </p>
          {/*
            这里原来有个绝对定位在右下角的「双击编辑」提示。
            字号提到 18px 之后它会盖住正文最后一行（正文 28px 后每行都很高，
            右下角那块正好落在最后一行的字上），所以挪到底栏和字数并排 ——
            底栏本来就有空位，而且提示常显比 hover 才现更容易被发现。
          */}
        </div>
      )}

      {/*
        底栏：只放操作。参数一个都不放 —— 它们全在选中后浮出的面板里。
        整张卡片（含这里）都不加 nodrag：任何位置都能拖动节点。
      */}
      <div
        data-card-footer="1"
        className="flex h-16 shrink-0 items-center gap-1.5 border-t border-[color:var(--line-1)] px-9"
      >
        {/*
          「AI 优化」标记放在这里而不是正文角落：正文会一直写到卡片右边界，
          任何叠在上面的绝对定位元素都会压字。底栏是固定高度的，
          塞几个小标签不会改变卡片高度（这是「有时出现的元素」能安全放进来的地方）。
        */}
        {def?.preview === "text" && (
          <span className="flex min-w-0 items-center gap-3 text-[length:var(--fs-card-chrome)] text-[color:var(--ink-3)]">
            <span className="shrink-0 tabular-nums">{bodyText.length} 字</span>
            {/* 双击可编辑是隐藏交互，必须给视觉线索 —— 没有线索这个能力等于不存在 */}
            {bodyParam && <span className="shrink-0">双击编辑</span>}
            {optimized && (
              <span
                data-optimized="1"
                title="这段是 AI 根据你的原始描述改写过的。原始描述在选中后的面板里"
                className="shrink-0 rounded-lg bg-sky-950/90 px-3 py-1.5 leading-none text-sky-300"
              >
                AI 优化
              </span>
            )}
          </span>
        )}

        {/*
          这里原来有「▶ 运行」和下载两个按钮，都随图 / 视频节点脱壳一起消失了：
            运行 → 和面板里的「生成」重复（同一个 startRun），已删；
                   文本节点的 capability 是 null，本来就不显示它。
            下载 → 只有产物节点才有可下载的东西，那种节点已经不走这条壳了。

          删除叉号也搬走了（2026-10-26 晚）：底栏里那个方块人看了说「太丑了」，
          现在和图片 / 视频节点用同一个右上角圆形叉号（common.tsx 的 NodeDeleteButton）。
          底栏因此回到 40，正文回到 13 行 —— 那是这一轮唯一的额外收获。
        */}
      </div>

      {/*
        进度条绝对定位在底边：之前是普通块级元素，出现/消失会改变卡片高度，
        上下游连线跟着抖一次。绝对定位后它只是「贴在底边的一条线」。
      */}
      {statusKey === NODE_STATUS.RUNNING && (
        <div
          className="absolute inset-x-0 bottom-0 h-1 overflow-hidden rounded-b-3xl bg-[color:var(--surface-2)]"
          data-progress={Math.round((rt?.progress ?? 0) * 100)}
        >
          <div
            className="h-full bg-blue-500 transition-[width] duration-200 ease-out"
            style={{ width: `${Math.round((rt?.progress ?? 0) * 100)}%` }}
          />
        </div>
      )}

      {/*
        删除：和图片 / 视频节点**同一个组件、同一个位置**（右上角外侧的圆形叉号）。
        2026-10-26 晚从底栏里搬出来的 —— 人看到底栏那个方块说「太丑了」。
        顺手把底栏送回 40、正文送回 13 行：那个 88 高的底栏本来只为装它。

        条件也一样（选中且没在拖动），否则两种节点上同一个按钮的出场时机不同，
        用户会以为「卡片节点的叉号时有时无」。
      */}
      {selected && !dragging && <NodeDeleteButton nodeId={id} />}

      {/*
        选中后浮出的参数面板。
        两种情况下收起：
          dragging —— 拖着节点时浮一块面板既挡视线又跟着晃，松手自己回来
          editing  —— 正在写字时把参数摊在下面，人会分心去调模型/换按钮
      */}
      {selected && !dragging && !editing && def && (
        <NodePanel nodeId={id} def={def} data={data} />
      )}

      <NodeOutputHandle />
    </div>
  );
}

/** 注册表里查不到类型时的空定义，只用来避免把 undefined 传进 NodeInputHandles */
const emptyDef: NodeDefinition = {
  type: "__unknown",
  label: "未知",
  hint: "",
  badge: "",
  size: { w: NODE_WIDTH, h: NODE_HEIGHT },
  preview: "none",
  defaultData: () => ({ label: "", prompt: "", status: "idle" }),
  accepts: [],
  capability: null,
};

/**
 * 卡片主体的内联编辑器（双击进入，见 CardNode 里的 `editing`）。
 *
 * ### 它和面板里的 PromptEditor 的区别
 *
 * 长得像，但职责不同：PromptEditor 活在浮出的面板里，是个「一块区域高 80px」的控件；
 * 这个撑满卡片主体，是**卡片本身变成了输入框**。所以它必须自己处理进出：
 * 挂载即聚焦、Esc 退出。面板里的那个不需要，因为面板一收起它自然就没了。
 *
 * ### 为什么用防抖而不是受控绑 store
 *
 * 每敲一个字符都写 store 会让整张画布重渲染，而且外部回灌会打断光标。
 * 这里的光标位置尤其要紧 —— 用户正在一段长文本中间改字，
 * 光标被弹到别处基本等于这次编辑作废。
 *
 * ### 滚动条为什么要藏起来
 *
 * 卡片尺寸是常量（1024×768），出现滚动条会占掉约 8px 宽度，
 * 文字会在恰好需要滚动的那一刻整体向左横跳一下。藏掉滚动条后
 * 溢出是「悄悄可以滚」，靠行数本身提示还有内容。
 *
 * ### 字号必须和只读态一致（同一个 CSS 变量）
 *
 * 双击进去时字号变了，等于「我看到的和我正在改的不是同一个东西」——
 * 文字会重排，光标会跳到意想不到的位置，视觉上像闪了一下。
 * 所以这里的 --fs-body / leading-relaxed 要和上面只读的 <p> 一模一样。
 * 用同一个变量而不是抄同一个数字：抄数字的话下次调字号必然有一处被漏掉，
 * 而漏掉的表现是「双击进去文字就重排了」，很难归因到这个变量上。
 */
function BodyEditor({
  nodeId,
  fieldKey,
  value,
  placeholder,
  onExit,
}: {
  nodeId: string;
  fieldKey: string;
  value: string;
  placeholder?: string;
  onExit: () => void;
}) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData);
  const commit = useCallback(
    (v: string) => updateNodeData(nodeId, { [fieldKey]: v }),
    [nodeId, fieldKey, updateNodeData]
  );
  const { draft, onChange, focusedRef } = useDebouncedCommit(value, commit);
  const ref = useRef<HTMLTextAreaElement>(null);

  /*
   * 光标放到**末尾**，不要全选。
   * 全选的话下一次击键会把整段替换掉 —— 双击的直觉是「我要在这个位置写字」，
   * 不是「我要重写一切」。真想全选，用户会按 Ctrl+A。
   */
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <div className="min-h-0 flex-1 px-2 py-1.5">
      <textarea
        ref={ref}
        value={draft}
        data-field={fieldKey}
        // 让自动化验收能区分「卡内编辑器」和「面板里的输入框」：
        // 两者 data-field 相同，只看字段名分不出来。
        data-card-editor="1"
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
        }}
        onKeyDown={(e) => {
          // Esc 退出。不拦别的键 —— Tab、方向键、Ctrl+Z 都是正常的输入行为，
          // 拦了就是在输入框里造一套自造的快捷键，比不拦更让人困惑。
          if (e.key === "Escape") {
            e.preventDefault();
            onExit();
          }
        }}
        style={{
          /*
           * 滚动条必须用 **inline style** 藏，不能只靠 CSS 类。
           *
           * 反面教材就在这行下面：`no-scrollbar` 那个类在 globals.css 里写得好好的，
           * 但构建期的 Lightning CSS 会按浏览器目标做特性裁剪 ——
           * `-ms-overflow-style`（只有 IE 认）、`scrollbar-width`、`::-webkit-scrollbar`
           * 都被判成"目标浏览器不需要"，声明删光、规则变空、整条消失。
           * 证据：编译产物 CSS 里 `scrollbar` 出现 **0 次**，
           * 而同一文件里的 `.react-flow__edge` 还在。
           *
           * 症状是不会报任何错，只是滚动条照旧出现。
           * inline style 不进 CSS 构建管线，是唯一保证到位的路径。
           */
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        }}
        className="no-scrollbar nodrag nopan nowheel h-full w-full resize-none rounded-lg border border-[color:var(--line-2)] bg-[color:var(--surface-2)] px-2.5 py-1.5 text-[length:var(--fs-body)] leading-relaxed text-[color:var(--ink-1)] outline-none transition-colors placeholder:text-[color:var(--ink-3)] focus:border-[color:var(--line-3)] focus:bg-[color:var(--surface-1)]"
      />
    </div>
  );
}
