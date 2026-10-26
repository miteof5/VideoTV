import {
  ProviderError,
  type GenerationOutput,
  type GenerationRequest,
  type ModelDescriptor,
  type ModelProvider,
  type ProviderInput,
} from "@/providers/types";
import {
  DryRunAbort,
  callDashScope,
  fileToDataUrl,
  sleepAbortable,
} from "./http";

/**
 * 万相 3.0 视频（`wan3.0-video`）—— 异步任务接口。
 *
 * 形态和 `wanImage` 同构（建任务 → 轮询 → 取产物），但**不是同一套参数**，
 * 所以是独立实现而不是往 wanImage 里塞分支。三处差异都来自实测/官方文档：
 *
 * 1. **输入用 `media` 数组，不是 `img_url`**（wan2.x 是 `img_url`）。
 *    数组元素是 `{ type, url }`，`type` 决定这张图是首帧还是尾帧还是参考图。
 *    探测时百炼的报错原文是 `prompt and media cannot both be empty` —— 这句话
 *    同时说明了「prompt 和 media 至少给一个」和「字段名就叫 media」。
 * 2. **比例走 `ratio`，而且支持 `adaptive`**（跟随首帧宽高比）。
 * 3. **`duration` 是 2~30 秒**（wan2.7 是 2~15），最长 30 秒是它最大的差异点。
 *
 * ### 为什么比例在「接了图」时会变成 adaptive
 *
 * 官方文档对图生视频的建议原文是「ratio 建议设为 adaptive，模型自动匹配首帧
 * 宽高比」。用户接了一张 16:9 的图却在下面选了 9:16，硬传 9:16 会让首帧被
 * 裁切或补边 —— 出来的视频和他看到的那张图不是同一个画幅。
 * 所以接了首帧就把比例交给模型，没接图（文生视频）才用用户选的那个。
 * 这是**产品决定**，不是模型限制；想改回严格遵循用户选择，删掉 hasFrame 那个分支即可。
 */

/**
 * 轮询间隔。
 *
 * 官方建议 15 秒（RPS 上限 20），但那是给「提交完就走、有回调」的架构用的。
 * 我们这里是同步等结果的 Worker：15 秒轮询意味着用户盯着进度条 15 秒不动，
 * 会被当成卡死。5 秒一次既不会触发限流，进度的颗粒度也够。
 */
const POLL_MS = 5_000;

/**
 * 分辨率档位。
 *
 * 480P / 720P / 1080P 三档的单价大概是 1 : 2 : 4（按秒计费，差得比图像狠）。
 * 取 720P 的理由和图像那边选 1K 一样：画布上的卡片只有几百像素宽，
 * 1080P 看不出来，纯粹多花钱。
 *
 * 想换档改这一个常量即可 —— 它没有做成用户可选项，因为「多一个下拉」的代价
 * 比「多花一倍的钱」更值得省。真要暴露给用户，在 catalog 那条的 options 上
 * 加字段，别在这里加环境变量。
 */
const RESOLUTION = "720P";

/** 一个 `input.media` 元素。目前只会用到前两种 */
interface MediaRef {
  type: "first_frame" | "last_frame";
  url: string;
}

interface CreateResponse {
  output?: { task_id?: string; task_status?: string };
  request_id?: string;
}

interface TaskResponse {
  output?: {
    task_id?: string;
    task_status?: string;
    /**
     * 视频地址在 `output.video_url`，**不是** `output.results[].url`。
     *
     * 图像那套是 results 数组（一次可能出几张），视频固定一个。
     * 照抄图像那段 `results?.find(r => r.url)` 会永远拿不到地址，
     * 表现是「任务成功但没有返回视频地址」。
     */
    video_url?: string;
    code?: string;
    message?: string;
    orig_prompt?: string;
    submit_time?: string;
    end_time?: string;
  };
  usage?: {
    /** 计费时长（秒）——30 秒额度按它扣 */
    output_video_duration?: number;
    ratio?: string;
    SR?: number;
    video_count?: number;
  };
  request_id?: string;
}

