/**
 * 裸节点上「字 / 图标 / 叉号」的尺寸护栏。
 *
 * ## 它守的是哪一轮
 *
 * 2026-10-26：人要求「保持当前所有内容的大小比例不变，仅让卡片节点上的字变大 ——
 * 比如角色图三个字、图片中间的尚未生成这四个字以及它的图标、还有右上角的叉号」。
 *
 * 之前这些在屏幕上都小得看不清（zoom ≈ 0.40 时：标签 7.2px、空态文字 9.6px、
 * 叉号圆 12.8px）。现在整体 2 倍：36 / 32 / 160 / 64。
 *
 * ## 为什么断言里同时有「设计值」和「屏幕值」
 *
 * 裸节点在画布内，屏幕上看到的是 `设计值 × zoom`。只看设计值会漏掉
 * 「值改了但画布缩放变了」；只看屏幕值又说不清该改哪里。
 * 两个都写，报红时一眼能看出是「变量没生效」还是「取景变了」。
 *
 * ## 最容易翻车的一条：标签压到产物上
 *
 * 标签原来用 `-top-6`（写死 -24px）。字号从 18 涨到 36 后，标签高度也涨到 36，
 * 底边就从「节点顶边上方 6px」变成「节点顶边下方 12px」—— 字压在图片上，
 * 而且**不报错**。所以位置改成了 `bottom-full mb-1.5`（约束「底边在顶边上方 6px」），
 * 并且这里有一条独立断言直接比两块 rect。反向验证时要专门改它。
 *
 * ## 为什么每次建一个一次性项目
 *
 * 往现有项目里加节点跑一次多两个，第二轮起视口被撑大、点击落空
 * （`page.mouse.click` 在视口外**静默失效**），症状是「代码没动断言全红」。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const ck = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const db = new Database("dev.db");
const projId = `probe_${Date.now().toString(36)}`;
const now = new Date().toISOString();
db.prepare("insert into Project (id, name, createdAt, updatedAt) values (?,?,?,?)").run(
  projId,
  "__probe_bare_type__",
  now,
  now
);
const dropProject = () => {
  const ids = db.prepare("select id from Node where projectId=?").all(projId).map((r) => r.id);
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    db.prepare(`delete from Edge where source in (${ph}) or target in (${ph})`).run(...ids, ...ids);
    db.prepare("delete from Edge where projectId=?").run(projId);
    db.prepare(`delete from Node where id in (${ph})`).run(...ids);
  }
  db.prepare("delete from Run where projectId=?").run(projId);
  db.prepare("delete from Project where id=?").run(projId);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
/*
 * 不能用 networkidle2：dev 第一次编译这个路由会超过 30s，
 * 报错是 `Navigation timeout`，看着像页面坏了。
 * 改成 domcontentloaded + 等画布真的挂出来（轮询，不睡固定毫秒）。
 */
