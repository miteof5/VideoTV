/**
 * 节点尺寸改版后的肉眼验收截图（不是自动断言，断言在各 e2e-*.mjs 里）。
 *
 * 跑法：node scripts/shot-sizes.mjs
 * 产物：`.e2e-tmp/sizes-*.png`
 *
 * 为什么要单独一个脚本：自动化断言只能证明「尺寸对了、字没溢出」，
 * 证明不了「看起来舒不舒服」。排版这种事必须亲眼过一遍。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";
import fs from "node:fs";

const BASE = "http://127.0.0.1:3000";
const PROJECT_NAME = "__sizes_shot__";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = ".e2e-tmp";
const VIEW = { width: 1920, height: 1080 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rfc3339 = (d = new Date()) => d.toISOString().replace("Z", "+00:00");
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const LONG = `雨夜。城市街角的霓虹招牌在积水里被拉成长条。

她撑着一把坏了一根骨的透明伞，站在便利店门口，回头看镜头。伞面上滚下的水珠把霓虹切成碎片，落在她的锁骨上。

镜头从她脚下升起，经过湿透的裤脚、发梢、最后停在她眼睛的高度。她张开嘴，但没有出声。

远处有汽车驶过，灯光扫过整条街，照亮墙上那张褪色的海报——海报上的人和她长得一模一样。

她愣了一下，把手伸进口袋，摸出一张同样褪色的照片。照片里是这个街角，但没有雨。

镜头缓慢推近到她手里的照片，焦点从照片拉到背景，背景里的招牌是新的。

她的手指在照片上停住，画面渐渐失焦。雨还在下。`;

function setup() {
  const db = new Database("dev.db");
  const now = rfc3339();

  const old = db.prepare("select id from Project where name = ?").get(PROJECT_NAME);
  if (old) {
    db.prepare("delete from Edge where projectId = ?").run(old.id);
    db.prepare("delete from Node where projectId = ?").run(old.id);
    db.prepare("delete from Project where id = ?").run(old.id);
  }

  const projectId = newId("shot");
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

  const ids = { text: newId("sht"), image: newId("shi"), video: newId("shv") };

  /*
   * 按新尺寸排开：文本 1024×768，图 / 视频 1280×720。
   * 横向间距 1400（前一列 1024 宽 + 376 空隙），
   * 纵向间距 900（720 高 + 面板 130 + 余量）。
   */
  insert.run(
    ids.text,
    projectId,
    "text.prompt",
    -100,
    -400,
    JSON.stringify({ label: "开场 · 雨夜街角", prompt: "雨夜街角，女孩回头", optimizedPrompt: LONG, status: "idle" }),
    "idle",
    now,
    now
  );
  insert.run(
    ids.image,
    projectId,
    "image.gen",
    1300,
    -400,
    JSON.stringify({
      label: "关键帧 · 回眸",
      prompt: "写实风格，电影感布光，雨夜霓虹，浅景深",
      negativePrompt: "",
      aspectRatio: "16:9",
      status: "idle",
    }),
    "idle",
    now,
    now
  );
  insert.run(
    ids.video,
    projectId,
    "video.gen",
    1300,
    500,
    JSON.stringify({
      label: "镜头 1 · 推近",
      prompt: "镜头缓慢推进，雨丝清晰可见",
      mode: "auto",
      aspectRatio: "16:9",
      duration: "3",
      status: "idle",
    }),
    "idle",
    now,
    now
  );

  db.close();
  return { projectId, ids };
}

const { projectId, ids } = setup();
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", `--window-size=${VIEW.width},${VIEW.height}`],
  defaultViewport: VIEW,
});
const page = await browser.newPage();

await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "networkidle2" });
await page.waitForSelector(".react-flow__node", { timeout: 30000 });
await sleep(1200);

const box = await page.evaluate(() => ({
  vw: innerWidth,
  vh: innerHeight,
  t: document.querySelector(".react-flow__viewport")?.style.transform,
  nodes: [...document.querySelectorAll("[data-node-id]")].map((e) => {
    const r = e.getBoundingClientRect();
    return {
      type: e.getAttribute("data-node-type"),
      // offsetWidth 是布局值（画布单位），不受缩放影响
      w: e.offsetWidth,
      h: e.offsetHeight,
    };
  }),
}));
console.log("视口", box.vw + "×" + box.vh, "| 画布", box.t);
for (const n of box.nodes) console.log(`  ${n.type.padEnd(12)} ${n.w}×${n.h}`);

