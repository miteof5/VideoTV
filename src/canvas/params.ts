import type { ModelDescriptor, ProviderCapability } from "@/providers/types";

/**
 * 参数层 —— 节点面板里「有哪些控件」的唯一来源。
 *
 * ### 为什么参数要跟着**能力**走，而不是跟着节点类型走
 *
 * 三个节点的关系是三件事，必须分开表达：
 *
 *   能力 capability → 调哪个 Provider、面板有哪些控件
 *   端口 kind       → 这条线能不能接（见 portRules.ts）
 *   外观 preview    → 卡片长什么样（见 nodeRegistry.ts）
 *
 * 把它们混在一个字段里，就会出现「改图片节点的参数，顺手影响了视频节点」——
 * 那不是感觉，是物理上它们曾经写在同一个函数里。
 *
 * 按能力分组之后：
 *   - 同能力的节点，面板必然一样（相似性**自动**成立，不用刻意对齐）
 *   - 不同能力的节点，面板必然不一样（独立性也自动成立）
 *   - 加一个参数 = 在对应的那一组里加一行，UI 代码零改动
 *
 * ### 与 M6 那版 fields 的区别
 *
 * M6 曾用 `nodeRegistry.<type>.fields` 驱动渲染，后来为了让卡片尺寸恒定
 * 就把渲染改成了手写 if —— 尺寸恒定是对的，但参数从「数据」退回了「代码」。
 * 这一版把参数变回数据，同时保留那个真正重要的约束：
 *
 *   **布局位置固定，参数集合可变。**
 *
 * body 永远在名称下面竖排，inline 永远挤在底部操作行。
 * 这样加参数不会让面板「换个长相」，只是多一个控件。
 */

/** 面板能渲染的控件种类。加一种新控件 = 这里加一行 + PanelControl 加一个分支 */
export type ParamControl = "prompt" | "text" | "select";

/**
 * 下拉框的选项从哪来。
 *
 * 三种都是**运行时**才知道的：模型清单要 fetch，比例和时长挂在具体模型上。
 * 写死在注册表里就成了谎话 —— 模型换了，比例没跟着换。
 */
export type ParamSource = "models" | "aspectRatios" | "durations";

/**
 * 控件住在卡片哪一侧。
 *
 * 这个字段存在的理由：卡片的**主体**只有一块地方，而有些节点有两个
 * 文字框（文本节点：原始描述 + 优化结果）。「谁在卡上、谁在面板里」
 * 如果不说出来，就必然退化成渲染组件里的
 * `if (type === "text.prompt")` —— 那正是 M9 要消灭的东西。
 *
 * 两半区各有两个位置，所以是「半区 × 位置」而不是一个平铺的枚举：
 *
 *   body + panel  → 面板里，名称下面竖排
 *   body + card   → 卡片主体（正文编辑器，双击进入）
 *   inline + panel→ 面板底部操作行，和「生成」按钮同一排
 *   inline + card → 卡片底栏（暂时没用，留位）
 *
 * 默认 panel：漏写只是「留在默认位置」，是安全的失败方式 ——
 * 不像 accepts 漏写会静默放行本不该接的线。
 *
 * 注意同一个参数集里 `card` 位置只能有一个 —— 卡片主体只有一块。
 * 写在两个上，前一个会被 find() 拿到，后一个静默消失。
 */
export type ParamPlace = "panel" | "card";

export interface ParamDef {
  /** 对应节点 data 里的键名，同时也是 DOM 上的 data-field（自动化验收依赖它） */
  key: string;
  /** 控件标题，同时作为 title 属性 */
  label: string;
  control: ParamControl;
  /** 住在卡片哪一侧，默认 panel */
  place?: ParamPlace;
  /** select 用：选项来源 */
  from?: ParamSource;
  /** select 用：静态选项（没有 from 时生效） */
  options?: { value: string; label: string }[];
  placeholder?: string;
  /** inline 控件的最大宽度（px） */
  width?: number;
}

