import {
  ProviderError,
  type GenerationOutput,
  type GenerationRequest,
  type ModelDescriptor,
  type ModelProvider,
} from "@/providers/types";
import {
  DryRunAbort,
  callDashScope,
  dryRunImageOutput,
  fileToDataUrl,
} from "./http";

/**
 * 千问图像 —— 同步接口。
 *
 * 和万相（异步）的区别不在参数上，在**时序**上：
 * 千问一次 HTTP 请求就把图生成完再返回，客户端要一直挂着连接等
 * 十几秒到一分钟。万相是先拿到 task_id 立刻返回，之后靠轮询。
 *
 * 这条路径的价值：它是最短的真模型链路。第一次接真模型应该从这里开始 ——
 * 没有轮询、没有任务状态机，出问题一定是参数或鉴权。
 */

interface QwenResponse {
  output?: {
    choices?: {
      finish_reason?: string;
      message?: {
        role?: string;
        content?: { text?: string; image?: string }[];
      };
    }[];
  };
  usage?: { image_count?: number; width?: number; height?: number };
  request_id?: string;
}

/** 比例 → 百炼要的 `宽*高`。没声明的一律回落到 1:1，绝不猜一个模型不支持的值 */
function sizeFor(desc: ModelDescriptor, aspectRatio: unknown): string {
  const resolutions = desc.options.resolutions ?? {};
  const wanted = String(aspectRatio ?? "");
  const hit =
    resolutions[wanted] ??
    // 比例没选或选了不支持的值时用第一个声明过的比例。
    // 不直接用 1024*1024：万一这个模型只接受特定几档，硬塞一个会被拒。
    resolutions[Object.keys(resolutions)[0] ?? ""] ?? { width: 1024, height: 1024 };
  return `${hit.width}*${hit.height}`;
}

export function createQwenImageProvider(desc: ModelDescriptor): ModelProvider {
  return {
    id: desc.id,
    label: desc.label,
    capabilities: ["image"],
    options: desc.options,

    async generate(req: GenerationRequest): Promise<GenerationOutput> {
      const { prompt, negativePrompt, params = {}, inputs = [], signal, onProgress } = req;

      if (!prompt?.trim()) {
        throw new ProviderError("提示词为空", { retryable: false });
      }

      /*
       * 上游图片塞进 content，和文字并列。
       *
       * 这一步是「素材 → 图片节点」能不能真的做图生图的分水岭。
       * 只发文字的话，界面上明明连了一张图，模型却完全看不见它 ——
       * 出来一张和参考图毫无关系的画，而且不报错。
       *
       * 只取第一张：千问这条接口的 content 是按语义顺序理解的，
       * 塞三四张图进去它会当成「多图参考」，行为和用户预期（以这张为底改）
       * 不是一回事。要多图参考是另一个模型的能力，不该在这里假装支持。
       */
      const content: Record<string, string>[] = [];
      const first = inputs.find((i) => i.kind === "image");
      if (first) {
        content.push({ image: await fileToDataUrl(first.filePath, first.mimeType) });
      }
      content.push({ text: prompt });

      const body = {
        model: desc.id,
        input: {
          // 当前只支持单轮、且只能有一个 text 元素，多传会报 InvalidParameter
          messages: [{ role: "user", content }],
        },
        parameters: {
          size: sizeFor(desc, params.aspectRatio),
          // 节点上只存一张产物，要 6 张也没有地方放
          n: 1,
          /*
           * 智能改写默认开着（官方默认）。
           *
           * 代价是「同一段提示词跑两次，模型可能改写出不同的版本」，
           * 复现性变差。但关掉它，用户写得粗糙的提示词出来就是一坨 ——
           * 对一个给普通人用的创作台，前者的问题远小于后者。
           * 真要复现时可以通过固定 seed 解决，不是靠关这个开关。
           */
          prompt_extend: true,
          // 水印默认关。创作台的产出是用户的，不该被加别人的标
          watermark: false,
          ...(negativePrompt?.trim()
            ? { negative_prompt: negativePrompt.trim() }
            : {}),
        },
      };

      // 同步接口没有中间进度可拿。发出去就是这个节点唯一的阶段，
      // 给 0.15 是为了让前端进度条立刻有反应 —— 否则用户点完运行
      // 会盯着一个不动的 0% 怀疑是不是没点上。
      onProgress?.(0.15);

      let data: QwenResponse;
      try {
        data = await callDashScope<QwenResponse>({
          path: "/services/aigc/multimodal-generation/generation",
          body,
          signal,
        });
      } catch (err) {
        if (err instanceof DryRunAbort) {
          onProgress?.(1);
          return dryRunImageOutput(err.call);
        }
        throw err;
      }

      const imageUrl = data.output?.choices
        ?.flatMap((c) => c.message?.content ?? [])
        .map((c) => c.image)
        .find(Boolean);

      if (!imageUrl) {
        throw new ProviderError(
          `模型没有返回图片（finish_reason=${data.output?.choices?.[0]?.finish_reason ?? "未知"}）`,
          // 拿到了响应但没有图，多半是被审核静默拦截或模型内部出错，
          // 重试同一段提示词没有意义
          { retryable: false }
        );
      }

      onProgress?.(1);

      return {
        kind: "image",
        mimeType: "image/png",
        ext: "png",
        /*
         * 只交地址，不在这里下载。
         *
         * 这个 URL 带 `?Expires=...`，24 小时后失效。落盘是 storage 层
         * 紧接着要做的事（executor → persistOutput），中间没有别的环节，
         * 所以不会出现「拿到地址忘了下」。
         * 反过来，如果为了省事把 URL 直接存进节点，第二天画布上全是裂图，
         * 而且 <img> 加载失败是静默的。
         */
        remoteUrl: imageUrl,
        meta: {
          provider: "dashscope",
          model: desc.id,
          requestId: data.request_id,
          size: body.parameters.size,
          usedInputs: inputs.length,
        },
      };
    },
  };
}
