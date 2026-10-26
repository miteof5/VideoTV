/**
 * 文本节点「两段字」验收 —— 原始描述在面板、优化结果在卡片。
 *
 * 跑法：node scripts/e2e-text-prompt.mjs
 * 需要 dev（3000）和 worker 两个进程都跑着。
 *
 * ### 这一套在验什么
 *
 * 文本节点现在有两个文字字段：
 *   prompt            面板里那个框 —— 用户写的话，点一下就能改（像对话框）
 *   optimizedPrompt   卡片主体 —— AI 改写的结果，双击才能改（像记事本）
 *
 * 光验「两个框都在」没有意义。真正会坏、且坏了不报错的是**取值的流向**：
 *
 *   1. 发送之后，结果有没有真的写回卡片（而不是另开一个节点）
 *   2. 原文有没有被覆盖（覆盖了用户就再也回不到自己写的话）
 *   3. **下游节点拼提示词时，拿的是优化结果还是原文**
 *      —— 这条错了，界面上一切正常，只是生成出来的东西和卡片上写的字无关
 *
 * 第 3 条只能靠真跑一次下游节点、再读它日志里那行「提示词：」来证明。
 * 所以这里挂了一个图像节点当下游，并把它钉在 mock.image.v1 上
 * （演示模型不花钱，这条链路的正确性与模型真假无关）。
 */
import { requireMockWorld } from "./_preflight.mjs";
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const PROJECT_NAME = "__text_prompt_e2e__";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const RAW = "雨夜街头，一个女孩回头";
const EDITED = "雨夜街头，穿红裙的女孩回头看向镜头";

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

  const projectId = newId("e2etp");
  db.prepare("insert into Project (id,name,createdAt,updatedAt) values (?,?,?,?)").run(
    projectId,
    PROJECT_NAME,
    now,
    now
  );

  const ids = { text: newId("e2etpt"), image: newId("e2etpi") };
  const insert = db.prepare(
    `insert into Node (id, projectId, type, positionX, positionY, data, status, createdAt, updatedAt)
     values (?,?,?,?,?,?,?,?,?)`
  );
  const mk = (id, type, x, y, data) =>
    insert.run(id, projectId, type, x, y, JSON.stringify(data), "idle", now, now);

  mk(ids.text, "text.prompt", -260, -140, {
    label: "剧本",
    prompt: RAW,
    optimizedPrompt: "",
    status: "idle",
  });
  /*
   * 下游图像节点，钉在演示模型上：
   *   - 不花钱、不依赖 API Key，验证的是拼接逻辑不是模型
   *   - modelId 必须写死。留空的话 selectProvider 会挑清单里第一个
   *     可用的图像模型（真模型），跑一次就是真花钱。
   */
  mk(ids.image, "image.gen", 320, -140, {
    label: "分镜图",
    prompt: "",
    negativePrompt: "",
    aspectRatio: "16:9",
    modelId: "mock.image.v1",
    status: "idle",
  });

  db.prepare("insert into Edge (id, projectId, source, target, targetHandle) values (?,?,?,?,?)").run(
    newId("e2edge"),
    projectId,
    ids.text,
    ids.image,
    ""
  );

  db.close();
  return { projectId, ids };
}

function readData(nodeId) {
  const db = new Database("dev.db");
  const row = db.prepare("select data, status from Node where id = ?").get(nodeId);
  db.close();
  if (!row) return { data: {}, status: null };
  try {
    return { data: JSON.parse(row.data), status: row.status };
  } catch {
    return { data: {}, status: row.status };
  }
}

/**
 * 等某个节点跑到 succeeded（worker 是独立进程，只能轮询数据库）
 *
 * 20s 够用是因为这一套**只在演示模型世界跑**（见上面的 preflight）：
 * 演示模型一次调用几十毫秒。真模型 kimi-k3 单次要 19.2s（先思考再输出），
 * 20s 会把它误杀成「卡在 running」——所以真模型世界先被 preflight 挡掉了。
 * 想看真模型表现：手动验，或者临时把这里调大并且接受烧钱。
 */
async function waitNodeStatus(nodeId, want, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { status } = readData(nodeId);
    if (status === want) return true;
    if (status === "failed") return false;
    await sleep(250);
  }
  return false;
}

/** 取最近一条「提示词：」日志（执行引擎在调模型前必写这一行） */
function latestPromptLog() {
  const db = new Database("dev.db");
  const rows = db
    .prepare("select payload from RunEvent where type = 'log' order by seq desc limit 60")
    .all();
  db.close();
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload);
      if (typeof p.message === "string" && p.message.startsWith("提示词：")) return p.message;
    } catch {
      /* 跳过坏数据 */
    }
  }
  return null;
}

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

/** 真双击。puppeteer 的 clickCount:2 不产生 dblclick，必须发 CDP 四段序列 */
async function dblclickAt(cdp, x, y) {
  const base = { x, y, button: "left" };
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: 2 });
  await cdp.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: 2 });
  await sleep(280);
}

