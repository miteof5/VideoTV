/**
 * 首屏取景的「过程」探针：加第一个节点时，中间到底闪过哪些帧？
 *
 * 之前的 probe-add 只量**稳定后**那一帧（sleep 1800 之后），
 * 所以它全绿也说明不了「过程中没有突脸」。这个脚本逐帧采样，把时间序列打出来。
 *
 * 每帧记三件事：
 *   zoom      —— 画布缩放（viewport 的 scale）
 *   visibility —— 节点此刻是 visible 还是 hidden
 *               （@xyflow/react 12.12 的 NodeWrapper 是
 *                 visibility: hasDimensions ? 'visible' : 'hidden'，
 *                 所以「zoom 是 1」不等于「用户看得见」—— 必须两个一起看）
 *   屏幕高    —— 卡片在屏幕上实际占多少像素
 *
 * 真正会被眼睛看到的突脸帧 = zoom 明显大于目标 **且** visibility === 'visible'。
 */
import puppeteer from "puppeteer-core";

const BASE = "http://127.0.0.1:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORT = { width: 1920, height: 1080 };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
await page.setViewport(VIEWPORT);

// 走人走的那条路：首页 → 新建项目（客户端跳转）→ 加节点。全程不刷新。
await page.goto(BASE, { waitUntil: "networkidle2" });
await sleep(800);
await page.type('input[name="name"]', `__flicker_${Date.now()}`);
await page.evaluate(() => {
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent.trim() === "新建项目")
    .click();
});
await page.waitForFunction(() => location.pathname.startsWith("/projects/"), { timeout: 15000 });
await sleep(1200);

await page.evaluate(() => {
  window.__samples = [];
  const tick = () => {
    const vp = document.querySelector(".react-flow__viewport");
    const m = (vp?.style.transform ?? "").match(/scale\(([\d.]+)\)/);
    const node = document.querySelector("[data-node-type]");
    const rect = node?.getBoundingClientRect();
    const flow = document.querySelector(".react-flow");
    window.__samples.push({
      t: performance.now(),
      zoom: m ? Number(m[1]) : null,
      vis: node ? getComputedStyle(node).visibility : null,
      h: rect ? Math.round(rect.height) : 0,
      // 画布可见高（不是窗口高）—— 占比要拿它当分母，否则量出来的数对不上 probe-add
      canvasH: flow?.clientHeight ?? 0,
      n: document.querySelectorAll("[data-node-type]").length,
    });
    window.__raf = requestAnimationFrame(tick);
  };
  tick();
});

await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) =>
    b.textContent.trim().startsWith("+ 文本提示词")
  );
  btn.click();
});
await sleep(2500);

const samples = await page.evaluate(() => {
  cancelAnimationFrame(window.__raf);
  return window.__samples;
});

const first = samples.findIndex((s) => s.n > 0);
const seq = first >= 0 ? samples.slice(first) : samples;
const t0 = seq[0]?.t ?? 0;
// 画布可见高（不是窗口高）—— 占比要拿它当分母，否则量出来的数对不上 probe-add
const canvasH = seq.find((s) => s.canvasH > 0)?.canvasH ?? VIEWPORT.height;

console.log(`采样 ${samples.length} 帧，首个有节点的帧在第 ${first} 个采样点`);
console.log(`画布可见高 ${canvasH}px（窗口 ${VIEWPORT.height}px）\n`);
console.log("时间(ms)  zoom     可见性    屏幕高   占高");
for (const s of seq.slice(0, 26)) {
  const pct = ((s.h / canvasH) * 100).toFixed(1);
  console.log(
    `${(s.t - t0).toFixed(1).padStart(7)}  ${String(s.zoom ?? "-").padEnd(9)}${String(s.vis ?? "-").padEnd(10)}${String(s.h).padStart(5)}   ${pct}%`
  );
}

const zooms = seq.map((s) => s.zoom).filter((z) => z !== null);
const finalZoom = zooms[zooms.length - 1];

/*
 * 突脸帧的判据**不能拿 finalZoom 当基准**。
 *
 * 反向验证时踩到过：把登记尺寸兜底去掉之后最终 zoom 就停在 1（本身就是突脸值），
 * 于是「zoom > finalZoom * 1.2」永远不成立 → 断言假绿，只有靠另一条才抓到。
 * 基准必须是**绝对值**：目标是占画布高 34%，超过 45% 就是突脸，跟最终值无关。
 */
const OVERSIZED = 0.45;
const seen = seq.filter(
  (s) => s.vis === "visible" && s.h > 0 && s.h / canvasH > OVERSIZED
);
const ms = seen.length ? seen[seen.length - 1].t - seen[0].t : 0;

console.log(`\n最终 zoom ${finalZoom}`);

let fail = 0;
const check = (label, ok, got) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}  — ${got}`);
  if (!ok) fail++;
};

console.log("\n=== 加节点的过程中不许出现「看得见的突脸帧」===");
check(
  "看得见的突脸帧为 0",
  seen.length === 0,
  seen.length === 0
    ? "（zoom 全程贴着目标值，一次跳变都没有）"
    : `${seen.length} 帧，持续 ${ms.toFixed(0)} ms，屏幕高 ${seen[0].h}px（占 ${((seen[0].h / canvasH) * 100).toFixed(1)}%）`
);
// 同类护栏：稳态值也要对，否则上面那条可能只是因为压根没取景
check("最终 zoom 落在 34% 档（不是停在 1）", finalZoom > 0.3 && finalZoom < 0.99, String(finalZoom));

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${2 - fail} 通过 / ${fail} 失败`);

await browser.close();
process.exit(fail === 0 ? 0 : 1);