// 1. 全景：三张卡并排，看清尺寸关系
await page.screenshot({ path: `${OUT}/sizes-1-overview.png` });

// 2. 文本卡片特写：15px 正文 + 27 行
const textRect = await page.evaluate((id) => {
  const el = document.querySelector(`[data-node-id="${id}"]`);
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}, ids.text);
await page.screenshot({
  path: `${OUT}/sizes-2-text.png`,
  clip: {
    x: Math.max(0, textRect.x - 10),
    y: Math.max(0, textRect.y - 30),
    width: Math.min(textRect.w + 20, VIEW.width),
    height: Math.min(textRect.h + 40, VIEW.height - textRect.y),
  },
});

// 3. 图像节点空态 + 选中后浮出的面板（看面板不再满宽）
const imgRect = await page.evaluate((id) => {
  const el = document.querySelector(`[data-node-id="${id}"]`);
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}, ids.image);
await page.mouse.click(imgRect.x + imgRect.w / 2, imgRect.y + imgRect.h / 2);
await sleep(500);
await page.screenshot({ path: `${OUT}/sizes-3-image-selected.png` });

const panel = await page.evaluate((id) => {
  const p = document.querySelector(`[data-node-id="${id}"] [data-node-panel]`);
  if (!p) return null;
  const r = p.getBoundingClientRect();
  /*
   * 顺便把面板里的每个控件量出来。
   *
   * 面板从 2026-10-24 起固定 726 屏幕像素（不随画布缩放），约等于卡片屏幕宽，
   * 控件之间的间距和右边界在截图里已经能看准了 —— 但「有没有互相压」
   * 「有没有顶出右边界」还是给坐标更可靠。
   */
  const controls = [...p.querySelectorAll("select, button, textarea")].map((el) => {
    const b = el.getBoundingClientRect();
    return {
      f: el.getAttribute("data-field") ?? el.getAttribute("data-action") ?? el.tagName,
      x: Math.round(b.x),
      w: Math.round(b.width),
    };
  });
  return {
    w: Math.round(r.width),
    h: Math.round(r.height),
    right: Math.round(r.right),
    controls,
  };
}, ids.image);
console.log("图像节点的面板（屏幕）:", panel.w + "×" + panel.h, "右边 x=" + panel.right);
for (const c of panel.controls) {
  const over = c.x + c.w > panel.right ? " ← 超出面板右边界" : "";
  console.log(`  ${String(c.f).padEnd(14)} x=${String(c.x).padStart(5)} w=${String(c.w).padStart(4)}${over}`);
}

/*
 * 4 / 5. 面板特写：一体式 composer（2026-10-24）。
 *
 * 两张图配对看：一张未聚焦、一张聚焦。断言能证明「textarea 边框是 0」
 * 和「聚焦时出现 3px 光圈」，但证明不了「看起来像不像一个输入框」——
 * 而这正是这次改版的全部目的，只能肉眼看。
 */
async function shotPanel(tag) {
  const r = await page.evaluate((id) => {
    const p = document.querySelector(`[data-node-id="${id}"] [data-node-panel]`);
    if (!p) return null;
    const b = p.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }, ids.text);
  if (!r) {
    console.log("  文本节点面板没渲染出来，跳过", tag);
    return;
  }
  // 光圈是往外扩 3px，四周留 16px 才看得见
  await page.screenshot({
    path: `${OUT}/${tag}.png`,
    clip: {
      x: Math.max(0, r.x - 16),
      y: Math.max(0, r.y - 16),
      width: Math.min(r.w + 32, VIEW.width),
      height: Math.min(r.h + 32, VIEW.height - Math.max(0, r.y - 16)),
    },
  });
}

await page.mouse.click(textRect.x + textRect.w / 2, textRect.y + textRect.h / 2);
await sleep(500);
await shotPanel("sizes-4-panel-idle");

await page.evaluate((id) => {
  const ta = document.querySelector(`[data-node-id="${id}"] [data-node-panel] textarea`);
  ta?.focus();
}, ids.text);
await sleep(350); // transition-[border-color,box-shadow] 150ms
await shotPanel("sizes-5-panel-focus");

await browser.close();
console.log("\n截图已写入", OUT);
