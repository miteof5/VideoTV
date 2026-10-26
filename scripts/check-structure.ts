/**
 * 结构自检 —— 三层关系是不是按设计成立。
 *
 * 只测「关系」，不测渲染：渲染由 e2e-structure.mjs 用真实浏览器验。
 * 两者分开跑是因为这里能秒出结果，改一行就能立刻知道边界有没有被破坏。
 *
 * 跑法：npx tsx scripts/check-structure.ts
 */
import { nodeRegistry } from "@/canvas/nodeRegistry";
import { checkPort, producedKindOf } from "@/canvas/portRules";
import { PARAM_SETS } from "@/canvas/params";
import { isOptimized, mainText } from "@/canvas/promptText";
import { NODE_TYPE } from "@/lib/constants";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** 造一个最小节点，只带类型和 data */
const n = (type: string, data: Record<string, unknown> = {}) => ({
  id: `${type}#1`,
  type,
  data,
});

/** 换个 id，避免「不能连自己」那条规则误伤 */
const withId = (node: ReturnType<typeof n>, id: string) => ({ ...node, id });

console.log("=== 端口层：连线合不合法 ===");

const TEXT = n(NODE_TYPE.TEXT_PROMPT, {});
const IMAGE = n(NODE_TYPE.IMAGE_GEN, {});
const VIDEO = n(NODE_TYPE.VIDEO_GEN, {});
const ASSET_IMG = n(NODE_TYPE.MEDIA_ASSET, { assetKind: "image" });
const ASSET_VID = n(NODE_TYPE.MEDIA_ASSET, { assetKind: "video" });

const cases: [string, ReturnType<typeof n>, ReturnType<typeof n>, boolean][] = [
  ["文字 → 图像", TEXT, IMAGE, true],
  ["文字 → 视频", TEXT, VIDEO, true],
  ["图像 → 视频", IMAGE, VIDEO, true],
  ["素材(图) → 视觉节点", ASSET_IMG, VIDEO, true],
  ["图像 → 文字", IMAGE, withId(TEXT, "text#2"), false],
  ["视频 → 图像", VIDEO, IMAGE, false],
  ["视频 → 视频", VIDEO, withId(VIDEO, "video#2"), false],
  ["素材(视频) → 图像", ASSET_VID, IMAGE, false],
  ["任何东西 → 素材", IMAGE, withId(ASSET_IMG, "asset#2"), false],
];

for (const [name, src, tgt, expectOk] of cases) {
  const v = checkPort(src, tgt);
  check(name, v.ok === expectOk, v.ok ? "允许" : v.reason);
}

console.log("");
console.log("=== 端口层：拒绝时必须说清原因 ===");
const videoToImage = checkPort(VIDEO, IMAGE);
check(
  "拒绝文案包含种类和目标",
  !videoToImage.ok &&
    videoToImage.reason.includes("视频") &&
    videoToImage.reason.includes("图像生成"),
  videoToImage.ok ? "" : videoToImage.reason
);
const intoAsset = checkPort(IMAGE, withId(ASSET_IMG, "asset#2"));
check(
  "接进素材时说明它不接受输入",
  !intoAsset.ok && intoAsset.reason.includes("不接受输入"),
  intoAsset.ok ? "" : intoAsset.reason
);

console.log("");
console.log("=== 端口层：产物种类 ===");
check("文本节点产文字", producedKindOf(TEXT) === "text");
check("图像节点产图片", producedKindOf(IMAGE) === "image");
check("视频节点产视频", producedKindOf(VIDEO) === "video");
check("素材按实际类型产出（图）", producedKindOf(ASSET_IMG) === "image");
check("素材按实际类型产出（视频）", producedKindOf(ASSET_VID) === "video");

console.log("");
console.log("=== 端口层：输入点的渲染依据 ===");
check("素材不接受输入（accepts 为空）", nodeRegistry[NODE_TYPE.MEDIA_ASSET].accepts.length === 0);
check("文本接受文字", nodeRegistry[NODE_TYPE.TEXT_PROMPT].accepts.includes("text"));
check("图像接受文字和图片", nodeRegistry[NODE_TYPE.IMAGE_GEN].accepts.join(",") === "text,image");
check("视频接受文字和图片", nodeRegistry[NODE_TYPE.VIDEO_GEN].accepts.join(",") === "text,image");

