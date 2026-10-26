/**
 * 视口持久化（2026-10-26）的真浏览器验收。
 *
 * 为什么必须开真浏览器：这一整套的正确性只体现在「关掉再打开看到的东西」上。
 * 纯函数单测能证明换算公式自洽，证明不了 onMoveEnd 有没有被触发、
 * 存档有没有真的落库、刷新之后视野会不会被首屏取景覆盖回去。
 * 而「刷新就变回原样」正是这个功能要消灭的症状，测试必须直接盯它。
 *
 * 跑法：node scripts/probe-viewport.mjs
 * 前提：dev 在 3000。本脚本不触碰模型，MODEL_PROVIDER 是什么都行。
 *
 * 自建一次性项目，跑完连 Node / Edge / Asset / Project 一起删掉。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:3000";
const P = "__viewport_probe__";
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
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---------------- 建项目 ---------------- */

function cleanup() {
  const db = new Database("dev.db");
  const old = db.prepare("select id from Project where name = ?").get(P);
  if (old) {
    // 上传素材会往 ./storage 里写文件。Asset 记录删掉但文件不会自己消失 ——
    // 探针留下的孤儿文件属于「自己造的垃圾」，跑完必须带走，
    // 不然每跑一次就在磁盘上多两张图，跑几十次之后没人分得清哪些能用。
    const assets = db.prepare("select filePath from Asset where projectId = ?").all(old.id);
    db.prepare("delete from Edge where projectId = ?").run(old.id);
    db.prepare("delete from Node where projectId = ?").run(old.id);
    db.prepare("delete from Asset where projectId = ?").run(old.id);
    db.prepare("delete from Project where id = ?").run(old.id);
    for (const a of assets) {
      try {
        fs.unlinkSync(path.join("storage", a.filePath));
      } catch {
        // 文件可能已经不在了，不值得让清理失败挡住验收结论
      }
    }
  }
  db.close();
}

function readProjectRow(id) {
  const db = new Database("dev.db", { readonly: true });
  const r = db.prepare("select viewCenterX, viewCenterY, viewSpan from Project where id = ?").get(id);
  db.close();
  return r ?? {};
}

function setup() {
  cleanup();
  const db = new Database("dev.db");
  const now = rfc3339();
  const projectId = newId("vpt");

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
  ins.run(newId("vp"), projectId, "text.prompt", -100, -400,
    JSON.stringify({ label: "探针文本", prompt: "一行字", status: "idle" }), "idle", now, now);
  ins.run(newId("vp"), projectId, "image.gen", 1300, -400,
    JSON.stringify({ label: "探针图", prompt: "图", aspectRatio: "16:9", status: "idle" }), "idle", now, now);
  ins.run(newId("vp"), projectId, "video.gen", 1300, 500,
    JSON.stringify({ label: "探针视频", prompt: "视频", mode: "auto", aspectRatio: "16:9", duration: "3", status: "idle" }), "idle", now, now);

  db.close();
  return projectId;
}

/* ---------------- 浏览器侧 ---------------- */

/** 读当前视野 + 画布尺寸。React Flow 的 transform 是 `translate(xpx, ypx) scale(z)`。 */
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
  // 首屏取景 → 250ms 防抖 → PUT，留足余量
  await sleep(1000);
}

const projectId = setup();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
});

