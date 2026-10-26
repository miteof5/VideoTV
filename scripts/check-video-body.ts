// 视频模型（wan3.0-video）的**请求体拼装**检查 —— 一次真实调用都不发。
//
// 为什么需要它：视频按秒计费，30 秒额度一次试错就没了三分之一。
// 而最容易错的恰好不是「模型会不会处理」，是我们发出去的参数：
//   - 模型名写错版本号        → model_not_found
//   - 图生视频的字段还是老的 img_url（wan3.0 是 input.media[]）→ 接口不报错但图被忽略
//   - 接了首帧却没把 ratio 换成 adaptive → 出来的画幅和首帧不一致
//   - duration 传成字符串 / 超范围     → 校验失败
//
// 这些都能在**请求发出去之前**看清楚的：`PROVIDER_DRY_RUN=1` 时
// callDashScope 在 POST 前抛 DryRunAbort，wanVideo 把它转成一个带参数的
// ProviderError，请求体挂在 `cause.call.body` 上。
//
// 跑法：npx tsx scripts/check-video-body.ts
// 退出码 1 表示拼错了。它不联网、不花钱，可以随便跑。
import { ProviderError } from "@/providers/types";
import { createWanVideoProvider } from "@/providers/dashscope/wanVideo";
import { getModelDescriptor } from "@/providers/catalog";
import { DryRunAbort } from "@/providers/dashscope/http";

// 首帧素材：随便一张仓库里的真 png，只要读得出来就行（它进的是 data URL）
const PNG = "storage/assets/2026/10/04ab1e74-5f33-4ce2-8d28-029860e5b629.png";

let bad = 0;
const ck = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "OK  " : "FAIL"}  ${name}${ok ? "" : `  ← ${JSON.stringify(detail)}`}`);
  if (!ok) bad++;
};

async function main() {
  const desc = getModelDescriptor("wan3.0-video");
  if (!desc) {
    console.error("catalog 里没有 wan3.0-video");
    process.exit(1);
  }

  // 必须是「已配置」状态，否则 provider 会在读 key 时先抛未配置
  process.env.DASHSCOPE_API_KEY =
    process.env.DASHSCOPE_API_KEY || "sk-dry-run-placeholder";
  process.env.PROVIDER_DRY_RUN = "1";

  const provider = createWanVideoProvider(desc);

  /** 跑一次 dry run，把「本来要发出去的请求」捞出来 */
  async function dryRun(
    params: Record<string, unknown>,
    inputs?: { filePath: string; mimeType: string }[]
  ) {
    try {
      await provider.generate({
        prompt: "镜头缓慢推进，雨丝清晰可见",
        params,
        inputs: inputs?.map((i) => ({
          kind: "image" as const,
          mimeType: i.mimeType,
          filePath: i.filePath,
        })),
      });
    } catch (err) {
      if (err instanceof ProviderError && err.cause instanceof DryRunAbort) {
        return {
          body: err.cause.call.body as Record<string, any>,
          url: err.cause.call.url,
          message: err.message,
        };
      }
      throw err;
    }
    throw new Error("dry run 居然没抛错 —— PROVIDER_DRY_RUN 没生效？");
  }

  // ---- 一、文生视频：不接图 ----
  const text = await dryRun({ duration: "5", aspectRatio: "9:16" });
  console.log("\n[文生视频] 请求体：");
  console.log(JSON.stringify(text.body, null, 1));
  console.log();

  ck("模型名是 wan3.0-video", text.body.model === "wan3.0-video", text.body.model);
  ck(
    "打到原生异步端点（不是 compatible，也不是图像那个 text2image）",
    text.url ===
      "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    text.url
  );
  ck(
    "duration 是数字 5（不是字符串）",
    text.body.parameters?.duration === 5,
    text.body.parameters?.duration
  );
  ck("没接图时不传 media", text.body.input?.media === undefined, text.body.input);
  ck(
    "没接图时用用户选的比例 9:16",
    text.body.parameters?.ratio === "9:16",
    text.body.parameters?.ratio
  );
  ck(
    "分辨率 720P（省钱档）",
    text.body.parameters?.resolution === "720P",
    text.body.parameters?.resolution
  );
  ck(
    "关掉 prompt_extend（我们自己的提示词已经优化过）",
    text.body.parameters?.prompt_extend === false,
    text.body.parameters?.prompt_extend
  );
  ck(
    "没有 negative_prompt（这个仓库已无 UI 入口）",
    !("negative_prompt" in (text.body.input ?? {})),
    text.body.input
  );

  // ---- 二、图生视频：接一张首帧 ----
  const img = await dryRun({ duration: "3", aspectRatio: "9:16" }, [
    { filePath: PNG, mimeType: "image/png" },
  ]);
  const media = img.body.input?.media;
  console.log("\n[图生视频] 请求体（media 里的 data URL 太长，截断显示）：");
  console.log(
    JSON.stringify(
      {
        ...img.body,
        input: {
          ...img.body.input,
          media: media?.map((m: any) => ({
            type: m.type,
            url: `${String(m.url).slice(0, 40)}…（共 ${String(m.url).length} 字符）`,
          })),
        },
      },
      null,
      1
    )
  );
  console.log();

  ck("接了图 → media 是数组且 1 项", Array.isArray(media) && media.length === 1, media?.length);
  ck(
    "media[0].type 是 first_frame（wan3.0 的字段名）",
    media?.[0]?.type === "first_frame",
    media?.[0]?.type
  );
  ck(
    "media[0].url 是 base64 data URL（本地文件没有公网地址）",
    /^data:image\/png;base64,/.test(media?.[0]?.url ?? ""),
    String(media?.[0]?.url).slice(0, 30)
  );
  ck(
    "接了图 → 比例强制 adaptive（跟随首帧，忽略用户选的 9:16）",
    img.body.parameters?.ratio === "adaptive",
    img.body.parameters?.ratio
  );
  ck(
    "接了图 → duration 仍是用户选的 3",
    img.body.parameters?.duration === 3,
    img.body.parameters?.duration
  );

  console.log(`\n${bad === 0 ? "全部通过" : `${bad} 项不符`}`);
  process.exit(bad ? 1 : 0);
}

main();
