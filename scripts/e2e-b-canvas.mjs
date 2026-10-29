// B 阶段 · 真浏览器验收（看大图 / 运行历史 / 撤销）
//
// 前置：dev 跑在 3100，且指向隔离库
//   DATABASE_URL="file:./verify.db" STORAGE_DIR="./.verify-storage" \
//   MODEL_PROVIDER=mock npx next dev --port 3100
//
//   node scripts/e2e-b-canvas.mjs <projectId>
//
// 只读 verify.db 与 .verify-storage，不碰 dev.db / ./storage。

import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://127.0.0.1:3100";
const projectId = process.argv[2];
if (!projectId) {
  console.error("用法：node scripts/e2e-b-canvas.mjs <projectId>");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function ck(name, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${name}` + (detail === undefined ? "" : `  → ${detail}`));
  if (!ok) failed++;
}

/**
 * 真正的双击。
 *
 * 不能用 `page.mouse.click(x, y, { clickCount: 2 })`：那条路径下 Chrome
 * 只给出 `detail: 1` 的 click，**不会派发 dblclick**（实测，2026-10-29）。
 * 必须手动 down/up，并且第二次的 mousedown/up 都带 clickCount: 2。
 */
async function doubleClick(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await sleep(50);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
}

/**
 * 让每一轮都从同一个起点开始。
 *
 * 上一轮如果跑的是反向验证（故意不回写产物），种子节点的 outputAssetId
 * 会被留成 null。下一轮「撤销后图也回来了」从起点就不可能成立 ——
 * 测试自己污染了自己，而且看起来像是功能坏了。所以开跑前复位一次。
 *
 * 只动 verify.db 的种子那一行，不影响别的数据。
 */
function resetSeed() {
  const d = new Database("verify.db");
  try {
    const r = d
      .prepare('update "Node" set outputAssetId = ?, status = ? where id = ?')
      .run("asset_seed_one", "succeeded", "node_seed_one");
    if (r.changes === 1) return;

    /*
     * 这一行没了 —— 上一轮反向验证把它删掉之后就没再放回来（那正是要验的东西）。
     * 直接补一条全新的，让下一轮还能从同一个起点开始。
     */
    const now = new Date().toISOString();
    d.prepare(
      `insert into "Node"
        (id, projectId, type, positionX, positionY, data, status, error, outputAssetId, createdAt, updatedAt)
       values (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      "node_seed_one",
      projectId,
      "image.gen",
      0,
      0,
      JSON.stringify({
        label: "会被删掉的图",
        prompt: "雨夜的街道，霓虹倒影",
        aspectRatio: "16:9",
        status: "succeeded",
        naturalW: 1024,
        naturalH: 576,
      }),
      "succeeded",
      null,
      "asset_seed_one",
      now,
      now
    );
  } finally {
    d.close();
  }
}
resetSeed();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--window-size=1600,900"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "networkidle2" });
await page.waitForSelector("[data-node-id]", { timeout: 30_000 });
// 等 hydration：不等的话点击会静默失效（这个项目踩过）
await page.waitForFunction(
  () => Boolean(document.querySelector(".react-flow__node")) && document.readyState === "complete",
  { timeout: 30_000 }
);
await sleep(1500);

// ---------- B-1 看大图 ----------

/** 双击第一个带图片的节点 */
const imageNodeBox = await page.evaluate(() => {
  const node = [...document.querySelectorAll("[data-node-id]")].find((n) =>
    n.querySelector("img")
  );
  if (!node) return null;
  const r = node.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
});
ck("画布上有带图片的节点", Boolean(imageNodeBox), imageNodeBox && `${Math.round(imageNodeBox.w)}×${Math.round(imageNodeBox.h)}`);

await doubleClick(page, imageNodeBox.x, imageNodeBox.y);
await sleep(700);

const lightbox = await page.evaluate(() => {
  const el = document.querySelector("[data-lightbox]");
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    w: Math.round(r.width),
    h: Math.round(r.height),
    vw: window.innerWidth,
    vh: window.innerHeight,
    parentIsBody: el.parentElement === document.body,
    hasMedia: Boolean(el.querySelector("[data-lightbox-media]")),
    hasDownload: Boolean(el.querySelector("[data-lightbox-download]")),
  };
});

ck("双击图片打开全屏浮层", Boolean(lightbox));
ck(
  "浮层铺满视口（不是被画布缩放的小块）",
  Boolean(lightbox && lightbox.w >= lightbox.vw * 0.98 && lightbox.h >= lightbox.vh * 0.98),
  lightbox && `${lightbox.w}×${lightbox.h} vs 视口 ${lightbox.vw}×${lightbox.vh}`
);
ck(
  "浮层挂在 body 上（脱离了画布的 transform）",
  Boolean(lightbox?.parentIsBody),
  lightbox && String(lightbox.parentIsBody)
);
ck("浮层里有媒体与下载入口", Boolean(lightbox?.hasMedia && lightbox?.hasDownload));

// Esc 关闭
await page.keyboard.press("Escape");
await sleep(400);
ck("Esc 能关闭", (await page.$("[data-lightbox]")) === null);

