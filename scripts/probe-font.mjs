/**
 * 只读诊断：量出「画布字号在屏幕上实际多大」。
 *
 * 不改任何数据，只读。跑法：node scripts/probe-font.mjs
 *
 * 为什么要量而不是算：字号写的是 22px，但画布有 zoom。
 * 屏幕上真正看到的 = 设计字号 × zoom。zoom 又取决于画布里有几个节点
 * （fitView 会缩到装得下，maxZoom 封顶 1）。
 * 所以「太大了 / 太小了」这句话必须带上缩放比才有意义。
 *
 * 这张表就是调 --fs-* 的依据：要「屏幕上像首页正文（14px）」，
 * 就反推 14 ÷ zoom。zoom 0.56 时是 25px，这就是 22–24 这档的来历。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const db = new Database("dev.db");
const proj = db
  .prepare("select id from Project where name = ?")
  .get("__sizes_shot__");
db.close();
if (!proj) {
  console.log("没有 __sizes_shot__ 项目，先跑 node scripts/shot-sizes.mjs");
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--window-size=1920,1080"],
  defaultViewport: { width: 1920, height: 1080 },
});
const page = await browser.newPage();
await page.goto(`${BASE}/projects/${proj.id}`, { waitUntil: "networkidle2" });
await page.waitForSelector(".react-flow__node", { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));

const m = await page.evaluate(() => {
  const t = document.querySelector(".react-flow__viewport")?.style.transform ?? "";
  const zoom = Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? 0);
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { fs: parseFloat(cs.fontSize), lh: parseFloat(cs.lineHeight) };
  };
  const node = document.querySelector('[data-node-type="text.prompt"]');
  return {
    zoom,
    viewport: `${innerWidth}×${innerHeight}`,
    body: pick('[data-node-type="text.prompt"] [data-card-body] p'),
    title: pick('[data-node-type="text.prompt"] [data-card-header] span.truncate'),
    badge: pick('[data-node-type="text.prompt"] [data-card-header] span'),
    footer: pick('[data-node-type="text.prompt"] [data-card-footer] span'),
    nodeBox: node ? `${node.offsetWidth}×${node.offsetHeight}` : null,
  };
});

const at = (fs, z) => (fs * z).toFixed(1);
const rows = [
  ["正文", m.body],
  ["标题", m.title],
  ["徽标", m.badge],
  ["底栏", m.footer],
].filter(([, v]) => v);

console.log(`视口 ${m.viewport}  画布 zoom = ${m.zoom}  文本卡片 ${m.nodeBox}`);
console.log("");
console.log("元素   设计px   ×zoom    100%    50%     33%");
for (const [name, v] of rows) {
  console.log(
    `${name.padEnd(5)} ${String(v.fs).padStart(6)}   ${String(v.lh).padStart(5)}   ` +
      `${at(v.fs, 1).padStart(5)}  ${at(v.fs, 0.5).padStart(5)}  ${at(v.fs, 0.33).padStart(5)}`
  );
}
console.log("");
console.log("参照：首页正文 14px、元信息 12px、站名 24px（100% 缩放，不缩放）");

await browser.close();
