import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Next 16 起，dev server 默认只信任 "localhost" 作为来源。
  // 用 127.0.0.1 打开页面时，/_next/* 的 dev 资源会被判定为跨域并拦截，
  // 结果是客户端 bootstrap 中断 —— 页面看着正常（服务端渲染的 HTML 都在），
  // 但一个元素都没 hydrate，所有点击全部失效。显式放行常见回环地址：
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