await page.goto(`${BASE}/projects/${projId}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
/*
 * dev 首次编译这个路由时会在编译完成后触发一次整页刷新，
 * 那一瞬间 evaluate 会抛 `Execution context was destroyed (navigation)`。
 * 这不是页面坏了，所以给所有交互包一层重试。
 */
const retry = async (fn, tries = 5) => {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!/Execution context was destroyed|detached/i.test(String(e)) || i === tries - 1) throw e;
      await sleep(600);
    }
  }
};
await retry(() => page.waitForSelector(".react-flow__viewport", { timeout: 90_000 }));
/*
 * 还要等 hydration 完成，不能只等 DOM 出来。
 * `domcontentloaded` 之后 React 的事件处理函数还没挂上，这时候
 * `btn.click()` **什么都不会发生、也不报错** —— 后面的断言会以
 * 「节点没建出来」的形式一起红，看着像功能坏了。
 * 用网络空窗当信号，比 sleep 固定毫秒可靠（dev 编译时长不定）。
 */
await page.waitForNetworkIdle({ idleTime: 700, timeout: 60_000 }).catch(() => {});
await sleep(2500);

/** 所有 evaluate 都走这里：编译期那次整页刷新会打断正在跑的脚本 */
const ev = (fn, arg) => retry(() => page.evaluate(fn, arg));

/* ---------- 加一个未生成的视频节点（裸形态 + 空态 + 有标签） ---------- */
await ev(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /视频生成/.test(x.textContent || ""));
  b?.click();
});
/* 轮询等节点落位，不睡固定毫秒（第一次点击可能要等状态树就绪） */
for (let i = 0; i < 20; i++) {
  const n = await ev(() => document.querySelectorAll('[data-node-type="video.gen"]').length);
  if (n > 0) break;
  await sleep(400);
  if (i === 3) {
    // 第一次点没生效时补一次（hydration 完成前的那次点击会被吞掉）
    await ev(() => {
      const b = [...document.querySelectorAll("button")].find((x) => /视频生成/.test(x.textContent || ""));
      b?.click();
    });
  }
}
await sleep(1000);

/** 点中节点让叉号浮出来；点之前先确保它在视口里（视口外点击静默失效） */
const selectNode = async () => {
  for (let i = 0; i < 6; i++) {
    const r = await ev(() => {
      const n = document.querySelector('[data-node-type="video.gen"]');
      if (!n) return null;
      const b = n.getBoundingClientRect();
      return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
    });
    if (!r) return false;
    if (r.cy > 60 && r.cy < 840) {
      await page.mouse.click(r.cx, r.cy);
      await sleep(700);
      return true;
    }
    await ev(() => document.querySelector(".react-flow__controls-fitview")?.click());
    await sleep(700);
  }
  return false;
};
const selected = await selectNode();

const m = await ev(() => {
  const node = document.querySelector('[data-node-type="video.gen"]');
  if (!node) return { error: "no node" };
  const label = node.querySelector("[data-node-label]");
  const empty = node.querySelector("[data-empty]");
  const icon = empty?.querySelector("svg");
  const hint = empty?.querySelector("span");
  const del = node.querySelector('[data-action="delete"]');
  const dot = label?.querySelector("span");
  const nameSpan = label?.querySelector("span.cursor-text") ?? label?.lastElementChild;

  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      screenW: +r.width.toFixed(1),
      screenH: +r.height.toFixed(1),
      top: +r.top.toFixed(1),
      right: +r.right.toFixed(1),
      bottom: +r.bottom.toFixed(1),
      left: +r.left.toFixed(1),
    };
  };
  const design = (el) => {
    if (!el) return null;
    /*
     * SVG 元素没有 offsetWidth（是 undefined，不是 0）。
     * 也不能用 rect.width ÷ zoom —— 那个 zoom 是从
     * `.react-flow__viewport` 的 `style.transform` 里正则抠 `matrix(...)` 来的，
     * 而 React Flow 在这个版本写的是 `translate(...) scale(...)`，
     * 正则匹配不到就悄悄返回 1，于是「设计值」量出来等于屏幕值。
     * 症状：图标 160 被报成 64，看着像 h-40 没生效。
     * 改用 computedStyle.width：它是布局值，**不受 transform 影响**。
     */
    if (el instanceof SVGElement) return Math.round(parseFloat(getComputedStyle(el).width));
    return el.offsetWidth;
  };
  /* zoom 用「屏幕宽 ÷ 布局宽」反推，不依赖 transform 的字符串格式 */
  const zoom = () => {
    const n = document.querySelector('[data-node-type="video.gen"]');
    if (!n || !n.offsetWidth) return 1;
    return +(n.getBoundingClientRect().width / n.offsetWidth).toFixed(4);
  };
  const fs = (el) => (el ? getComputedStyle(el).fontSize : null);

  return {
    zoom: +zoom().toFixed(4),
    node: { designW: node.offsetWidth, designH: node.offsetHeight, ...box(node) },
    label: { fs: fs(label), designW: label?.offsetWidth, ...box(label) },
    nameText: { fs: fs(nameSpan), text: (nameSpan?.textContent || "").trim() },
    statusDot: { designW: dot?.offsetWidth, ...box(dot) },
    icon: { design: design(icon), ...box(icon) },
    hint: { fs: fs(hint), text: (hint?.textContent || "").trim(), ...box(hint) },
    del: del ? { designW: del.offsetWidth, fs: fs(del), text: (del.textContent || "").trim(), ...box(del) } : null,
    /* 空态那组的垂直间距：图标底边到文字顶边 */
    iconGap: icon && hint ? +(hint.getBoundingClientRect().top - icon.getBoundingClientRect().bottom).toFixed(1) : null,
  };
});

/* ---------- 断言 ---------- */
ck("视频裸节点被找到", !m.error, m.error ?? "ok");
ck("节点尺寸没被改动（1280×720）", m.node?.designW === 1280 && m.node?.designH === 720, `${m.node?.designW}×${m.node?.designH}`);

/* 标签 */
ck("标签字号设计值 36px", m.label?.fs === "36px", m.label?.fs);
ck(
  "标签在屏幕上有 14px 左右（= 首页正文，zoom≈0.40）",
  m.label && Math.abs(m.label.screenH - 14) <= 2.5,
  `屏幕高 ${m.label?.screenH}px（zoom ${m.zoom}）`
);
ck(
  "标签**没有压到产物上**（底边在节点顶边之上）",
  m.label && m.node && m.label.bottom <= m.node.top + 0.5,
  `标签底 ${m.label?.bottom} vs 节点顶 ${m.node?.top}`
);
ck("状态点跟着标签放大到 16px", m.statusDot?.designW === 16, String(m.statusDot?.designW));

/* 空态：图标 + 文字，两者比例不变 */
ck("空态图标 160px", Math.abs((m.icon?.design ?? 0) - 160) <= 2, String(m.icon?.design));
ck("空态文字 32px", m.hint?.fs === "32px", m.hint?.fs);
ck("空态文字还是「尚未生成」", /尚未生成/.test(m.hint?.text ?? ""), m.hint?.text);
ck(
  "图标:文字 仍保持 5:1（比例没被拆散）",
  m.icon && m.hint && Math.abs(m.icon.design / parseFloat(m.hint.fs) - 5) < 0.3,
  `${m.icon?.design} : ${m.hint?.fs}`
);

/* 叉号 */
ck("叉号圆 64×64", m.del?.designW === 64, String(m.del?.designW));
ck("叉号里的 × 是 32px", m.del?.fs === "32px", m.del?.fs);
ck(
  "叉号仍浮在节点右外侧（左边缘不侵入节点）",
  m.del && m.node && m.del.left >= m.node.right - 1,
  `叉号左 ${m.del?.left} vs 节点右 ${m.node?.right}`
);

/* ---------- 截图（当场截，之后视口一挪 rect 就过期） ---------- */
if (selected && !m.error) {
  const pad = 70;
  await page.screenshot({
    path: ".e2e-tmp/bare-type-after.png",
    clip: {
      x: Math.max(0, m.node.left - pad),
      y: Math.max(0, m.node.top - pad),
      width: Math.min(m.node.screenW + pad * 2, 1440 - Math.max(0, m.node.left - pad)),
      height: Math.min(m.node.screenH + pad * 2, 900 - Math.max(0, m.node.top - pad)),
    },
  });
}

console.log(JSON.stringify({ checks, m }, null, 1));
const bad = checks.filter((c) => !c.ok);
console.log(
  bad.length === 0
    ? `\nALL PASS ${checks.length}/${checks.length}`
    : `\nFAILED ${bad.length}/${checks.length}\n` + bad.map((b) => `  ✗ ${b.name} ← ${b.detail}`).join("\n")
);

await browser.close();
dropProject();
db.close();
process.exit(bad.length === 0 ? 0 : 1);