async function panelInfo(page, type) {
  return page.evaluate((t) => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === t
    );
    const panel = el?.querySelector("[data-node-panel]");
    if (!panel) return null;
    const ta = panel.querySelector('textarea[data-field="prompt"]');
    const btn = panel.querySelector('[data-action="send"]');
    return {
      hasPanel: true,
      textareaValue: ta?.value ?? null,
      textareaField: ta?.getAttribute("data-field") ?? null,
      sendLabel: btn?.textContent?.trim() ?? null,
      taRect: ta ? (() => {
        const r = ta.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })() : null,
      btnRect: btn ? (() => {
        const r = btn.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })() : null,
    };
  }, type);
}

/** 卡片主体里显示的文字 + 有没有「AI 优化」标记 */
async function cardInfo(page, type) {
  return page.evaluate((t) => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === t
    );
    if (!el) return null;
    const body = el.querySelector("[data-card-body] p");
    return {
      bodyText: body?.textContent ?? null,
      optimizedBadge: Boolean(el.querySelector('[data-optimized="1"]')),
      w: el.offsetWidth,
      h: el.offsetHeight,
      editing: el.getAttribute("data-editing"),
      hasCardEditor: Boolean(el.querySelector("[data-card-editor]")),
    };
  }, type);
}

