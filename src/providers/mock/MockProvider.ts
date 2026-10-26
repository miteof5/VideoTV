import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import {
  ProviderError,
  type GenerationOutput,
  type GenerationRequest,
  type ModelDescriptor,
  type ModelOptions,
  type ModelProvider,
  type ProviderCapability,
} from "@/providers/types";
import { renderPlaceholderPng } from "@/providers/mock/png";

// Mock Provider：不联网、不花钱，但走的是和真模型**完全一样**的代码路径。
//
// 它的价值不在于"假数据能跑"，而在于：
//   1. 现在就能把 Provider → storage → Asset → 前端预览 整条链路打通，
//      接真模型时只需要在 registry 里换一行。
//   2. 它诚实地产出**真文件**：真 PNG、真 MP4。
//      如果 Mock 返回一张 base64 假图，落盘/编码/预览的坑就全都推迟到
//      接真模型那天才爆出来，那时候你分不清是模型的问题还是链路的问题。
//
// 所以视频这里真的调 ffmpeg 编码 H.264 —— 浏览器能直接播放，
// M6 的预览才不是纸上谈兵。

/** 可中断的 sleep。取消信号在长任务里必须能真正生效，否则既烧钱又占并发名额 */
function sleepAbortable(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError("已取消", { retryable: false }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError("已取消", { retryable: false }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 跑 ffmpeg，把 stderr 攒起来以便失败时给出可读的原因 */
function runFfmpeg(args: string[], signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg.path, args, { windowsHide: true });

    let stderr = "";
    child.stderr.on("data", (d) => {
      // 只留最后一段，ffmpeg 的 stderr 很长
      stderr = (stderr + d.toString()).slice(-2000);
    });

    const onAbort = () => {
      // Windows 上不支持 POSIX 信号语义，直接强杀进程树
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(
        new ProviderError(`无法启动 ffmpeg：${err.message}`, {
          retryable: false,
          cause: err,
        })
      );
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new ProviderError("已取消", { retryable: false }));
        return;
      }
      if (code === 0) resolve();
      else
        reject(
          new ProviderError(`ffmpeg 退出码 ${code}\n${stderr}`, {
            retryable: false,
          })
        );
    });
  });
}

export interface MockProviderOptions {
  id: string;
  label: string;
  capability: ProviderCapability;
  /** 模拟耗时，用来让"排队→运行→完成"的状态流转看得见 */
  latencyMs?: number;
  /** 它接受哪些参数取值。前端下拉框直接用它过滤 */
  options?: ModelOptions;
}

/** H.264 要求宽高都是偶数，差一个像素编码器就会失败 */
function even(n: number) {
  return n - (n % 2);
}

/**
 * 比例 → 像素。
 *
 * 以**长边**为基准，而不是固定宽度：9:16 时如果按宽度算，
 * 会得到 768×1365 这种又大又慢的竖图；按长边算就是 432×768，
 * 和 16:9 的 768×432 像素量相当，渲染耗时也一致。
 */
function dimsFor(ratio: string | undefined, longSide: number) {
  const m = /^(\d+):(\d+)$/.exec(ratio ?? "16:9");
  const a = Number(m?.[1] ?? 16) || 16;
  const b = Number(m?.[2] ?? 9) || 9;

  const width = a >= b ? longSide : Math.round((longSide * a) / b);
  const height = b >= a ? longSide : Math.round((longSide * b) / a);
  return { width: even(width), height: even(height) };
}

/**
 * 一个 Mock 实现，按能力装配。
 *
 * 为什么按能力拆成三个实例（mock.image.v1 / mock.video.v1 / mock.text.v1），
 * 而不是一个类里写三个分支：
 * 这样它和真实世界同构 —— 真实情况下出图的模型（SD）和出视频的模型（可灵）
 * 本来就是两家，registry 按 capability 选模型这件事现在就能被真实地跑一遍。
 */
