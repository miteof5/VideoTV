import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { username } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { createHash } from "node:crypto";
import { db } from "./db";

/**
 * 认证的唯一实例。
 *
 * ### 为什么用 Better Auth 而不是自己写 cookie + session 表
 *
 * 认证的难点不在「校验密码」那一行，而在会话固定、CSRF、时序攻击、限流、
 * token 泄露这些「不跑到出问题就看不见」的地方。这些是 OWASP 明确要求用
 * 成熟库来解决的部分，自己写等于把风险集中到一个没有第二个人 review 的文件里。
 *
 * ### 为什么 session 存数据库，而不是 JWT
 *
 * cookie 里只有一个 token，真正的会话是 `session` 表里的一行。
 * 好处：登出、改密码、封号都能立刻生效（删行即可）；JWT 做不到——签发出去就收不回来。
 * 代价：每次请求要查一次库。单机 + SQLite 的量级下，这个代价可以忽略。
 *
 * 也因此：**真正的安全边界在数据访问层，不在 middleware**。
 * middleware 里查 cookie 只能做「乐观跳转」，它读不到库里那一行。
 */

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

/**
 * 用户名规则：3–20 个字符，允许中文、字母、数字、下划线。
 *
 * Better Auth 的默认校验只放行 `[A-Za-z0-9_.]`，中文会被直接拒掉。
 * 这是个中文产品，禁中文很怪，所以用自定义校验放行。
 * `\w` 已经包含字母数字下划线，再补一个中文区间即可。
 *
 * 长度按字符数算（一个汉字算 1），所以「张三丰」是合法的最短用户名。
 */
export const USERNAME_PATTERN = /^[\w\u4e00-\u9fa5]{3,20}$/;

/**
 * 由用户名派生一个**永远不会被投递**的占位邮箱。
 *
 * Better Auth 的 user 表要求 email 必填且唯一（它的身份模型本来是围绕邮箱建的），
 * 而我们的产品只认用户名。所以填一个占位值应付表结构。
 *
 * ### 为什么是哈希，不是 `${用户名}@local.invalid`
 *
 * 用户名允许中文，而中文不能直接出现在邮箱地址里 —— `张三@local.invalid` 不是合法邮箱。
 * 哈希之后是纯 ASCII，且天然唯一（用户名本来就唯一）。
 * 这也意味着**从 email 反查不出用户名**，多一层脱敏。
 *
 * ### 为什么用 `.invalid`
 *
 * RFC 2606 保留了这个顶级域，规定「永远不可解析、不可投递」。
 * 万一哪天我们接上了发信服务、而某段代码误把 user.email 当成真实收件地址，
 * 邮件也只会在 DNS 解析阶段失败，不会真的发到某个陌生人手里。
 */
export function placeholderEmail(username: string) {
  const normalized = username.trim().toLowerCase();
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 24);
  return `u${hash}@local.invalid`;
}

export const auth = betterAuth({
  database: prismaAdapter(db, {
    // 换成 postgresql 时只改这一个字符串（C-2 阶段的事）
    provider: "sqlite",
  }),

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL,

  /**
   * 允许携带 cookie 发起认证请求的来源白名单。
   *
   * 不配这个等于把跨站 POST 敞开 —— Better Auth 的文档里明确说
   * trustedOrigins 是 CSRF 防线的一部分，不是可选项。
   */
  trustedOrigins: [baseURL, "http://localhost:3000", "http://127.0.0.1:3000"],

  emailAndPassword: {
    enabled: true,
    // 用户名插件是包在「邮箱+密码」这条通道上的，所以它必须开着。
    // 但用户永远不会看到邮箱 —— 邮箱是服务端生成的占位地址，见 actions/auth.ts。
    minPasswordLength: 8,
    // 没有发信能力，所以不做邮箱验证（验证邮件根本发不出去）
    requireEmailVerification: false,
  },

  session: {
    // 30 天。刷新页面不会重置这个期限，只有超过 updateAge 才会续期。
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },

  /**
   * 不管请求从哪个入口进来，email 一律由用户名派生 —— 前端传什么都覆盖掉。
   *
   * 为什么需要这一层：`/api/auth/sign-up/email` 是公开端点，有人可以绕过我们的表单
   * 直接 POST 一个真实邮箱进去。email 在本站不参与任何逻辑，但让这列保持干净是零成本的，
   * 而且万一以后要「从 email 找用户」时，脏数据会立刻变成事故。
   */
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const name = (user as { username?: string }).username;
          if (!name) return;
          return { data: { ...user, email: placeholderEmail(name) } };
        },
      },
    },
  },

  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 20,
      usernameValidator: (value) => USERNAME_PATTERN.test(value),
    }),

    // 必须放在插件数组的最后。
    // 没有它，在 Server Action 里调用 auth.api.* 时 Set-Cookie 会被 Next 丢掉 ——
    // 表现是「注册/登录成功了，但下一个请求又变成未登录」，且不报任何错。
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
