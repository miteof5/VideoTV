/**
 * 视频节点面板的两种状态（看这个环境有没有视频模型）。
 *
 * ## 状态一：有模型（2026-10-26 接入 wan3.0-video 之后）
 *
 * 三个下拉都在、取值正确：比例 3 项、时长里有 30 秒（模型上限）、
 * 默认的 3 秒落在可选范围里（否则节点一建出来就是非法参数，
 * 点生成会在 executor 的 checkOptions 那里被拒）、生成按钮可点。
 *
 * ## 状态二：没有模型（2026-10-25 那天，视频 API 还没接）
 *
 * 1. 模型这一项为空时**必须仍渲染**（曾经是 `return null`，改完看不见、不报错）
 * 2. 「生成 ↑」必须 disabled（否则点下去在节点底部显示给开发者看的报错）
 *
 * 两种状态都是真的：没配 `DASHSCOPE_API_KEY` 时视频模型会从清单里消失，
 * 那时就该退回状态二。所以断言按 `/api/models` 现取现分叉 ——
 * 写死一套的话，另一个世界会红得跟代码对错无关。
 *
 * 图像那条是**对照**：验降级逻辑没误伤「有模型的能力」。
 *
 * ## 为什么每次建一个一次性项目
 *
 * 第一版往现有项目里加节点，跑一次加 2 个、跑完不删。第三次跑就崩了：
 * 7 个节点铺满画布、zoom 顶到下限 0.15、新节点被挤到视口外
 * （`page.mouse.click` 落视口外**静默失效**）→ 面板没浮出来、7 条断言一起红。
 * 症状是「代码没动，断言忽然全红」，非常像改坏了。
 *
 * 所以现在：直接往库里插一个空项目 → 跑 → 把项目和它的节点/边一起删掉。
 * 项目是纯数据行（没有 API 建项目，页面只认 id），插一条就够。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new Database("dev.db");
const projId = `probe_${Date.now().toString(36)}`;
const now = new Date().toISOString();
db.prepare('insert into Project (id, name, createdAt, updatedAt) values (?, ?, ?, ?)').run(
  projId,
  "__probe_video_empty__",
  now,
  now
);

const dropProject = () => {
  const ids = db.prepare("select id from Node where projectId=?").all(projId).map((r) => r.id);
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    db.prepare(`delete from Edge where source in (${ph}) or target in (${ph})`).run(...ids, ...ids);
    db.prepare(`delete from Edge where projectId=?`).run(projId);
    db.prepare(`delete from Node where id in (${ph})`).run(...ids);
  }
  db.prepare("delete from Run where projectId=?").run(projId);
  db.prepare("delete from Project where id=?").run(projId);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await page.goto(`${BASE}/projects/${projId}`, { waitUntil: "networkidle2" });
await sleep(1600);

const add = async (label) => {
  await page.evaluate((l) => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      new RegExp(l).test(b.textContent || "")
    );
    btn?.click();
  }, label);
  await sleep(1200);
  await page.evaluate(() => document.querySelector(".react-flow__controls-fitview")?.click());
  await sleep(800);
};

/**
 * 选中**最后加的那个**某类型节点，读它的面板。
 *
 * 点之前先确认它在视口里 —— `page.mouse.click` 落在视口外**静默失效**，
 * 后果是面板根本没浮出来，所有断言一起红，看着像代码坏了。
 * 加完节点那次 fitView 有可能早于新节点落位，所以这里重试几次。
 */
const inspect = async (type) => {
  const rectOf = (t) =>
    page.evaluate((ty) => {
      const all = [...document.querySelectorAll(`[data-node-type="${ty}"]`)];
      const n = all[all.length - 1];
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, t);

  let rect = await rectOf(type);
  for (let i = 0; i < 4 && rect; i++) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    if (cx > 0 && cx < 1440 && cy > 0 && cy < 900) break;
    await page.evaluate(() => document.querySelector(".react-flow__controls-fitview")?.click());
    await sleep(700);
    rect = await rectOf(type);
  }
  if (!rect) return { found: false };
  await page.mouse.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  await sleep(600);
  return page.evaluate(
    ({ t }) => {
      const all = [...document.querySelectorAll(`[data-node-type="${t}"]`)];
      const n = all[all.length - 1];
      const panel = n?.querySelector("[data-node-panel]");
      const btn = panel?.querySelector('[data-action="send"]');
      const field = panel?.querySelector('[data-field="modelId"]');
      const r = n.getBoundingClientRect();
      // 底栏那一行（模型下拉 + 生成按钮的共同父节点）：截图只截它，
      // 面板整块会带上一大段提示词输入区，字被缩小反而看不清。
      const bar = btn?.parentElement?.getBoundingClientRect();
      /*
       * 面板里所有下拉的取值，按 data-field 归拢。
       *
       * 只数"有几个下拉"是不够的：真正要验的是「时长里有 30 秒」这种
       * 具体取值 —— 那个数来自 catalog，写错了界面照样能渲染出一个下拉。
       */
      const selectFields = {};
      for (const el of panel?.querySelectorAll("select[data-field]") ?? []) {
        selectFields[el.getAttribute("data-field")] = [...el.options].map((o) => o.value);
      }
      return {
        found: true,
        hasPanel: Boolean(panel),
        modelFieldTag: field ? field.tagName.toLowerCase() : "none",
        modelFieldText: (field?.textContent || "").trim(),
        optionCount: field && field.tagName === "SELECT" ? field.options.length : 0,
        selectFields,
        sendDisabled: btn ? btn.disabled : null,
        sendTitle: btn?.getAttribute("title") || "",
        panelText: (panel?.innerText || "").replace(/\s+/g, " ").trim(),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        barRect: bar ? { x: bar.x, y: bar.y, w: bar.width, h: bar.height } : null,
      };
    },
    { t: type }
  );
};

