import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";
const BASE = "http://127.0.0.1:3000", CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new Database("dev.db");
const proj = db.prepare("select p.id, count(n.id) c from Project p join Node n on n.projectId=p.id group by p.id order by c desc limit 1").get();
db.close();
const b = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
await p.goto(`${BASE}/projects/${proj.id}`, { waitUntil: "networkidle2" });
await sleep(1800);

const r = await p.evaluate(() => {
  const vp = document.querySelector(".react-flow__viewport");
  const m = getComputedStyle(vp).transform.match(/matrix\(([^)]+)\)/);
  const zoom = m ? Number(m[1].split(",")[0]) : null;
  const handles = [...document.querySelectorAll(".react-flow__handle")].slice(0, 4).map((el) => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      design: `${el.offsetWidth}x${el.offsetHeight}`,
      screen: `${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`,
      border: cs.borderTopWidth,
      bg: cs.backgroundColor,
      radius: cs.borderRadius,
    };
  });
  const paths = [...document.querySelectorAll(".react-flow__edge-path")].slice(0, 3).map((el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return { strokeW: cs.strokeWidth, stroke: cs.stroke, screenW: `${rect.width.toFixed(0)}` };
  });
  return { zoom, handles, paths };
});
console.log(JSON.stringify(r, null, 1));
const z = r.zoom;
if (z) {
  const h = r.handles[0];
  const designW = Number(h.design.split("x")[0]);
  console.log(`\n换算：设计 ${designW}px × zoom ${z.toFixed(3)} = 屏幕 ${(designW * z).toFixed(1)}px（这个屏幕值才是你眼睛看到的）`);
  console.log(`      线 1px × zoom ${z.toFixed(3)} = 屏幕 ${(1 * z).toFixed(2)}px`);
}
await p.screenshot({ path: ".e2e-tmp/handle-before.png" });
await b.close();
