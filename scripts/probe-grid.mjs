/*
 * 量「网格点阵 + 缩放」的关系。
 *
 * 人观察到：一直缩小，点会逐渐看不见；一直放大，点变到某个大小就不变了。
 * 这个探针真滚轮，然后把每个 zoom 下的 pattern 尺寸、点半径抄出来，
 * 用数字确认「点有多大」到底由谁决定。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new Database("dev.db");
const proj = db
  .prepare(
    "select p.id, count(n.id) c from Project p join Node n on n.projectId=p.id group by p.id order by c desc limit 1"
  )
  .get();
db.close();
if (!proj) throw new Error("库里没有带节点的项目");

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto(`${BASE}/projects/${proj.id}`, { waitUntil: "networkidle2" });
await sleep(1200);

// 读数：viewport 的 scale、pattern 的宽、点半径，以及换算到屏幕上的点直径
const read = () =>
  page.evaluate(() => {
    const vp = document.querySelector(".react-flow__viewport");
    // xyflow 把 transform 写成 translate(...) scale(...)，读 computed 才是 matrix
    const cs = vp ? getComputedStyle(vp).transform : "";
    const m = cs.match(/matrix\(([^)]+)\)/);
    const zoom = m ? Number(m[1].split(",")[0]) : null;
    const pattern = document.querySelector(".react-flow__background pattern");
    const circle = pattern?.querySelector("circle");
    // SVG 属性而不是 computed style：pattern 的 width 是用户坐标，正好就是「缩放后格距」
    const gapPx = pattern ? Number(pattern.getAttribute("width")) : null;
    const r = circle ? Number(circle.getAttribute("r")) : null;
    const sizeAttr = pattern?.getAttribute("patternUnits");
    return { zoom, gapPx, r, dotDiameter: r === null ? null : r * 2, sizeAttr };
  });

const samples = [];
const first = await read();
samples.push({ step: "初始", ...first });

// 缩小：滚轮向下
const cx = 720;
const cy = 460;
await page.mouse.move(cx, cy);
for (let i = 1; i <= 28; i++) {
  await page.mouse.wheel({ deltaY: 240 });
  await sleep(70);
  if (i % 4 === 0 || i === 28) samples.push({ step: `缩小 ${i} 格`, ...(await read()) });
}
await page.screenshot({ path: ".e2e-tmp/grid-min.png", clip: { x: 0, y: 60, width: 520, height: 420 } });

// 放大：一路滚回并继续向上
await page.mouse.move(cx, cy);
for (let i = 1; i <= 60; i++) {
  await page.mouse.wheel({ deltaY: -240 });
  await sleep(70);
  if (i % 6 === 0 || i === 60) samples.push({ step: `放大 ${i} 格`, ...(await read()) });
}
await page.screenshot({ path: ".e2e-tmp/grid-max.png", clip: { x: 0, y: 60, width: 520, height: 420 } });

console.log("step".padEnd(12), "zoom".padStart(7), "格距".padStart(8), "点直径".padStart(8), "屏幕上点直径".padStart(12));
for (const s of samples) {
  console.log(
    s.step.padEnd(12),
    String(s.zoom?.toFixed(4)).padStart(7),
    String(s.gapPx?.toFixed(2)).padStart(8),
    String(s.dotDiameter?.toFixed(3)).padStart(8),
    String((s.dotDiameter ?? 0).toFixed(3)).padStart(12)
  );
}

const zooms = samples.map((s) => s.zoom).filter((z) => z !== null);
console.log(`\nzoom 范围：${Math.min(...zooms).toFixed(4)} ~ ${Math.max(...zooms).toFixed(4)}`);
const rMax = Math.max(...samples.map((s) => s.r ?? 0));
console.log(`点半径最大：${rMax.toFixed(3)}（对应屏幕直径 ${(rMax * 2).toFixed(3)}px）`);

await browser.close();