// 选中节点 → 点「放大」按钮
await page.mouse.click(imageNodeBox.x, imageNodeBox.y);
await sleep(600);
const zoomBtn = await page.$('[data-action="zoom"]');
ck("选中节点后出现「放大」按钮", Boolean(zoomBtn));
if (zoomBtn) {
  await zoomBtn.click();
  await sleep(500);
  ck("点按钮也能打开全屏", Boolean(await page.$("[data-lightbox]")));
  // 点空白处关闭（点浮层顶部空白区域）
  await page.mouse.click(40, 40);
  await sleep(400);
  ck("点空白处能关闭", (await page.$("[data-lightbox]")) === null);
}

await page.screenshot({ path: ".tmp-b1.png" });

// ---------- B-2 运行历史 ----------

await page.click('[data-action="open-runs"]');
await page.waitForSelector("[data-run-history]", { timeout: 15_000 });
await page.waitForSelector("[data-run-row]", { timeout: 15_000 });
await sleep(400);

const history = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("[data-run-row]")];
  return {
    count: rows.length,
    statuses: rows.map((r) => r.getAttribute("data-run-status")),
    texts: rows.map((r) => r.textContent.replace(/\s+/g, " ").trim()),
  };
});

ck("抽屉列出运行记录", history.count >= 2, `${history.count} 条`);
ck(
  "列表里有一条成功、一条失败",
  history.statuses.includes("succeeded") && history.statuses.includes("failed"),
  history.statuses.join(",")
);
ck(
  "最近一次排在最前（种子数据里失败那条更新）",
  history.statuses[0] === "failed",
  history.statuses.join(",")
);
ck(
  "每行带上了节点数与积分",
  history.texts.some((t) => t.includes("个节点") && t.includes("积分")),
  history.texts[0]?.slice(0, 60)
);
ck(
  "失败那行直接显示错误原因",
  history.texts.some((t) => t.includes("Throttling") || t.includes("限流")),
  history.texts.find((t) => t.includes("个节点"))?.slice(0, 60)
);

// 展开失败那一条，看明细
const failedIndex = history.statuses.indexOf("failed");
const rows = await page.$$("[data-run-row]");
await rows[failedIndex].$eval("[data-run-toggle]", (el) => el.click());
await page.waitForSelector("[data-run-event]", { timeout: 15_000 });
await sleep(300);
const detail = await page.evaluate(() => {
  const items = [...document.querySelectorAll("[data-run-event]")];
  return {
    count: items.length,
    levels: items.map((i) => i.getAttribute("data-run-event")),
    texts: items.map((i) => i.textContent.trim()),
  };
});
ck("展开后能看到逐条记录", detail.count >= 2, `${detail.count} 条`);
ck(
  "记录落在正确的节点名下（不是一串 id）",
  detail.texts.some((t) => t.includes("留下的图")),
  detail.texts.find((t) => t.includes("「"))?.slice(0, 60)
);
ck(
  "失败/重试这类记录标成了提醒色",
  detail.levels.includes("error") || detail.levels.includes("warn"),
  detail.levels.join(",")
);

await page.screenshot({ path: ".tmp-b2.png" });

// Esc 关闭抽屉
await page.keyboard.press("Escape");
await sleep(400);
ck("Esc 能关掉运行历史", (await page.$("[data-run-history]")) === null);

// ---------- B-3 撤销 ----------

/** 画布上节点数 */
const nodeCount = () =>
  page.evaluate(() => document.querySelectorAll("[data-node-id]").length);

