/**
 * 资产库（每个项目一个）的端到端探针。
 *
 * 守的是这一串**每一环都能静默失效**的东西：
 *
 * 1. 入口是工具栏里一个**独立的**按钮，不是「+ 节点」那几个的同类
 *    （混在一起的话，以后加节点类型会把它挤走，而没人会发现）
 * 2. 上传的素材、生成的产物都进**本项目**的库
 * 3. 别的项目看不到（这是「一个项目一个库」的全部意义）
 * 4. 右键出三项：添加到画布 / 下载 / 删除
 * 5. 「添加到画布」真的落一张 media.asset 节点，并且库里立刻标出「画布上 1」
 * 6. **正在被节点使用时删除会被拒**，且拒绝的话是人话
 * 7. 删掉节点之后能删资产，**磁盘上的文件也没了**
 *
 * 第 7 条最后半句是重点：之前删项目只删记录、文件永远留在 storage 里，
 * 272 个文件只有 2 个还被引用。如果这个探针只验「列表少了一项」，
 * 那个漏会原样保留 —— 所以它直接去磁盘上找文件。
 *
 * ## 一次性项目
 *
 * 建两个空项目（主项目 + 隔离对照项目），跑完连同节点/边/资产一起删。
 * 用现成项目的话跑第二遍就有历史残留，症状是「代码没动，断言忽然红」。
 */
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询直到条件成立。比固定 sleep 可靠：慢的是首次编译，不是我们的代码 */
const waitFor = async (fn, timeoutMs = 5000, step = 120) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(step);
  }
};

const db = new Database("dev.db");
const stamp = Date.now().toString(36);
const projId = `probe_${stamp}`;
const otherId = `probe_${stamp}b`;
const dropId = `probe_${stamp}c`;
const now = new Date().toISOString();
const insertProject = db.prepare(
  "insert into Project (id, name, createdAt, updatedAt) values (?, ?, ?, ?)"
);
insertProject.run(projId, "__probe_assets__", now, now);
insertProject.run(otherId, "__probe_assets_other__", now, now);
insertProject.run(dropId, "__probe_assets_drop__", now, now);

const checks = [];
const ck = (name, ok, detail) =>
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? "" : String(detail) });

/** 清理：资产 → 节点/边 → 项目。资产还要删磁盘文件 */
const dropAll = () => {
  for (const pid of [projId, otherId, dropId]) {
    for (const a of db.prepare("select id, filePath from Asset where projectId=?").all(pid)) {
      fs.rmSync(path.join("storage", a.filePath), { force: true });
    }
    db.prepare("delete from Asset where projectId=?").run(pid);
    const ids = db.prepare("select id from Node where projectId=?").all(pid).map((r) => r.id);
    if (ids.length) {
      const ph = ids.map(() => "?").join(",");
      db.prepare(`delete from Edge where source in (${ph}) or target in (${ph})`).run(...ids, ...ids);
      db.prepare(`delete from Node where id in (${ph})`).run(...ids);
    }
    db.prepare("delete from Run where projectId=?").run(pid);
    db.prepare("delete from Project where id=?").run(pid);
  }
};

/* ---------- 造一个上传件：用库里最大的那张真图，缩略图看起来才像样 ---------- */
const sample = db
  .prepare("select filePath from Asset where kind='image' and sizeBytes > 20000 order by sizeBytes desc limit 1")
  .get();
if (!sample) {
  console.error("storage 里找不到可用的 png/jpg，先跑一次生成或上传");
  process.exit(1);
}
const sampleBuf = fs.readFileSync(path.join("storage", sample.filePath));
const ext = path.extname(sample.filePath).slice(1) || "png";
const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;

