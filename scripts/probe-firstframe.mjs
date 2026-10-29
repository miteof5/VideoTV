/**
 * 「点返回再点进来，先突脸再缩回」的回归探针（2026-10-29）。
 *
 * 为什么不能用 probe-reenter 兼任：那个探针量的是**最终** zoom 对不对，
 * 而这个 bug 的终点一直是对的 —— 错的是中间**一帧**。所以这里必须逐帧采样：
 * 在页面里挂一个 rAF 循环（客户端跳转不会换文档，采样器能活过导航），
 * 记录每一帧的相机 transform 和节点可见性。
 *
 * 实测出来的坏帧长这样（修之前，1600×1000，存档 zoom=0.1827）：
 *   dt= 75ms  zoom=1.0000  节点 2 个可见  首节点屏幕宽 1024   ← 突脸
 *   dt= 84ms  zoom=0.1827                 首节点屏幕宽 187     ← 已缩回
 * 两个条件同时成立才有那一帧：① 挂载时 react-flow 的 store 被重置成 [0,0,1]；
 * ② canvasStore 里还留着上一次的节点（带 measured），第一帧就画出来。
 *
 * 所以断言分三层：
 *   A 不许有「有节点可见 且 zoom 不是目标值」的帧（突脸帧）
 *   B 相机不许在帧与帧之间跳（种子用错尺寸会先差几十 px 再对齐 —— 不突脸但会抖）
 *   C 正确画面必须在点击后 300ms 内出现（别为了不闪而卡住半秒）
 *
 * 跑法：node scripts/probe-firstframe.mjs
 * 前提：dev 在 3000。不碰模型。自建一次性项目，跑完连节点/边/项目一起删。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const P = "__firstframe_probe__";
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

function cleanup() {
  const db = new Database("dev.db");
  // 先 SELECT 出将被删的行再删；只认精确项目名，不用 like 通配
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
  const projectId = newId("ffp");
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
    newId("ff"),
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
    newId("ff"),
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

/** 在页面里装采样器：每一帧记一次相机与可见节点。 */
function installSampler(page) {
  return page.evaluate(() => {
    window.__frames = [];
    window.__rec = false;
    const tick = () => {
      if (window.__rec) {
        const vp = document.querySelector(".react-flow__viewport");
        const t = vp?.style.transform ?? "";
        const m = t.match(
          /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\s*\)\s*scale\(\s*([\d.]+)\s*\)/
        );
        const all = [...document.querySelectorAll(".react-flow__node")];
        const shown = all.filter((n) => {
          const cs = getComputedStyle(n);
          if (cs.visibility === "hidden" || cs.display === "none") return false;
          return n.getBoundingClientRect().width > 1;
        });
        window.__frames.push({
          t: performance.now(),
          path: location.pathname,
          zoom: m ? +m[3] : null,
          x: m ? +m[1] : null,
          y: m ? +m[2] : null,
          shown: shown.length,
          w0: shown[0] ? shown[0].getBoundingClientRect().width : 0,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
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

  console.log("\n[1] 整页加载 → 把相机挪到一个跟默认差别很大的位置");
  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".react-flow__node", { timeout: 30000 });
  await sleep(1200);
  await page.mouse.move(800, 500);
  await page.mouse.wheel({ deltaY: 600 }); // 缩小
  await sleep(300);
  await page.mouse.move(200, 800);
  await page.mouse.down();
  await page.mouse.move(600, 400, { steps: 10 });
  await page.mouse.up();
  await sleep(900); // onMoveEnd 250ms 防抖 → PUT

  const before = await page.evaluate(() => {
    const vp = document.querySelector(".react-flow__viewport");
    const m = (vp?.style.transform ?? "").match(
      /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\s*\)\s*scale\(\s*([\d.]+)\s*\)/
    );
    return m ? { x: +m[1], y: +m[2], zoom: +m[3] } : null;
  });
  check("离开前读得到相机", before !== null && before.zoom > 0,
    before ? `zoom=${before.zoom.toFixed(4)}` : "读不到");

  await installSampler(page);

  console.log("\n[2] 点「← 返回」→ 点项目卡片进来（客户端跳转），逐帧采样");
  await page.evaluate(() => {
    const a = [...document.querySelectorAll("a")].find((x) => x.textContent?.includes("返回"));
    a.click();
  });
  await page.waitForFunction(() => location.pathname === "/", { timeout: 20000 });
  await page.waitForSelector('a[href^="/projects/"]', { timeout: 20000 });
  await sleep(400);

  await page.evaluate(() => {
    window.__frames = [];
    window.__t0 = performance.now();
    window.__rec = true;
  });
  await page.evaluate((id) => {
    document.querySelector(`a[href="/projects/${id}"]`).click();
  }, projectId);
  await sleep(1500);
  const { t0, list } = await page.evaluate(() => {
    window.__rec = false;
    return { t0: window.__t0, list: window.__frames };
  });

  const frames = list
    .filter((f) => f.path.includes("/projects/"))
    .map((f) => ({ ...f, dt: f.t - t0 }));

  if (process.env.PROBE_VERBOSE) {
    console.log("   dt    zoom      x        y    可见  首节点宽");
    for (const f of frames.slice(0, 12)) {
      console.log(
        `  ${String(Math.round(f.dt)).padStart(4)}  ${f.zoom === null ? "  -   " : f.zoom.toFixed(4)}  ` +
          `${f.x === null ? "   -  " : f.x.toFixed(1).padStart(7)}  ` +
          `${f.y === null ? "   -  " : f.y.toFixed(1).padStart(6)}  ` +
          `${String(f.shown).padStart(3)}  ${String(Math.round(f.w0)).padStart(6)}`
      );
    }
  }

  check("采样到了足够多的帧（探针自检）", frames.length >= 8, `${frames.length} 帧`);

  // A 突脸帧：有节点可见，但 zoom 不是目标
  const slap = frames.filter(
    (f) => f.shown > 0 && (f.zoom === null || Math.abs(f.zoom - before.zoom) > 0.02)
  );
  check(
    "没有任何一帧「有节点可见但 zoom 不对」（突脸帧）",
    slap.length === 0,
    slap.length
      ? `${slap.length} 帧，第一帧 dt=${Math.round(slap[0].dt)}ms zoom=${slap[0].zoom}`
      : "0 帧"
  );

  // A' 更严格：只要有节点可见，节点屏幕宽就必须 ≈ 设计宽 × 目标 zoom
  const badWidth = frames.filter(
    (f) => f.shown > 0 && Math.abs(f.w0 - 1024 * before.zoom) > 6
  );
  check(
    "可见节点的屏幕宽度始终等于「设计宽 × 目标 zoom」",
    badWidth.length === 0,
    badWidth.length ? `${badWidth.length} 帧，最大 ${Math.round(Math.max(...badWidth.map((f) => f.w0)))}px` : "全部吻合"
  );

  // B 相机不许帧间跳：种子用错尺寸会先差几十 px 再对齐
  let jump = null;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a.zoom === null || b.zoom === null) continue;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > 2 && !jump) jump = { dt: b.dt, d };
  }
  check("相机没有帧间跳变（>2px）", jump === null,
    jump ? `dt=${Math.round(jump.dt)}ms 跳了 ${jump.d.toFixed(1)}px` : "最平滑");

  // C 正确画面要在 300ms 内出现
  const firstRight = frames.find((f) => f.shown > 0 && Math.abs(f.zoom - before.zoom) <= 0.02);
  check("正确画面在点击后 300ms 内出现", !!firstRight && firstRight.dt < 300,
    firstRight ? `dt=${Math.round(firstRight.dt)}ms` : "始终没出现");

  console.log("\n[3] 回来之后相机仍是离开时那个，没有被种子写坏存档");
  const after = await page.evaluate(() => {
    const vp = document.querySelector(".react-flow__viewport");
    const m = (vp?.style.transform ?? "").match(
      /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\s*\)\s*scale\(\s*([\d.]+)\s*\)/
    );
    return m ? { x: +m[1], y: +m[2], zoom: +m[3] } : null;
  });
  check(
    "相机与离开时一致",
    after !== null && Math.abs(after.zoom - before.zoom) < 0.004 &&
      Math.abs(after.x - before.x) < 2 && Math.abs(after.y - before.y) < 2,
    after
      ? `前 (${before.x.toFixed(1)}, ${before.y.toFixed(1)}, ${before.zoom.toFixed(4)}) ` +
        `后 (${after.x.toFixed(1)}, ${after.y.toFixed(1)}, ${after.zoom.toFixed(4)})`
      : "读不到"
  );
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
  const left = db.prepare("select count(*) c from Project where name = ?").get(P).c;
  db.close();
  if (left !== 0) {
    console.log(`探针残留 ${left} 个项目，请检查 cleanup()`);
    exitCode = 1;
  }
}
process.exit(exitCode);
