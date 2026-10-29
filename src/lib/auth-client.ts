import { createAuthClient } from "better-auth/react";
import { usernameClient } from "better-auth/client/plugins";

/**
 * 浏览器端用的认证客户端。
 *
 * 不传 baseURL：默认就是当前页面的 origin。写死成 localhost 的话，
 * 换端口、换局域网地址、上生产都会失效，而且失效方式是「cookie 存下来了但下一个请求不带」——
 * 表现成「登录成功了，一刷新又退出来」，很难查。
 *
 * usernameClient 是 username 插件的客户端对应物：没有它，authClient 上不会有
 * signIn.username 这类方法。服务端插件和客户端插件必须成对，漏一个就少一半 API。
 */
export const authClient = createAuthClient({
  plugins: [usernameClient()],
});