const upload = async (pid) => {
  const fd = new FormData();
  fd.append("file", new Blob([sampleBuf], { type: mime }), `probe.${ext}`);
  const res = await fetch(`${BASE}/api/projects/${pid}/assets`, { method: "POST", body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`上传失败：${body?.error ?? res.status}`);
  return body;
};

/* ---------- 浏览器 ---------- */
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

const openLibrary = async () => {
  await page.evaluate(() => document.querySelector('[data-action="open-assets"]')?.click());
  // 等列表真的到位，不等固定毫秒。
  // 第一次打开时 dev 还在编译这条路由，700ms 只够看到「加载中…」——
  // 那会红成「空项目没有空态说明」，而代码是对的。
  await waitFor(
    async () =>
      page.evaluate(() => {
        const t = document.querySelector("[data-asset-count]")?.textContent ?? "";
        return t.trim() !== "" && !/加载中/.test(t);
      }),
    6000
  );
};
const closeLibrary = async () => {
  await page.evaluate(() => document.querySelector('[data-action="close-assets"]')?.click());
  await sleep(300);
};
const items = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-asset-id]")].map((el) => ({
      id: el.getAttribute("data-asset-id"),
      kind: el.getAttribute("data-asset-kind"),
      used: el.querySelector("[data-asset-used]")?.textContent ?? "",
    }))
  );