/**
 * 自己给自己设的等待上限。
 *
 * 视频的生成耗时大致和时长成正比：3~5 秒的片子一到两分钟，30 秒的片子
 * 要五到十分钟。写死一个固定值必然两头不对 ——
 * 短片的等待上限太松（卡死了也看不出来），长片的太紧（还在跑就报超时，
 * 而「执行超时」在 Worker 里算可重试，会**再排一次、再扣一次额度**）。
 *
 * executor 那边对 video 能力的上限比这里更宽松（见 `engine/executor.ts`
 * 的 `timeoutFor`），所以正常情况下先在这里收手，报出来的原因是准确的
 * 「任务等待超时」而不是「已取消」。
 */
function maxWaitMs(durationSec: number) {
  return Math.max(6 * 60_000, durationSec * 30_000);
}

/**
 * 上游产物 → `input.media`。
 *
 * 百炼的 HTTP 接口只认**公网 URL 或 base64 data URL**，`file://` 是
 * Python/Java SDK 自己读文件转的，HTTP 层没有。我们的上游产物全在本地
 * 磁盘上，所以只能转 base64。
 *
 * 这条路上有个未验证的假设：`media[].url` 是否和图像的 `img_url` 一样接受
 * data URL。文档所有示例给的都是公网地址。如果真跑报 URL 无效，
 * 说明这条路要换成「先传 OSS 换临时 URL」，届时改这一个函数即可 ——
 * 其余部分（任务、轮询、取产物）不用动。
 */
async function toMedia(inputs: ProviderInput[] | undefined): Promise<MediaRef[]> {
  const out: MediaRef[] = [];
  for (const input of inputs ?? []) {
    // 视频节点只 accept text / image（见 nodeRegistry 的 accepts），
    // 走到这里的非图片说明上游声明和实际不一致，直接跳过比传上去被拒更好 ——
    // 传上去的话报错在几十秒后才回来，而且看不出是哪条输入的问题。
    if (input.kind !== "image") continue;
    out.push({
      // 目前没有声明具名端口，role 恒为空 → 一律当首帧。
      // 将来在 nodeRegistry 里加 last_frame 端口后，这里按 role 分流。
      type: input.role === "endImage" ? "last_frame" : "first_frame",
      url: await fileToDataUrl(input.filePath, input.mimeType),
    });
  }
  return out;
}

