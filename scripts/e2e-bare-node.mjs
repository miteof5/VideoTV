/**
 * 裸节点验收 —— 图像 / 视频 / 素材节点去掉边框和标题，尺寸按产物比例走。
 *
 * 跑法：node scripts/e2e-bare-node.mjs
 * 需要 dev 在 3000 端口跑着。自建独立测试项目，跑完清理。
 *
 * ### 这里为什么必须用真浏览器
 *
 *  - 「尺寸按图片像素比例」只有在图片解码之后才成立，服务端不知道宽高
 *  - 「没有边框、没有标题栏」是渲染结果，读代码只能读到自己写了什么
 *  - 「尺寸变过之后连线端点还接在边上」是最容易悄悄坏的一处：
 *    节点变高了，React Flow 的 handle 坐标缓存不刷新的话，
 *    线会插在原来那个高度，而**不会有任何报错**
 *  - 双击不许缩放画布（d3-zoom 抢事件，零提示）
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";
import zlib from "node:zlib";
import fs from "node:fs";
import { requireMockWorld } from "./_preflight.mjs";
import path from "node:path";

const BASE = "http://127.0.0.1:3000";
const PROJECT_NAME = "__bare_node_e2e__";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const TMP = ".e2e-tmp";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rfc3339 = (d = new Date()) => d.toISOString().replace("Z", "+00:00");
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* ---------------- 造两张已知尺寸的 PNG ---------------- */

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 一张 w×h 的渐变 PNG（RGB，无压缩优化）。
 * 自己造而不是用现成素材，是为了让「封顶缩放」和「小图不放大」
 * 这两条断言的期望值由脚本决定，而不是由某张图的运气决定。
 */
function makePng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  const rowLen = w * 3 + 1;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * rowLen + 1 + x * 3;
      raw[i] = Math.round((x / w) * 255);
      raw[i + 1] = Math.round((y / h) * 255);
      raw[i + 2] = 180;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- 数据库 ---------------- */

function cleanupProject(db, projectId) {
  db.prepare("delete from RunEvent where runId in (select id from Run where projectId = ?)").run(projectId);
  db.prepare("delete from Job where runId in (select id from Run where projectId = ?)").run(projectId);
  db.prepare("delete from Run where projectId = ?").run(projectId);
  db.prepare("delete from Edge where projectId = ?").run(projectId);
  db.prepare("delete from Node where projectId = ?").run(projectId);
  db.prepare("delete from Project where id = ?").run(projectId);
}

function setup() {
  const db = new Database("dev.db");
  const now = rfc3339();

  const old = db.prepare("select id from Project where name = ?").get(PROJECT_NAME);
  if (old) cleanupProject(db, old.id);

  const projectId = newId("e2eb");
  db.prepare("insert into Project (id,name,createdAt,updatedAt) values (?,?,?,?)").run(
    projectId,
    PROJECT_NAME,
    now,
    now
  );

  const insert = db.prepare(
    `insert into Node (id, projectId, type, positionX, positionY, data, status, createdAt, updatedAt)
     values (?,?,?,?,?,?,?,?,?)`
  );

  const ids = { image: newId("e2ebi"), video: newId("e2ebv") };
  const mk = (id, type, x, y, data) =>
    insert.run(id, projectId, type, x, y, JSON.stringify(data), "idle", now, now);

  // 分开摆，避免两块面板互相压住
  // modelId 钉死成演示模型：这套验收要验的是「尺寸」，不是模型质量。
  // 不钉的话会用到真的千问接口（有额度、但要 80 秒，还会烧额度）。
  mk(ids.image, "image.gen", -700, -260, {
    label: "待生成图",
    prompt: "一张图",
    negativePrompt: "",
    aspectRatio: "16:9",
    modelId: "mock.image.v1",
    status: "idle",
  });
  mk(ids.video, "video.gen", -700, 380, {
    label: "待生成视频",
    prompt: "一段视频",
    mode: "auto",
    aspectRatio: "16:9",
    duration: "3",
    modelId: "mock.video.v1",
    status: "idle",
  });

  db.close();
  return { projectId, ids };
}

function readData(nodeId) {
  const db = new Database("dev.db");
  const row = db.prepare("select data from Node where id = ?").get(nodeId);
  db.close();
  if (!row) return {};
  try {
    return JSON.parse(row.data);
  } catch {
    return {};
  }
}

