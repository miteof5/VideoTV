/**
 * 量「浮窗不随画布缩放」这件事本身。
 *
 * 跑法：node scripts/probe-panel.mjs
 *
 * 为什么不能只靠肉眼看截图：面板跟随缩放和面板不缩放，在**某一张**截图里
 * 长得可能一模一样 —— 只要那张图的 zoom 恰好让乘出来的结果接近 726。
 * 只有「同一个面板，在两种 zoom 下量两次」才能证明它没跟着缩。
 * 所以这个脚本量两次：默认 zoom、滚轮放大后。
 *
 * 判据（四条，全部是屏幕像素）：
 *   1. 面板视觉宽度恒为 PANEL_W（726），两次一致
 *   2. 面板水平中心 = 卡片水平中心（±1px）
 *   3. 面板顶边 − 卡片底边 = PANEL_GAP（8），两次一致
 *   4. 面板内字号是 14 / 13，不随 zoom 变
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const PROJECT_NAME = "__probe_panel__";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const VIEW = { width: 1920, height: 1080 };

const PANEL_W = 726;
const PANEL_GAP = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rfc3339 = (d = new Date()) => d.toISOString().replace("Z", "+00:00");
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function setup() {
  const db = new Database("dev.db");
  const now = rfc3339();

  const old = db.prepare("select id from Project where name = ?").get(PROJECT_NAME);
  if (old) {
    db.prepare("delete from Edge where projectId = ?").run(old.id);
    db.prepare("delete from Node where projectId = ?").run(old.id);
    db.prepare("delete from Project where id = ?").run(old.id);
  }

  const projectId = newId("pbp");
  db.prepare("insert into Project (id,name,createdAt,updatedAt) values (?,?,?,?)").run(
    projectId,
    PROJECT_NAME,
    now,
    now
  );

  // 只放一个图节点：16:9 空态 = 1280×720，够宽，居中/溢出的边界都能看清
  const imageId = newId("pbi");
  db.prepare(
    `insert into Node (id, projectId, type, positionX, positionY, data, status, createdAt, updatedAt)
     values (?,?,?,?,?,?,?,?,?)`
  ).run(
    imageId,
    projectId,
    "image.gen",
    0,
    0,
    JSON.stringify({
      label: "关键帧",
      prompt: "写实风格，电影感布光，雨夜霓虹",
      aspectRatio: "16:9",
      status: "idle",
    }),
    "idle",
    now,
    now
  );

  db.close();
  return { projectId, imageId };
}

const { projectId, imageId } = setup();

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

/** 选中节点，等面板渲染 */
const nodeRect = await page.evaluate((id) => {
  const r = document.querySelector(`[data-node-id="${id}"]`).getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}, imageId);
await page.mouse.click(nodeRect.x + nodeRect.w / 2, nodeRect.y + nodeRect.h / 2);
await sleep(600);

const measure = () =>
  page.evaluate((id) => {
    const nodeEl = document.querySelector(`[data-node-id="${id}"]`);
    const panelEl = document.querySelector(`[data-node-id="${id}"] [data-node-panel]`);
    const vp = document.querySelector(".react-flow__viewport");
    const m = new DOMMatrix(getComputedStyle(vp).transform);
    const nr = nodeEl.getBoundingClientRect();
    const pr = panelEl.getBoundingClientRect();
    const cs = getComputedStyle(panelEl);
    const ta = panelEl.querySelector("textarea");
    const btn = panelEl.querySelector('[data-action="send"]');
    const sel = panelEl.querySelector("select");
    // 命中测试：面板**可见部分**的中心点，最上层元素得在面板里面。
    // 不能直接用面板几何中心 —— zoom 2 时面板整个在视口下方之外，
    // elementFromPoint 返回 null，那是判据错不是产品错。
    const ix = Math.max(0, pr.x);
    const iy = Math.max(0, pr.y);
    const ir = Math.min(innerWidth, pr.right);
    const ib = Math.min(innerHeight, pr.bottom);
    const visible = ir > ix && ib > iy;
    const hitEl = visible ? document.elementFromPoint((ix + ir) / 2, (iy + ib) / 2) : null;
    return {
      zoom: m.a,
      vw: innerWidth,
      vh: innerHeight,
      visible,
      node: { x: nr.x, y: nr.y, w: nr.width, h: nr.height, right: nr.right, bottom: nr.bottom },
      panel: { x: pr.x, y: pr.y, w: pr.width, h: pr.height, right: pr.right, bottom: pr.bottom },
      // offsetWidth 是布局值（画布坐标），transform 之后的视觉宽度在 rect 里
      layoutW: panelEl.offsetWidth,
      radius: cs.borderTopLeftRadius,
      pad: [cs.paddingTop, cs.paddingLeft, cs.paddingBottom],
      fs: {
        text: ta && getComputedStyle(ta).fontSize,
        btn: btn && getComputedStyle(btn).fontSize,
        sel: sel && getComputedStyle(sel).fontSize,
      },
      hitInPanel: visible ? Boolean(hitEl && panelEl.contains(hitEl)) : null,
      hitTag: visible ? (hitEl?.tagName ?? "null") : "skipped",
    };
  }, imageId);

