// 批 2 的前端验收：按节点 busy、并行三条、第 4 条被拒、积分回执。
//
// 为什么必须真浏览器：这几条全是「界面在某个瞬间是不是这样」——
// 按钮的 disabled、同时出现几个「生成中…」、错误提示有没有冒出来。
// 用接口断言只能证明后端允许并发，证明不了用户能不能点。
//
// 跑法（前置：dev 与 worker 都指向 verify.db、MODEL_PROVIDER=mock、
// worker 用 MOCK_LATENCY_SCALE=8 把延迟放大，否则 1.2 秒的出图比三次点击
// 之间的间隔还短，验不出并发）：
//   node scripts/e2e-batch2-parallel.mjs
//
// 只读写 verify.db，不碰 dev.db。
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const VIEW = { width: 1600, height: 900 };
const PROJECT_NAME = "__verify_batch2_ui__";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rfc3339 = (d = new Date()) => d.toISOString().replace("Z", "+00:00");
const newId = (p) =>
  `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

let bad = 0;
const ck = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(
    `${ok ? "✓" : "✗"} ${name}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`
  );
};

// ---------- 造一个干净的项目：4 个互不依赖的图节点，排成一行 ----------
const db = new Database("verify.db");
const now = rfc3339();

const old = db.prepare("select id from Project where name = ?").get(PROJECT_NAME);
if (old) {
  db.prepare(
    "delete from RunEvent where runId in (select id from Run where projectId = ?)"
  ).run(old.id);
  db.prepare(
    "delete from Job where runId in (select id from Run where projectId = ?)"
  ).run(old.id);
  db.prepare("delete from Run where projectId = ?").run(old.id);
  db.prepare("delete from Edge where projectId = ?").run(old.id);
  db.prepare("delete from Node where projectId = ?").run(old.id);
  db.prepare("delete from Project where id = ?").run(old.id);
}

const projectId = newId("vui");
db.prepare(
  "insert into Project (id,name,createdAt,updatedAt) values (?,?,?,?)"
).run(projectId, PROJECT_NAME, now, now);

const nodeIds = [];
for (let i = 0; i < 4; i++) {
  const id = newId("vun");
  nodeIds.push(id);
  db.prepare(
    `insert into Node (id, projectId, type, positionX, positionY, data, status, createdAt, updatedAt)
     values (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    projectId,
    "image.gen",
    i * 1700,
    0,
    JSON.stringify({
      label: `测试图${i + 1}`,
      prompt: `第 ${i + 1} 张测试图，雨夜霓虹`,
      aspectRatio: "16:9",
      status: "idle",
    }),
    "idle",
    now,
    now
  );
}
db.close();

// ---------- 真浏览器 ----------
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", `--window-size=${VIEW.width},${VIEW.height}`],
  defaultViewport: VIEW,
});
const page = await browser.newPage();

await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "networkidle2" });
await page.waitForSelector(".react-flow__node", { timeout: 30000 });
// 等 hydration：不等到就是「看着正常但点了没反应」
await sleep(1500);

/** 点节点中心（选中它，面板才会浮出来） */
async function selectNode(id) {
  const rect = await page.evaluate((nodeId) => {
    const el = document.querySelector(`[data-node-id="${nodeId}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, id);
  if (!rect) throw new Error(`节点 ${id} 不在 DOM 里`);
  await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await page.waitForSelector(`[data-node-id="${id}"] [data-node-panel]`, {
    timeout: 5000,
  });
}

async function clickSend(id) {
  await page.click(`[data-node-id="${id}"] [data-action="send"]`);
}

const buttonText = (id) =>
  page.evaluate((nodeId) => {
    const b = document.querySelector(`[data-node-id="${nodeId}"] [data-action="send"]`);
    return b ? b.textContent.trim() : null;
  }, id);

const buttonDisabled = (id) =>
  page.evaluate((nodeId) => {
    const b = document.querySelector(`[data-node-id="${nodeId}"] [data-action="send"]`);
    return b ? b.disabled : null;
  }, id);

// ---------- 连点三个节点 ----------
for (let i = 0; i < 3; i++) {
  await selectNode(nodeIds[i]);
  await clickSend(nodeIds[i]);
  await sleep(250);
}

await sleep(900); // 等三条 SSE 的 queued/running 事件到齐

// 状态条是唯一横跨多条 run 的界面元素：它说「3 个任务」，就说明真的有三条
// 在同时跑。不能拿节点面板的按钮去数 —— 面板只属于被选中的那一个节点。
const strip = await page.evaluate(() => {
  const el = document.querySelector("[data-run-strip]");
  return el ? el.textContent.replace(/\s+/g, " ").trim() : null;
});
ck(
  "三条 run 同时在跑（状态条显示 3 个任务）",
  Boolean(strip && strip.includes("3 个任务")),
  strip
);
ck("状态条处在「运行中」而不是「排队中」", Boolean(strip && strip.includes("运行中")), strip);

// 第 4 个节点的按钮：此刻别处有两个任务在跑，但它**不该**是灰的。
// 这是「busy 从全局改成按节点」最直接的一条证据。
await selectNode(nodeIds[3]);
const fourthDisabled = await buttonDisabled(nodeIds[3]);
ck("别的节点在跑时，第四个节点的按钮仍可点（busy 已按节点）", fourthDisabled === false, fourthDisabled);

// ---------- 第 4 个点下去：应被明确拒绝 ----------
await clickSend(nodeIds[3]);
await sleep(800);

const banner = await page.evaluate(() => {
  const el = document.querySelector("[data-error-banner]");
  return el ? el.textContent.trim() : null;
});
ck(
  "第 4 个任务被明确拒绝并说明原因",
  Boolean(banner && banner.includes("已经有 3 个任务")),
  banner
);

// ---------- 等跑完，看积分回执 ----------
const chip = await page
  .waitForSelector("[data-credits-chip]", { timeout: 90_000 })
  .then((h) =>
    h.evaluate((el) => ({
      credits: Number(el.dataset.credits),
      nodes: Number(el.dataset.nodes),
      text: el.textContent.replace(/\s+/g, " ").trim(),
    }))
  )
  .catch(() => null);

ck(
  "跑完显示本次总消耗（3 张图 = 30 积分，不是最后一条的 10）",
  Boolean(chip && chip.credits === 30 && chip.nodes === 3),
  chip
);

await page.screenshot({ path: ".tmp-batch2.png" });

console.log(bad === 0 ? "\n全部通过" : `\n${bad} 条不符`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