const openMenuOn = async (id) => {
  const box = await page.evaluate((aid) => {
    const el = document.querySelector(`[data-asset-id="${aid}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }, id);
  if (!box) return null;
  await page.mouse.click(box.x, box.y, { button: "right" });
  await sleep(350);
  return page.evaluate(() => {
    const m = document.querySelector("[data-asset-menu]");
    if (!m) return null;
    return [...m.querySelectorAll("[data-menu-action]")].map((b) => ({
      action: b.getAttribute("data-menu-action"),
      text: (b.textContent || "").trim(),
    }));
  });
};

await page.goto(`${BASE}/projects/${projId}`, { waitUntil: "networkidle2" });
await sleep(1600);

/* ---------- 1. 入口是独立按钮 ---------- */
const toolbar = await page.evaluate(() => {
  const btn = document.querySelector('[data-action="open-assets"]');
  if (!btn) return null;
  const group = btn.parentElement;
  const buttons = [...group.querySelectorAll("button")];
  const addBtns = buttons.filter((b) => /^\s*\+/.test(b.textContent || ""));
  const lastAdd = addBtns[addBtns.length - 1];
  const divider = [...group.children].find(
    (el) => el.tagName !== "BUTTON" && el.getAttribute("aria-hidden") === "true"
  );
  return {
    text: (btn.textContent || "").trim(),
    isPlus: /^\s*\+/.test(btn.textContent || ""),
    addCount: addBtns.length,
    afterLastAdd:
      lastAdd && btn.getBoundingClientRect().left > lastAdd.getBoundingClientRect().right,
    /*
     * 分隔线要**真的看得见**：判 offsetWidth 而不是「元素存在」。
     * 第一版只判存在，于是把它改成 `className="hidden"`（视觉上完全消失）
     * 这条断言照样绿 —— 等于没守。0 宽的线和不存在的线是一个意思。
     */
    dividerWidth: divider ? divider.offsetWidth : 0,
    dividerBetween:
      Boolean(divider && lastAdd) &&
      divider.getBoundingClientRect().left >= lastAdd.getBoundingClientRect().right - 1 &&
      divider.getBoundingClientRect().right <= btn.getBoundingClientRect().left + 1,
  };
});
ck("工具栏有资产库入口", toolbar !== null);
ck("它是独立按钮（不以 + 开头）", toolbar && !toolbar.isPlus, toolbar?.text);
ck(
  "排在添加节点按钮的右边",
  toolbar && toolbar.afterLastAdd && toolbar.addCount >= 1,
  `添加节点 ${toolbar?.addCount} 个`
);
ck(
  "与添加节点之间有一条看得见的分隔线",
  toolbar && toolbar.dividerWidth >= 1 && toolbar.dividerBetween,
  `宽 ${toolbar?.dividerWidth}px`
);

/* ---------- 2. 空态 ---------- */
await openLibrary();
const empty = await page.evaluate(() => {
  const el = document.querySelector("[data-asset-library]");
  return {
    exists: Boolean(el),
    count: document.querySelector("[data-asset-count]")?.textContent?.trim() ?? "",
    text: (el?.innerText || "").replace(/\s+/g, " ").trim(),
  };
});
ck("点开后抽屉出现", empty.exists);
ck("空项目和空态说明", empty.count === "0 个" && /还没有图片或视频/.test(empty.text), empty.count);
await closeLibrary();

/* ---------- 3. 上传的素材进本项目的库 ---------- */
const up = await upload(projId);
await openLibrary();
const afterUpload = await items();
ck("上传后出现在资产库里", afterUpload.length === 1, JSON.stringify(afterUpload));
ck("类型是 image", afterUpload[0]?.kind === "image", afterUpload[0]?.kind);
ck(
  "刚上传时没被任何节点使用",
  afterUpload[0] && !/画布上/.test(afterUpload[0].used),
  afterUpload[0]?.used
);

/* ---------- 4. 右键三项 ---------- */
const menu = await openMenuOn(up.assetId);
ck("右键弹出菜单", menu !== null);
ck(
  "菜单三项：添加到画布 / 下载 / 删除",
  menu &&
    menu.length === 3 &&
    menu.some((m) => m.action === "add" && /添加到画布/.test(m.text)) &&
    menu.some((m) => m.action === "download" && /下载/.test(m.text)) &&
    menu.some((m) => m.action === "delete" && /删除/.test(m.text)),
  JSON.stringify(menu)
);
await page.screenshot({ path: ".e2e-tmp/asset-library-menu.png" });

/* ---------- 5. 添加到画布 ---------- */
const before = await page.evaluate(
  () => document.querySelectorAll('[data-node-type="media.asset"]').length
);
await page.evaluate(() => document.querySelector('[data-menu-action="add"]')?.click());
await sleep(1200);
const added = await page.evaluate(() => {
  const all = [...document.querySelectorAll('[data-node-type="media.asset"]')];
  return {
    count: all.length,
    label: all[all.length - 1]?.getAttribute("data-node-label") ?? "",
  };
});
ck("画布上多了一张素材节点", added.count === before + 1, `${before} → ${added.count}`);
ck("抽屉自动收起（看得见刚加的卡片）", !(await page.$("[data-asset-library]")));
// 保存是 800ms 防抖，等它落库再验 usedBy
await sleep(1200);

await openLibrary();
const used = await items();
ck(
  "库里标出「画布上 1」",
  used.length === 1 && /画布上\s*1/.test(used[0].used),
  used[0]?.used
);

/* ---------- 6. 正在被使用时删除被拒 ---------- */
const menu2 = await openMenuOn(up.assetId);
await page.evaluate(() => document.querySelector('[data-menu-action="delete"]')?.click());
await sleep(600);
const refused = await page.evaluate(() => ({
  error: document.querySelector("[data-asset-error]")?.textContent?.trim() ?? "",
  count: document.querySelectorAll("[data-asset-id]").length,
}));
ck(
  "被节点使用时删除被拒，并说明怎么做",
  /正被\s*1\s*个节点使用/.test(refused.error),
  refused.error
);
ck("被拒时那一条还在", refused.count === 1, String(refused.count));

/* ---------- 7. 删掉节点后能删资产，文件也没了 ---------- */
await closeLibrary();

/*
 * 删节点要**先选中再按 Delete**，不能直接点那个叉号。
 *
 * 素材是裸形态（bare shell），叉号只在悬停/选中时浮现 ——
 * 直接 `querySelector(...).click()` 打在一个还没浮出来的元素上，
 * 什么都不发生，也**不报错**。第一版就是栽在这里：
 * 它报出来的是后面四条连环失败（资产还在、删不掉、文件还在、接口还返回它），
 * 看着像删除接口坏了。
 */
const nodeBox = await page.evaluate(() => {
  const n = document.querySelector('[data-node-type="media.asset"]');
  if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
ck("能定位到刚加的素材节点", nodeBox !== null);
if (nodeBox) {
  await page.mouse.click(nodeBox.x, nodeBox.y);
  await sleep(400);
  await page.keyboard.press("Delete");
  // 等到库里真的没了那张节点（800ms 保存防抖 + 一次提交）
  await waitFor(
    () =>
      page.evaluate(() => !document.querySelector('[data-node-type="media.asset"]')),
    5000
  );
  await sleep(1400);
}
const nodeLeft = db
  .prepare("select count(*) c from Node where projectId=? and type='media.asset'")
  .get(projId).c;
ck("节点已从库里删掉（否则下面删资产会被正当拒绝）", nodeLeft === 0, `剩 ${nodeLeft} 个`);
const assetRow = db.prepare("select filePath from Asset where id=?").get(up.assetId);
await openLibrary();
const menu3 = await openMenuOn(up.assetId);
ck("删掉节点后右键菜单还在", menu3 !== null);
await page.evaluate(() => document.querySelector('[data-menu-action="delete"]')?.click());
await sleep(900);
const gone = await items();
ck("删除后列表里没有了", gone.length === 0, JSON.stringify(gone));
ck(
  "磁盘上的文件也删掉了",
  assetRow ? !fs.existsSync(path.join("storage", assetRow.filePath)) : false,
  assetRow?.filePath
);
ck(
  "数据库记录也没了",
  db.prepare("select count(*) c from Asset where id=?").get(up.assetId).c === 0
);

/* ---------- 8. 别的项目看不到 ---------- */
await upload(otherId);
const api = async (pid) => (await (await fetch(`${BASE}/api/projects/${pid}/assets`)).json()).assets ?? [];
const mine = await api(projId);
const others = await api(otherId);
ck("本项目接口返回自己的资产", mine.length === 0, `主项目 ${mine.length} 条`);
ck("对照项目只看到自己那 1 条", others.length === 1, `对照项目 ${others.length} 条`);
await page.goto(`${BASE}/projects/${otherId}`, { waitUntil: "networkidle2" });
await sleep(1400);
await openLibrary();
const otherView = await items();
ck(
  "打开对照项目的资产库，只有它自己的",
  otherView.length === 1 && otherView[0].id === others[0].id,
  JSON.stringify(otherView)
);
await page.screenshot({ path: ".e2e-tmp/asset-library.png" });

/* ---------- 9. 删项目连带删资产的文件 ---------- */
/*
 * 这一段守的是那个**已经发生了**的漏：删项目只级联数据库记录，
 * 磁盘上的文件永远留在 storage 里。上一版的数字是 272 个文件、55MB，
 * 只有 2 个还被引用 —— 也就是说这个漏已经悄悄吃掉了 99% 的磁盘。
 *
 * 光断言「资产记录没了」是抓不到的：记录本来就一直是没的（级联本来就会删）。
 * 必须**去磁盘上找文件**。
 */
const dropUp = await upload(dropId);
const dropFile = db.prepare("select filePath from Asset where id=?").get(dropUp.assetId)?.filePath;
ck("准备：待删项目的资产有实体文件", Boolean(dropFile && fs.existsSync(path.join("storage", dropFile))), dropFile);

await page.goto(BASE, { waitUntil: "networkidle2" });
await sleep(600);
const submitted = await page.evaluate((pid) => {
  const form = [...document.querySelectorAll("form")].find(
    (f) => f.querySelector('input[name="id"]')?.value === pid
  );
  if (!form) return false;
  form.querySelector('button[type="submit"]')?.click();
  return true;
}, dropId);
ck("首页上找到这个项目的删除按钮", submitted);
await sleep(1500);
ck(
  "删项目后记录没了",
  db.prepare("select count(*) c from Project where id=?").get(dropId).c === 0
);
ck(
  "删项目后磁盘上的文件也没了",
  dropFile ? !fs.existsSync(path.join("storage", dropFile)) : false,
  dropFile
);

/* ---------- 收尾 ---------- */
await browser.close();
dropAll();

const bad = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `  ← ${c.detail}` : ""}`);
console.log(`\n${checks.length - bad.length}/${checks.length} 通过${bad.length ? `，${bad.length} 项失败` : ""}`);
process.exit(bad.length ? 1 : 0);
