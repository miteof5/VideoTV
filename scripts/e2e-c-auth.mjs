// C 阶段 · 真浏览器验收（注册 / 登录 / 登出 / 持久化 / 错误提示）
//
// 前置：dev 跑在 3000（`npm run dev`）
//   node scripts/e2e-c-auth.mjs
//
// 会自建一个一次性用户（名字带时间戳），跑完由 scripts/_cleanup-auth-e2e.ts 清掉。
// 不碰 Project / Node / Asset。

import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://127.0.0.1:3000";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function ck(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}` + (detail === undefined ? "" : `  → ${detail}`));
  if (!ok) failed++;
}

const stamp = Date.now().toString().slice(-8);
const USER = `e2e${stamp}`;
const PASS = "e2e-pass-1234";

/** 读页面上的可见文字，用来断言错误提示 */
async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function fillAndSubmit(page, fields) {
  // 等表单真的可交互：Next 的客户端组件要 hydrate 完，onSubmit 才会挂上。
  // 不等就点，表现是「点了没反应」，而且不报任何错。
  await page.waitForSelector('form input[name="username"]', { timeout: 15000 });
  await sleep(400);

  for (const [name, value] of Object.entries(fields)) {
    const sel = `input[name="${name}"]`;
    await page.click(sel, { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type(sel, value, { delay: 15 });
  }

  await page.click('button[type="submit"]');
}

/** 点页面上的「退出」。按钮在 header 里，用文字找比记 class 稳 */
async function signOut(page) {
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "退出"
    );
    btn?.click();
  });
  return waitPath(page, "/sign-in");
}

/** 等到 URL 变成目标路径（Server Action 的 redirect 不是传统导航，不能用 waitForNavigation） */
async function waitPath(page, path, timeout = 15000) {
  try {
    await page.waitForFunction(
      (p) => window.location.pathname === p,
      { timeout },
      path
    );
    return true;
  } catch {
    return false;
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(String(e)));

try {
  // ── 1. 未登录访问首页 → 被送到登录页 ────────────────────────────────
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  ck("未登录访问 / 会被送到 /sign-in", await waitPath(page, "/sign-in"), page.url());

  // ── 2. 从登录页点进注册页 ─────────────────────────────────────────
  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle2" });
  await page.waitForSelector('a[href="/sign-up"]', { timeout: 10000 });
  await sleep(300);
  await page.click('a[href="/sign-up"]');
  ck("登录页能进注册页", await waitPath(page, "/sign-up"));

  // ── 3. 注册 ───────────────────────────────────────────────────────
  await fillAndSubmit(page, {
    username: USER,
    password: PASS,
    confirmPassword: PASS,
  });
  ck("注册成功后进入首页", await waitPath(page, "/", 20000), page.url());

  await page.waitForFunction(
    (u) => document.body.innerText.includes(u),
    { timeout: 10000 },
    USER
  );
  ck("首页顶部显示当前用户名", (await bodyText(page)).includes(USER));

  // ── 4. 刷新后仍然是登录状态（session 在库里，不是内存里）───────────
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(600);
  ck("刷新后仍在首页（没有退回登录页）", page.url().endsWith("/"), page.url());
  ck("刷新后用户名还在", (await bodyText(page)).includes(USER));

  // ── 5. 退出 ───────────────────────────────────────────────────────
  ck("点退出回到登录页", await signOut(page), page.url());

  // ── 6. 退出后直接访问首页 → 又被挡住 ──────────────────────────────
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  ck("退出后访问 / 仍被挡回登录页", await waitPath(page, "/sign-in"), page.url());

  // ── 7. 密码错 → 一句人话，不是 500 ────────────────────────────────
  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle2" });
  await fillAndSubmit(page, { username: USER, password: "definitely-wrong" });
  await page.waitForFunction(
    () => document.body.innerText.includes("用户名或密码不对"),
    { timeout: 15000 }
  );
  ck("密码错时提示「用户名或密码不对」", true);
  ck("密码错时没有跳走", page.url().endsWith("/sign-in"), page.url());

  // ── 8. 正确密码登录 ───────────────────────────────────────────────
  await fillAndSubmit(page, { username: USER, password: PASS });
  ck("正确密码能登录并进首页", await waitPath(page, "/", 20000), page.url());

  // ── 9. 已登录时进注册页 → 被送回首页 ──────────────────────────────
  // 这条是上一轮跑出来的：脚本原本直接 goto /sign-up，结果等了 15 秒没有表单。
  // 不是 bug —— 是 proxy 把已登录的人从登录/注册页送回去了。行为正确，补成断言。
  await page.goto(`${BASE}/sign-up`, { waitUntil: "networkidle2" });
  ck("已登录访问 /sign-up 会被送回首页", await waitPath(page, "/"), page.url());

  // 下面全是要在未登录状态下测的
  ck("退出以便继续测注册", await signOut(page), page.url());

  // ── 10. 重名注册被拒 ──────────────────────────────────────────────
  await page.goto(`${BASE}/sign-up`, { waitUntil: "networkidle2" });
  await fillAndSubmit(page, {
    username: USER,
    password: PASS,
    confirmPassword: PASS,
  });
  await page.waitForFunction(
    () => document.body.innerText.includes("已经有人用了"),
    { timeout: 15000 }
  );
  ck("重名注册被拒并给出人话提示", true);

  // ── 11. 两次密码不一致 ────────────────────────────────────────────
  await page.goto(`${BASE}/sign-up`, { waitUntil: "networkidle2" });
  await fillAndSubmit(page, {
    username: `${USER}b`,
    password: PASS,
    confirmPassword: "another-pass-1",
  });
  await page.waitForFunction(
    () => document.body.innerText.includes("两次输入的密码不一样"),
    { timeout: 15000 }
  );
  ck("两次密码不一致会被拦下", true);

  // ── 12. 中文用户名（产品承诺过要支持）──────────────────────────────
  const CN_USER = `测试${stamp.slice(-6)}`;
  await page.goto(`${BASE}/sign-up`, { waitUntil: "networkidle2" });
  await fillAndSubmit(page, {
    username: CN_USER,
    password: PASS,
    confirmPassword: PASS,
  });
  ck("中文用户名能注册成功", await waitPath(page, "/", 20000), page.url());
  ck(
    "中文用户名正确显示",
    await page.waitForFunction(
      (u) => document.body.innerText.includes(u),
      { timeout: 10000 },
      CN_USER
    ).then(() => true).catch(() => false)
  );
} catch (error) {
  ck(`执行中断：${error.message}`, false);
  await page.screenshot({ path: ".e2e-tmp/c-auth-failure.png" }).catch(() => {});
} finally {
  ck("控制台无报错", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await browser.close();
}

console.log(`\n注册的测试用户：${USER} / 测试${stamp.slice(-6)}`);
console.log(failed === 0 ? "\n全部通过" : `\n${failed} 条失败`);
process.exit(failed === 0 ? 0 : 1);