let exitCode = 0;
try {
  const WIDE = { width: 1600, height: 1000 };
  const page = await browser.newPage();
  await page.setViewport(WIDE);
  await openProject(page, projectId);

  /* --- P1/P2：首屏自动取景要立刻写成存档（人拍板「自动取景算一次操作」） --- */
  console.log("\n[1] 打开没有存档的项目 → 自动取景 → 落库");
  const vp1 = await readVP(page);
  const row1 = readProjectRow(projectId);
  check("视口能读到", Number.isFinite(vp1.zoom), `zoom=${vp1.zoom} raw=${vp1.raw}`);
  check("库里写入了存档", typeof row1.viewSpan === "number" && row1.viewSpan > 0,
    `span=${row1.viewSpan}`);
  check("存档 span 与页面自洽（span ≈ 画布宽 / zoom）",
    near(row1.viewSpan, vp1.w / vp1.zoom, 2),
    `库 ${row1.viewSpan?.toFixed(2)} vs 页面 ${(vp1.w / vp1.zoom).toFixed(2)}`);

  /* --- P3：手动缩放 + 平移后，存档要跟着变 --- */
  console.log("\n[2] 滚轮缩放 + 拖拽平移 → 存档更新");
  const cx = vp1.w / 2;
  const cy = vp1.h / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel({ deltaY: -400 }); // 放大
  await sleep(300);
  // 在一处空白拖拽平移（画布左下角，避开节点）
  await page.mouse.move(120, vp1.h - 120);
  await page.mouse.down();
  await page.mouse.move(260, vp1.h - 40, { steps: 12 });
  await page.mouse.up();
  await sleep(700);

  const vp2 = await readVP(page);
  const row2 = readProjectRow(projectId);
  check("缩放确实变了", !near(vp2.zoom, vp1.zoom, 1e-6), `${vp1.zoom} → ${vp2.zoom}`);
  check("库里的 span 跟着变了", !near(row2.viewSpan, row1.viewSpan, 0.5),
    `${row1.viewSpan?.toFixed(1)} → ${row2.viewSpan?.toFixed(1)}`);
  check("库里的 span 与操作后的页面自洽", near(row2.viewSpan, vp2.w / vp2.zoom, 2),
    `库 ${row2.viewSpan?.toFixed(2)} vs 页面 ${(vp2.w / vp2.zoom).toFixed(2)}`);

  /* --- P4/P5：刷新之后必须回到刚才那个视野（这是整个需求的验收点） --- */
  console.log("\n[3] 刷新页面 → 应该回到刚才的视野，而不是重新取景");
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector(".react-flow__node", { timeout: 30000 });
  await sleep(1000);
  const vp3 = await readVP(page);

  // 期望值由存档算出：zoom = 画布宽 / span，x = 宽/2 − centerX×zoom
  const expZoom = vp3.w / row2.viewSpan;
  const expX = vp3.w / 2 - row2.viewCenterX * expZoom;
  const expY = vp3.h / 2 - row2.viewCenterY * expZoom;
  check("刷新后 zoom 等于存档换算值", near(vp3.zoom, expZoom, 0.004),
    `实测 ${vp3.zoom.toFixed(4)} 期望 ${expZoom.toFixed(4)}`);
  check("刷新后平移量等于存档换算值", near(vp3.x, expX, 1.5) && near(vp3.y, expY, 1.5),
    `实测 (${vp3.x.toFixed(1)}, ${vp3.y.toFixed(1)}) 期望 (${expX.toFixed(1)}, ${expY.toFixed(1)})`);
  check("刷新后视野与刷新前一致（不是重新取景）",
    near(vp3.zoom, vp2.zoom, 0.004) && near(vp3.x, vp2.x, 1.5) && near(vp3.y, vp2.y, 1.5),
    `前 (${vp2.zoom.toFixed(4)}, ${vp2.x.toFixed(1)}, ${vp2.y.toFixed(1)}) 后 (${vp3.zoom.toFixed(4)}, ${vp3.x.toFixed(1)}, ${vp3.y.toFixed(1)})`);

  /* --- P6/P7：换个小窗口打开，内容占屏比例不变 --- */
  console.log("\n[4] 换 1100 宽窗口打开 → zoom 按宽度等比缩小，span 不变");
  const spanBefore = readProjectRow(projectId).viewSpan;
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1100, height: 800 });
  await openProject(page2, projectId);
  const vp4 = await readVP(page2);
  const spanAfter = readProjectRow(projectId).viewSpan;

  check("zoom 按窗口宽等比变化（1100/1600）",
    near(vp4.zoom / vp3.zoom, 1100 / 1600, 0.02),
    `比值 ${(vp4.zoom / vp3.zoom).toFixed(4)} 期望 ${(1100 / 1600).toFixed(4)}`);
  check("span 跨窗口保持不变（这就是「存比例」的意思）",
    near(spanAfter, spanBefore, 2),
    `${spanBefore?.toFixed(1)} → ${spanAfter?.toFixed(1)}`);

  /* --- P8：点「+ 图像生成」，节点必须落在画面正中 --- */
  console.log("\n[5] 加节点 → 必须落在当前画面正中");
  await page2.click('[data-action="open-assets"]').catch(() => {});
  // 用左上工具栏的第一个「+ 节点」按钮
  const addBtn = await page2.$("div.absolute.left-4.top-4 button");
  await addBtn.click();
  await sleep(500);

  const centerCheck = await page2.evaluate(() => {
    const rf = document.querySelector(".react-flow").getBoundingClientRect();
    const nodes = [...document.querySelectorAll("[data-node-id]")];
    const last = nodes[nodes.length - 1];
    const r = last.getBoundingClientRect();
    return {
      dx: r.x + r.width / 2 - (rf.x + rf.width / 2),
      dy: r.y + r.height / 2 - (rf.y + rf.height / 2),
      n: nodes.length,
    };
  });
  check("新节点中心 = 画布中心（±3 屏幕像素）",
    near(centerCheck.dx, 0, 3) && near(centerCheck.dy, 0, 3),
    `偏移 (${centerCheck.dx.toFixed(1)}, ${centerCheck.dy.toFixed(1)})，节点数 ${centerCheck.n}`);

  /* --- P9：一次上传两个文件，同批次要错开（不能重叠） --- */
  console.log("\n[6] 一次上传 2 个文件 → 同批次错开 0.3 个节点宽");
  const input = await page2.$('input[data-upload-input]');
  await input.uploadFile("docs/m7-text-card.png", "docs/m6-canvas.png");
  await sleep(2500);

  const batch = await page2.evaluate(() => {
    const nodes = [...document.querySelectorAll("[data-node-id]")];
    const tail = nodes.slice(-2).map((n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    return { tail, n: nodes.length };
  });
  const vp5 = await readVP(page2);
  const dxWorld = (batch.tail[1].x - batch.tail[0].x) / vp5.zoom;
  const dyWorld = (batch.tail[1].y - batch.tail[0].y) / vp5.zoom;
  const expectDx = 1280 * 0.3; // media.asset 占用尺寸 1280×720
  check("两个新节点确实加上了", batch.n >= 5, `节点数 ${batch.n}`);
  check("同批次横向错开 0.3 个节点宽",
    near(dxWorld, expectDx, 6), `实测 ${dxWorld.toFixed(1)} 期望 ${expectDx.toFixed(0)}`);
  check("纵向按 h/w 等比错开",
    near(dyWorld, expectDx * (720 / 1280), 6),
    `实测 ${dyWorld.toFixed(1)} 期望 ${(expectDx * 720 / 1280).toFixed(0)}`);

  await browser.close();
} catch (e) {
  console.error("\n脚本异常:", e);
  exitCode = 1;
} finally {
  try {
    cleanup();
  } catch (e) {
    console.error("清理失败:", e);
  }
}

console.log(`\n========== ${pass} 通过 / ${fail} 失败 ==========`);
if (fail > 0) exitCode = 1;
process.exit(exitCode);
