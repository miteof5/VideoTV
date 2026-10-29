/**
 * 「A 项目 → 首页 → B 项目，B 沿用 A 的相机」（2026-10-29 报的问题）真浏览器探针。
 *
 * 为什么单独一个脚本：`probe-reenter` 验的是**同一个项目**来回进出，
 * 那条路径上相机被复原成同一个值，掩盖了「相机属于上一个项目」这件事。
 * 跨项目时相机一旦没被重置，症状是 B 打开后节点全在屏幕外 ——
 * 看着像空画布，像项目丢了，且不报错。
 *
 * 判据（两条一起看才算数）：
 *   ① B 的 zoom 不能等于 A 离开时的 zoom（精确相等 = 沿用了 A 的相机）
 *   ② B 自己的节点必须在画布矩形里看得见（只看 ① 会被「退回出厂 1.0」骗过）
 *
 * 跑法：node scripts/probe-two-projects.mjs
 * 前提：dev 在 3000。不碰模型，MODEL_PROVIDER 是什么都行。
 * 自建两个一次性项目，跑完连 Node / Edge / Asset / Project 一起删掉。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const PA = "__two_probe_a__";
const PB = "__two_probe_b__";
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
  const rows = db.prepare("select id, name from Project where name in (?, ?)").all(PA, PB);
  for (const r of rows) {
    db.prepare("delete from Edge where projectId = ?").run(r.id);
    db.prepare("delete from Node where projectId = ?").run(r.id);
    db.prepare("delete from Asset where projectId = ?").run(r.id);
    db.prepare("delete from Project where id = ?").run(r.id);
  }
  db.close();
}

/**
 * 两个项目，节点故意摆在不同象限：
 *   A 在 (-200,-300) 附近，B 在 (3000,1500) 附近。
 * 只要相机是 A 的，B 的节点就一定落在屏幕外 —— 不做任何近似判断也能看出来。
 */
function setup() {
  cleanup();
  const db = new Database("dev.db");
  const now = rfc3339();
  const idA = newId("tpa");
  const idB = newId("tpb");
  db.prepare("insert into Project (id,name,createdAt,updatedAt) values (?,?,?,?)").run(
    idA,
    PA,
    now,
    now
  );
  db.prepare("insert into Project (id,name,createdAt,updatedAt) values (?,?,?,?)").run(
    idB,
    PB,
    now,
    now
  );
  const ins = db.prepare(
    `insert into Node (id, projectId, type, positionX, positionY, data, status, createdAt, updatedAt)
     values (?,?,?,?,?,?,?,?,?)`
  );
  const seed = (pid, xs, ys) => {
    ins.run(
      newId("tn"),
      pid,
      "text.prompt",
      xs,
      ys,
      JSON.stringify({ label: "探针文本", prompt: "一行字", status: "idle" }),
      "idle",
      now,
      now
    );
    ins.run(
      newId("tn"),
      pid,
      "image.gen",
      xs + 1400,
      ys,
      JSON.stringify({ label: "探针图", prompt: "图", aspectRatio: "16:9", status: "idle" }),
      "idle",
      now,
      now
    );
  };
  seed(idA, -200, -300);
  seed(idB, 3000, 1500);
  db.close();
  return { idA, idB };
}

function readSaved(id) {
  const db = new Database("dev.db", { readonly: true });
  const r = db
    .prepare("select viewCenterX, viewCenterY, viewSpan from Project where id = ?")
    .get(id);
  db.close();
  return r ?? {};
}

/* ---------------- 浏览器侧 ---------------- */

