/**
 * 临时：暗色主题的观感 + 关键色值探针。
 * 截首页、画布、选中态面板，并读 computed style 确认变量真的生效
 * （变量写错时是「无色/透明」，在近黑背景上肉眼分不出，必须读值）。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new Database("dev.db");
const proj = db
  .prepare(
    "select p.id, count(n.id) c from Project p join Node n on n.projectId = p.id group by p.id order by c desc limit 1"
  )
  .get();
db.close();
if (!proj) throw new Error("库里没有带节点的项目");

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });

// 首页
await page.goto(BASE, { waitUntil: "networkidle2" });
await sleep(1200);
await page.screenshot({ path: ".e2e-tmp/dark-home.png" });

// 画布
await page.goto(`${BASE}/projects/${proj.id}`, { waitUntil: "networkidle2" });
await sleep(1800);
await page.screenshot({ path: ".e2e-tmp/dark-canvas.png" });

// 选中一个文本节点，让面板浮出来
const picked = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll(".react-flow__node")];
  const text = nodes.find((n) => n.getAttribute("data-id") && n.querySelector("[data-card-header]"));
  const el = text ?? nodes[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + Math.min(40, r.height / 2) };
});
if (picked) {
  await page.mouse.click(picked.x, picked.y);
  await sleep(900);
}
await page.screenshot({ path: ".e2e-tmp/dark-selected.png" });

// 探针：关键面/字/边界的实际计算值
const probe = await page.evaluate(() => {
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const body = cs(document.body);
  const flow = cs(document.querySelector(".react-flow"));
  const node = document.querySelector(".react-flow__node");
  const ncs = cs(node);
  const panel = document.querySelector("[data-node-panel]");
  const pcs = cs(panel);
  const btn = document.querySelector('[data-action="send"]');
  const bcs = cs(btn);
  const sel = document.querySelector("select");
  const scs = cs(sel);
  const meta = document.querySelector("[class*='fs-card-meta']");
  const h1 = document.querySelector("h1");
  return {
    bodyBg: body.backgroundColor,
    bodyInk: body.color,
    flowBg: flow && flow.backgroundColor,
    cardBg: ncs && ncs.backgroundColor,
    cardBorder: ncs && ncs.borderTopColor,
    panelBg: pcs && pcs.backgroundColor,
    panelBorder: pcs && pcs.borderTopColor,
    panelShadow: pcs && pcs.boxShadow,
    sendBg: bcs && bcs.backgroundColor,
    sendBorder: bcs && bcs.borderTopColor,
    sendInk: bcs && bcs.color,
    selectBg: scs && scs.backgroundColor,
    selectInk: scs && scs.color,
    metaInk: meta && getComputedStyle(meta).color,
    h1Ink: h1 && getComputedStyle(h1).color,
  };
});
console.log(JSON.stringify(probe, null, 1));

await browser.close();
