/**
 * 素材上传的浏览器 E2E。
 *
 * 为什么不用 API 测试代替：上一轮（M2）就是因为只测了接口，
 * 漏掉了「拖不动节点」和「连线端点错位」两个致命 bug。
 * 这一轮的风险全在交互侧 —— 加号浮窗、文件选择、上传后落位、刷新后复原，
 * 每一条都必须在真实浏览器里点出来才算数。
 *
 * 跑法：node scripts/e2e-upload.mjs
 * 前置：npm run dev 与 npm run worker 都在跑。
 *
 * 用一个独立的临时项目，不碰演示项目 —— 否则反复跑会把演示画布越堆越乱，
 * 而「节点数量」这类断言一旦依赖历史数据就不可复现了。
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://127.0.0.1:3000";

const IMG = path.resolve(".e2e-tmp/测试图片.png");
const VID = path.resolve(".e2e-tmp/测试视频.mp4");

const PW = "__e2e_upload__";

// 测试图里预置的三个节点。专门安排成「Z → A → 视频」这条链，
// 用来验证提示词**不会**递归到爷爷辈。
const ANCESTOR_TEXT = "祖先不该出现";
const DIRECT_TEXT = "雨夜街头霓虹";
const VIDEO_PROMPT = "镜头缓慢推进";

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rfc3339(d = new Date()) {
  // Prisma 在 SQLite 里存的是 "+00:00" 结尾的 RFC3339，不是 ISO 的 "Z"
  return d.toISOString().replace("Z", "+00:00");
}

function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 建一个干净的测试项目：
 *
 *   Z(祖先文本) ─→ A(直接上游) ─┐
 *                                ├─→ 视频
 *   图片生成(已有产物) ──────────┤
 *   上传的图片素材 ──────────────┘
 *
 * 四个东西各验证一件事：
 *   Z 存在        → 验证提示词**不递归**到爷爷辈
 *   图片生成      → 验证走 outputAsset 的常规上游仍然有效
 *   上传素材      → 验证走 data.assetId 的新路径有效
 *   两条图都接进来 → 验证「多对一」的产物**都**被送到模型（不是只取第一条）
 */
function setupProject() {
  const db = new Database("dev.db");
  const now = rfc3339();

  const old = db.prepare("select id from Project where name = ?").get(PW);
  if (old) cleanupProject(db, old.id);

  const projectId = newId("e2ep");
  db.prepare(
    "insert into Project (id,name,createdAt,updatedAt) values (?,?,?,?)"
  ).run(projectId, PW, now, now);

  const insertNode = db.prepare(
    `insert into Node (id, projectId, type, positionX, positionY, data, status, outputAssetId, createdAt, updatedAt)
     values (?,?,?,?,?,?,?,?,?,?)`
  );
  const insertEdge = db.prepare(
    "insert into Edge (id, projectId, source, target, targetHandle) values (?,?,?,?,'')"
  );

  const zId = newId("e2enz");
  const aId = newId("e2ena");
  const genId = newId("e2eng");
  const videoId = newId("e2env");

  const textData = (label, prompt) =>
    JSON.stringify({ label, prompt, status: "succeeded" });

  // 借一个库里已有的图片资产当「已经生成过」的产图节点，
  // 这样不必真的跑一次模型就能覆盖 outputAsset 那条路径
  const anyImage = db
    .prepare("select id from Asset where kind='image' limit 1")
    .get();
  if (!anyImage) throw new Error("库里没有任何图片资产，无法构造产图上游");

  /*
   * 坐标必须按新尺寸排（文本 1024×768、图视频 1280×720）。
   *
   * 原来这里横竖都是几百的间距，是按 400×250 的卡片排的；
   * 节点放大之后相邻两个会直接叠在一起，症状是「拖线拖不动」——
   * 因为 handle 被另一个节点盖住了，而报错只会说「边数没变」。
   * 两列各留 480 的余量（≥ 面板高 130 + 节点间距），保证选中任一节点后
   * 浮出的参数面板不会压到别的节点顶部。
   */
  insertNode.run(zId, projectId, "text.prompt", -1600, 1200, textData("祖先文本", ANCESTOR_TEXT), "succeeded", null, now, now);
  insertNode.run(aId, projectId, "text.prompt", -1600, 0, textData("直接上游", DIRECT_TEXT), "succeeded", null, now, now);
  insertNode.run(
    genId,
    projectId,
    "image.gen",
    -100,
    0,
    JSON.stringify({
      label: "已有产物",
      prompt: "已生成过的图",
      aspectRatio: "16:9",
      status: "succeeded",
    }),
    "succeeded",
    anyImage.id,
    now,
    now
  );
  insertNode.run(
    videoId,
    projectId,
    "video.gen",
    -100,
    1200,
    JSON.stringify({
      label: "E2E 视频",
      prompt: VIDEO_PROMPT,
      mode: "auto",
      aspectRatio: "16:9",
      duration: "3",
      status: "idle",
    }),
    "idle",
    null,
    now,
    now
  );

  insertEdge.run(newId("e2ee"), projectId, zId, aId);
  insertEdge.run(newId("e2ee"), projectId, aId, videoId);
  insertEdge.run(newId("e2ee"), projectId, genId, videoId);

  db.close();
  return { projectId, videoId, zId, aId, genId };
}