export function createWanVideoProvider(desc: ModelDescriptor): ModelProvider {
  return {
    id: desc.id,
    label: desc.label,
    capabilities: ["video"],
    options: desc.options,

    async generate(req: GenerationRequest): Promise<GenerationOutput> {
      const { prompt, params = {}, signal, onProgress } = req;

      if (!prompt?.trim()) {
        throw new ProviderError("提示词为空", { retryable: false });
      }

      const duration = Math.round(Number(params.duration) || 5);
      const media = await toMedia(req.inputs);
      const hasFrame = media.length > 0;

      /*
       * 接了首帧就用 adaptive（理由见文件头），否则用用户选的比例。
       *
       * `ratio` 缺省是 "adaptive" 而不是 "16:9"：用户什么都没选时，
       * 让模型自己决定比我们替他猜一个更不会错。
       */
      const ratio = hasFrame
        ? "adaptive"
        : String(params.aspectRatio ?? "").trim() || "adaptive";

      const body = {
        model: desc.id,
        input: {
          prompt: prompt.trim(),
          // 空数组和「不传」在百炼那边有区别：传 [] 会被当成「给了 media 但没内容」。
          ...(hasFrame ? { media } : {}),
        },
        parameters: {
          resolution: RESOLUTION,
          ratio,
          duration,
          /*
           * 关掉智能改写。
           *
           * 它会先把提示词扩写一遍再生成，短提示词效果提升明显，但它和我们的
           * 「文本节点先把口语改写成专业提示词」是同一件事，叠加等于改写两次 ——
           * 多花时间，还会把我们精心调过的提示词改跑。
           * 如果哪天发现短句直出的效果确实差，把它改成 true 再对比。
           */
          prompt_extend: false,
        },
      };

      // ---- 第一步：建任务 ----
      let taskId: string;
      try {
        const created = await callDashScope<CreateResponse>({
          path: "/services/aigc/video-generation/video-synthesis",
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
        /*
         * dry run 收场方式与图像不同：**抛错**，不产出占位视频。
         *
         * 图像那边能渲染一张占位 PNG（纯 canvas，几毫秒）；视频要产出可预览的
         * mp4 就得引 ffmpeg 逐帧渲染编码 —— 那会把「视频为什么没真跑」这件事
         * 藏进一段几十行的生成代码里，而 dry run 的全部价值只是「看一眼请求体」。
         * 所以这里把拼好的参数放进错误信息，用户在节点底部就能读到。
         */
        if (err instanceof DryRunAbort) {
          throw new ProviderError(
            `DRY_RUN：视频请求已组装但未发出（${desc.id} / ${duration} 秒 / ${ratio} / ${RESOLUTION}${
              hasFrame ? ` / 首帧 ${media.length} 张` : " / 纯文本"
            }）`,
            { retryable: false, cause: err }
          );
        }
        throw err;
      }

      // ---- 第二步：轮询 ----
      //
      // 进度只能「估」：任务没有百分比可读。视频的耗时和时长强相关，
      // 所以按「已用时间 / 预估总时长」推，比按轮询次数推更接近真实体感 ——
      // 后者在 30 秒视频上会在 0.5 停住三分钟，比不动更让人怀疑。
      const startedAt = Date.now();
      const estTotalMs = 20_000 + duration * 15_000;
      const limit = maxWaitMs(duration);
      let attempt = 0;

      while (true) {
        const elapsed = Date.now() - startedAt;
        if (elapsed > limit) {
          throw new ProviderError(
            `任务等待超时（${Math.round(limit / 60_000)} 分钟内没跑完，任务号 ${taskId}）`,
            // 不可重试：任务可能还在平台那边接着跑，重排一次就是再扣一次额度
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
          const url = st.output?.video_url;
          if (!url) {
            throw new ProviderError("任务成功但没有返回视频地址", {
              retryable: false,
            });
          }
          onProgress?.(1);
          return {
            kind: "video",
            mimeType: "video/mp4",
            ext: "mp4",
            /*
             * 只交 remoteUrl，不在这里下载。
             *
             * 百炼的产物链接 **24 小时就过期**，所以必须当场归档 —— 但那件事
             * 由 `lib/assetService` 的 `persistOutput` 做（它拿到 remoteUrl 就
             * 立刻 downloadToStorage）。Provider 不碰磁盘，这条边界不能破。
             */
            remoteUrl: url,
            meta: {
              provider: "dashscope",
              model: desc.id,
              taskId,
              requestId: st.request_id,
              duration,
              ratio,
              // 实际用的比例。接了图时这是 adaptive，和用户选的可能不同 ——
              // 排查「怎么出来的画幅不对」时，这个字段是唯一线索。
              ratioSource: hasFrame ? "adaptive（跟随首帧）" : "用户选择",
              resolution: RESOLUTION,
              polls: attempt,
              elapsedMs: Date.now() - startedAt,
              // 计费口径：30 秒额度按它扣
              billedSeconds: st.usage?.output_video_duration,
              outputSR: st.usage?.SR,
            },
          };
        }

        if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
          const reason =
            st.output?.message ?? st.output?.code ?? status;
          throw new ProviderError(`任务失败：${reason}`, {
            // CANCELED 是用户或平台主动取消，重试会重复扣费；UNKNOWN 是任务过期
            retryable: false,
          });
        }

        // PENDING / RUNNING —— 还要等
        onProgress?.(Math.min(0.9, 0.08 + (elapsed / estTotalMs) * 0.82));
      }
    },
  };
}