/* ---------------- 浏览器辅助 ---------------- */

/** 节点尺寸用 offsetWidth/Height：getBoundingClientRect 是缩放后的屏幕尺寸 */
async function nodeSize(page, nodeId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-node-id="${id}"]`);
    if (!el) return null;
    return { w: el.offsetWidth, h: el.offsetHeight };
  }, nodeId);
}

async function nodeRect(page, nodeId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-node-id="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  }, nodeId);
}

async function rectOf(page, selector) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  }, selector);
}

async function viewportTransform(page) {
  return page.evaluate(() => {
    const vp = document.querySelector(".react-flow__viewport");
    return vp ? vp.style.transform : "";
  });
}

/**
 * 量一个连接点是不是「完整可见」。
 *
 * 为什么不能只看它的包围盒：handle 的 rect 永远是完整的 20×20 ——
 * 被兄弟元素盖住一半时，rect 一点都不变。量几何测不出「被盖住」。
 *
 * 所以判据换成**绘制顺序**：在 handle「内侧半圆」的中心点上取
 * elementsFromPoint 的第一个元素，它必须就是 handle 本身。
 * 这正是当初漏掉的 bug —— 裸图形态里左 handle 写在产物层**前面**，
 * 两者都是定位元素且 z-index 都是 auto，于是产物层把它盖掉了；
 * 右 handle 写在产物层**后面**，所以完好。同一个样式，两种结果。
 *
 * 顺带量一件事：圆心是否骑在节点边界上（而不是整个缩在节点里或飘在外面）。
 */
async function handleProbe(page, nodeId, kind) {
  return page.evaluate(
    ({ id, k }) => {
      const root = document.querySelector(`[data-node-id="${id}"]`);
      const h = root?.querySelector(`.react-flow__handle.${k}`);
      if (!h) return null;
      const r = h.getBoundingClientRect();
      const nr = root.getBoundingClientRect();
      // 内侧 = 靠节点中心的那一半
      const cx = k === "target" ? r.x + r.width * 0.75 : r.x + r.width * 0.25;
      const cy = r.y + r.height / 2;
      const stack = document.elementsFromPoint(cx, cy);
      const top = stack[0];
      const edge = k === "target" ? nr.left : nr.right;
      return {
        topIsHandle: Boolean(top?.classList?.contains("react-flow__handle")),
        topCls: String(top?.getAttribute("class") ?? "").slice(0, 50),
        // 圆心和节点边界的偏差（屏幕像素，经过画布缩放，所以给 3px 容差）
        offEdge: +Math.abs(r.x + r.width / 2 - edge).toFixed(1),
        inViewport: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        /*
         * 布局尺寸（画布坐标），不受 transform 影响 —— 所以它是 40，
         * 而 rect.width 在 zoom 0.173 的项目里只有 6.9。
         *
         * 为什么断言要盯这个值而不是 rect.width：屏幕尺寸随项目节点数变化
         * （单节点 0.455 → 18px，多节点 0.173 → 6.9px），拿它当判据会随夹具漂。
         * 而「设计值多少」是我们真正能控制的那一件事。
         */
        designW: h.offsetWidth,
      };
    },
    { id: nodeId, k: kind }
  );
}

/**
 * 真双击。
 *
 * puppeteer 的 mouse.click({clickCount:2}) **不产生 dblclick**
 * （连 document 级捕获都收不到），必须用 CDP 发标准的四段序列。
 */
async function dblclickAt(cdp, x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: "left" };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, clickCount: 2 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, clickCount: 2 });
}

async function selectNode(page, nodeId) {
  const r = await nodeRect(page, nodeId);
  if (!r) throw new Error(`节点不存在：${nodeId}`);
  await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
  await sleep(350);
}

async function uploadFile(page, file) {
  const fab = await page.$('[data-action="toggle-upload"]');
  const open = await page.$("[data-upload-panel]");
  if (!open) await fab.click();
  await page.waitForSelector("[data-upload-input]", { timeout: 3000 });
  await (await page.$("[data-upload-input]")).uploadFile(file);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-node-type="media.asset"]').length > 0,
    { timeout: 25000 }
  );
}

async function centerOf(page, selector) {
  const el = await page.$(selector);
  if (!el) throw new Error(`找不到元素：${selector}`);
  const box = await el.boundingBox();
  if (!box) throw new Error(`元素不可见：${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragConnect(page, fromSelector, toSelector) {
  const from = await centerOf(page, fromSelector);
  const to = await centerOf(page, toSelector);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
}

/**
 * 线的两端各落在哪儿，和两个 handle 的圆心比一比。
 *
 * 为什么要在 SVG user space 里取点再换算：`getPointAtLength` 返回的是
 * 画布坐标（未缩放），而 handle 的 rect 是屏幕坐标（缩放后）。
 * 直接比会把 fitView 的 0.73 缩放算成「偏了 27%」，全是假失败。
 */
async function measureEdge(page, srcId, tgtId) {
  return page.evaluate(
    ({ src, tgt }) => {
      const path = document.querySelector(".react-flow__edge-path");
      if (!path) return null;
      const m = path.getScreenCTM();
      const toScreen = (pt) => {
        const d = new DOMPoint(pt.x, pt.y).matrixTransform(m);
        return { x: d.x, y: d.y };
      };
      const center = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      };
      return {
        start: toScreen(path.getPointAtLength(0)),
        end: toScreen(path.getPointAtLength(path.getTotalLength())),
        src: center(`[data-node-id="${src}"] .react-flow__handle.source`),
        tgt: center(`[data-node-id="${tgt}"] .react-flow__handle.target`),
      };
    },
    { src: srcId, tgt: tgtId }
  );
}