/** 读相机 + 画布矩形 + 每个节点的屏幕矩形（可见性用真实几何判断，不读 store）。 */
function readScene(page) {
  return page.evaluate(() => {
    const vp = document.querySelector(".react-flow__viewport");
    const rf = document.querySelector(".react-flow");
    const t = vp?.style.transform ?? "";
    const r = rf?.getBoundingClientRect();
    const m = t.match(
      /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\s*\)\s*scale\(\s*([\d.]+)\s*\)/
    );
    const box = r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
    const nodes = [...document.querySelectorAll(".react-flow__node")].map((n) => {
      const b = n.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    // 节点矩形与画布矩形的相交面积占节点面积的比例 —— 1 = 完全在画布内
    const vis = nodes.map((n) => {
      if (!box || n.w <= 0 || n.h <= 0) return 0;
      const iw = Math.max(0, Math.min(n.x + n.w, box.x + box.w) - Math.max(n.x, box.x));
      const ih = Math.max(0, Math.min(n.y + n.h, box.y + box.h) - Math.max(n.y, box.y));
      return (iw * ih) / (n.w * n.h);
    });
    return {
      x: m ? +m[1] : NaN,
      y: m ? +m[2] : NaN,
      zoom: m ? +m[3] : NaN,
      box,
      nodeCount: nodes.length,
      vis,
      maxVis: vis.length ? Math.max(...vis) : 0,
    };
  });
}

async function openByUrl(page, id) {
  await page.goto(`${BASE}/projects/${id}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".react-flow__node", { timeout: 30000 });
  await sleep(1000); // 首屏取景 → 250ms 防抖 → PUT
}

async function goHome(page) {
  await page.evaluate(() => {
    const a = [...document.querySelectorAll("a")].find((x) => x.textContent?.includes("返回"));
    a.click();
  });
  await page.waitForFunction(() => location.pathname === "/", { timeout: 20000 });
  await page.waitForSelector('a[href^="/projects/"]', { timeout: 20000 });
}

/** 从首页点卡片进来（客户端跳转，不整页刷新）。 */
async function enterByClick(page, id) {
  await page.evaluate((pid) => {
    document.querySelector(`a[href="/projects/${pid}"]`).click();
  }, id);
  await page.waitForFunction((pid) => location.pathname === `/projects/${pid}`, { timeout: 20000 }, id);
  await page.waitForSelector(".react-flow__node", { timeout: 30000 });
  await sleep(900);
}

/** 把相机拖到一个独特位置（滚轮放大 + 平移），保证和默认取景值可区分。 */
async function moveCamera(page) {
  const s = await readScene(page);
  await page.mouse.move(s.box.x + s.box.w / 2, s.box.y + s.box.h / 2);
  await page.mouse.wheel({ deltaY: -400 });
  await sleep(300);
  await page.mouse.move(s.box.x + 120, s.box.y + s.box.h - 120);
  await page.mouse.down();
  await page.mouse.move(s.box.x + 300, s.box.y + s.box.h - 40, { steps: 12 });
  await page.mouse.up();
  await sleep(800);
  return readScene(page);
}

const { idA, idB } = setup();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
});

let exitCode = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });

  console.log("\n[1] A、B 都是全新项目：先确认两者没有视野存档");
  check("A 没有视野存档", readSaved(idA).viewSpan === null, JSON.stringify(readSaved(idA)));
  check("B 没有视野存档", readSaved(idB).viewSpan === null, JSON.stringify(readSaved(idB)));

  console.log("\n[2] 打开 A → 把相机拖到独特位置");
  await openByUrl(page, idA);
  const a0 = await readScene(page);
  check("A 自动取景后节点可见", a0.maxVis > 0.5, `最大可见比例 ${a0.maxVis.toFixed(2)}`);
  const a1 = await moveCamera(page);
  check("A 的相机确实变了", !near(a1.zoom, a0.zoom, 1e-6),
    `zoom ${a0.zoom.toFixed(4)} → ${a1.zoom.toFixed(4)}`);
  check("A 的存档写下了独特值", near(readSaved(idA).viewSpan, a1.box.w / a1.zoom, 3),
    `span=${readSaved(idA).viewSpan?.toFixed(1)}`);

  console.log("\n[3] 回首页 → 点 B 进来（这条就是被测路径）");
  await goHome(page);
  await enterByClick(page, idB);
  const b1 = await readScene(page);
  check("B 没有沿用 A 的相机", !near(b1.zoom, a1.zoom, 0.004),
    `A 离开时 zoom=${a1.zoom.toFixed(4)}  B 现在 zoom=${b1.zoom.toFixed(4)}`);
  check("B 没有沿用 A 的平移", !(near(b1.x, a1.x, 2) && near(b1.y, a1.y, 2)),
    `A (${a1.x.toFixed(1)}, ${a1.y.toFixed(1)})  B (${b1.x.toFixed(1)}, ${b1.y.toFixed(1)})`);
  check("B 自己的节点在画布里看得见（关键）", b1.maxVis > 0.5,
    `最大可见比例 ${b1.maxVis.toFixed(2)}`);
  check("B 的视野已落库（打开即定型）", typeof readSaved(idB).viewSpan === "number",
    `span=${readSaved(idB).viewSpan?.toFixed(1)}`);

  console.log("\n[4] 反向：回首页 → 点 A 进来，A 必须恢复自己的存档");
  const savedA = readSaved(idA);
  await goHome(page);
  await enterByClick(page, idA);
  const a2 = await readScene(page);
  check("A 恢复自己的视野（不是 B 的）", near(a2.zoom, a1.zoom, 0.004),
    `A 离开时 ${a1.zoom.toFixed(4)}  回来 ${a2.zoom.toFixed(4)}  B 是 ${b1.zoom.toFixed(4)}`);
  check("A 恢复的平移也对", near(a2.x, a1.x, 2) && near(a2.y, a1.y, 2),
    `前 (${a1.x.toFixed(1)}, ${a1.y.toFixed(1)}) 后 (${a2.x.toFixed(1)}, ${a2.y.toFixed(1)})`);
  check("A 的存档没被 B 覆盖", near(savedA.viewSpan, a1.box.w / a1.zoom, 3),
    `span=${savedA.viewSpan?.toFixed(1)}`);

  console.log("\n[5] 再走一遍：A → 首页 → B（B 现在有存档了，仍必须是 B 自己的）");
  const savedB = readSaved(idB);
  await goHome(page);
  await enterByClick(page, idB);
  const b2 = await readScene(page);
  check("B 第二次进来还是 B 自己的视野", near(b2.zoom, b1.zoom, 0.004),
    `上次 ${b1.zoom.toFixed(4)} 现在 ${b2.zoom.toFixed(4)}（A 是 ${a1.zoom.toFixed(4)}）`);
  check("B 的节点仍然可见", b2.maxVis > 0.5, `最大可见比例 ${b2.maxVis.toFixed(2)}`);
  check("B 的存档仍是自己那份", near(readSaved(idB).viewSpan, savedB.viewSpan, 2),
    `${savedB.viewSpan?.toFixed(1)} → ${readSaved(idB).viewSpan?.toFixed(1)}`);
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
{
  const db = new Database("dev.db", { readonly: true });
  const left = db.prepare("select count(*) c from Project where name in (?, ?)").get(PA, PB).c;
  db.close();
  if (left !== 0) {
    console.log(`探针残留 ${left} 个项目，请检查 cleanup()`);
    exitCode = 1;
  }
}
process.exit(exitCode);