/** 删项目和它的节点，并清掉这些节点引用的磁盘文件 */
function cleanupProject(db, projectId) {
  const nodes = db.prepare("select id, data from Node where projectId=?").all(projectId);
  for (const n of nodes) {
    let data;
    try {
      data = JSON.parse(n.data);
    } catch {
      continue;
    }
    if (!data?.assetId) continue;
    const asset = db.prepare("select filePath from Asset where id=?").get(data.assetId);
    if (asset) {
      const abs = path.join("storage", asset.filePath);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      db.prepare("delete from Asset where id=?").run(data.assetId);
    }
  }
  db.prepare("delete from Edge where projectId=?").run(projectId);
  db.prepare("delete from Node where projectId=?").run(projectId);
  db.prepare("delete from RunEvent where runId in (select id from Run where projectId=?)").run(projectId);
  db.prepare("delete from Job where runId in (select id from Run where projectId=?)").run(projectId);
  db.prepare("delete from Run where projectId=?").run(projectId);
  db.prepare("delete from Project where id=?").run(projectId);
}

async function centerOf(page, selector) {
  const el = await page.$(selector);
  if (!el) throw new Error(`找不到元素：${selector}`);
  const box = await el.boundingBox();
  if (!box) throw new Error(`元素不可见：${selector}`);
  // 用真实宽高取中心。缩放后 handle 只有 20px，
  // 以前按固定偏移算坐标会落在 handle 外面，症状是「拖了没连上」且无报错。
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragConnect(page, fromSelector, toSelector) {
  const from = await centerOf(page, fromSelector);
  const to = await centerOf(page, toSelector);
  if (process.env.E2E_DEBUG) {
    console.log(
      "  [debug] connect",
      JSON.stringify({ from, to }),
      JSON.stringify(
        await page.evaluate(
          (f, t) => {
            const at = (p) => {
              const el = document.elementFromPoint(p.x, p.y);
              return el
                ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`
                : "null";
            };
            return {
              vw: innerWidth,
              vh: innerHeight,
              t: document.querySelector(".react-flow__viewport")?.style.transform,
              fromHit: at(f),
              toHit: at(t),
              nodes: [...document.querySelectorAll("[data-node-id]")].map((e) => {
                const r = e.getBoundingClientRect();
                return {
                  type: e.getAttribute("data-node-type"),
                  x: Math.round(r.x),
                  y: Math.round(r.y),
                  w: Math.round(r.width),
                  h: Math.round(r.height),
                };
              }),
            };
          },
          from,
          to
        )
      )
    );
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
}

/** 读最近一次 Run 的日志消息 */
function latestRunLogs(db, projectId) {
  const run = db
    .prepare("select id from Run where projectId=? order by createdAt desc limit 1")
    .get(projectId);
  if (!run) return [];
  return db
    .prepare("select payload from RunEvent where runId=? and type='log' order by seq")
    .all(run.id)
    .map((e) => {
      try {
        return JSON.parse(e.payload).message;
      } catch {
        return "";
      }
    });
}

async function main() {
  for (const f of [IMG, VID]) {
    if (!fs.existsSync(f)) throw new Error(`测试素材不存在：${f}`);
  }

  const { projectId, videoId } = setupProject();
  console.log(`测试项目：${projectId}\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--window-size=1600,1000"],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console: ${m.text()}`);
  });

  try {
    await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".react-flow__node", { timeout: 20000 });
    await sleep(700);

    // ---------- 1. 加号浮窗 ----------
    const fab = await page.$('[data-action="toggle-upload"]');
    check("画布底部有加号浮窗", Boolean(fab));
    check("浮窗初始收起", (await page.$("[data-upload-panel]")) === null);

    const fabBox = await fab.boundingBox();
    const vw = await page.evaluate(() => window.innerWidth);
    check(
      "浮窗在画布水平正中",
      Math.abs(fabBox.x + fabBox.width / 2 - vw / 2) < 4,
      `偏离 ${Math.abs(fabBox.x + fabBox.width / 2 - vw / 2).toFixed(1)}px`
    );

    await fab.click();
    await page.waitForSelector("[data-upload-panel]", { timeout: 3000 });
    check("点加号后浮出上传面板", true);

    const hasFakeAddBtn = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button")).some(
        (b) => (b.textContent ?? "").trim() === "+ 素材"
      )
    );
    check("左上角没有「+ 素材」假按钮", !hasFakeAddBtn);

    // ---------- 2. 上传图片 ----------
    await (await page.$("[data-upload-input]")).uploadFile(IMG);
    await page.waitForSelector('[data-node-type="media.asset"]', { timeout: 25000 });
    check("上传图片后画布上出现素材节点", true);

    await sleep(300);
    check("上传成功后浮窗自动收起", (await page.$("[data-upload-panel]")) === null);

    const imgProbe = await page.$$eval('[data-node-type="media.asset"] img', (els) =>
      els.map((e) => ({ src: e.getAttribute("src"), natural: e.naturalWidth }))
    );
    check("素材卡片渲染出 <img>", imgProbe.length === 1, JSON.stringify(imgProbe));
    check("图片真的解码成功", imgProbe[0]?.natural > 0, `naturalWidth=${imgProbe[0]?.natural}`);

    const labelShown = await page.$eval(
      '[data-node-type="media.asset"]',
      (el) => (el.textContent ?? "").includes("测试图片")
    );
    check("默认名字取自文件名", labelShown);

    const assetNodeId = await page.$eval(
      '[data-node-type="media.asset"]',
      (el) => el.getAttribute("data-node-id")
    );

    const assetHasRunBtn = await page.$eval(
      '[data-node-type="media.asset"]',
      (el) => Boolean(el.querySelector('[data-action="run"]'))
    );
    check("素材卡片没有「运行」按钮", !assetHasRunBtn);

    // ---------- 3. 落库 ----------
    await sleep(1600);
    let db = new Database("dev.db", { readonly: true });
    const persisted = JSON.parse(
      db.prepare("select data from Node where id=?").get(assetNodeId).data
    );
    check("已落库且 data 带 assetId", Boolean(persisted.assetId), JSON.stringify(persisted));
    check("落库 kind=image", persisted.assetKind === "image", persisted.assetKind);
    check("落库 status=succeeded", persisted.status === "succeeded", persisted.status);
    db.close();

    // ---------- 4. 刷新后还在 ----------
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector(".react-flow__node", { timeout: 20000 });
    await sleep(900);
    const afterReload = await page.$$eval('[data-node-type="media.asset"] img', (els) =>
      els.map((e) => e.naturalWidth)
    );
    check("刷新后素材节点还在", afterReload.length === 1);
    check("刷新后图片依然能解码", afterReload[0] > 0, `naturalWidth=${afterReload[0]}`);

    // ---------- 5. 连线：素材 → 视频 ----------
    const edgeBefore = await page.$$eval(".react-flow__edge", (e) => e.length);
    await dragConnect(
      page,
      `[data-node-id="${assetNodeId}"] .react-flow__handle.source`,
      `[data-node-id="${videoId}"] .react-flow__handle.target`
    );
    await page.waitForFunction(
      (n) => document.querySelectorAll(".react-flow__edge").length > n,
      { timeout: 5000 },
      edgeBefore
    );
    const edgeAfter = await page.$$eval(".react-flow__edge", (e) => e.length);
    check("素材能连到视频节点", edgeAfter === edgeBefore + 1, `${edgeBefore} → ${edgeAfter}`);

    // 让连线落库（防抖 800ms）
    await sleep(1400);

    // ---------- 6. 运行视频节点 ----------
    /*
     * 「运行」按钮已经删掉了（它和面板里的「生成」是同一个 startRun，
     * 两个入口只会让人选错）。现在统一走：点一下节点 → 面板浮出 → 点生成。
     */
    await page.click(`[data-node-id="${videoId}"]`);
    await page.waitForSelector(`[data-node-id="${videoId}"] [data-action="send"]`, {
      timeout: 5000,
    });
    await page.click(`[data-node-id="${videoId}"] [data-action="send"]`);
    await page.waitForFunction(
      (id) => {
        const n = document.querySelector(`[data-node-id="${id}"]`);
        const s = n?.getAttribute("data-status");
        return s === "succeeded" || s === "failed";
      },
      { timeout: 120000 },
      videoId
    );

    db = new Database("dev.db", { readonly: true });
    const logs = latestRunLogs(db, projectId);
    db.close();

    const startLine = logs.find((m) => m.startsWith("开始生成")) ?? "";
    const promptLine = logs.find((m) => m.startsWith("提示词：")) ?? "";

    // ① producedKind 生效：上传的图片（media.asset）被认成「图」，推成图生视频
    check("上传的图让视频进图生视频模式", startLine.includes("image2video"), startLine);

    // ② 多对一的两个上游产物**都**被送到了模型。
    //    这里的关键是「2」：上游有两条图（一条走 outputAsset，一条走 data.assetId），
    //    早先 inputs 是 Record<string,string>，同端口只能存一条，
    //    界面上两条线都在、执行时只有一条生效，而且完全没有提示。
    check(
      "多对一的两条上游产物都传下去了（参考 2 个）",
      startLine.includes("参考 2 个上游产物"),
      startLine
    );

    // 先确认这条日志真的存在。缺了它，下面几条断言会在空字符串上「通过」——
    // 那正是最坏的一种假阳性：看起来全绿，其实一个字都没验到。
    check("运行日志里有实际提示词", promptLine.length > 0, promptLine || "（没有这条日志）");

    // ③ composePrompt 只拼直接上游：直接上游的文本在，爷爷辈的不在
    check("提示词含直接上游文本", promptLine.includes(DIRECT_TEXT), promptLine);
    check("提示词不含祖先文本（不递归）", !promptLine.includes(ANCESTOR_TEXT), promptLine);
    check("提示词含自己的描述", promptLine.includes(VIDEO_PROMPT), promptLine);

    // ---------- 7. 上传视频 ----------
    await page.click('[data-action="toggle-upload"]');
    await page.waitForSelector("[data-upload-panel]");
    await (await page.$("[data-upload-input]")).uploadFile(VID);
    await page.waitForFunction(
      () => document.querySelectorAll('[data-node-type="media.asset"]').length > 1,
      { timeout: 25000 }
    );
    await sleep(400);

    const videoReady = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('[data-node-type="media.asset"]'));
      const v = nodes.map((n) => n.querySelector("video")).find(Boolean);
      return v ? { found: true, src: v.getAttribute("src") } : { found: false };
    });
    check("上传视频后卡片用 <video> 渲染", videoReady.found, videoReady.src ?? "");

    await page.screenshot({ path: ".e2e-tmp/01-after-upload.png" });

    // ---------- 8. 刷新后两个素材都在 ----------
    // 必须等防抖落库（800ms）走完再刷新。
    // 早先这里只等了 400ms，第二个素材还没写进库就刷新了，
    // 于是「刷新后 2 个」失败 —— 那是测试写早了，不是功能坏了。
    await sleep(1800);
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector(".react-flow__node", { timeout: 20000 });
    await sleep(900);
    const finalCount = await page.$$eval(
      '[data-node-type="media.asset"]',
      (els) => els.length
    );
    check("刷新后两个素材节点都在", finalCount === 2, `${finalCount} 个`);

    const stillConnected = await page.$$eval(".react-flow__edge", (e) => e.length);
    check("刷新后「素材→视频」那条线还在", stillConnected === edgeAfter, `${stillConnected} 条`);

    check("页面没有 JS 报错", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } finally {
    await browser.close();
    const db = new Database("dev.db");
    cleanupProject(db, projectId);
    db.close();
  }

  console.log(`\n${passed} 项通过，${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E 崩溃：", e);
  process.exit(1);
});