/** 某个节点在屏幕上的中心点 */
async function box(nodeId) {
  return page.evaluate((id) => {
    const n = document.querySelector(`[data-node-id="${id}"]`);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, nodeId);
}

/**
 * 库里这一行长什么样。
 *
 * 必须查库，不能只看画面：保存是 800ms 防抖的，删完马上撤销的话
 * 那一行**可能从来没被删过** —— 于是「产物回写」那条路一次都没走到，
 * 界面看起来全绿，实际上改的那段代码根本没执行。
 */
function dbNode() {
  const d = new Database("verify.db", { readonly: true });
  try {
    return d
      .prepare('select id, status, outputAssetId from "Node" where id = ?')
      .get("node_seed_one");
  } finally {
    d.close();
  }
}

const countBefore = await nodeCount();
ck("起始状态：两个节点都在", countBefore === 2, String(countBefore));

const target = await box("node_seed_one");
ck("目标节点在视口内（否则点击会静默失效）", Boolean(target), JSON.stringify(target));

// 选中 → 按 Delete 删除
await page.mouse.click(target.x, target.y);
await sleep(400);
await page.keyboard.press("Delete");
await sleep(500);
ck(
  "Delete 删掉了节点",
  (await nodeCount()) === countBefore - 1,
  `${countBefore} → ${await nodeCount()}`
);

// 等删除落库：那一刻这一行真的没了，产物引用也随之消失
await sleep(1600);
ck("删除已经落库（这一行真的从库里没了）", dbNode() === undefined, JSON.stringify(dbNode()));

/*
 * 输入框里按 Ctrl+Z 不能撤画布。
 *
 * 这里不断言「文字被撤回了」—— 那条会跟 400ms 防抖提交打架：
 * 提交把值写回 store，React 再把带字的文本渲染回来，同一瞬间谁先谁后不确定。
 * 换成一个没有竞态的判据：刚才那一下**没有把删掉的节点撤回来**。
 * 抢走 Ctrl+Z 的话，节点会当场回来，这条立刻变红。
 */
const other = await box("node_seed_two");
await page.mouse.click(other.x, other.y);
await sleep(500);
await page.click("textarea");
await sleep(200);
await page.keyboard.down("Control");
await page.keyboard.press("z");
await page.keyboard.up("Control");
await sleep(500);
ck(
  "输入框里按 Ctrl+Z 不会撤掉画布上的删除",
  (await nodeCount()) === countBefore - 1,
  `${countBefore - 1} → ${await nodeCount()}`
);

// 离开输入框（点空白处取消选中），再撤销画布
await page.mouse.click(80, 700);
await sleep(300);
await page.keyboard.down("Control");
await page.keyboard.press("z");
await page.keyboard.up("Control");
await sleep(1800); // 等撤销后的保存落库

const afterUndo = await page.evaluate(() => {
  const n = document.querySelector('[data-node-id="node_seed_one"]');
  return {
    count: document.querySelectorAll("[data-node-id]").length,
    back: Boolean(n),
    hasImage: Boolean(n?.querySelector("img")),
    type: n?.getAttribute("data-node-type") ?? null,
  };
});
ck("Ctrl+Z 把节点放回来了", afterUndo.back && afterUndo.count === countBefore, JSON.stringify(afterUndo));
ck("回来的是图片节点（不是素材节点）", afterUndo.type === "image.gen", afterUndo.type);
ck("图也回来了（不用重新花积分生成）", afterUndo.hasImage);

const restored = dbNode();
ck(
  "库里那一行被重建，且产物引用写了回去",
  Boolean(restored && restored.outputAssetId === "asset_seed_one"),
  JSON.stringify(restored)
);
ck(
  "状态也一起回写（不是「图在、状态为空」的半截状态）",
  Boolean(restored && restored.status === "succeeded"),
  restored?.status
);

// 提示词还在 —— 这就是「能在下方写提示词的那种节点」
const b2 = await box("node_seed_one");
if (!b2) {
  // 前面已经红了，这里再抛就是一堆堆栈盖住结论
  console.log("✗ 节点没回来，后面的断言没法继续（前面的失败已经说明了原因）");
  failed++;
  await browser.close();
  process.exit(1);
}
await page.mouse.click(b2.x, b2.y);
await sleep(600);
const promptValue = await page.evaluate(() => {
  const ta = document.querySelector("textarea");
  return ta ? ta.value : null;
});
ck(
  "撤销回来的节点连提示词都还是原来那段",
  typeof promptValue === "string" && promptValue.includes("雨夜"),
  promptValue
);

/*
 * 重做：再删一次，撤销回来，然后 Ctrl+Shift+Z 应该再删掉。
 *
 * 先点节点（把焦点从输入框拿开），否则 Delete 会删文字。
 */
await page.mouse.click(b2.x, b2.y);
await sleep(400);
await page.keyboard.press("Delete");
await sleep(600);
const afterDelete2 = await nodeCount();
await page.keyboard.down("Control");
await page.keyboard.press("z");
await page.keyboard.up("Control");
await sleep(600);
await page.keyboard.down("Control");
await page.keyboard.down("Shift");
await page.keyboard.press("z");
await page.keyboard.up("Shift");
await page.keyboard.up("Control");
await sleep(600);
ck(
  "Ctrl+Shift+Z 能重做（重做后又是删掉的状态）",
  (await nodeCount()) === afterDelete2,
  `删除后 ${afterDelete2}，重做后 ${await nodeCount()}`
);

// 回到「有节点」的状态，等保存落库，然后刷新验证产物是不是真的回到库里
await page.keyboard.down("Control");
await page.keyboard.press("z");
await page.keyboard.up("Control");
await sleep(1800);

await page.reload({ waitUntil: "networkidle2" });
await page.waitForSelector("[data-node-id]", { timeout: 30_000 });
await sleep(1500);

const afterReload = await page.evaluate(() => {
  const n = document.querySelector('[data-node-id="node_seed_one"]');
  return {
    count: document.querySelectorAll("[data-node-id]").length,
    back: Boolean(n),
    hasImage: Boolean(n?.querySelector("img")),
  };
});
ck(
  "刷新之后节点还在（撤销真的落库了）",
  afterReload.back && afterReload.count === countBefore,
  JSON.stringify(afterReload)
);
ck("刷新之后图也还在（产物引用回写成功）", afterReload.hasImage);

await page.screenshot({ path: ".tmp-b3.png" });

if (errors.length) {
  console.log("\n⚠️ 页面报错：");
  for (const e of errors.slice(0, 5)) console.log("   " + e);
}

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 条不符`}`);
await browser.close();
process.exit(failed === 0 ? 0 : 1);
