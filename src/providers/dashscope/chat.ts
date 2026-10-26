import {
  ProviderError,
  type GenerationOutput,
  type GenerationRequest,
  type ModelDescriptor,
  type ModelProvider,
} from "@/providers/types";
import { DryRunAbort, callDashScope } from "./http";

/**
 * 百炼 · 文本生成（OpenAI 兼容模式）。
 *
 * ### 为什么不是原生端点（2026-10-25 实测，不是选型偏好）
 *
 * 第一版按图像那条路写，打的是 `/api/v1/services/aigc/text-generation/generation`，
 * 结果四个文本模型全部被拒：
 *
 * ```
 * {"code":"InvalidParameter","message":"url error, please check url！"}
 * ```
 *
 * 换成 `/compatible-mode/v1/chat/completions` 之后四个全部正常返回。
 * 也就是说：**图像和文本在百炼上是两套接入方式**，不是同一套的两种用法。
 * 逐个 curl 验证过，样本是这四个：qwen3.8-max / qwen3.8-flash / kimi-k3 /
 * deepseek-v4.1-flash-1017。
 *
 * 详见 http.ts 里的 `compatibleBaseUrl` 与 `DEFAULT_COMPATIBLE_BASE`。
 *
 * ### 为什么仍然复用 callDashScope 而不是直接用 fetch
 *
 * 鉴权、脱敏、错误分类（限流可重试 / 审核不可重试 / 额度不足）、
 * 取消信号、dry run —— 这些和图像共用一套。自己写 fetch 等于把
 * 「429 该不该重试」这种判断复制一份，两份迟早不一致。
 */

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: {
    finish_reason?: string;
    message?: {
      role?: string;
      /**
       * OpenAI 标准是字符串。但**推理模型可能返回 null**：
       * token 预算全花在 reasoning 上时 content 就是空的。
       * 实测 kimi-k3 在 max_tokens 很小时就是这个状态。
       */
      content?: string | null;
      /** 推理模型的思考过程（qwen3.8 / kimi-k3 都有） */
      reasoning_content?: string;
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** 其中有多少花在思考上 —— 排查「为什么这次特别慢/贵」时有用 */
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export function createDashScopeChatProvider(
  desc: ModelDescriptor
): ModelProvider {
  return {
    id: desc.id,
    label: desc.label,
    capabilities: ["text"],
    options: desc.options,

    async generate(req: GenerationRequest): Promise<GenerationOutput> {
      const { prompt, system, signal, onProgress } = req;

      /*
       * 空提示词直接拒。
       *
       * 不交给模型去处理：有些模型会回一句「你想让我做什么？」，
       * 那句话会被当成优化结果**写回卡片**，用户看到自己的卡片
       * 莫名其妙变成一句反问。在入口挡掉，比让它生成垃圾再解释便宜得多。
       */
      if (!prompt?.trim()) {
        throw new ProviderError("提示词为空", { retryable: false });
      }

      const messages: { role: "system" | "user"; content: string }[] = [];
      // system 有值才发。空串会被某些模型当成一条空指令，行为不确定
      if (system?.trim()) {
        messages.push({ role: "system", content: system.trim() });
      }
      messages.push({ role: "user", content: prompt.trim() });

      /*
       * 不设 temperature / top_p / max_tokens。
       *
       * 每个模型自己的默认值不一样（kimi 和 deepseek 差得远），
       * 统一写死一个数反而会破坏它调好的默认。而 max_tokens 尤其危险：
       * 这批里有三个是推理模型，思考也要花 token —— 卡一个上限会让
       * content 变成空字符串（不是报错，是静默返回空），
       * 而这个空值会被 executor 判成「模型没有返回文本」。
       */
      const body = {
        model: desc.id,
        messages,
        // 明确不要流式：我们这一层是"一次拿完整结果"，流式解析是另一套代码
        stream: false,
      };

      // 文本生成通常几秒，但仍然给个进度，让前端知道"发出去了"
      onProgress?.(0.3);

      let data: ChatResponse;
      try {
        data = await callDashScope<ChatResponse>({
          base: "compatible",
          path: "/chat/completions",
          body,
          signal,
        });
      } catch (err) {
        if (err instanceof DryRunAbort) {
          /*
           * dry run：不真调，但要产出一段**看起来像结果**的文本。
           *
           * 为什么不抛错：dry run 的目的是验证
           * 「点发送 → 有文字 → 写回卡片 → 刷新还在」这条链路。
           * 抛错只走到一半，后面的环节全验不到。
           * 前缀写明 DRY_RUN，免得有人以为真模型回得这么快。
           */
          onProgress?.(1);
          return {
            kind: "text",
            mimeType: "text/plain; charset=utf-8",
            ext: "txt",
            text: `【DRY_RUN】未真实调用 ${desc.id}。messages=${JSON.stringify(messages.map((m) => m.role))}`,
            meta: { dryRun: true, dryRunCall: err.call },
          };
        }
        throw err;
      }

      const choice = data.choices?.[0];
      const text = (choice?.message?.content ?? "").trim();

      if (!text) {
        /*
         * 没文本的三种情形，报错必须能区分，否则用户只能重复点同一个按钮：
         *
         *   content_filter —— 被内容审核拦（换说法，不要重试）
         *   length         —— 输出被截断
         *   只有 reasoning —— 推理模型把预算全花在思考上（这个最迷惑：
         *                     API 返回 200，看起来成功了，但我们拿到的正文是空的
         *                     —— 唯一的线索是 reasoning_content 有内容）
         */
        const reason = choice?.finish_reason ?? "未知";
        const hasReasoning = Boolean(choice?.message?.reasoning_content?.trim());
        const hint =
          reason === "content_filter"
            ? "内容被审核拦截，换一种说法再试"
            : hasReasoning
              ? "模型只输出了思考过程（reasoning），正文为空 —— 多半是 token 预算被思考耗尽，重试一次通常就好"
              : "";
        throw new ProviderError(
          `模型没有返回文本（finish_reason=${reason}）${hint ? `：${hint}` : ""}`,
          // 只有"只输出了思考"这一种值得重试：同样的输入再跑一次，
          // 思考长度不一定一样，经常第二次就有正文了。
          { retryable: hasReasoning && reason !== "content_filter" }
        );
      }

      onProgress?.(1);

      return {
        kind: "text",
        mimeType: "text/plain; charset=utf-8",
        ext: "txt",
        text,
        meta: {
          provider: "dashscope",
          model: desc.id,
          requestId: data.id,
          finishReason: choice?.finish_reason,
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
          reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
          usedSystem: Boolean(system?.trim()),
        },
      };
    },
  };
}
