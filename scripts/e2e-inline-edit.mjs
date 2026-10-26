/**
 * 卡片内联编辑验收 —— 双击节点，正文在卡片框里就能改。
 *
 * 跑法：node scripts/e2e-inline-edit.mjs
 * 需要 dev 在 3000 端口跑着。自建独立测试项目，跑完清理。
 *
 * ### 这里为什么必须用真浏览器
 *
 * 这一整套东西没有任何一个环节能靠调 API 验出来：
 *   - 双击是不是真的进了编辑态（React 合成事件 + d3-zoom 抢事件）
 *   - 双击会不会顺带把画布放大一级（这是最阴的一个，没有报错）
 *   - 编辑态下卡片尺寸有没有变（变一像素，连线端点就会重算）
 *   - 焦点从正文移到底栏/面板时，编辑态是不是被误杀
 *   - 输入框里的字有没有真的落库（防抖 + 卸载 flush）
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const PROJECT_NAME = "__inline_edit_e2e__";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

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

  const projectId = newId("e2ex");
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

  const ids = { text: newId("e2ext"), image: newId("e2exi") };
  const mk = (id, type, x, y, data) =>
    insert.run(id, projectId, type, x, y, JSON.stringify(data), "idle", now, now);

  // 分开摆，避免两块面板互相压住
  mk(ids.text, "text.prompt", -260, -140, {
    label: "剧本",
    prompt: "原始内容",
    status: "idle",
  });
  mk(ids.image, "image.gen", 320, -140, {
    label: "图",
    prompt: "一张图",
    negativePrompt: "",
    aspectRatio: "16:9",
    status: "idle",
  });

  db.close();
  return { projectId, ids };
}

function readData(projectId, nodeId) {
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

/**
 * 读节点某个字段。
 *
 * 不能只留一个 readPrompt() 读 `.prompt`：卡片主体编辑的是
 * `optimizedPrompt`，而 `.prompt` 是面板里那段原始描述。
 * 混用会让「输入框里明明有字、库里却是空的」这种断言失败看起来像 bug。
 */
function readField(nodeId, key) {
  return readData(null, nodeId)[key];
}

/**
 * 等某个字段变成期望值，最多等 6 秒。
 *
 * 为什么不写 `await sleep(1700)` 然后读一次：那是在**赌机器速度**。
 * 400ms 改 store + 800ms 防抖落库，冷启动（dev server 刚重启、首次编译）
 * 时会超时，症状是这条断言偶发变红、重跑又绿 —— 最浪费时间的一类失败，
 * 因为它看起来像产品的 bug。
 *
 * 固定等待还有个反向问题：等得够久时它掩盖了「落库其实很慢」；
 * 轮询则只在真的写进去了才通过，同时把实际耗时留在了失败信息里。
 */
async function waitForField(nodeId, key, expected, timeout = 6000) {
  return waitUntil(() => readField(nodeId, key) === expected, timeout);
}

/** 通用轮询：predicate 返回 true 就过。返回实际耗时和最后一次的值，供失败信息用 */
async function waitUntil(predicate, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    const ok = predicate();
    if (ok) return { ok: true, ms: Date.now() - start };
    if (Date.now() - start > timeout) return { ok: false, ms: Date.now() - start };
    await sleep(150);
  }
}

/**
 * 打开项目页并等到节点出现 —— 带重试。
 *
 * 为什么不能只写一次 `goto + waitForSelector`：
 *
 *   · 项目页有一条常驻 SSE（/api/runs/stream），dev 下还有 HMR 的 websocket，
 *     所以 `networkidle2` 永远等不到「网络空闲」。
 *   · dev 在**第一次编译完这个路由**（或者 watch 目录里有任何文件变动）之后，
 *     会让已经打开的页面整页刷新一次。刷新的那一刻，正在跑的
 *     `waitForSelector` / `evaluate` 会抛
 *     `Execution context was destroyed` 或 `Cannot find context with specified id`
 *     —— 这不是页面坏了，重来一次就好。
 *   · 用 `next dev` 的机器上，这个刷新几乎每次跑脚本都会撞上一次。
 *
 * 所以判据只有一个：`.react-flow__node` 真的出现了。
 */