export interface ParamSet {
  /** 竖排：名称下面一块一块排下来 */
  body: ParamDef[];
  /** 横排：挤在底部操作行里，和「生成」按钮同一行 */
  inline: ParamDef[];
}

const MODEL: ParamDef = {
  key: "modelId",
  label: "模型",
  control: "select",
  from: "models",
  /*
   * 宽度上限，单位是**屏幕像素**（面板从 2026-10-24 起不随画布缩放）。
   * 140 是画布坐标时代的数，屏幕上只有 79px，「演示图片模型」这种名字会被截。
   * 13px 字号下 240 能放下十来个汉字。
   */
  width: 240,
};

/**
 * 三个能力的参数集。
 *
 * ## 想加参数时改这里
 *
 * - 视频的「生成方式」（auto / 文生 / 图生）现在**没有 UI 入口**，由 modeRule
 *   看上游产物种类自动推导。想给用户一个强制指定的入口，在 video.inline 里加：
 *
 *      { key: "mode", label: "生成方式", control: "select", options: [...], width: 110 }
 *
 *   加完之后面板自动多一个下拉，CanvasNode 一行都不用动。
 *   但要想清楚：能手动指定就会有人指定错（没接图却选「图生视频」），
 *   那种组合只能靠执行时报错兜住。
 *
 * - 图像想加「张数」，在 image.inline 加一条 `n`。选项来自 Provider 声明
 *   （见 catalog 的 options），不要在这里写死 [1,2,4] —— 模型支持几张是模型的事。
 */
export const PARAM_SETS: Record<ProviderCapability, ParamSet> = {
  text: {
    body: [
      /*
       * 原始描述 —— 用户自己写的那句话，住在**面板**里。
       *
       * 它和下面那项是同一件事的两个阶段，不是两个参数：
       * 「我想要的」→（发送）→「AI 改写成模型能看懂的」。
       *
       * 为什么它在面板而不是卡片上：面板是「选中才浮出来的一块操作区」，
       * 语义等于对话框 —— 点一下就能打字，写完点发送。这比卡片更符合
       * 「临时输入」的身份：卡片是产物，面板是动作。
       */
      {
        key: "prompt",
        label: "原始描述",
        control: "prompt",
        place: "panel",
        placeholder: "描述你想要的画面，发送后会经过 AI 优化",
      },
      /*
       * 优化结果 —— 住在**卡片主体**里，双击就地编辑（像记事本）。
       *
       * 为什么它是主内容：下游节点拼提示词、模型生成，用的都是这一份
       * （取值规则集中在 canvas/promptText.ts 的 mainText）。
       * 用户的原话是给人和 AI 看的，这一份才是给模型看的。
       *
       * 注意它**只声明在 text 的参数集里**。图像 / 视频节点的提示词
       * 目前只有一段，将来接入优化时在各自的参数集里加同样一条即可，
       * 引擎和渲染组件都不用动 —— 它们比的始终是 `place`，不是节点类型。
       */
      {
        key: "optimizedPrompt",
        label: "提示词",
        control: "prompt",
        place: "card",
        placeholder: "双击这里写内容",
      },
    ],
    // 文本节点自己是纯输入（capability 为 null），模型来自它的发送动作，
    // 所以这里的模型清单按 "text" 能力过滤。
    inline: [MODEL],
  },

  image: {
    body: [
      {
        key: "prompt",
        label: "提示词",
        control: "prompt",
        placeholder: "描述你要生成的内容",
      },
      /*
       * 这里**曾经**有 negativePrompt（单行输入框）。
       *
       * 2026-10-24 人拍板删掉：面板改成「一个输入框 + 底栏（模型 / 比例 / 生成）」
       * 的一体式结构，参照 ActionAgent 的 composer。负面提示词是第二个输入区，
       * 无框容器里两段空白分不清谁是谁，加分隔线又违背「一整块」的初衷。
       *
       * 删的是**入口**，引擎那一侧也一起断开了（见 engine/plan.ts）——
       * 理由：没有入口的字段还偷偷生效，用户永远查不出「结果为什么是这个样」。
       * 这意味着存量节点里填过的负面提示词**不再发给模型**。
       *
       * 想加回来：这里补一条，plan.ts 恢复 `negativePrompt: data.negativePrompt`。
       * provider 层（qwenImage / wanImage 的 negative_prompt）一行没动，随时可用。
       */
    ],
    inline: [
      MODEL,
      { key: "aspectRatio", label: "画面比例", control: "select", from: "aspectRatios", width: 110 },
    ],
  },

  video: {
    body: [
      {
        key: "prompt",
        label: "提示词",
        control: "prompt",
        placeholder: "描述镜头里发生什么",
      },
    ],
    inline: [
      MODEL,
      { key: "aspectRatio", label: "画面比例", control: "select", from: "aspectRatios", width: 110 },
      { key: "duration", label: "时长", control: "select", from: "durations", width: 110 },
    ],
  },
};

