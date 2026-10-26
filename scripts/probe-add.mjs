/**
 * 「新建项目 → 加一个节点」时，卡片在屏幕上占多大？
 *
 * 只读探测，不改任何产品代码，只往库里建一个一次性的空项目。
 * 跑法：node scripts/probe-add.mjs
 *
 * 为什么要这个脚本：人反馈「新加的节点太突脸」。突脸的量化指标不是字号，
 * 也不是节点设计尺寸，而是**卡片占视口的比例** —— 同一个 1024×768 的卡片，
 * 在 1920 宽的屏幕里是 53%，在 1080 宽的屏幕里是 62%，高度更是从 47% 涨到 82%。
 * 所以必须在**真实窗口尺寸**下量，不能拿 1920×1080 的截图代替。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const PROJECT_NAME = "__probe_add__";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rfc3339 = (d = new Date()) => d.toISOString().replace("Z", "+00:00");
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function freshProject() {
  const db = new Database("dev.db");
  const now = rfc3339();
  const old = db.prepare("select id from Project where name = ?").get(PROJECT_NAME);
  if (old) {
    db.prepare("delete from Edge where projectId = ?").run(old.id);
    db.prepare("delete from Node where projectId = ?").run(old.id);
    db.prepare("delete from Project where id = ?").run(old.id);
  }
  const id = newId("probe");
  db.prepare("insert into Project (id,name,createdAt,updatedAt) values (?,?,?,?)").run(
    id,
    PROJECT_NAME,
    now,
    now
  );
  db.close();
  return id;
}

/** 量一次：卡片屏幕尺寸 / zoom / 占视口比例 */
async function measure(page) {
  return page.evaluate(() => {
    const vpEl = document.querySelector(".react-flow__viewport");
    const nodeEl = document.querySelector(".react-flow__node");
    const flowEl = document.querySelector(".react-flow");
    const m = new DOMMatrix(getComputedStyle(vpEl).transform);
    const r = nodeEl.getBoundingClientRect();
    const f = flowEl.getBoundingClientRect();
    return {
      // 画布可见区（不含顶部项目栏）
      flow: { w: f.width, h: f.height, top: f.top },
      zoom: m.a,
      node: { w: r.width, h: r.height, x: r.x, y: r.y },
      layoutW: nodeEl.offsetWidth,
      layoutH: nodeEl.offsetHeight,
      pctW: +((r.width / f.width) * 100).toFixed(1),
      pctH: +((r.height / f.height) * 100).toFixed(1),
      // 卡片四周到画布边缘的余量（突脸的直接观感：上下各剩多少）
      gapTop: +(r.y - f.top).toFixed(1),
      gapBottom: +(f.bottom - r.bottom).toFixed(1),
      gapLeft: +(r.x - f.left).toFixed(1),
      gapRight: +(f.right - r.right).toFixed(1),
    };
  });
}

const VIEWS = [
  { label: "1080×680（人报缺陷时的窗口）", width: 1080, height: 680 },
  { label: "1440×900", width: 1440, height: 900 },
  { label: "1920×1080（我们 E2E 的默认视口）", width: 1920, height: 1080 },
];

/** 首屏取景的目标：内容占画布高 FIRST_VIEW_MAX_H（产品里的常量，这里独立写死） */
const TARGET_H = 0.34;
const FLOATING_UI_H = 96;

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) pass++;
  else fails.push(`${name}  →  ${detail}`);
}

const projectId = freshProject();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  defaultViewport: null,
});