async function openProject(page, url, tries = 8) {
  /*
   * 用「轮询 + 出错就继续」而不是 waitForSelector。
   *
   * 为什么：脚本自己在往 dev.db 里写夹具数据，而 Turbopack 在 watch 项目目录，
   * 库文件一变就可能触发一次重编译 → 已打开的页面整页刷新 →
   * 正在跑的 waitForSelector 立刻抛 context destroyed。
   * 只要等的是「节点数量 > 0」，这个中断就可以自然穿过去。
   */
  for (let i = 0; i < tries; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      if (!/context|navigation|timed out|Timeout/i.test(String(e))) throw e;
    }
    for (let j = 0; j < 40; j++) {
      try {
        const n = await page.evaluate(
          () => document.querySelectorAll(".react-flow__node").length
        );
        if (n > 0) return;
      } catch {
        /* 正在刷新，下一轮再来 */
      }
      await sleep(500);
    }
  }
  throw new Error("页面一直没能稳定加载：.react-flow__node 始终没出现");
}

/**
 * 真双击。
 *
 * puppeteer 的 `mouse.click(x, y, { clickCount: 2 })` **不产生 dblclick** ——
 * 它只把 clickCount 塞进事件里，浏览器不会合成双击。连 document 级的
 * 捕获监听都收不到，症状是「双击功能看起来是坏的」，其实是测试写错了。
 * 必须用 CDP 发标准的「按下1-松开1-按下2-松开2」四段序列。
 */
async function dblclickAt(cdp, x, y) {
  const base = { x, y, button: "left" };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: 2 });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: 2 });
  await sleep(280);
}

/** 某个类型节点的卡片矩形（屏幕坐标） */
async function nodeRect(page, type) {
  return page.evaluate((t) => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === t
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, type);
}

/** 双击点在主体正中：卡片 768 高，主体在 40~730，取 0.5 处正好在中间 */
function bodyPoint(rect) {
  return { x: rect.x + rect.w * 0.45, y: rect.y + rect.h * 0.5 };
}

async function cardState(page, type) {
  return page.evaluate((t) => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === t
    );
    if (!el) return null;
    return {
      editing: el.getAttribute("data-editing"),
      // 用 offsetWidth/offsetHeight 而不是 getBoundingClientRect：
      // 后者是画布缩放后的屏幕尺寸，fitView 缩到 66% 时会误判成「尺寸没生效」。
      w: el.offsetWidth,
      h: el.offsetHeight,
      hasCardEditor: Boolean(el.querySelector("[data-card-editor]")),
      labelInputInCard: Boolean(el.querySelector('[data-card-header] input[data-field="label"]')),
      hasPanel: Boolean(el.querySelector("[data-node-panel]")),
      panelTextareas: [...el.querySelectorAll("[data-node-panel] textarea")].map((x) =>
        x.getAttribute("data-field")
      ),
      panelSelects: [...el.querySelectorAll("[data-node-panel] select")].map((x) =>
        x.getAttribute("data-field")
      ),
    };
  }, type);
}

/** 编辑器的滚动状态：能滚，且滚动条被藏掉 */
async function editorScrollState(page, type) {
  return page.evaluate((t) => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === t
    );
    const ta = el?.querySelector("[data-card-editor]");
    if (!ta) return null;
    const cs = getComputedStyle(ta);
    return {
      scrollH: ta.scrollHeight,
      clientH: ta.clientHeight,
      /*
       * 判据必须是 scrollbarWidth，不能是 offsetWidth - clientWidth。
       *
       * 后者是上一轮用的，它什么都证明不了：Chrome 的 overlay 滚动条本来
       * 就不占宽度，所以无论滚动条在不在，这个差值都是「边框 2px」。
       * 那一版"验证通过"了，用户看到的却还是滚动条 —— 判据选错的典型。
       */
      scrollbarWidth: cs.scrollbarWidth,
      wGap: ta.offsetWidth - ta.clientWidth,
    };
  }, type);
}