const dy = (a, b) => (a && b ? Math.abs(a.y - b.y) : 999);
const dx = (a, b) => (a && b ? Math.abs(a.x - b.x) : 999);

/* ---------------- 主流程 ---------------- */

fs.mkdirSync(TMP, { recursive: true });
const wideFile = path.resolve(TMP, "bare-wide-1600x800.png");
const tallFile = path.resolve(TMP, "bare-tall-300x600.png");
/*
 * 宽图必须**真的超过上限**（1280）才测得到封顶。
 * 1200×600 在 720 时代是超标的，上限提到 1280 之后它反而变成「小图不放大」，
 * 这条断言会静默变成另一件事的测试 —— 所以跟着上限一起改。
 */
fs.writeFileSync(wideFile, makePng(1600, 800));
fs.writeFileSync(tallFile, makePng(300, 600));

/*
 * 夹具把图像/视频节点钉在 mock.image.v1 / mock.video.v1 上（验的是尺寸与布局，
 * 不关心模型真假）。演示模型现在默认不在清单里，所以先确认跑在世界哪一边。
 * 退出码 2 = 环境不对；跑法见 scripts/_preflight.mjs。
 */
await requireMockWorld();

const { projectId, ids } = setup();

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
  defaultViewport: { width: 1700, height: 1050 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const cdp = await page.createCDPSession();

  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".react-flow__node", { timeout: 20000 });
  await sleep(800);

  /* ================= A. 没有壳 ================= */
  console.log("");
  console.log("=== 图像 / 视频节点：没有边框、没有标题栏 ===");

  const shells = await page.$$eval("[data-node-type]", (els) =>
    els.map((e) => {
      const label = e.querySelector("[data-node-label]");
      return {
        type: e.getAttribute("data-node-type"),
        shell: e.getAttribute("data-shell"),
        hasHeader: Boolean(e.querySelector("[data-card-header]")),
        hasFooter: Boolean(e.querySelector("[data-card-footer]")),
        hasRun: Boolean(e.querySelector('[data-action="run"]')),
        empty: Boolean(e.querySelector("[data-empty]")),
        labelFont: label ? getComputedStyle(label).fontSize : null,
      };
    })
  );
  const imgShell = shells.find((s) => s.type === "image.gen");
  const vidShell = shells.find((s) => s.type === "video.gen");

  check("图像节点声明为裸形态", imgShell?.shell === "bare", JSON.stringify(imgShell));
  check("图像节点没有标题栏", imgShell?.hasHeader === false);
  check("图像节点没有底栏", imgShell?.hasFooter === false);
  check("视频节点也是裸形态", vidShell?.shell === "bare", JSON.stringify(vidShell));
  check("「运行」按钮已从所有节点上消失", shells.every((s) => !s.hasRun));
  check("未生成的图像节点显示占位", imgShell?.empty === true);
  /*
   * 这条是「裸节点标签字号」的护栏，防的是**变量被共用**。
   *
   * 历史：2026-10-24 人要求「只放大卡片里的字，图像生成/视频生成 这些不用动」，
   * 于是裸节点标签和卡片名字分到两个变量。2026-10-26 反过来 ——
   * 人要求把裸节点上的字（标签 / 空态 / 叉号）放大，而标签当时挂在
   * `--fs-title` 上，那个变量**同时是项目页标题**的字号。直接调大会把
   * 页面标题一起带涨，正是他要排除的「界面上的字」。所以又拆出 `--fs-bare-label`。
   *
   * 现在这三个尺度**必须互不相同**，任何一个被合并就会在这里变红：
   *   裸节点标签  36px（--fs-bare-label）
   *   卡片名字    20px（--fs-card-name）
   *   项目页标题  18px（--fs-title）
   */
  check(
    "裸节点标签是 36px（--fs-bare-label，没和卡片名字/界面标题共用变量）",
    imgShell?.labelFont === "36px",
    imgShell?.labelFont
  );

  const idleSize = await nodeSize(page, ids.image);
  check(
    "未生成时用注册表里的占位尺寸 1280×720",
    idleSize?.w === 1280 && idleSize?.h === 720,
    JSON.stringify(idleSize)
  );

  const anyBorder = await page.$eval(
    `[data-node-id="${ids.image}"]`,
    (el) => getComputedStyle(el).borderTopWidth
  );
  check("节点根本没有边框（computed border-width = 0）", anyBorder === "0px", anyBorder);

  /* ================= B. 上传宽图 → 封顶 1280 ================= */
  console.log("");
  console.log("=== 上传 1600×800：长边封顶 1280，比例不变 ===");

  await uploadFile(page, wideFile);
  /*
   * 等「高度变了」而不是「宽度变了」：宽图的长边就是宽，
   * 所以它缩放后的宽度**必然**等于上限 1280，而占位宽度也正好是 1280 ——
   * 拿 offsetWidth !== 1280 当判据会永远等不到，超时且看不出原因。
   * 高度没有这个问题：占位 720，产物 640。
   */
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-node-type="media.asset"]');
      return el && el.offsetHeight !== 720;
    },
    { timeout: 15000 }
  );
  await sleep(300);

  const wideId = await page.$eval(
    '[data-node-type="media.asset"]',
    (el) => el.getAttribute("data-node-id")
  );
  const wideSize = await nodeSize(page, wideId);
  // 1600×800 → 长边 1600 超上限 → 1280/1600 = 0.8 → 1280×640
  check("宽图缩到 1280×640", wideSize?.w === 1280 && wideSize?.h === 640, JSON.stringify(wideSize));

  const wideNatural = await page.$eval(
    `[data-node-id="${wideId}"] img`,
    (el) => ({ w: el.naturalWidth, h: el.naturalHeight })
  );
  check("图片本身的像素是 1600×800", wideNatural.w === 1600 && wideNatural.h === 800, JSON.stringify(wideNatural));
  check(
    "节点比例和图片比例一致（误差 ≤ 1px）",
    Math.abs(wideSize.w / wideSize.h - wideNatural.w / wideNatural.h) < 0.01,
    `${(wideSize.w / wideSize.h).toFixed(4)} vs ${(wideNatural.w / wideNatural.h).toFixed(4)}`
  );

  /* ================= C. 上传竖图 → 不放大 ================= */
  console.log("");
  console.log("=== 上传 300×600：小图不放大，长边 1280 只封顶不放 ===");

  await uploadFile(page, tallFile);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-node-type="media.asset"]').length === 2,
    { timeout: 15000 }
  );
  /*
   * 判据用「出现一个 300 宽的节点」而不是「所有节点宽度都不是 1280」：
   * 宽图缩放后宽度正好是 1280，两条路径的宽度会撞在一起，分不开。
   */
  await page.waitForFunction(
    () => {
      const els = [...document.querySelectorAll('[data-node-type="media.asset"]')];
      return els.some((e) => e.offsetWidth === 300);
    },
    { timeout: 15000 }
  );
  await sleep(300);

  const tallId = await page.$$eval('[data-node-type="media.asset"]', (els) =>
    els
      .map((e) => ({
        id: e.getAttribute("data-node-id"),
        w: e.offsetWidth,
        h: e.offsetHeight,
      }))
      .find((x) => x.w === 300)?.id
  );
  const tallSize = await nodeSize(page, tallId);
  check("竖图按原样 300×600（没有被放大到 1280）", tallSize?.w === 300 && tallSize?.h === 600, JSON.stringify(tallSize));

  /* ================= D. 尺寸落库，刷新不回跳 ================= */
  console.log("");
  console.log("=== 尺寸写进节点数据，刷新后一次到位 ===");

  // 画布落库是 800ms 防抖（见 Canvas.tsx）。这里必须等它写完，
  // 否则 reload 会把「还没存下来的节点」整个丢掉 —— 上一版就是这样错的。
  await sleep(1600);

  const wideData = readData(wideId);
  check("宽图的 naturalW/H 落库", wideData.naturalW === 1600 && wideData.naturalH === 800, JSON.stringify({
    naturalW: wideData.naturalW,
    naturalH: wideData.naturalH,
  }));

  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector(".react-flow__node", { timeout: 20000 });
  await sleep(700);

  /*
   * 这里**不**点 fitView 控件：首屏对齐是产品自己的行为，脚本去代劳
   * 就等于把「打开项目看不见节点」那个 bug 盖住了。
   * 后面能点中节点、能读到正确尺寸，本身就说明它在视野里。
   */
  await sleep(400);

  if (process.env.E2E_DEBUG) {
    console.log(
      JSON.stringify(
        await page.evaluate(() => ({
          transform: document.querySelector(".react-flow__viewport")?.style.transform,
          vw: innerWidth,
          vh: innerHeight,
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
        })),
        null,
        2
      )
    );
  }

  const afterReloadWide = await nodeSize(page, wideId);
  const afterReloadTall = await nodeSize(page, tallId);
  check(
    "刷新后宽图仍是 1280×640（不是先从 1280×720 的占位跳过去的）",
    afterReloadWide?.w === 1280 && afterReloadWide?.h === 640,
    JSON.stringify(afterReloadWide)
  );
  check("刷新后竖图仍是 300×600", afterReloadTall?.w === 300 && afterReloadTall?.h === 600, JSON.stringify(afterReloadTall));

  /* ================= D2. 连接点不能被产物盖住 ================= */
  console.log("");
  console.log("=== 左右两个连接点都完整可见（骑在边界上，不被图盖住） ===");

  /*
   * 这条必须有：裸图形态下节点里唯一的兄弟元素就是「那张图」。
   * 连接点一半在节点内、一半在外，节点内那半会不会被图盖掉，
   * 取决于它和产物层谁先绘制 —— 而那个顺序由 JSX 里写的先后决定。
   * 一旦被盖，症状是「左边只剩半个圆、右边好好的」，不报任何错。
   */
  for (const c of [
    // 素材节点 accepts 为空 → 它只有输出端口，没有输入端口。
    // 这不是漏掉，是「画一个永远接不上的点等于邀请用户犯错」那条规则的体现，
    // 所以这里把它当成一条**该成立**的断言，而不是跳过。
    { label: "带产物的素材节点", nodeId: tallId, hasInput: false },
    { label: "空态的图像节点", nodeId: ids.image, hasInput: true },
  ]) {
    const l = await handleProbe(page, c.nodeId, "target");
    const out = await handleProbe(page, c.nodeId, "source");

    check(
      `${c.label}：${c.hasInput ? "有输入端口" : "没有输入端口（accepts 为空）"}`,
      Boolean(l) === c.hasInput,
      `target handle = ${l ? "有" : "无"}`
    );
    check(`${c.label}：输出端口在视口内`, out?.inViewport === true, JSON.stringify(out));
    check(`${c.label}：右侧连接点完整可见`, out?.topIsHandle === true, `顶层是 ${out?.topCls}`);
    check(
      `${c.label}：右侧连接点骑在节点边界上`,
      out && out.offEdge <= 3,
      `偏差 ${out?.offEdge}px`
    );
    /*
     * 连接点太小是**只有真点过才知道**的问题：20px 设计值在 zoom 0.173 的项目里
     * 屏幕上只有 3.5px，视觉上"看得见"、手上"点不中"。所有几何类断言
     * （在视口内 / 骑在边界上 / 完整可见）在 3.5px 时全绿，所以必须单独量尺寸。
     * 门槛取 40：这是人拍板的值（10 → 20 → 40）。
     */
    check(
      `${c.label}：连接点不小于 40px（画布坐标）`,
      out && out.designW >= 40,
      `设计值 ${out?.designW}px`
    );

    if (c.hasInput) {
      check(`${c.label}：左侧连接点完整可见`, l?.topIsHandle === true, `顶层是 ${l?.topCls}`);
      check(`${c.label}：左侧连接点骑在节点边界上`, l && l.offEdge <= 3, `偏差 ${l?.offEdge}px`);
    }
  }

  /* ================= E. 选中才出现的两个操作 ================= */
  console.log("");
  console.log("=== 下载在上方、删除在右上角外侧 —— 都只在选中时出现 ===");

  const beforeSelect = await page.$$eval("[data-action='download'], [data-action='delete']", (e) => e.length);
  check("没选中时画布上一个操作按钮都没有", beforeSelect === 0, String(beforeSelect));

  await selectNode(page, tallId);
  const tallRect = await nodeRect(page, tallId);
  const panelRect = await rectOf(page, `[data-node-panel="${tallId}"]`);
  const delRect = await rectOf(page, `[data-node-id="${tallId}"] [data-action="delete"]`);

  /*
   * 素材节点**不该**浮参数面板（2026-10-26 人要求删掉）。
   *
   * 它是纯输入：没有提示词、没有模型下拉、没有动作。面板里原本只剩一行
   * 「文件名 + 体积」的只读小字 —— 选中就冒出来一个什么都填不了的浮窗。
   * 面板容器带着边框/圆角/阴影，所以只删那一行会剩下一个空盒子；
   * 实现是「一行可渲染项都没有 → 整块不渲染」，这条直接判它不存在。
   *
   * 反向验证：把 NodePanel 里那个提前 return 去掉，这条立刻红。
   *
   * 顺带说明为什么这里不再量面板几何（下方 8px、最小宽度）：
   * 那些断言的对象现在是图像/文本节点，由 probe-panel.mjs 按三种 zoom 量，
   * 素材这块已经没有面板可量了。
   */
  check("素材节点选中后不浮参数面板", panelRect === null, JSON.stringify(panelRect));

  check("选中后出现删除按钮", Boolean(delRect));
  check(
    "删除按钮在节点右边界之外",
    delRect && delRect.x >= tallRect.right - 0.5,
    `btn.left=${delRect?.x?.toFixed(1)} node.right=${tallRect.right.toFixed(1)}`
  );

  /* ================= F. 双击不缩放画布 ================= */
  console.log("");
  console.log("=== 双击裸图不缩放画布 ===");

  const zoomBefore = await viewportTransform(page);
  await dblclickAt(cdp, tallRect.x + tallRect.w / 2, tallRect.y + tallRect.h / 2);
  await sleep(400);
  const zoomAfter = await viewportTransform(page);
  check("双击图片后画布视口逐字符相同", zoomBefore === zoomAfter, `${zoomBefore} → ${zoomAfter}`);

  /* ================= G. 双击标签改名 ================= */
  console.log("");
  console.log("=== 标题栏没了，但改名入口还得在：双击节点上方的标签 ===");

  const labelRect = await rectOf(page, `[data-node-id="${tallId}"] [data-node-label]`);
  check("节点外侧有标签行", Boolean(labelRect));
  check(
    "标签在节点上方之外",
    labelRect && labelRect.bottom <= tallRect.y + 0.5,
    `label.bottom=${labelRect?.bottom?.toFixed(1)} node.top=${tallRect.y.toFixed(1)}`
  );

  await dblclickAt(cdp, labelRect.x + 12, labelRect.y + labelRect.h / 2);
  await page.waitForSelector(`[data-node-id="${tallId}"] [data-node-label] input[data-field="label"]`, {
    timeout: 3000,
  });
  check("双击标签出现改名输入框", true);

  await page.click(`[data-node-id="${tallId}"] [data-node-label] input[data-field="label"]`);
  // 三击选不干净（光标是 focusOnMount 放到末尾的，三击位置未必覆盖全文），
  // 用 Ctrl+A 明确全选再打字，否则会变成「旧名字中间插进新字」。
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.type("竖图素材");
  await sleep(120);
  await page.keyboard.press("Escape");
  // 防抖 400ms 写回 store + 800ms 画布防抖落库，留够
  await sleep(1600);
  check("改名落库", readData(tallId).label === "竖图素材", String(readData(tallId).label));

  /* ================= H. 连线端点跟着尺寸走 ================= */
  console.log("");
  console.log("=== 节点变高之后，连线端点必须还在边上 ===");

  await page.mouse.click(60, 980);
  await sleep(300);
  await dragConnect(
    page,
    `[data-node-id="${tallId}"] .react-flow__handle.source`,
    `[data-node-id="${ids.image}"] .react-flow__handle.target`
  );
  await sleep(600);

  const edgeGeo = await measureEdge(page, tallId, ids.image);

  check("连线画出来了", Boolean(edgeGeo));
  /*
   * 判据只看**垂直方向**。
   *
   * 水平方向天生差了一个 handle 半径（线接在圆点边缘而不是圆心），
   * 拿总距离去断言只会得到一条「差 7px」的假失败。
   * 而尺寸变化真正会破坏的就是垂直对齐：节点从 720 高变成 432 高，
   * handle 还在旧的中点（360）上的话，实际中点已经到 216，y 会差 144px —— 
   * 一眼就能看出来。
   */
  check(
    "线起点和源节点端点在同一个高度",
    dy(edgeGeo?.start, edgeGeo?.src) < 3,
    `Δy=${dy(edgeGeo?.start, edgeGeo?.src).toFixed(1)}px`
  );
  check(
    "线起点在源节点端点附近（水平差不超过一个 handle 半径）",
    dx(edgeGeo?.start, edgeGeo?.src) < 20,
    `Δx=${dx(edgeGeo?.start, edgeGeo?.src).toFixed(1)}px`
  );
  check(
    "线终点和目标节点端点在同一个高度",
    dy(edgeGeo?.end, edgeGeo?.tgt) < 3,
    `Δy=${dy(edgeGeo?.end, edgeGeo?.tgt).toFixed(1)}px`
  );
  check(
    "线终点在目标节点端点附近",
    dx(edgeGeo?.end, edgeGeo?.tgt) < 20,
    `Δx=${dx(edgeGeo?.end, edgeGeo?.tgt).toFixed(1)}px`
  );

  /* ================= H2. 线已经连着，节点再变尺寸 ================= */
  console.log("");
  console.log("=== 线已经连着时目标节点从 720 变到 432：线必须跟着端点走 ===");

  const imgBefore = await nodeSize(page, ids.image);
  check(
    "生成前图像节点是占位尺寸 1280×720",
    imgBefore?.w === 1280 && imgBefore?.h === 720,
    JSON.stringify(imgBefore)
  );

  await selectNode(page, ids.image);
  await page.click(`[data-node-id="${ids.image}"] [data-action="send"]`);
  await page.waitForFunction(
    (id) => {
      const el = document.querySelector(`[data-node-id="${id}"]`);
      const s = el?.getAttribute("data-status");
      return s === "succeeded" || s === "failed";
    },
    { timeout: 120000 },
    ids.image
  );
  // 图片解码 → 写回 naturalW/H → 节点重排，给这条链留时间
  await sleep(1200);

  const imgAfter = await nodeSize(page, ids.image);
  /*
   * Mock 产物是 768×432，长边 768 没超上限 1280 → 不缩放，按原始像素显示。
   * （上限还是 720 的时候这里会被压成 720×405，所以这条断言能区分两者。）
   */
  check("产物 768×432 未超上限，按原始像素显示", imgAfter?.w === 768 && imgAfter?.h === 432, JSON.stringify(imgAfter));

  const imgData = readData(ids.image);
  check(
    "产物像素尺寸也落库了（768×432）",
    imgData.naturalW === 768 && imgData.naturalH === 432,
    JSON.stringify({ naturalW: imgData.naturalW, naturalH: imgData.naturalH })
  );

  const imgRect = await nodeRect(page, ids.image);
  const dlRect = await rectOf(page, `[data-node-id="${ids.image}"] [data-action="download"]`);
  check("生成后出现下载按钮", Boolean(dlRect));
  check(
    "下载按钮完全在节点上方",
    dlRect && dlRect.bottom <= imgRect.y + 0.5,
    `btn.bottom=${dlRect?.bottom?.toFixed(1)} node.top=${imgRect.y.toFixed(1)}`
  );

  const edgeAfter = await measureEdge(page, tallId, ids.image);
  /*
   * 这条断言要有区分力，必须两步：
   *   ① 端点**确实移动了** —— 不然「线和端点在同一个高度」可能只是因为谁都没动
   *   ② 线仍然贴着端点 —— 这才是被验证的性质
   * 只写②的话，一个根本不重测量的实现也能通过（两边都停在旧位置）。
   */
  const moved = Math.abs((edgeAfter?.tgt?.y ?? 0) - (edgeGeo?.tgt?.y ?? 0));
  check("端点位置真的变了（否则下面的断言没有区分力）", moved > 20, `移动了 ${moved.toFixed(1)}px`);
  check(
    "节点尺寸变了之后，线的终点仍然贴着端点",
    dy(edgeAfter?.end, edgeAfter?.tgt) < 3,
    `Δy=${dy(edgeAfter?.end, edgeAfter?.tgt).toFixed(1)}px`
  );

  /* ================= H2. 线宽（屏幕像素恒定） ================= */
  console.log("");
  console.log("=== 连线的粗细不随画布缩放变 ===");

  /*
   * 这条断言盯的是「鼠标看到的那几像素」，不是画布里的设计值。
   *
   * 起因：人报「线太细」。查下来 stroke-width 一直是 1，可它画在
   * `.react-flow__viewport` 里，那个 div 带 `transform: scale(zoom)`，
   * 所以屏幕上只有 `1 × zoom`。多节点项目 zoom 0.173 时 = **0.17px**：
   * 所有几何断言（起点对齐、终点贴合）都不会红，因为它测得全对 ——
   * 只是细到看不见。所以必须单独量屏幕宽度。
   *
   * 判据用 `strokeWidth × zoom` 而不是像素采样：后者要解码截图，
   * 而前者是同一个乘法，任何缩放级别都能用。反向验证时把
   * `EDGE_SCREEN_W` 改回 1 就能让这条红（设计值变 1，屏幕变 0.17）。
   */
  const edgeWidthProbe = () =>
    page.evaluate(() => {
      const m = getComputedStyle(document.querySelector(".react-flow__viewport")).transform.match(/matrix\(([^)]+)\)/);
      const zoom = m ? Number(m[1].split(",")[0]) : null;
      const path = document.querySelector(".react-flow__edge-path");
      const sw = path ? parseFloat(getComputedStyle(path).strokeWidth) : null;
      return { zoom, sw, screen: zoom && sw ? sw * zoom : null };
    });

  const w0 = await edgeWidthProbe();
  check(
    "首屏线宽 = 屏幕 1.5px",
    w0.screen !== null && Math.abs(w0.screen - 1.5) <= 0.12,
    `设计 ${w0.sw}px × zoom ${w0.zoom?.toFixed(3)} = ${w0.screen?.toFixed(2)}px`
  );

  // 只量首屏有可能「碰巧对」—— 缩放到另一个级别再量，才是真的验证。
  // 注意：滚轮必须落在画布空白处。落在卡片上时 wheel 事件被节点吃掉
  // （节点带 nowheel），zoom 一点都不变 —— 断言会因此假红（实测踩过）。
  const paneCenter = await page.evaluate(() => {
    const r = document.querySelector(".react-flow__pane")?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  await page.mouse.move(paneCenter.x, paneCenter.y);
  for (let i = 0; i < 12; i++) await page.mouse.wheel({ deltaY: -240 });
  await sleep(600);
  const w1 = await edgeWidthProbe();
  check(
    "放大之后线宽仍然是屏幕 1.5px",
    w1.screen !== null && Math.abs(w1.screen - 1.5) <= 0.12 && w1.zoom !== w0.zoom,
    `设计 ${w1.sw}px × zoom ${w1.zoom?.toFixed(3)} = ${w1.screen?.toFixed(2)}px`
  );

  /* ================= I. 删除 ================= */
  console.log("");
  console.log("=== 右上角圆形叉号真的能删 ===");

  await selectNode(page, tallId);
  const nodeCountBefore = await page.$$eval("[data-node-id]", (e) => e.length);
  await page.click(`[data-node-id="${tallId}"] [data-action="delete"]`);
  await sleep(500);
  const nodeCountAfter = await page.$$eval("[data-node-id]", (e) => e.length);
  check("点叉号删掉了一个节点", nodeCountAfter === nodeCountBefore - 1, `${nodeCountBefore} → ${nodeCountAfter}`);

  await page.screenshot({ path: `${TMP}/11-bare-node.png` });

  console.log("");
  console.log("=== 页面没有报错 ===");
  check("没有未捕获异常", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  const db = new Database("dev.db");
  cleanupProject(db, projectId);
  db.close();
}

console.log("");
console.log(`共 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
