import type {
  ModelDescriptor,
  ModelProvider,
  ProviderCapability,
} from "@/providers/types";
import { MODEL_CATALOG, availableModels, isUsable } from "@/providers/catalog";
import { createMockFromDescriptor } from "@/providers/mock/MockProvider";
import { createDashScopeChatProvider } from "@/providers/dashscope/chat";
import { createQwenImageProvider } from "@/providers/dashscope/qwenImage";
import { createWanImageProvider } from "@/providers/dashscope/wanImage";
import { createWanVideoProvider } from "@/providers/dashscope/wanVideo";

// Provider 注册表。
//
// 它存在的唯一目的：让「有哪些模型可用」「这个能力该用谁」
// 变成一次查表，而不是散落在业务代码里的 if/else。
//
// 接真模型时，这个文件只需要在 build() 的 switch 里加一行分支。
// 业务代码一行不动 —— 这是第一阶段定下的边界，现在第一次被真的用到。

const providers = new Map<string, ModelProvider>();

export function registerProvider(provider: ModelProvider) {
  if (providers.has(provider.id)) {
    // 覆盖注册往往是 bug（两个模块各自注册了同名模型），所以给出警告而不是静默覆盖
    console.warn(`[providers] 覆盖同名 Provider：${provider.id}`);
  }
  providers.set(provider.id, provider);
}

/**
 * 按描述装配一个实现。
 *
 * 分派依据是 `desc.impl`，声明在 catalog 里而不是这里 ——
 * 否则加一个模型要同时改 catalog（让它出现在下拉框）和 registry（让它能跑），
 * 漏改后者的表现是「选得到、点运行报未注册」，而且只有点了才知道。
 */
function build(desc: ModelDescriptor): ModelProvider {
  switch (desc.impl) {
    case "mock":
      return createMockFromDescriptor(desc);
    case "dashscope.chat":
      return createDashScopeChatProvider(desc);
    case "dashscope.qwen-image":
      return createQwenImageProvider(desc);
    case "dashscope.wan-image":
      return createWanImageProvider(desc);
    case "dashscope.wan-video":
      return createWanVideoProvider(desc);
    default:
      throw new Error(`模型 ${desc.id} 没有可用的实现（impl=${desc.impl}）`);
  }
}

let ready = false;

/**
 * 惰性注册，而不是在模块顶层直接注册。
 *
 * 为什么这件事重要：模块顶层的代码在 **import 那一刻** 执行，
 * 而 `process.env` 的填充时机不由我们控制 —— Next.js 在启动时注入、
 * tsx 靠 `import "dotenv/config"`，测试脚本可能先 import 再设变量。
 * 一旦 import 早于 env 就绪，真模型会被静默漏注册，
 * 界面上的表现是「配了 key 也看不到那些模型」，而且没有任何报错。
 *
 * 放到第一次查询时做，时机问题就消失了。
 */
function ensureRegistered() {
  if (ready) return;
  ready = true;

  /*
   * MODEL_PROVIDER=mock 时强制只用演示模型。
   *
   * 用途很具体：配了 key、但今天只想调界面不想烧额度的时候。
   * 没有这个开关就只能去注释代码或者临时删 .env 里的 key ——
   * 两种做法都会在某次忘记改回来时变成事故。
   *
   * 这个判断不写在这里，而是交给 catalog 的 isUsable ——
   * 清单和注册表必须用同一套规则，各写一遍必然走偏
   * （漏写的那次表现是「清单里有、点运行报未注册」）。
   */
  let realCount = 0;

  for (const desc of MODEL_CATALOG) {
    if (!isUsable(desc, process.env)) continue;

    try {
      providers.set(desc.id, build(desc));
      if (!desc.demo) realCount++;
    } catch (err) {
      // 一个模型装配失败不该拖垮整个注册表 ——
      // 否则一个配置错误会让连文本节点都用不了
      console.error(`[providers] 装配 ${desc.id} 失败：`, err);
    }
  }

  if (realCount === 0) {
    // 只提示，不报错：没有 key 时 Mock 仍然要能把整条链路跑通，
    // 那是第一阶段就定下的设计，不是降级。
    console.info(
      "[providers] 当前只注册了演示模型。在 .env（或系统环境变量）里配置 " +
        "DASHSCOPE_API_KEY 后重启 dev 与 worker 即可启用真模型。"
    );
  }
}

export function getProvider(id: string): ModelProvider {
  ensureRegistered();
  const p = providers.get(id);
  if (!p) {
    throw new Error(
      `未注册的 Provider：${id}（已注册：${[...providers.keys()].join(", ")}）`
    );
  }
  return p;
}

export function hasProvider(id: string) {
  ensureRegistered();
  return providers.has(id);
}

/** 列出具备某个能力的模型。前端「选择模型」下拉框直接用它 */
export function listProviders(capability?: ProviderCapability): ModelProvider[] {
  ensureRegistered();
  const all = [...providers.values()];
  return capability
    ? all.filter((p) => p.capabilities.includes(capability))
    : all;
}

/**
 * 给前端用的模型清单。
 *
 * 用 availableModels 而不是 listModelsByCapability：前者会过滤掉
 * 「依赖的环境变量没配」的条目。两边必须用同一套规则 ——
 * 清单里出现一个点了就报「未配置 API Key」的模型，比它干脆不出现糟糕得多。
 *
 * 只暴露 id / label / 能力 / 参数取值 —— 不能把 Provider 实例直接序列化出去，
 * 那会带上 generate 函数，而实例闭包里可能握着 API Key。
 */
export function listModels(capability?: ProviderCapability): ModelDescriptor[] {
  return availableModels(capability, process.env);
}

/**
 * 选出这次该用哪个模型。
 *
 * 语义很关键：**指定了 preferredId 就必须用它**。
 * 如果它不支持这个能力，宁可报错也不悄悄换成别的 ——
 * 用户选的是「千问 3.0 Pro」，你偷偷用演示模型出了个色块，比直接失败更糟。
 *
 * 没指定时才回落到该能力的默认（注册顺序第一的）实现。
 * 注册顺序来自 catalog 的数组顺序，真模型排在演示模型前面，
 * 所以配了 key 之后默认就是真模型。
 */
export function selectProvider(
  capability: ProviderCapability,
  preferredId?: string
): ModelProvider {
  if (preferredId) {
    const p = getProvider(preferredId);
    if (!p.capabilities.includes(capability)) {
      throw new Error(
        `模型 ${preferredId} 不支持 ${capability}（它支持：${p.capabilities.join(", ")}）`
      );
    }
    return p;
  }

  const candidate = listProviders(capability)[0];
  if (!candidate) {
    throw new Error(
      `没有支持 ${capability} 的 Provider，请先注册一个（见 src/providers/registry.ts）`
    );
  }
  return candidate;
}