const out = {};
await add("视频生成");
out.video = await inspect("video.gen");

/*
 * 截图必须**当场**截：等会儿再加图像节点并 fitView，viewport 会整体移动，
 * 这张 rect 就过期了 —— 第一版截出来的是一张完全无关的图，
 * 而断言全绿（断言读的是 DOM 文本，它们并不关心画面）。
 *
 * 用元素自身截图而不是 clip 手算矩形：clip 要自己保证落在视口内，
 * 新节点靠下时算出来的高度会变成负数（puppeteer 直接抛
 * `'height' in 'clip' must be positive`），而那是布局问题不是断言问题。
 */
await page.evaluate(() => document.querySelector(".react-flow__controls-fitview")?.click());
await sleep(800);
/*
 * 面板是浮在节点**下方**的，fitView 会把节点挤到底边，面板有一半在视口外 ——
 * 元素截图只会截到视口内那半截（第一版截出来只有提示词输入区）。
 * 先往上拖一段画布，把面板整个带进视口。
 * 截图只是给人看的证据，失败不许影响断言，所以整段包 try。
 */
try {
  await page.mouse.move(50, 700);
  await page.mouse.down();
  await page.mouse.move(50, 480, { steps: 10 });
  await page.mouse.up();
  await sleep(400);
  const panelEl = await page.$('[data-node-type="video.gen"] [data-node-panel]');
  if (panelEl) await panelEl.screenshot({ path: ".e2e-tmp/video-empty-panel.png" });
} catch (err) {
  console.warn("截图失败（不影响断言）：", err.message);
}

await add("图像生成");
out.image = await inspect("image.gen");

const checks = [];
const ck = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

/*
 * 视频节点有两种合法状态，**取决于这个环境有没有视频模型**：
 *
 *   有模型（2026-10-26 起，接入了 wan3.0-video）→ 三个下拉 + 生成可点
 *   没模型（2026-10-25 那天，视频 API 还没接）  → 灰字说明 + 生成变灰
 *
 * 写死任何一套，另一个世界就会红 —— 而那种红跟代码对错无关，
 * 纯粹是「今天没配 key」。所以判据从这里现取，两套断言各守各的状态。
 */
const models = (await (await fetch(`${BASE}/api/models`)).json()).models ?? [];
const hasVideoModel = models.some((m) => m.capabilities.includes("video"));

ck("视频节点被找到", out.video.found, out.video.found);
ck("视频面板选中后浮出", out.video.hasPanel, out.video.panelText);

if (hasVideoModel) {
  // ---- 有模型：正常节点该有的样子 ----
  ck(
    "模型是下拉（不是说明文字）",
    out.video.modelFieldTag === "select" && out.video.optionCount >= 1,
    `${out.video.modelFieldTag} / ${out.video.optionCount} 项`
  );
  ck(
    "比例下拉有 3 个具体比例",
    (out.video.selectFields?.aspectRatio ?? []).length === 3,
    JSON.stringify(out.video.selectFields?.aspectRatio)
  );
  ck(
    "时长下拉里有 30 秒（模型的上限）",
    (out.video.selectFields?.duration ?? []).includes("30"),
    JSON.stringify(out.video.selectFields?.duration)
  );
  /*
   * 「节点一建出来，参数就都是合法的」。
   *
   * 这条最初写成「时长选项里包含 3」，实测**没有区分力**：把 catalog 的
   * durations 改成 [5, 10] 之后它照样绿 —— 因为 PanelSelect 会给
   * 「当前值不在选项里」的项补一行 `3（当前模型不支持）`，
   * 当前值于是永远出现在 options 里。断言等于恒真。
   *
   * 改成判「那行兜底提示有没有出现」：出现了就说明节点带着模型不认的参数
   * 出生，用户点生成会被 executor 的 checkOptions 拒掉，
   * 而界面上只是多了一行小字，很容易看漏。
   */
  ck(
    "节点建出来的默认参数都被模型支持（没有「当前模型不支持」提示）",
    !/当前模型不支持/.test(out.video.panelText),
    out.video.panelText
  );
  ck("生成按钮可点", out.video.sendDisabled === false, String(out.video.sendDisabled));
  ck(
    "生成按钮的 title 是「用当前参数生成」",
    /用当前参数生成/.test(out.video.sendTitle),
    out.video.sendTitle
  );
} else {
  // ---- 没模型：降级呈现 ----
  ck(
    "模型这一项仍渲染（不是 return null）",
    out.video.modelFieldTag === "span",
    `${out.video.modelFieldTag} / "${out.video.modelFieldText}"`
  );
  ck(
    "文字说明「视频模型还没接入」",
    /视频模型还没接入/.test(out.video.modelFieldText),
    out.video.modelFieldText
  );
  ck("生成按钮变灰", out.video.sendDisabled === true, String(out.video.sendDisabled));
  ck(
    "生成按钮的 title 说明原因",
    /视频模型还没接入/.test(out.video.sendTitle),
    out.video.sendTitle
  );
}

ck(
  "图像节点没被误伤（还是下拉且有多项）",
  out.image.modelFieldTag === "select" && out.image.optionCount >= 5,
  `${out.image.modelFieldTag} / ${out.image.optionCount} 项`
);
ck("图像节点生成按钮可点", out.image.sendDisabled === false, String(out.image.sendDisabled));

console.log(JSON.stringify({ world: hasVideoModel ? "有视频模型" : "无视频模型", checks, video: out.video, image: out.image }, null, 1));

await browser.close();
dropProject();
db.close();

const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0 ? "ALL PASS" : `FAILED ${failed.length}: ${failed.map((f) => f.name).join(" | ")}`);
process.exit(failed.length === 0 ? 0 : 1);
