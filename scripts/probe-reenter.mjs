/**
 * 「点返回再点进来，视野没了」（2026-10-26）的真浏览器回归探针。
 *
 * 为什么单独一个脚本：`probe-viewport.mjs` 验的是**整页加载**（F5 / 直接访问）那条路径，
 * 而这条 bug 只在**客户端跳转**（首页 → 点项目卡片）时出现 ——
 * 两条路径的差异是几帧的时序，纯函数测不出来，刷新也复现不了。
 *
 * 实测的两种失效机制（两个都得挡住）：
 *   ① Next 的段缓存会留下组件实例、把 react-flow 的相机重置成 `{0,0,1}`。
 *      任何「effect 跑过就锁死」的 ref 都会挡住还原 —— 所以判据必须是
 *      「相机现在是不是出厂状态」，不能是「我跑过没有」。
 *   ② 客户端跳转时 effect 跑在 react-flow 把平移缩放层挂上 DOM 之前，
 *      那一刻 `setViewport` 是**静默空操作**（不报错、值不变）——
 *      所以还原要有界重试，直到真的生效。
 *
 * 跑法：node scripts/probe-reenter.mjs
 * 前提：dev 在 3000。不碰模型，MODEL_PROVIDER 是什么都行。
 * 自建一次性项目，跑完连 Node / Edge / Asset / Project 一起删掉。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const P = "__reenter_probe__";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rfc3339 = (d = new Date()) => d.toISOString().replace("Z", "+00:00");
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`);
  }
}
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/* ---------------- 建项目 / 清项目 ---------------- */

function cleanup() {
  const db = new Database("dev.db");
  // 先 SELECT 出将被删的行再删 —— 只认精确项目名，不用 like 通配
  const rows = db.prepare("select id from Project where name = ?").all(P);
  for (const r of rows) {
    db.prepare("delete from Edge where projectId = ?").run(r.id);
    db.prepare("delete from Node where projectId = ?").run(r.id);
    db.prepare("delete from Asset where projectId = ?").run(r.id);
    db.prepare("delete from Project where id = ?").run(r.id);
  }
  db.close();
}

function setup() {
  cleanup();
  const db = new Database("dev.db");
  const now = rfc3339();
  const projectId = newId("rnt");
  db.prepare("insert into Project (id,name,createdAt,updatedAt) values (?,?,?,?)").run(
    projectId,
    P,
    now,
    now
  );
  const ins = db.prepare(
    `insert into Node (id, projectId, type, positionX, positionY, data, status, createdAt, updatedAt)
     values (?,?,?,?,?,?,?,?,?)`
  );
  ins.run(
    newId("rn"),
    projectId,
    "text.prompt",
    -200,
    -300,
    JSON.stringify({ label: "探针文本", prompt: "一行字", status: "idle" }),
    "idle",
    now,
    now
  );
  ins.run(
    newId("rn"),
    projectId,
    "image.gen",
    1200,
    -300,
    JSON.stringify({ label: "探针图", prompt: "图", aspectRatio: "16:9", status: "idle" }),
    "idle",
    now,
    now
  );
  db.close();
  return projectId;
}

function readProjectRow(id) {
  const db = new Database("dev.db", { readonly: true });
  const r = db.prepare("select viewCenterX, viewCenterY, viewSpan from Project where id = ?").get(id);
  db.close();
  return r ?? {};
}

/* ---------------- 浏览器侧 ---------------- */

function readVP(page) {
  return page.evaluate(() => {
    const vp = document.querySelector(".react-flow__viewport");
    const rf = document.querySelector(".react-flow");
    const t = vp?.style.transform ?? "";
    const r = rf?.getBoundingClientRect();
    const m = t.match(/translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\s*\)\s*scale\(\s*([\d.]+)\s*\)/);
    return {
      raw: t,
      w: r?.width ?? 0,
      h: r?.height ?? 0,
      x: m ? +m[1] : NaN,
      y: m ? +m[2] : NaN,
      zoom: m ? +m[3] : NaN,
    };
  });
}

async function openProject(page, projectId) {
  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".react-flow__node", { timeout: 30000 });
  await sleep(1000); // 首屏取景 → 250ms 防抖 → PUT
}

/** 点「← 返回」回首页，等列表出来。 */
async function goHome(page) {
  await page.evaluate(() => {
    const a = [...document.querySelectorAll("a")].find((x) => x.textContent?.includes("返回"));
    a.click();
  });
  await page.waitForFunction(() => location.pathname === "/", { timeout: 20000 });
  await page.waitForSelector('a[href^="/projects/"]', { timeout: 20000 });
}

/** 在首页点项目卡片进来（**客户端跳转**，不是整页加载）。 */
async function enterByClick(page, projectId) {
  await page.evaluate((id) => {
    document.querySelector(`a[href="/projects/${id}"]`).click();
  }, projectId);
  await page.waitForSelector(".react-flow__node", { timeout: 30000 });
  await sleep(900);
}