/*
 * 这一套只能在**演示模型世界**跑：下游图像节点钉在 mock.image.v1（不花钱），
 * 还有「优化结果里带着原文」这种只有演示模型才成立的断言。
 * 判据与跑法说明见 scripts/_preflight.mjs（退出码 2 = 环境不对）。
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
  await page.waitForSelector(".react-flow__node");
  await sleep(1100);

  console.log("=== 初始：没优化过，卡片显示的是原文 ===");
  const before = await cardInfo(page, "text.prompt");
  check("卡片主体显示原文（optimizedPrompt 空时的回退）", before.bodyText === RAW, String(before.bodyText));
  check("还没优化，不挂「AI 优化」标记", !before.optimizedBadge, JSON.stringify(before));

  console.log("");
  console.log("=== 面板里是对话框：点一下就能改 ===");
  const rect0 = await nodeRect(page, "text.prompt");
  // 单击选中（不是双击）—— 面板就是在这个状态下浮出来的
  await page.mouse.click(rect0.x + rect0.w * 0.45, rect0.y + rect0.h * 0.5);
  await sleep(450);
  const p0 = await panelInfo(page, "text.prompt");
  if (process.env.E2E_DEBUG) {
    console.log(
      "  [debug] p0",
      JSON.stringify(p0),
      JSON.stringify(
        await page.evaluate(() => ({
          vw: innerWidth,
          vh: innerHeight,
          t: document.querySelector(".react-flow__viewport")?.style.transform,
        }))
      )
    );
  }
  check("单击选中就浮出面板", Boolean(p0), JSON.stringify(p0));
  check("面板里有原始描述框", p0?.textareaField === "prompt", String(p0?.textareaField));
  check("框里是用户的原始描述", p0?.textareaValue === RAW, String(p0?.textareaValue));
  check("按钮叫「发送」（不是「生成」）", p0?.sendLabel?.includes("发送"), String(p0?.sendLabel));

  /*
   * 这一条是用户点名要的「点击就能用」：不双击、不进编辑态，
   * 鼠标点进框里直接打字就该生效。曾经文本节点的正文只有双击入口，
   * 面板里根本没有输入框 —— 输入这件事必须有两个不同门槛，才不会互相打架。
   */
  await page.mouse.click(p0.taRect.x + 20, p0.taRect.y + 14);
  await sleep(150);
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute?.("data-field") === "prompt"
  );
  check("单击输入框就获得焦点（不需要双击）", focused);
  check(
    "单击输入框没有把卡片拉进编辑态",
    (await cardInfo(page, "text.prompt")).editing === "0",
    (await cardInfo(page, "text.prompt")).editing
  );

  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await cdp.send("Input.insertText", { text: EDITED });
  await sleep(1500);
  check("改完的原文落库到 prompt", readData(ids.text).data.prompt === EDITED, String(readData(ids.text).data.prompt));
  check(
    "改原文不会顺手改掉优化结果（那是发送之后的事）",
    readData(ids.text).data.optimizedPrompt === "",
    JSON.stringify(readData(ids.text).data.optimizedPrompt)
  );

  console.log("");
  console.log("=== 点发送：走完整执行链路，结果写回卡片 ===");
  const p1 = await panelInfo(page, "text.prompt");
  await page.mouse.click(p1.btnRect.x + p1.btnRect.w / 2, p1.btnRect.y + p1.btnRect.h / 2);

  const ok = await waitNodeStatus(ids.text, "succeeded", 25_000);
  check("节点跑到 succeeded（真经过了 Worker）", ok, readData(ids.text).status ?? "超时");

  await sleep(700); // 等 SSE 把结果推回画布
  const after = readData(ids.text);
  const optimized = String(after.data.optimizedPrompt ?? "");
  check("结果写进了 optimizedPrompt（不是另开节点）", optimized.length > 0, `${optimized.length} 字`);
  check(
    "优化结果里带着原文（证明送去优化的是原文，不是上次的结果）",
    optimized.includes(EDITED),
    optimized.slice(0, 60)
  );
  check("原文没有被覆盖", after.data.prompt === EDITED, String(after.data.prompt));

  const card1 = await cardInfo(page, "text.prompt");
  check("卡片主体换成了优化结果", card1.bodyText?.includes("Mock") || card1.bodyText === optimized, String(card1.bodyText).slice(0, 40));
  check("挂上了「AI 优化」标记", card1.optimizedBadge, JSON.stringify(card1));
  check("卡片尺寸没变（仍是 1024×768）", card1.w === 1024 && card1.h === 768, `${card1.w}×${card1.h}`);

  const p2 = await panelInfo(page, "text.prompt");
  check("面板里的原文还在（可以继续改、继续发）", p2?.textareaValue === EDITED, String(p2?.textareaValue));

  // 留一张「发送之后」的正常状态图：面板里是原话，卡片上是优化结果
  await page.screenshot({ path: ".e2e-tmp/10-after-send.png" });

  console.log("");
  console.log("=== 下游拿到的是优化结果，不是原文 ===");
  /*
   * 这是整套设计里最容易断的一环：引擎如果把 upstream 的 `.prompt`
   * 直接拼进去，界面上完全看不出问题 —— 卡片写着优化后的词，下游却按
   * 原话生成。只有真跑一次下游、再读它日志里那行「提示词：」才能证明。
   */
  const imgRect = await nodeRect(page, "image.gen");
  await page.mouse.click(imgRect.x + imgRect.w * 0.5, imgRect.y + imgRect.h * 0.5);
  await sleep(400);
  const runBtn = await page.evaluate((t) => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === t
    );
    // 「运行」按钮已删（和面板里的「生成」重复），统一用面板的发送按钮
    const b = el?.querySelector("[data-action='send']");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, "image.gen");
  check("下游节点的面板有「生成」按钮", Boolean(runBtn));
  await page.mouse.click(runBtn.x + runBtn.w / 2, runBtn.y + runBtn.h / 2);

  const imgOk = await waitNodeStatus(ids.image, "succeeded", 30_000);
  check("下游节点跑成功", imgOk, readData(ids.image).status ?? "超时");

  const log = latestPromptLog();
  check("执行引擎记下了实际发出的提示词", Boolean(log), String(log));
  check(
    "下游拼的是优化结果",
    Boolean(log) && log.includes(optimized.split("\n")[0].slice(0, 12)),
    log ? log.slice(0, 60) : ""
  );

  console.log("");
  console.log("=== 面板输入框：长文能滚，但不长出一条滚动条 ===");
  /*
   * 判据必须读计算样式，不能看截图：headless 的 Chrome 本来就不绘制
   * 滚动条，光看截图永远发现不了（上一轮就是这么"全绿"却漏掉的）。
   */
  const rect1b = await nodeRect(page, "text.prompt");
  await page.mouse.click(rect1b.x + rect1b.w * 0.45, rect1b.y + rect1b.h * 0.5);
  await sleep(400);
  const p3 = await panelInfo(page, "text.prompt");
  await page.mouse.click(p3.taRect.x + 20, p3.taRect.y + 14);
  await sleep(120);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await cdp.send("Input.insertText", { text: "很长的原始描述。".repeat(30) });
  await sleep(220);
  const cs = await page.evaluate(() => {
    const ta = document.querySelector('[data-node-panel] textarea[data-field="prompt"]');
    const style = getComputedStyle(ta);
    return {
      scrollbarWidth: style.scrollbarWidth,
      scrollH: ta.scrollHeight,
      clientH: ta.clientHeight,
    };
  });
  check("长文确实超出框高", cs.scrollH > cs.clientH, JSON.stringify(cs));
  check("滚动条被藏起来（scrollbar-width: none）", cs.scrollbarWidth === "none", cs.scrollbarWidth);

  console.log("");
  console.log("=== 卡片仍然双击才能改，改的是优化结果 ===");
  const rect2 = await nodeRect(page, "text.prompt");
  await dblclickAt(cdp, rect2.x + rect2.w * 0.45, rect2.y + rect2.h * 0.5);
  const s = await cardInfo(page, "text.prompt");
  check("双击进入编辑态", s.editing === "body", String(s.editing));
  check("出现卡内编辑器", s.hasCardEditor, JSON.stringify(s));
  check(
    "编辑器绑的是 optimizedPrompt",
    (await page.evaluate(() => document.querySelector("[data-card-editor]")?.getAttribute("data-field"))) ===
      "optimizedPrompt"
  );
  check(
    "编辑器初值就是卡片上那段优化结果（不是空的）",
    (await page.evaluate(() => document.querySelector("[data-card-editor]")?.value)) === optimized,
    String((await page.evaluate(() => document.querySelector("[data-card-editor]")?.value))).slice(0, 30)
  );
  await page.keyboard.press("Escape");
  await sleep(300);

  await page.screenshot({ path: ".e2e-tmp/09-two-prompts.png" });

  check("页面无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
  const db = new Database("dev.db");
  cleanupProject(db, projectId);
  db.close();
}

console.log("");
console.log(`${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