for (const v of VIEWS) {
  const page = await browser.newPage();
  await page.setViewport({ width: v.width, height: v.height });
  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "networkidle2" });
  await sleep(1200);

  // 点左上角「+ 文本提示词」
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent.trim().startsWith("+ 文本提示词")
    );
    btn.click();
  });
  await sleep(1400); // 等首屏 fitView 落下去

  const d = await measure(page);
  console.log(`\n${v.label}`);
  console.log(
    `  画布可见区 ${d.flow.w.toFixed(0)}×${d.flow.h.toFixed(0)}   zoom ${d.zoom.toFixed(3)}`
  );
  console.log(
    `  卡片屏幕 ${d.node.w.toFixed(0)}×${d.node.h.toFixed(0)}` +
      `（布局 ${d.layoutW}×${d.layoutH}）`
  );
  console.log(`  占视口宽 ${d.pctW}%   占视口高 ${d.pctH}%`);
  console.log(
    `  四周余量  上 ${d.gapTop} / 下 ${d.gapBottom} / 左 ${d.gapLeft} / 右 ${d.gapRight}`
  );

  /*
   * 四条判据。为什么要「占比」而不是「zoom 等于多少」：
   * zoom 是随窗口变的（这正是「按比例取景」的语义），拿 zoom 当判据
   * 就只能在某一个窗口尺寸下成立。
   */
  check(
    `${v.label} 占画布高 ${(TARGET_H * 100).toFixed(0)}%`,
    Math.abs(d.pctH - TARGET_H * 100) <= 1.5,
    `${d.pctH}%`
  );
  check(`${v.label} 顶边不钻工具栏`, d.gapTop >= FLOATING_UI_H - 2, `上余量 ${d.gapTop}`);
  check(`${v.label} 底边不出视口`, d.gapBottom >= 0, `下余量 ${d.gapBottom}`);
  check(`${v.label} 左右居中`, Math.abs(d.gapLeft - d.gapRight) <= 1.5, `${d.gapLeft} / ${d.gapRight}`);
  check(`${v.label} 不放大超过 1:1`, d.zoom <= 1.001, String(d.zoom));

  await page.screenshot({ path: `.e2e-tmp/add-fixed-${v.width}.png` });

  // 每清一次项目再加下一个视口，保证是「空项目 → 加第一个节点」的真实路径
  if (v !== VIEWS[VIEWS.length - 1]) {
    const db = new Database("dev.db");
    db.prepare("delete from Node where projectId = ?").run(projectId);
    db.close();
  }
  await page.close();
}

/*
 * ── 附加用例：走人的真实路径 ──
 *
 * 上面那三个视口都是 `page.goto(项目地址)` = **完整页面加载**。
 * 人报的 bug 却不是这条路：他是**在首页点「新建项目」**（server action + redirect，
 * 属于客户端跳转），然后点添加节点，**全程不刷新**。
 * 两条路在 react-flow 眼里不是一回事：完整加载时组件全新挂载，客户端跳转时
 * store / react-flow 的内部状态可能是热的。历史 bug 恰恰是「不刷新就突脸，
 * 刷新就对」—— 所以这条路径必须单独守。
 *
 * 判据里加 `zoom < 1`：万一取景没执行，viewport 会停在 react-flow 的初始
 * `zoom = 1`，这条立刻红，比只看占比更早暴露问题。
 */
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(BASE, { waitUntil: "networkidle2" });
  await sleep(500);

  const uiName = `__probe_ui_${Date.now()}`;
  await page.type('input[name="name"]', uiName);
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.trim() === "新建项目")
      .click();
  });
  await page.waitForFunction(() => location.pathname.startsWith("/projects/"), {
    timeout: 15000,
  });
  const uiProjectId = page.url().split("/projects/")[1].split(/[?#]/)[0];
  await sleep(1200); // 项目页挂载完（但**不刷新**，这是关键）

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      b.textContent.trim().startsWith("+ 文本提示词")
    );
    btn.click();
  });
  await sleep(1800);

  const d = await measure(page);
  console.log(`\n首页点「新建项目」→ 点添加节点（全程未刷新）`);
  console.log(`  zoom ${d.zoom}  卡片 ${d.node.w.toFixed(0)}×${d.node.h.toFixed(0)}  占高 ${d.pctH}%`);

  check(
    "UI 路径（新建→加节点，未刷新）占画布高 34%",
    Math.abs(d.pctH - TARGET_H * 100) <= 1.5,
    `${d.pctH}%`
  );
  check(
    "UI 路径（新建→加节点，未刷新）取景真的执行了",
    d.zoom > 0.3 && d.zoom < 0.99,
    `zoom ${d.zoom}（若停在 1 说明 fitView 没跑）`
  );
  check(
    "UI 路径（新建→加节点，未刷新）上下余量相等",
    Math.abs(d.gapTop - d.gapBottom) <= 1.5,
    `${d.gapTop} / ${d.gapBottom}`
  );

  await page.screenshot({ path: ".e2e-tmp/add-ui-path-1920.png" });
  await page.close();

  // 清掉这条用例建的项目，别在库里留垃圾
  const db = new Database("dev.db");
  db.prepare("delete from Edge where projectId = ?").run(uiProjectId);
  db.prepare("delete from Node where projectId = ?").run(uiProjectId);
  db.prepare("delete from Project where id = ?").run(uiProjectId);
  db.close();
}

await browser.close();

console.log("\n---------------------------------------");
if (fails.length) {
  for (const f of fails) console.log("FAIL  " + f);
  console.log(`\n${pass} 通过 / ${fails.length} 失败`);
  process.exit(1);
}
console.log(`全部通过（${pass} 条）`);