export function createMockProvider({
  id,
  label,
  capability,
  latencyMs = 1500,
  options = {},
}: MockProviderOptions): ModelProvider {
  return {
    id,
    label,
    capabilities: [capability],
    options,

    async generate(req: GenerationRequest): Promise<GenerationOutput> {
      const { prompt, params = {}, onProgress, signal } = req;

      if (!prompt?.trim()) {
        throw new ProviderError("提示词为空", { retryable: false });
      }

      // 进度用定时器按时间推进，而不是"跑完直接给 1"。
      // 前端进度条、SSE 事件、Worker 心跳全都依赖中途回调 ——
      // 如果 Mock 只在结束时回调一次，这些链路等于没测到。
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const p = Math.min(0.9, ((Date.now() - startedAt) / latencyMs) * 0.9);
        onProgress?.(Number(p.toFixed(2)));
      }, 200);

      try {
        await sleepAbortable(latencyMs, signal);

        if (capability === "text") {
          onProgress?.(1);
          return {
            kind: "text",
            mimeType: "text/plain; charset=utf-8",
            ext: "txt",
            text: `【Mock 剧本】${prompt}\n\n（这一段由 MockProvider 生成，用于打通链路）`,
            meta: { provider: id, model: "mock-text" },
          };
        }

        if (capability === "image") {
          // 比例由用户在节点参数里选，Mock 真的按它出图 ——
          // 否则用户选 9:16 出来还是横的，那是"假按钮"。
          const { width, height } = dimsFor(
            params.aspectRatio as string | undefined,
            768
          );
          const buffer = renderPlaceholderPng({ width, height, seed: prompt });
          onProgress?.(1);
          return {
            kind: "image",
            mimeType: "image/png",
            ext: "png",
            buffer,
            meta: {
              provider: id,
              model: "mock-image",
              width,
              height,
              usedInputs: req.inputs?.length ?? 0,
            },
          };
        }

        // ---- 视频：逐帧渲染 → ffmpeg 编码成 H.264 MP4 ----
        //
        // 为什么要真的逐帧渲染，而不是拿 ffmpeg 的 testsrc 图案糊弄过去：
        //   1. 这条路径和真实的视频生成同构 —— 模型也是逐帧（或逐潜空间块）
        //      产出，再交给编码器封装。现在把「帧 → 编码 → 容器」的坑先踩完，
        //      接真模型时只需要把「渲染帧」换成「下载模型返回的帧/直接拿 mp4」。
        //   2. 产物和图像节点风格一致：同一个 prompt 的图和视频看起来是一套的。
        //   3. 一眼能看出它在动，M6 的预览才是真的验证过。
        const duration = Math.max(1, Math.min(10, Number(params.duration ?? 3)));
        const fps = Math.max(1, Math.min(30, Number(params.fps ?? 24)));
        const { width: w, height: h } = dimsFor(
          params.aspectRatio as string | undefined,
          640
        );

        const frames = Math.round(duration * fps);
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "videotv-mock-"));
        const outFile = path.join(tmpDir, "out.mp4");

        try {
          for (let i = 0; i < frames; i++) {
            const png = renderPlaceholderPng({
              width: w,
              height: h,
              seed: prompt,
              phase: i / frames,
            });
            await fs.writeFile(
              path.join(tmpDir, `f${String(i).padStart(4, "0")}.png`),
              png
            );
            // 渲染阶段占进度 0.9，剩下 0.1 留给编码
            onProgress?.(Number(((i + 1) / frames * 0.9).toFixed(2)));
          }

          await runFfmpeg(
            [
              "-y",
              "-hide_banner",
              "-loglevel", "error",
              "-framerate", String(fps),
              "-i", path.join(tmpDir, "f%04d.png"),
              "-c:v", "libx264",
              "-preset", "veryfast",
              "-crf", "23",
              // yuv420p 是关键：不加它浏览器可能不认这个 mp4
              "-pix_fmt", "yuv420p",
              // 偶数尺寸是 H.264 的硬要求
              "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
              // faststart 把索引挪到文件头，浏览器不必下完整个文件就能起播
              "-movflags", "+faststart",
              outFile,
            ],
            signal
          );

          const buffer = await fs.readFile(outFile);
          onProgress?.(1);

          return {
            kind: "video",
            mimeType: "video/mp4",
            ext: "mp4",
            buffer,
            meta: {
              provider: id,
              model: "mock-video",
              duration,
              fps,
              frames,
              size: `${w}x${h}`,
              usedInputs: req.inputs?.length ?? 0,
            },
          };
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
      } finally {
        clearInterval(timer);
      }
    },
  };
}

/**
 * 按 catalog 里的描述装配一个实现。
 *
 * 描述（对外暴露的能力）和实现（怎么真的生成）分居两个模块，
 * 但装配时从同一处读取，所以两边不会走偏 —— 不会出现
 * 「清单说支持 9:16，实现却不认」这种最难查的分裂。
 *
 * 这个函数是 registry 的 mock 分支唯一入口。早先这里还导出过
 * mockTextProvider / mockImageProvider 等四个具名常量，现在统一交给
 * 「描述 → 实例」这条路 —— 加一个演示模型只需要在 catalog 里加一条，
 * 不用再来这里补一行 export。
 */

/**
 * 各演示模型的模拟耗时。
 *
 * 故意不一样：如果全都一样，「并发执行时进度条分别推进」这件事就验不出来了，
 * 而且排队和运行两种状态在界面上看起来也分不清。
 */
const MOCK_LATENCY: Record<string, number> = {
  "mock.text.v1": 600,
  "mock.image.v1": 1200,
  "mock.image.fast": 400,
  "mock.video.v1": 1800,
};

export function createMockFromDescriptor(desc: ModelDescriptor): ModelProvider {
  const capability = desc.capabilities[0];
  if (!capability) {
    throw new Error(`演示模型 ${desc.id} 没有声明任何能力`);
  }
  return createMockProvider({
    id: desc.id,
    label: desc.label,
    capability,
    options: desc.options,
    latencyMs: MOCK_LATENCY[desc.id] ?? 1000,
  });
}
