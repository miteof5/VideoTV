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
  sleepAbortable,
} from "./http";

/**
 * 万相 —— 异步任务接口。
 *
 * 两步走：先建任务拿 task_id，再轮询结果。和千问的同步接口相比多出来的东西
 * 全在「任务可能一直不结束」这件事上：要能取消、要有自己的超时上限、
 * 进度只能估不能测。
 *
 * ### 为什么这条路径比它看起来重要
 *
 * 几乎所有的**视频**模型都是这个形状（可灵、即梦、Seedance 都是异步任务）。
 * 现在用万相把「建任务 → 轮询 → 取产物 → 取消」这条腿走通，
 * 将来接视频模型就只是换端点，不需要重新设计时序。
 * 要是跳过它直接写视频，第一次会在轮询和取消上同时翻车。
 */

/** 轮询间隔。官方建议 3~5 秒，取 3 秒 —— 免费额度按张计费，多轮几次不额外花钱 */
const POLL_MS = 3_000;

/**
 * 自己给自己设的等待上限。
 *
 * executor 那边有 5 分钟的总超时，但那个超时抛出来会被当成「用户取消」，
 * 日志里写「已取消」，真相是「等太久了」。这里提前 1 分钟收手，
 * 报出来的原因是准确的：「任务超时未完成」。
 */
const MAX_WAIT_MS = 4 * 60_000;

interface CreateResponse {
  output?: { task_id?: string; task_status?: string };
  request_id?: string;
}

interface TaskResponse {
  output?: {
    task_id?: string;
    task_status?: string;
    results?: { url?: string; code?: string; message?: string }[];
    code?: string;
    message?: string;
  };
  usage?: { image_count?: number };
  request_id?: string;
}

function sizeFor(desc: ModelDescriptor, aspectRatio: unknown): string {
  const resolutions = desc.options.resolutions ?? {};
  const wanted = String(aspectRatio ?? "");
  const hit =
    resolutions[wanted] ??
    resolutions[Object.keys(resolutions)[0] ?? ""] ?? { width: 1024, height: 1024 };
  return `${hit.width}*${hit.height}`;
}

export function createWanImageProvider(desc: ModelDescriptor): ModelProvider {
  return {
    id: desc.id,
    label: desc.label,
    capabilities: ["image"],
    options: desc.options,

    async generate(req: GenerationRequest): Promise<GenerationOutput> {
      const { prompt, negativePrompt, params = {}, signal, onProgress } = req;

      if (!prompt?.trim()) {
        throw new ProviderError("提示词为空", { retryable: false });
      }

      const body = {
        model: desc.id,
        input: {
          prompt: prompt.trim(),
          ...(negativePrompt?.trim()
            ? { negative_prompt: negativePrompt.trim() }
            : {}),
        },
        parameters: { size: sizeFor(desc, params.aspectRatio), n: 1 },
      };

      // ---- 第一步：建任务 ----
      let taskId: string;
      try {
        const created = await callDashScope<CreateResponse>({
          path: "/services/aigc/text2image/image-synthesis",
          body,
          // 少了这个头，服务端会走同步分支并报
          // "current user api does not support synchronous calls"
          async: true,
          signal,
        });
        taskId = created.output?.task_id ?? "";
        if (!taskId) {
          throw new ProviderError("百炼没有返回 task_id", { retryable: true });
        }
      } catch (err) {
        if (err instanceof DryRunAbort) {
          onProgress?.(1);
          return dryRunImageOutput(err.call);
        }
        throw err;
      }

      // ---- 第二步：轮询 ----
      //
      // 建任务本身很快（几百毫秒），真正的等待全在这里。
      // 进度只能「估」：任务没有百分比可以读，只能按轮询次数往上爬，
      // 且必须留出 0.9 以上的空间给最后的下载和落盘 ——
      // 进度条冲到 100% 之后还卡十几秒，比慢慢走更让人怀疑卡死了。
      const startedAt = Date.now();
      let attempt = 0;

      while (true) {
        if (Date.now() - startedAt > MAX_WAIT_MS) {
          throw new ProviderError(
            `任务等待超时（超过 ${Math.round(MAX_WAIT_MS / 60_000)} 分钟仍未完成）`,
            { retryable: false }
          );
        }

        await sleepAbortable(POLL_MS, signal);
        attempt++;

        const st = await callDashScope<TaskResponse>({
          method: "GET",
          path: `/tasks/${encodeURIComponent(taskId)}`,
          signal,
        });

        const status = st.output?.task_status;

        if (status === "SUCCEEDED") {
          const url = st.output?.results?.find((r) => r.url)?.url;
          if (!url) {
            throw new ProviderError("任务成功但没有返回图片地址", {
              retryable: false,
            });
          }
          onProgress?.(1);
          return {
            kind: "image",
            mimeType: "image/png",
            ext: "png",
            remoteUrl: url,
            meta: {
              provider: "dashscope",
              model: desc.id,
              taskId,
              requestId: st.request_id,
              polls: attempt,
              elapsedMs: Date.now() - startedAt,
              size: body.parameters.size,
            },
          };
        }

        if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
          const reason =
            st.output?.results?.[0]?.message ??
            st.output?.message ??
            st.output?.code ??
            status;
          throw new ProviderError(`任务失败：${reason}`, {
            // CANCELED 是用户或平台主动取消，重试会重复扣费；其余看审核情况
            retryable: status === "UNKNOWN",
          });
        }

        // PENDING / RUNNING —— 还要等
        onProgress?.(Math.min(0.85, 0.15 + attempt * 0.04));
      }
    },
  };
}