async function viewportTransform(page) {
  return page.evaluate(() => {
    const vp = document.querySelector(".react-flow__viewport");
    return vp ? vp.style.transform : "";
  });
}

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

  /*
   * 用 openProject：SSE 让 networkidle2 永远等不到空闲，而 dev 编译完
   * 会整页刷新一次、把正在跑的等待打断。判据只有「节点出现了」。
   */
  await openProject(page, `${BASE}/projects/${projectId}`);
  await sleep(1100);

  console.log("=== 初始：只读状态 ===");
  const rect0 = await nodeRect(page, "text.prompt");
  const s0 = await cardState(page, "text.prompt");
  check("卡片上有 data-editing=0", s0.editing === "0", String(s0.editing));
  check("没有卡内编辑器（只读时不渲染输入框）", !s0.hasCardEditor, JSON.stringify(s0));
  check("卡片尺寸 1024×768", s0.w === 1024 && s0.h === 768, `${s0.w}×${s0.h}`);
  /*
   * 和图片 / 视频节点同一个出场时机：选中才出现。
   *
   * 卡片上的叉号原来是「底栏里常驻」，现在换成右上角圆形之后如果忘了加
   * `selected` 条件，它会一直在画布上挂着 —— 而单个节点的截图上完全看不出
   * 问题（它本来就在右上角）。只有「未选中时那东西不该在」能抓到。
   */
  check(
    "未选中时没有删除叉号",
    await page.evaluate(
      () => !document.querySelector('[data-node-type="text.prompt"] [data-action="delete"]')
    )
  );

  console.log("");
  console.log("=== 双击进入编辑 ===");
  const zoomBefore = await viewportTransform(page);
  await dblclickAt(cdp, bodyPoint(rect0).x, bodyPoint(rect0).y);

  const s1 = await cardState(page, "text.prompt");
  check("双击后进入正文编辑态", s1.editing === "body", String(s1.editing));
  check("出现卡内编辑器", s1.hasCardEditor, JSON.stringify(s1));
  check(
    "编辑器字段是 optimizedPrompt（卡片放的是优化结果）",
    (await page.evaluate(() => {
      const ta = document.querySelector("[data-card-editor]");
      return ta?.getAttribute("data-field");
    })) === "optimizedPrompt"
  );

  const zoomAfter = await viewportTransform(page);
  // 这条最容易漏：React Flow 的 d3-zoom 把「双击放大」挂在画布上，
  // 双击节点会冒泡上去顺带放大一级，而且没有任何报错。
  check("双击没有缩放画布", zoomBefore === zoomAfter, `${zoomBefore} → ${zoomAfter}`);

  check(
    "编辑器自动获得焦点",
    await page.evaluate(() => document.activeElement?.hasAttribute?.("data-card-editor") === true)
  );

  const s1h = await cardState(page, "text.prompt");
  check("编辑态下卡片尺寸不变（仍是 1024×768）", s1h.w === 1024 && s1h.h === 768, `${s1h.w}×${s1h.h}`);

  console.log("");
  console.log("=== 编辑态下浮层必须收起 ===");
  // 双击会先选中节点，按旧逻辑面板会跟着浮出来。写字时把参数摊在下面既挤视线
  // 又让人分心，所以 editing 期间面板不该存在。
  check("编辑态没有浮层面板", !s1.hasPanel, JSON.stringify(s1));

  console.log("");
  console.log("=== 输入并落库 ===");
  await page.click("[data-card-editor]");
  await sleep(150);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await cdp.send("Input.insertText", { text: "E2E-CHANGED" });
  // 400ms 防抖写 store + 800ms 防抖落库。这里**不猜时间**，轮询到写进去为止。
  const saved = await waitForField(ids.text, "optimizedPrompt", "E2E-CHANGED");
  check(
    "新内容已经写进数据库的 optimizedPrompt",
    saved.ok,
    saved.ok
      ? `落库耗时 ${saved.ms}ms`
      : `${saved.ms}ms 超时，实际读到 ${String(readField(ids.text, "optimizedPrompt"))}`
  );
  check(
    "原始描述没有被卡片编辑覆盖",
    readField(ids.text, "prompt") === "原始内容",
    String(readField(ids.text, "prompt"))
  );
  const s3 = await cardState(page, "text.prompt");
  check("落库后卡片尺寸依然没变", s3.w === 1024 && s3.h === 768, `${s3.w}×${s3.h}`);

  console.log("");
  console.log("=== 长文本：能滚，但看不见滚动条 ===");
  /*
   * 2400 字，不是 240 字。
   *
   * 卡片从 400×250 放大到 1024×768 之后，编辑器能装的内容：
   * 30px 字、单行约 33 字、可用高 666px ≈ 13 行 ≈ 430 字。
   * 240 字只占 6 行，这条「能滚动」的断言会变成永假 ——
   * 而且失败信息只会说 scrollH 不大于 clientH，
   * 完全看不出是「内容不够多」还是「滚动坏了」。
   */
  await cdp.send("Input.insertText", {
    text: "很长的正文。".repeat(400),
  });
  await sleep(200);
  const scroll = await editorScrollState(page, "text.prompt");
  check("内容超出后可以滚动", scroll.scrollH > scroll.clientH, JSON.stringify(scroll));
  check("滚动条被藏起来", scroll.scrollbarWidth === "none", `scrollbar-width=${scroll.scrollbarWidth}`);

  // 留一张编辑态的图，方便肉眼核对（自动化断言看不出"丑"）
  await page.screenshot({ path: ".e2e-tmp/07-editing.png" });

  console.log("");
  console.log("=== Esc 退出，内容不丢 ===");
  await page.keyboard.press("Escape");
  await sleep(250);
  const s4 = await cardState(page, "text.prompt");
  check("Esc 后退出编辑态", s4.editing === "0", String(s4.editing));
  check("退出后编辑器卸载、回到只读正文", !s4.hasCardEditor, JSON.stringify(s4));
  // 卸载 flush 是同步补写的，但落库仍是 800ms 防抖 —— 同样不猜时间。
  // 判据用 includes 而不是 ===：上一步 Ctrl+A 之后，长文是接在 E2E-CHANGED 后面的。
  const flushed = await waitUntil(() => {
    const v = readField(ids.text, "optimizedPrompt");
    return typeof v === "string" && v.includes("很长的正文。") && v.length > 2000;
  });
  check(
    "长文在退出时补写进了数据库（卸载 flush）",
    flushed.ok,
    `${flushed.ms}ms 后读到 ${String(readField(ids.text, "optimizedPrompt")?.length)} 字`
  );

  console.log("");
  console.log("=== 只读态：长文不许压到底栏 ===");
  /*
   * 这一组是为了防一个真实的翻车：`line-clamp-7` 在 Tailwind 里是**不存在**的类
   * （内置只有 1..6），写错了不报错、不生成样式，症状是正文一路写到卡片底边、
   * 被 overflow-hidden 从半行处切断，看起来只像"文案有点挤"。
   * 所以要同时验「截断值生效」和「几何上没溢出」——只看其中一条会漏。
   */
  const layout = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === "text.prompt"
    );
    const body = el.querySelector("[data-card-body]");
    const footer = el.querySelector("[data-card-footer]");
    const p = body.querySelector("p");
    const del = el.querySelector('[data-action="delete"]');
    /*
     * 节点根元素的 offsetWidth 是**设计值**（1024），rect.width 是屏幕值，
     * 两者相除就是 zoom。屏幕值才是「点不点得到」的判据 ——
     * 设计值 64 在 zoom 0.267 的项目里只有 17px。
     */
    const zoom = el.getBoundingClientRect().width / el.offsetWidth;
    const elRect = el.getBoundingClientRect();
    const delRect = del?.getBoundingClientRect();
    return {
      bodyH: body.offsetHeight,
      pBottom: p.getBoundingClientRect().bottom,
      bodyBottom: body.getBoundingClientRect().bottom,
      footerTop: footer.getBoundingClientRect().top,
      clamp: getComputedStyle(p).webkitLineClamp,
      fontSize: getComputedStyle(p).fontSize,
      lineHeight: getComputedStyle(p).lineHeight,
      cardBadge: getComputedStyle(el.querySelector("[data-card-header] span")).fontSize,
      cardMeta: getComputedStyle(footer.querySelector("span")).fontSize,
      headerText: el.querySelector("[data-card-header]").textContent,
      delInFooter: Boolean(footer.querySelector('[data-action="delete"]')),
      delW: del?.offsetWidth ?? 0,
      delH: del?.offsetHeight ?? 0,
      delLeft: delRect ? +delRect.left.toFixed(1) : 0,
      cardRight: +elRect.right.toFixed(1),
      delRadius: del ? getComputedStyle(del).borderTopLeftRadius : "",
      delScreenW: delRect ? +(delRect.width).toFixed(1) : 0,
    };
  });
  /*
   * 字号断言是这一组里唯一能证明「CSS 变量真的生效」的东西。
   *
   * 字号全部改成 text-[length:var(--fs-body)] 之后，变量一旦没定义
   * （或者 Tailwind 没生成这个任意值），结果不是报错，而是**回落成继承的
   * 默认 16px** —— 页面照常渲染，只是小了一号。几何断言（不溢出、不压底栏）
   * 反而会因为字变小而更容易通过。所以必须直接读 computed fontSize。
   */
  check("正文用的是 30px（CSS 变量生效）", layout.fontSize === "30px", layout.fontSize);
  check("行高 1.625 = 48.75px", layout.lineHeight === "48.75px", layout.lineHeight);
  /*
   * 卡片上下的两条 chrome 是 32px（2026-10-26 人要求放大，原来 16px）。
   *
   * 这里原本是两条：名字 20px（--fs-card-name）、底栏 16px（--fs-card-meta）。
   * 那一轮拆变量是为了「卡片里的字和界面上的字互不牵连」——
   * 现在名字整块删掉，--fs-card-name 一并消失；--fs-card-meta 改名成
   * --fs-card-chrome（32 已经不是「meta」了）。
   *
   * 判据仍然是**直接读 computed fontSize**：变量没定义不会报错，
   * 只会回落成继承的 16px，几何断言反而更容易通过。
   */
  check("头部徽标是 32px（--fs-card-chrome）", layout.cardBadge === "32px", layout.cardBadge);
  check("底栏字数与提示也是 32px", layout.cardMeta === "32px", layout.cardMeta);
  /*
   * 头部只剩一个词。
   *
   * 原来这里并排放着类型徽标「文本提示词」和节点名「剧本描述」，右边还有状态
   * 「待运行」。人要求「这一块改为提示词优化」「待运行删掉」，
   * 所以整个头部的文本应该精确等于「提示词优化」—— 多一个字都说明
   * 有东西被加回来了（比如状态文字又常驻，或者名字又渲染出来了）。
   */
  check("头部只有「提示词优化」四个字", layout.headerText === "提示词优化", layout.headerText);
  // 768 - 头部 40 - 底栏 40 - 上下边框 2 = 686
  check("主体高度占了卡片剩下的全部", layout.bodyH === 686, String(layout.bodyH));
  check("正文没有溢出主体", layout.pBottom <= layout.bodyBottom + 0.5, `${layout.pBottom} vs ${layout.bodyBottom}`);
  check("正文没有压到底栏", layout.pBottom <= layout.footerTop + 0.5, `${layout.pBottom} vs ${layout.footerTop}`);
  /*
   * 13 行，跟着底栏高度走。
   *
   * 底栏 2026-10-26 曾为了装一个 72px 的方形叉号加高到 88（正文降到 12 行），
   * 当晚叉号搬到右上角、底栏回到 40，行数也回到 13。
   * 这条断言就是「两个数字绑死」的那根绳：只改一边，正文会被从半个字处切断，
   * 而 clamp 值本身看着毫无问题。
   */
  check("按 13 行截断", layout.clamp === "13", layout.clamp);
  /*
   * 删除叉号：和图片 / 视频节点**同一个组件**（common.tsx 的 NodeDeleteButton），
   * 位置在节点右上角**之外**。
   *
   * 这里判的是「搬走了、并且和裸节点一致」：
   *   ① 底栏里不再有它（曾经的方块叉号就在这里）
   *   ② 它在卡片右侧之外 —— 用户要的「和图片节点一样」本质上就是这个位置
   *   ③ 尺寸 64×64、圆形，和裸节点那条断言同源
   *
   * ②用「按钮左边缘 ≥ 卡片右边缘」而不是写死 -64：屏幕坐标是缩放后的值，
   * 写死数字会在别的 zoom 下假失败。
   */
  check("底栏里没有删除叉号了", layout.delInFooter === false, `delInFooter=${layout.delInFooter}`);
  check("右上角有删除叉号", Boolean(layout.delW), `delW=${layout.delW}`);
  check("叉号在卡片右侧之外", layout.delLeft >= layout.cardRight - 1, `${layout.delLeft} vs ${layout.cardRight}`);
  check("叉号 64×64（和图片节点同一尺寸）", layout.delW === 64 && layout.delH === 64, `${layout.delW}×${layout.delH}`);
  /*
   * 屏幕上也要够大 —— 这一条才是人真正抱怨的那件事（「太小了点不到」）。
   * 原来底栏里那个 32px 方框，屏幕上只有 8.6px。现在 64px 的圆形，
   * 屏幕上 17~28px。阈值取 12：比旧值大一半以上，又不至于在
   * 不同窗口尺寸下假失败。
   */
  check("叉号屏幕上不小于 12px", layout.delScreenW >= 12, `${layout.delScreenW}px`);
  /*
   * 圆形（rounded-full）。**不能判字符串等于 9999px**：
   * Chrome 会把超大圆角夹到 2^25 = 33554432px，computed 值长这样。
   * 判据只能是「圆角远大于边长」，即视觉上必然是个圆。
   */
  check(
    "叉号是圆形（圆角远大于边长）",
    parseFloat(layout.delRadius) >= 1000,
    layout.delRadius
  );

  console.log("");
  console.log("=== 双击头部不再编辑任何东西（改名能力已随名字一起删掉）===");
  const rect1 = await nodeRect(page, "text.prompt");
  /*
   * 双击头部约 1/4 高度处（头部固定 40px，卡片 768 高）。
   *
   * 这一节以前验的是「双击头部 → 出现名称输入框 → 改完落库」。
   * 2026-10-26 头部只留一个「提示词优化」，节点名不再显示，
   * 双击改名这个入口随之删除 —— 这是人拍板过的后果，不是漏改。
   *
   * 现在验的是「删干净了」，外加一条行为记录：头部既然没有自己的可编辑对象，
   * 双击它就落到**正文编辑**上（`enterEdit` 里那个 header 分支被删掉之后，
   * 双击位置不再影响进哪个编辑器）。如果哪天有人把 label 编辑加回来，
   * 卡片上会出现一个用户根本看不见名字的输入框。
   */
  await dblclickAt(cdp, rect1.x + rect1.w * 0.45, rect1.y + rect1.h * 0.026);
  await sleep(300);
  const s5 = await cardState(page, "text.prompt");
  check(
    "双击头部进的是正文编辑（头部已没有自己的可编辑对象）",
    s5.editing === "body",
    String(s5.editing)
  );
  check("头部没有名称输入框", s5.labelInputInCard === false, JSON.stringify(s5));
  check("只有一个编辑器（没有出现两个）", s5.hasCardEditor === true, JSON.stringify(s5));

  await page.keyboard.press("Escape");
  await sleep(300);
  const s6 = await cardState(page, "text.prompt");
  check("Esc 退出编辑态", s6.editing === "0", String(s6.editing));
  check("不在编辑时面板照常浮出", s6.hasPanel, JSON.stringify({ hasPanel: s6.hasPanel }));

  console.log("");
  console.log("=== 面板里是原始描述，卡片里是优化结果 ===");
  check(
    "面板里有原始描述框",
    s6.panelTextareas.includes("prompt"),
    JSON.stringify(s6.panelTextareas)
  );
  check(
    "面板里没有优化结果的框（它在卡片主体里）",
    !s6.panelTextareas.includes("optimizedPrompt"),
    JSON.stringify(s6.panelTextareas)
  );
  check(
    "面板里没有名称框",
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("[data-node-type]")].find(
        (n) => n.getAttribute("data-node-type") === "text.prompt"
      );
      return !el.querySelector('[data-node-panel] input[data-field="label"]');
    })
  );
  check("面板里仍有模型下拉", s6.panelSelects.includes("modelId"), JSON.stringify(s6.panelSelects));

  // 留一张「退出编辑后」的图：用来核对面板是不是已经收成「模型 + 改写」一行
  await page.screenshot({ path: ".e2e-tmp/08-panel-after-edit.png" });

  console.log("");
  console.log("=== 点画布空白退出编辑 ===");
  const rect2 = await nodeRect(page, "text.prompt");
  await dblclickAt(cdp, bodyPoint(rect2).x, bodyPoint(rect2).y);
  const reentered = await cardState(page, "text.prompt");
  check("重新双击能再次进入编辑", reentered.editing === "body", String(reentered.editing));
  await page.mouse.click(80, 700);
  await sleep(350);
  const afterBlank = await cardState(page, "text.prompt");
  check("点画布空白后退出编辑", afterBlank.editing === "0", String(afterBlank.editing));

  console.log("");
  console.log("=== 只有声明了 place:card 的节点才可双击编辑 ===");
  const imgRect = await nodeRect(page, "image.gen");
  await dblclickAt(cdp, bodyPoint(imgRect).x, bodyPoint(imgRect).y);
  const imgState = await cardState(page, "image.gen");
  check("图像节点双击不进编辑态", imgState.editing === "0", String(imgState.editing));
  check("图像节点没有卡内编辑器", !imgState.hasCardEditor, JSON.stringify(imgState));
  check(
    "图像节点的提示词仍在面板里",
    imgState.panelTextareas.includes("prompt"),
    JSON.stringify(imgState.panelTextareas)
  );

  check("页面无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));

  await page.screenshot({ path: ".e2e-tmp/06-inline-edit.png" });
} finally {
  await browser.close();
  const db = new Database("dev.db");
  cleanupProject(db, projectId);
  db.close();
}

console.log("");
console.log(`${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