let fail = 0;
const check = (name, ok, detail) => {
  if (!ok) fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail !== undefined ? `  [${detail}]` : ""}`);
};

function report(tag, d) {
  const cx = d.panel.x + d.panel.w / 2;
  const ncx = d.node.x + d.node.w / 2;
  const gap = d.panel.y - d.node.bottom;
  console.log(`\n${tag}  zoom=${d.zoom.toFixed(4)}`);
  console.log(`  卡片  屏幕 ${Math.round(d.node.w)}×${Math.round(d.node.h)}  底边 y=${Math.round(d.node.bottom)}`);
  console.log(`  面板  屏幕 ${Math.round(d.panel.w)}×${Math.round(d.panel.h)}  布局宽 ${d.layoutW}`);
  console.log(`  居中偏差 ${(cx - ncx).toFixed(2)}px · 间距 ${gap.toFixed(2)}px`);
  console.log(
    `  溢出  左 ${Math.round(d.panel.x)}  右 ${Math.round(d.vw - d.panel.right)}` +
      `  （负数 = 出视口）  底 ${Math.round(d.vh - d.panel.bottom)}`
  );
  console.log(`  字号  正文 ${d.fs.text} / 按钮 ${d.fs.btn} / 下拉 ${d.fs.sel}`);

  check("面板视觉宽度 = 726px", Math.abs(d.panel.w - PANEL_W) < 1.5, d.panel.w.toFixed(1));
  check("面板水平居中对齐卡片", Math.abs(cx - ncx) < 1, (cx - ncx).toFixed(2));
  check("面板顶边距卡片底边 = 8px", Math.abs(gap - PANEL_GAP) < 1.5, gap.toFixed(2));
  check("面板内正文 14px", d.fs.text === "14px", d.fs.text);
  check("面板内按钮 13px", d.fs.btn === "13px", d.fs.btn);
  check("面板内下拉 13px", d.fs.sel === "13px", d.fs.sel);
  check("面板圆角 16px", d.radius === "16px", d.radius);
  check("面板内边距 12/12/10", d.pad.join("/") === "12px/12px/10px", d.pad.join("/"));
  check("面板中心点命中面板自己", d.hitInPanel !== false, d.hitInPanel === null ? `面板不在视口内（${d.hitTag}）` : String(d.hitInPanel));
  return { cx, ncx, gap, ...d };
}

const a = report("① 默认缩放", await measure());
// 三张图并排看才知道「谁跟着缩、谁没跟着缩」
await page.screenshot({ path: ".e2e-tmp/panel-scale-1x.png" });

/* 放大画布：在卡片**上方**的空白处滚轮（滚在面板上会被 nowheel 挡掉） */
await page.mouse.move(VIEW.width / 2, Math.max(40, nodeRect.y - 30));
await page.mouse.wheel({ deltaY: -600 });
await sleep(500);
await page.mouse.wheel({ deltaY: -600 });
await sleep(600);

const b = report("② 滚轮放大后", await measure());

/* 缩小画布 */
await page.mouse.wheel({ deltaY: 1400 });
await sleep(600);
const c = report("③ 滚轮缩小后", await measure());

console.log("\n--- 跨缩放对比（这三行是本轮的真正判据）---");
check("三种 zoom 下 zoom 真的变了", a.zoom !== b.zoom && b.zoom !== c.zoom, `${a.zoom.toFixed(3)} / ${b.zoom.toFixed(3)} / ${c.zoom.toFixed(3)}`);
check(
  "三种 zoom 下面板宽度一模一样",
  Math.abs(a.panel.w - b.panel.w) < 1 && Math.abs(b.panel.w - c.panel.w) < 1,
  `${a.panel.w.toFixed(1)} / ${b.panel.w.toFixed(1)} / ${c.panel.w.toFixed(1)}`
);
check(
  "卡片宽度确实跟着 zoom 变了（对照组，证明缩放真的作用在节点上）",
  Math.abs(a.node.w - b.node.w) > 20,
  `${a.node.w.toFixed(0)} → ${b.node.w.toFixed(0)}`
);
check(
  "三种 zoom 下间距都是 8px",
  [a, b, c].every((d) => Math.abs(d.gap - PANEL_GAP) < 1.5),
  [a.gap, b.gap, c.gap].map((g) => g.toFixed(1)).join(" / ")
);

await page.screenshot({ path: ".e2e-tmp/panel-scale-small.png" });
await browser.close();

console.log(fail === 0 ? "\n全部通过" : `\n${fail} 条失败`);
process.exit(fail === 0 ? 0 : 1);
