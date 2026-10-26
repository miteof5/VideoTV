import { NextResponse } from "next/server";
// 只 import catalog，不要 import registry —— 后者会顺着 MockProvider 和
// DashScope 实现把 @ffmpeg-installer/ffmpeg 拖进打包，
// 而那个包用运行时的动态 require 去找平台二进制，打包器解析不了，
// 整条路由直接 500。
import { availableModels } from "@/providers/catalog";

// 模型清单。前端「选择模型」「选择比例」两个下拉框的数据来源。
//
// 为什么不让前端写死一份：千问支持五种比例，万相只支持三种，
// 另一家可能只支持 16:9。写死的后果是用户选了个不支持的组合，
// 点运行，等一分钟后收到 400。由 Provider 声明、这里吐出来，
// 下拉框就只会出现合法值。
//
// 这份清单还承担一件事：**没配好凭证的模型根本不会出现**。
// availableModels 会按 requiresEnv 过滤，所以用户看不到自己用不了的东西 ——
// 「选得到但点了报错」和「根本选不到」相比，后者才是干净的。
export async function GET() {
  return NextResponse.json(
    { models: availableModels(undefined, process.env) },
    {
      // 清单跟着 .env 变，不能让浏览器缓存住 ——
      // 否则配好 key 重启后，前端还拿着一份只有演示模型的旧清单
      headers: { "Cache-Control": "no-store" },
    }
  );
}