console.log("");
console.log("=== 参数层：控件跟着能力走 ===");
const keysOf = (cap: keyof typeof PARAM_SETS) => [
  ...PARAM_SETS[cap].body.map((p) => p.key),
  ...PARAM_SETS[cap].inline.map((p) => p.key),
];

check(
  "text 有原始描述、优化结果和模型",
  keysOf("text").join(",") === "prompt,optimizedPrompt,modelId",
  keysOf("text").join(",")
);
check(
  "image 只有一段提示词 + 比例（负面提示词已并入输入框，2026-10-24）",
  keysOf("image").join(",") === "prompt,modelId,aspectRatio",
  keysOf("image").join(",")
);
check(
  "video 有时长、没有负面提示词",
  keysOf("video").join(",") === "prompt,modelId,aspectRatio,duration",
  keysOf("video").join(",")
);
check("text 没有比例（文本没有画幅）", !keysOf("text").includes("aspectRatio"));
check("image 没有时长（图是静态的）", !keysOf("image").includes("duration"));
check("三个能力参数集互不完全相同", new Set(["text", "image", "video"].map((c) => keysOf(c as never).join(","))).size === 3);

console.log("");
console.log("=== 参数层：卡片主体的位置只有一个 ===");

/*
 * 「谁在卡片上」是靠 find(p => p.place === "card") 找的。
 * 一个参数集里写两个 card，第二个会被静默忽略 —— 用户会看到
 * 「我明明加了参数，界面上没有」，而这既不报错也不违反类型。
 * 这条检查就是给那个沉默兜底。
 */
for (const cap of ["text", "image", "video"] as const) {
  const card = PARAM_SETS[cap].body.filter((p) => p.place === "card");
  check(`${cap} 最多一个卡上参数`, card.length <= 1, `实际 ${card.length} 个`);
}

const textBody = PARAM_SETS.text.body;
check(
  "原始描述在面板里（点一下就能改）",
  textBody.find((p) => p.key === "prompt")?.place === "panel"
);
check(
  "优化结果在卡片上（双击才能改）",
  textBody.find((p) => p.key === "optimizedPrompt")?.place === "card"
);
check(
  "图像节点的提示词仍留在面板里（没有两段字，不需要搬到卡上）",
  PARAM_SETS.image.body.find((p) => p.key === "prompt")?.place !== "card"
);

console.log("");
console.log("=== 主文本取值：优化结果优先，没有就回退原文 ===");

/*
 * 这段规则如果写错，症状是「卡片显示的是优化版、下游拿的是原文」
 * 或者「升级后老项目节点全变空」，两者都不会报错。所以单独列出来验。
 */
check("只有原文时取原文", mainText({ prompt: "原话" }) === "原话");
check(
  "有优化结果时取优化结果",
  mainText({ prompt: "原话", optimizedPrompt: "改写后的" }) === "改写后的"
);
check(
  "优化结果只有空白时回退原文",
  mainText({ prompt: "原话", optimizedPrompt: "   " }) === "原话"
);
check("什么都没有时是空串", mainText({}) === "");
check("空节点不会崩", mainText(null) === "");

check("和原文不同才算优化", isOptimized({ prompt: "a", optimizedPrompt: "b" }));
check(
  "手改回和原文一样就不算优化",
  !isOptimized({ prompt: "a", optimizedPrompt: "a " })
);
check("没优化过不算优化", !isOptimized({ prompt: "a", optimizedPrompt: "" }));

console.log("");
console.log("=== 参数层：每个 select 都声明了选项来源 ===");
for (const cap of ["text", "image", "video"] as const) {
  for (const p of PARAM_SETS[cap].inline) {
    if (p.control !== "select") continue;
    check(`${cap}.${p.key} 有选项来源`, Boolean(p.from || p.options));
  }
}

console.log("");
console.log(`${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