const projectId = setup();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
});

let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });

  console.log("\n[1] 整页加载进来 → 自动取景 → 落库");
  await openProject(page, projectId);
  const vp1 = await readVP(page);
  const row1 = readProjectRow(projectId);
  check("视口读得到", Number.isFinite(vp1.zoom), `zoom=${vp1.zoom.toFixed(4)}`);
  check("库里写入了存档", typeof row1.viewSpan === "number" && row1.viewSpan > 0,
    `span=${row1.viewSpan}`);

  console.log("\n[2] 用户缩放 + 平移 → 存档跟着变");
  await page.mouse.move(vp1.w / 2, vp1.h / 2);
  await page.mouse.wheel({ deltaY: -400 });
  await sleep(300);
  await page.mouse.move(120, vp1.h - 120);
  await page.mouse.down();
  await page.mouse.move(300, vp1.h - 40, { steps: 12 });
  await page.mouse.up();
  await sleep(800);
  const vp2 = await readVP(page);
  const row2 = readProjectRow(projectId);
  check("缩放确实变了", !near(vp2.zoom, vp1.zoom, 1e-6), `${vp1.zoom.toFixed(4)} → ${vp2.zoom.toFixed(4)}`);
  check("存档跟着变了", !near(row2.viewSpan, row1.viewSpan, 0.5),
    `span ${row1.viewSpan?.toFixed(1)} → ${row2.viewSpan?.toFixed(1)}`);

  console.log("\n[3] 点返回 → 再点项目进来（客户端跳转）→ 必须是刚才那个视野");
  await goHome(page);
  await enterByClick(page, projectId);
  const vp3 = await readVP(page);
  check("不是出厂 zoom=1（这条就是那个 bug 的指纹）", !near(vp3.zoom, 1, 1e-3), `zoom=${vp3.zoom.toFixed(4)}`);
  check("zoom 还原（不是重新取景）", near(vp3.zoom, vp2.zoom, 0.004),
    `离开前 ${vp2.zoom.toFixed(4)} 回来后 ${vp3.zoom.toFixed(4)}`);
  check("平移量还原", near(vp3.x, vp2.x, 2) && near(vp3.y, vp2.y, 2),
    `前 (${vp2.x.toFixed(1)}, ${vp2.y.toFixed(1)}) 后 (${vp3.x.toFixed(1)}, ${vp3.y.toFixed(1)})`);

  console.log("\n[4] 回来之后加一个节点 → 视野不许被抢回去");
  const beforeAdd = await readVP(page);
  const addBtn = await page.$("div.absolute.left-4.top-4 button");
  await addBtn.click();
  await sleep(600);
  const afterAdd = await readVP(page);
  check("加节点不改相机", near(afterAdd.zoom, beforeAdd.zoom, 0.004) &&
    near(afterAdd.x, beforeAdd.x, 2) && near(afterAdd.y, beforeAdd.y, 2),
    `前 ${beforeAdd.zoom.toFixed(4)} 后 ${afterAdd.zoom.toFixed(4)}`);

  console.log("\n[5] 再走一遍「返回 → 点进来」（这次相机已被用户动过、还加过节点）");
  await sleep(400); // 让加节点的保存请求落地，避免干扰
  await goHome(page);
  await enterByClick(page, projectId);
  const vp4 = await readVP(page);
  check("第三次进入仍然是同一个视野", near(vp4.zoom, vp2.zoom, 0.004) &&
    near(vp4.x, vp2.x, 2) && near(vp4.y, vp2.y, 2),
    `期望 zoom ${vp2.zoom.toFixed(4)} 实测 ${vp4.zoom.toFixed(4)}`);

  console.log("\n[6] 存档没有被这些来回跳转写坏");
  const row3 = readProjectRow(projectId);
  check("span 与离开时一致", near(row3.viewSpan, row2.viewSpan, 2),
    `${row2.viewSpan?.toFixed(2)} → ${row3.viewSpan?.toFixed(2)}`);
  check("存档与页面自洽（span ≈ 画布宽 / zoom）", near(row3.viewSpan, vp4.w / vp4.zoom, 3),
    `库 ${row3.viewSpan?.toFixed(2)} vs 页面 ${(vp4.w / vp4.zoom).toFixed(2)}`);
} catch (e) {
  fail++;
  exitCode = 1;
  console.error("\n探针异常：", e?.message ?? e);
} finally {
  await browser.close();
  cleanup();
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
if (fail > 0) exitCode = 1;
// 清理后再确认没有残留
{
  const db = new Database("dev.db", { readonly: true });
  const left = db.prepare("select count(*) c from Project where name = ?").get(P).c;
  db.close();
  if (left !== 0) {
    console.log(`探针残留 ${left} 个项目，请检查 cleanup()`);
    exitCode = 1;
  }
}
process.exit(exitCode);
