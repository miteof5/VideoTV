/*
 * 画布到底是不是「无限」的？
 *
 * 分两件事量，因为它们的答案不一样：
 *   ① 平移：连续往一个方向拖 20 次，看视角坐标是不是一直增长（有没有墙）
 *   ② 缩放：滚轮滚到底，看 zoom 停在哪（这已被 probe-grid 量过，这里顺带复核）
 *
 * 只读操作：拖的是视角，不动节点位置，不写库。
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

const read = () =>
  page.evaluate(() => {
    const vp = document.querySelector(".react-flow__viewport");
    const cs = vp ? getComputedStyle(vp).transform : "";
    const m = cs.match(/matrix\(([^)]+)\)/);
    const n = m ? m[1].split(",").map(Number) : null;
    const pattern = document.querySelector(".react-flow__background pattern");
    return {
      x: n ? Math.round(n[4]) : null,
      y: n ? Math.round(n[5]) : null,
      zoom: n ? Number(n[0].toFixed(4)) : null,
      // pattern 用 transform % scaledGap 取模，理论上永远是一格之内
      patternX: pattern ? Number(pattern.getAttribute("x")) : null,
      patternY: pattern ? Number(pattern.getAttribute("y")) : null,
      patternW: pattern ? Number(pattern.getAttribute("width")) : null,
    };
  });

// 找一块底下真的是 pane 的空白处，避免拖到节点上变成移动节点
const spot = await page.evaluate(() => {
  for (let y = 200; y < 800; y += 40) {
    for (let x = 120; x < 1100; x += 40) {
      const el = document.elementFromPoint(x, y);
      if (el && el.className && String(el.className).includes("react-flow__pane")) return { x, y };
    }
  }
  return null;
});
if (!spot) throw new Error("找不到空白画布区域");
console.log(`拖动起点 (${spot.x}, ${spot.y})\n`);
console.log("次数".padStart(4), "viewportX".padStart(10), "viewportY".padStart(10), "patternX".padStart(9));

const rows = [{ i: 0, ...(await read()) }];
for (let i = 1; i <= 20; i++) {
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.down();
  await page.mouse.move(spot.x + 300, spot.y + 200, { steps: 8 });
  await page.mouse.up();
  await sleep(90);
  const r = await read();
  rows.push({ i, ...r });
  if (i % 4 === 0 || i === 20) {
    console.log(String(i).padStart(4), String(r.x).padStart(10), String(r.y).padStart(10), String(r.patternX).padStart(9));
  }
}

const first = rows[0];
const last = rows[rows.length - 1];
const dx = last.x - first.x;
const dy = last.y - first.y;
console.log(`\n拖了 20 次 × (300,200)px，视角共移动 (${dx}, ${dy})px`);
console.log(`每次平均 (${(dx / 20).toFixed(1)}, ${(dy / 20).toFixed(1)})px —— 若是墙，最后几次会是 0`);

// 滚轮缩到极限，复核缩放下限
await page.mouse.move(spot.x, spot.y);
for (let i = 0; i < 30; i++) await page.mouse.wheel({ deltaY: 240 });
await sleep(400);
const minState = await read();
for (let i = 0; i < 40; i++) await page.mouse.wheel({ deltaY: -240 });
await sleep(400);
const maxState = await read();
console.log(`\n缩放极限：${minState.zoom} ~ ${maxState.zoom}`);

await browser.close();