/**
 * 某个节点该用哪一套参数 —— 卡片和面板都必须从这一个函数取。
 *
 * 为什么需要它：文本节点的 `capability` 是 null（它不调模型），
 * 但它有改写动作，动作声明了要调 "text" 能力。所以「用哪套参数」
 * 不能只看 capability，得看 `capability ?? 第一个动作的能力`。
 *
 * 这个回退逻辑一旦写两遍（卡片一处、面板一处），就会漂移：
 * 某天卡片主体还在按 text 渲染，面板已经不认了，症状是
 * 「正文在卡片里能改，模型下拉却不见了」，而两边代码看着都对。
 *
 * 参数用结构化最小接口而不是 import NodeDefinition —— 后者会让
 * 参数层反向依赖注册表，而这层本意是注册表的下游。
 */
export function paramSetOf(def: {
  capability: ProviderCapability | null;
  actions?: { capability: ProviderCapability }[];
}): ParamSet | null {
  const cap = def.capability ?? def.actions?.[0]?.capability ?? null;
  return cap ? PARAM_SETS[cap] : null;
}

/**
 * 把下拉框的选项算出来。
 *
 * `model` 是当前会用的那个模型 —— 比例和时长都挂在它身上，
 * 所以「换模型 → 比例列表跟着变」是这里自然发生的结果，
 * 不需要谁去 notify 谁。
 */
export function optionsOf(
  param: ParamDef,
  models: ModelDescriptor[],
  capability: ProviderCapability,
  model: ModelDescriptor | undefined
): { value: string; label: string }[] {
  switch (param.from) {
    case "models":
      // 只出「有这个能力」的模型。这是模型不串味的唯一依据：
      // 视频节点拿不到图像模型，因为图像模型的 capabilities 里没有 video。
      return models
        .filter((m) => m.capabilities.includes(capability))
        .map((m) => ({ value: m.id, label: m.label }));

    case "aspectRatios":
      return (model?.options.aspectRatios ?? []).map((v) => ({ value: v, label: v }));

    case "durations":
      return (model?.options.durations ?? []).map((d) => ({
        value: String(d),
        label: `${d} 秒`,
      }));

    default:
      return param.options ?? [];
  }
}

/**
 * 当前实际会用哪个模型。
 *
 * 「没选」和「选了但没注册」要同等对待：都回落到该能力的第一个模型。
 * 这和引擎 `selectProvider` 的行为一致 —— 前端显示的必须是后端真会用的那个，
 * 否则用户看到的和实际生成的对不上。
 */
export function effectiveModel(
  data: Record<string, unknown>,
  models: ModelDescriptor[],
  capability: ProviderCapability | null
): ModelDescriptor | undefined {
  if (!capability) return undefined;
  const list = models.filter((m) => m.capabilities.includes(capability));
  const wanted = String(data.modelId ?? "");
  return list.find((m) => m.id === wanted) ?? list[0];
}
