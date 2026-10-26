/**
 * 结构验收 —— 用真实浏览器验证「能力 / 端口 / 参数」三层在界面上成立。
 *
 * 只验渲染和交互，不验规则本身（那是 check-structure.ts 的活）。
 *
 * 跑法：node scripts/e2e-structure.mjs
 * 自建独立测试项目，跑完自动清理，不碰演示数据。
 */
import puppeteer from "puppeteer-core";
import Database from "better-sqlite3";

const BASE = "http://127.0.0.1:3000";
const PROJECT_NAME = "__structure_e2e__";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rfc3339 = (d = new Date()) => d.toISOString().replace("Z", "+00:00");
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function cleanupProject(db, projectId) {
  db.prepare("delete from RunEvent where runId in (select id from Run where projectId = ?)").run(projectId);
  db.prepare("delete from Job where runId in (select id from Run where projectId = ?)").run(projectId);
  db.prepare("delete from Run where projectId = ?").run(projectId);
  db.prepare("delete from Edge where projectId = ?").run(projectId);
  db.prepare("delete from Node where projectId = ?").run(projectId);
  db.prepare("delete from Project where id = ?").run(projectId);
}

function setup() {
  const db = new Database("dev.db");
  const now = rfc3339();

  const old = db.prepare("select id from Project where name = ?").get(PROJECT_NAME);
  if (old) cleanupProject(db, old.id);

  const projectId = newId("e2es");
  db.prepare("insert into Project (id,name,createdAt,updatedAt) values (?,?,?,?)").run(
    projectId,
    PROJECT_NAME,
    now,
    now
  );

  const insert = db.prepare(
    `insert into Node (id, projectId, type, positionX, positionY, data, status, createdAt, updatedAt)
     values (?,?,?,?,?,?,?,?,?)`
  );

  const ids = {
    text: newId("e2et"),
    image: newId("e2ei"),
    video: newId("e2ev"),
    asset: newId("e2ea"),
  };

  const mk = (id, type, x, y, data) =>
    insert.run(id, projectId, type, x, y, JSON.stringify(data), "idle", now, now);

  /*
   * 分散摆放，避免面板互相遮挡。
   *
   * 坐标必须跟着注册表里的尺寸走：节点从 400×250 变成
   * 文本 1024×768 / 图视频 1280×720 之后，原来 600 横、520 竖的间距
   * 会让相邻节点叠在一起 —— 症状是「点 A 点到 B 身上」，
   * 而断言只会说「面板里的字段不对」，看不出是布局问题。
   *
   * 现在的规矩：横向间距 ≥ 上一个节点的宽度 + 200；
   * 纵向间距 ≥ 上一个节点的高度 + 面板高 + 余量，
   * 因为参数面板挂在节点下方，叠到下一个节点上就会截胡它的点击。
   *
   * 2026-10-24：字号从 28/20 回落到 22/16，面板高度从约 250 降到约 210
   * （提示词框 128→112、下拉和按钮 40→32）。坐标没有再动 —— 间距本来就比面板高，
   * 面板变矮只会更安全。**但注释里的数字必须跟着改**：留着旧数字，
   * 下次谁按 250 去算，会得到间距过大，虽然不坏但会让人怀疑自己算错了。
   * 真正要盯的还是那条底线：纵向间距 ≥ 上方节点高度 + 上方面板高度。
   */
  mk(ids.text, "text.prompt", -100, -500, { label: "文字", prompt: "一段描述", status: "idle" });
  mk(ids.image, "image.gen", 1200, -500, {
    label: "图",
    prompt: "一张图",
    negativePrompt: "",
    aspectRatio: "16:9",
    status: "idle",
  });
  mk(ids.video, "video.gen", 1200, 700, {
    label: "视频",
    prompt: "一个镜头",
    mode: "auto",
    aspectRatio: "16:9",
    duration: "3",
    status: "idle",
  });
  mk(ids.asset, "media.asset", -100, 700, {
    label: "素材",
    prompt: "",
    status: "idle",
    assetId: "",
    assetKind: "image",
    assetMime: "image/png",
    assetName: "x.png",
    assetSize: 1,
  });

  db.close();
  return { projectId, ids };
}

/** 点中某个节点，返回它面板里的控件清单 */
async function panelFields(page, type) {
  const box = await page.evaluate((t) => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === t
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    /*
     * 点**节点正中**，不是「顶部往下 18px」。
     *
     * 原来用 r.y + 18 是为了点中头部，但那是个绝对像素量：
     * 节点缩放到 0.53 时头部在屏幕上只剩 25px 高，18px 已经贴到边界，
     * 任何一点缩放变化都会让落点滑到正文里（结果仍是选中节点，但脆弱）。
     * 中心点离四条边都远，不会被隔壁节点的面板截胡，也不受缩放下限影响。
     */
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, type);
  if (!box) return null;

  if (process.env.E2E_DEBUG) {
    console.log(
      "  [debug]",
      type,
      JSON.stringify(box),
      JSON.stringify(
        await page.evaluate(
          (p) => ({
            vw: innerWidth,
            vh: innerHeight,
            t: document.querySelector(".react-flow__viewport")?.style.transform,
            // 点击落点到底命中了谁 —— 节点被浮层盖住时，坐标本身是对的，
            // 只有这一项能看出「点到别的东西身上了」。
            hit: (() => {
              const el = document.elementFromPoint(p.x, p.y);
              return el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}` : "null";
            })(),
          }),
          box
        )
      )
    );
  }

  await page.mouse.click(box.x, box.y);
  await sleep(450);

  return page.evaluate((t) => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === t
    );
    const panel = el?.querySelector("[data-node-panel]");
    if (!panel) return { missing: true };
    /*
     * 字号也一起带回来：所有字号都来自 globals.css 里的 --fs-* 变量，
     * 而「变量没定义」「Tailwind 没生成这个任意值」都**不会报错** ——
     * 只是静默回落成继承的 16px。几何断言（宽度、位置）对此完全没有感觉，
     * 只有直接读 computed fontSize 才能证明变量真的生效了。
     */
    const fs = (sel) => {
      const e = panel.querySelector(sel);
      return e ? getComputedStyle(e).fontSize : null;
    };
    return {
      selects: [...panel.querySelectorAll("select")].map((s) => s.getAttribute("data-field")),
      textareas: [...panel.querySelectorAll("textarea")].map((s) => s.getAttribute("data-field")),
      inputs: [...panel.querySelectorAll("input")].map((s) => s.getAttribute("data-field")),
      fsTextarea: fs("textarea"),
      fsSelect: fs("select"),
      fsSend: fs('button[data-action="send"]'),
    };
  }, type);
}

/**
 * 读面板的「composer 几何」：容器的圆角/内边距/边框/阴影 + 里面输入框的边框/底色。
 *
 * 这组断言的来历：2026-10-24 把面板改成一体式 composer（容器带框、控件不带框），
 * 但**退回去是零报错的** —— 只要谁给 textarea 加回 `border`，面板就又变回
 * 「盒子里的盒子」，代码看着完全正常，只有肉眼觉得别扭。
 * 而「别扭」这种东西断言里写不出来，只能钉住「textarea 的边框必须是 0」。
 *
 * 阴影不做精确值断言：里面混着浮层阴影和聚焦光圈两层，
 * 精确比对会在调阴影时天天变红。只测「有没有 3px 那层」和「30px 那层还在不在」——
 * 前者证明 focus-within 生效，后者证明光圈没把浮层阴影顶掉
 * （Tailwind 的 shadow-* 和 ring-* 是两条独立声明，同时存在时后写的会赢）。
 */
async function composerStyle(page, type) {
  return page.evaluate((t) => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === t
    );
    const panel = el?.querySelector("[data-node-panel]");
    if (!panel) return { missing: true };
    const ta = panel.querySelector("textarea");
    const ps = getComputedStyle(panel);
    const ts = ta ? getComputedStyle(ta) : null;
    /*
     * 几何量取的是 getBoundingClientRect（**视觉**尺寸，已经把画布 zoom
     * 和面板自己的 scale(1/zoom) 都算进去了）。所以这三个数直接就是
     * 「屏幕上看起来是多少」—— 面板不随缩放这件事只有这样才测得到。
     * offsetWidth 不行：它是布局值，「不缩放」和「缩放了但布局宽不同」
     * 两种情况下都可能等于 726，区分不了。
     */
    const nr = el.getBoundingClientRect();
    const pr = panel.getBoundingClientRect();
    const vp = document.querySelector(".react-flow__viewport");
    const zoom = vp ? new DOMMatrix(getComputedStyle(vp).transform).a : 1;
    return {
      radius: ps.borderTopLeftRadius,
      padding: ps.paddingTop,
      paddingBottom: ps.paddingBottom,
      borderColor: ps.borderTopColor,
      boxShadow: ps.boxShadow,
      taCount: panel.querySelectorAll("textarea").length,
      taBorder: ts ? ts.borderTopWidth : null,
      taBg: ts ? ts.backgroundColor : null,
      zoom: Math.round(zoom * 1000) / 1000,
      panelW: Math.round(pr.width * 10) / 10,
      centerOff: Math.round((pr.x + pr.width / 2 - (nr.x + nr.width / 2)) * 100) / 100,
      gap: Math.round((pr.y - nr.bottom) * 100) / 100,
    };
  }, type);
}

/** 把焦点放进面板的输入框 / 移走，用来测 focus-within。 */
async function setPanelFocus(page, type, on) {
  await page.evaluate(
    (t, focus) => {
      const el = [...document.querySelectorAll("[data-node-type]")].find(
        (n) => n.getAttribute("data-node-type") === t
      );
      const ta = el?.querySelector("[data-node-panel] textarea");
      if (!ta) return;
      if (focus) ta.focus();
      else ta.blur();
    },
    type,
    on
  );
  // transition-[border-color,box-shadow] 是 150ms，等它跑完再读
  await sleep(260);
}

const { projectId, ids } = setup();const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
  defaultViewport: { width: 1700, height: 1050 },
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: "networkidle2" });
  await page.waitForSelector(".react-flow__node");
  await sleep(1100);

  console.log("=== 参数层：面板控件按能力派生 ===");

  const text = await panelFields(page, "text.prompt");
  // 文本节点有两段字，各住一处：
  //   面板 = 原始描述（prompt），点一下就能改，像对话框
  //   卡片 = 优化结果（optimizedPrompt），双击才能改，像记事本
  // 所以面板里**应该**有一个 textarea，而且只能是 prompt。
  check("文本：面板里有原始描述框", text.textareas.includes("prompt"), JSON.stringify(text.textareas));
  check(
    "文本：面板里没有优化结果的框（它在卡片上）",
    !text.textareas.includes("optimizedPrompt"),
    JSON.stringify(text.textareas)
  );
  // 名称框已经移出面板（改成双击卡片标题改名），面板里只留真参数
  check("文本：面板里没有名称框", !text.inputs.includes("label"), JSON.stringify(text.inputs));
  check("文本：有模型下拉", text.selects.includes("modelId"), JSON.stringify(text.selects));
  check("文本：没有比例", !text.selects.includes("aspectRatio"), JSON.stringify(text.selects));
  check("文本：没有时长", !text.selects.includes("duration"));

  const image = await panelFields(page, "image.gen");
  check("图像：有提示词框", image.textareas.includes("prompt"));
  /*
   * 2026-10-24 起图像节点**没有**负面提示词：面板改成
   * 「一个输入框 + 底栏（模型 / 比例 / 生成）」的一体式 composer，
   * 面板里只允许存在一个 textarea（参照 ActionAgent 的 .chat-input）。
   * 这条断言守的就是「别又长出一个输入框」。
   */
  check("图像：只有一个输入框（没有负面提示词）", image.textareas.length === 1, JSON.stringify(image.textareas));
  check("图像：没有负面提示词", !image.inputs.includes("negativePrompt"), JSON.stringify(image.inputs));
  check("图像：有模型和比例", image.selects.includes("modelId") && image.selects.includes("aspectRatio"));
  check("图像：没有时长", !image.selects.includes("duration"), JSON.stringify(image.selects));

  /*
   * 面板内的字号从 2026-10-24 起是**屏幕像素**，不再引用 --fs-body / --fs-control。
   *
   * 原因：面板脱离画布缩放了（scale(1/zoom)）。画布坐标里写的 30px
   * 在屏幕上会变成实打实的 30px，把面板撑成一堵墙；而 14px 在任何 zoom 下
   * 屏幕上都是 14px。规格抄 ActionAgent 的 14 / 13 / 13。
   *
   * 这两个变量仍然管着「卡片正文」和「界面工具栏」，那边一个字没动。
   */
  check("图像：面板提示词框 14px（屏幕值）", image.fsTextarea === "14px", image.fsTextarea);
  check("图像：面板下拉 13px（屏幕值）", image.fsSelect === "13px", image.fsSelect);
  check("图像：面板发送按钮 13px（屏幕值）", image.fsSend === "13px", image.fsSend);

  /*
   * === 面板是一体式 composer：容器带框、控件不带框 ===
   *
   * 判据全部读 computed style，不看几何：几何正确的东西可以是错的
   * （例如两个框套着也能占对位置，只是难看）。
   */
  const idle = await composerStyle(page, "image.gen");
  check("面板圆角 16px（比卡片 12 更软一档）", idle.radius === "16px", idle.radius);
  check("面板内边距 12px", idle.padding === "12px", idle.padding);
  check("面板下内边距 10px（参照物 12/12/10）", idle.paddingBottom === "10px", idle.paddingBottom);

  /*
   * === 面板不随画布缩放、居中在卡片正下方（2026-10-24）===
   *
   * 这三条在这里只测「当前 zoom 下的静态结果」。真正证明「不随缩放」的
   * 是 scripts/probe-panel.mjs —— 它把 zoom 从 1.0 拉到 2.0 再缩到 0.29，
   * 每次都量一遍宽度，三次都是 726。静态断言测不出「跟着缩了但恰好等于 726」。
   */
  check("面板宽 726px（屏幕值）", Math.abs(idle.panelW - 726) < 1.5, idle.panelW);
  check("面板水平居中对齐卡片", Math.abs(idle.centerOff) < 1, idle.centerOff);
  check("面板距卡片底边 8px", Math.abs(idle.gap - 8) < 1.5, idle.gap);
  check("画布是缩放状态（否则上面三条等于没测）", idle.zoom < 0.95, idle.zoom);
  check("面板里只有一个输入框", idle.taCount === 1, String(idle.taCount));
  check("输入框自己不带边框", idle.taBorder === "0px", idle.taBorder);
  check("输入框背景透明（融进容器）", idle.taBg === "rgba(0, 0, 0, 0)", idle.taBg);
  check("未聚焦时面板只有浮层阴影，没有光圈", !idle.boxShadow.includes("3px"), idle.boxShadow);

  await setPanelFocus(page, "image.gen", true);
  const focused = await composerStyle(page, "image.gen");
  check("聚焦时面板出现 3px 光圈", focused.boxShadow.includes("3px"), focused.boxShadow);
  check(
    "聚焦时面板边框变深",
    focused.borderColor !== idle.borderColor,
    `${idle.borderColor} → ${focused.borderColor}`
  );
  /*
   * 这一条守的是写法本身：光圈和浮层阴影必须是同一条 box-shadow。
   * 分开写（`shadow-[...]` + `ring-*`）时 ring 会把浮层阴影顶掉，
   * 面板会突然「贴在画布上」，而 focus 前后都只是一条看着挺对的阴影。
   */
  check("浮层阴影没被光圈顶掉", focused.boxShadow.includes("30px"), focused.boxShadow);

  await setPanelFocus(page, "image.gen", false);
  const blurred = await composerStyle(page, "image.gen");
  check("失焦后光圈收回，浮层阴影还在", !blurred.boxShadow.includes("3px") && blurred.boxShadow.includes("30px"), blurred.boxShadow);

  const video = await panelFields(page, "video.gen");
  /*
   * 视频节点的面板长什么样，取决于**有没有接视频模型**，两套断言都得备着：
   *   有模型 → 模型 / 比例 / 时长三个下拉
   *   没模型 → 一行「视频模型还没接入」+ 生成按钮禁用（2026-10-25 人拍板）
   * 硬编码任何一套，另一个世界就会红 —— 而那时代码是对的。
   * 这一类「红得没道理」最费时间，所以判据从 `/api/models` 现取，不写死。
   */
  const videoModelIds = await page.evaluate(async () => {
    const j = await (await fetch("/api/models")).json();
    return (j.models ?? [])
      .filter((m) => (m.capabilities ?? []).includes("video"))
      .map((m) => m.id);
  });
  const hasVideoModel = videoModelIds.length > 0;
  check("视频：有提示词框", video.textareas.includes("prompt"));
  check("视频：没有负面提示词", !video.inputs.includes("negativePrompt"), JSON.stringify(video.inputs));
  if (hasVideoModel) {
    check("视频：有时长", video.selects.includes("duration"), JSON.stringify(video.selects));
    check("视频：有模型和比例", video.selects.includes("modelId") && video.selects.includes("aspectRatio"));
  } else {
    const noModel = await page.evaluate(() => {
      const el = document.querySelector('[data-node-type="video.gen"]');
      const field = el?.querySelector('[data-field="modelId"]');
      const btn = el?.querySelector('[data-action="send"]');
      return {
        tag: field ? field.tagName.toLowerCase() : "none",
        text: (field?.textContent || "").trim(),
        sendDisabled: btn ? btn.disabled : null,
        sendTitle: btn?.getAttribute("title") || "",
      };
    });
    check(
      "视频：模型这一项显示「视频模型还没接入」（不是空白下拉）",
      noModel.tag === "span" && /视频模型还没接入/.test(noModel.text),
      `${noModel.tag} / "${noModel.text}"`
    );
    check(
      "视频：没有时长/比例下拉（没有模型就无从取值）",
      !video.selects.includes("duration") && !video.selects.includes("aspectRatio"),
      JSON.stringify(video.selects)
    );
    check(
      "视频：生成按钮禁用，title 说明原因",
      noModel.sendDisabled === true && /视频模型还没接入/.test(noModel.sendTitle),
      `${noModel.sendDisabled} / ${noModel.sendTitle}`
    );
  }

  /*
   * 素材节点：**整个面板都不该存在**（2026-10-26 人要求删掉）。
   *
   * 这里原来是三条「面板里没有提示词框 / 没有下拉 / 没有名称框」。
   * 素材是纯输入，本来就没有任何可编辑项，于是面板里只剩一行
   * 「文件名 + 体积」的只读小字 —— 一个选了什么都填不了的浮窗。
   * 现在判到更前面一步：「里面没有什么」升格成「没有里面」。
   *
   * 反向验证：去掉 NodePanel 里「一行可渲染项都没有 → 不渲染」的提前 return，
   * 面板会回来，这条立刻红（missing 变 false）。
   */
  const asset = await panelFields(page, "media.asset");
  check("素材：选中后没有参数面板", asset.missing === true, JSON.stringify(asset));

  console.log("");
  console.log("=== 参数层：下拉里只出现本能力的模型 ===");
  // 必须重新选中视频节点：上一步选中的是素材，它不浮面板（也没有任何参数），
  // 视频的下拉根本还没被渲染出来。
  await panelFields(page, "video.gen");
  const videoModels = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === "video.gen"
    );
    const s = el?.querySelector('select[data-field="modelId"]');
    return s ? [...s.options].map((o) => o.value) : [];
  });
  /*
   * 这条守的是「模型清单按能力过滤」：视频节点只该看到 video 能力的模型。
   *
   * 判据用 `/api/models` 现取的 video 集合，**不写死模型名**。
   * 原来写的是 `startsWith("mock.video")` —— 那在演示模型时代成立，
   * 接了真视频模型之后它会把「正确的行为」判成失败（红得没道理）。
   * 现在换成「下拉里的每个 id 都必须在这个集合里」：既能抓住串味
   * （视频节点冒出图像模型），也不在乎当前用的是哪家。
   *
   * 一个 video 模型都没有时（没配 key、或视频 API 还没接），
   * 正确的表现是**根本不存在这个下拉** —— 所以断言跟着分叉。
   */
  if (hasVideoModel) {
    check(
      "视频节点的模型全部是 video 能力",
      videoModels.length > 0 && videoModels.every((v) => videoModelIds.includes(v)),
      `${JSON.stringify(videoModels)} ⊆ ${JSON.stringify(videoModelIds)}`
    );
  } else {
    check(
      "没有 video 模型时不渲染模型下拉（降级成说明文字）",
      videoModels.length === 0,
      JSON.stringify(videoModels)
    );
  }

  console.log("");
  console.log("=== 端口层：输入点渲染 ===");
  const handles = await page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll("[data-node-type]")) {
      const t = el.getAttribute("data-node-type");
      out[t] = {
        target: el.querySelectorAll(".react-flow__handle-left").length,
        source: el.querySelectorAll(".react-flow__handle-right").length,
      };
    }
    return out;
  });
  check("素材没有输入点", handles["media.asset"].target === 0, JSON.stringify(handles["media.asset"]));
  check("素材保留输出点", handles["media.asset"].source === 1, JSON.stringify(handles["media.asset"]));
  check("图像有一个输入点", handles["image.gen"].target === 1, JSON.stringify(handles["image.gen"]));
  check("视频有一个输入点", handles["video.gen"].target === 1, JSON.stringify(handles["video.gen"]));

  console.log("");
  console.log("=== 端口层：拖拽时的实时拦截 ===");

  async function handleCenter(nodeType, side) {
    return page.evaluate(
      (t, s) => {
        const el = [...document.querySelectorAll("[data-node-type]")].find(
          (n) => n.getAttribute("data-node-type") === t
        );
        const h = el?.querySelector(`.react-flow__handle-${s}`);
        if (!h) return null;
        const r = h.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      },
      nodeType,
      side
    );
  }

  async function dragConnect(fromType, toType) {
    const from = await handleCenter(fromType, "right");
    const to = await handleCenter(toType, "left");
    if (!from || !to) return { ok: false, why: "找不到 handle" };
    const before = await page.evaluate(() => document.querySelectorAll(".react-flow__edge").length);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 14 });
    await page.mouse.up();
    await sleep(600);
    const after = await page.evaluate(() => document.querySelectorAll(".react-flow__edge").length);
    const err = await page.evaluate(() => document.querySelector("[data-error-banner]")?.textContent ?? "");
    return { ok: after > before, edges: `${before}→${after}`, err };
  }

  // 视频节点的产物是视频，图像节点只接受文字 / 图片 → 必须被拒
  const bad = await dragConnect("video.gen", "image.gen");
  check("视频拖进图像被拒绝（边数不变）", !bad.ok, bad.edges);
  check(
    "拒绝时给出原因（说了谁不能接谁）",
    bad.err.includes("视频") && bad.err.includes("图像生成"),
    bad.err || "（没有出现提示条）"
  );

  // 文字 → 图像是合法的
  const good = await dragConnect("text.prompt", "image.gen");
  check("文字拖进图像被接受（边数 +1）", good.ok, good.edges);

  console.log("");
  console.log("=== 回归：没有凭空出现的下拉项 ===");
  await panelFields(page, "video.gen");
  const dupCheck = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-node-type]")].find(
      (n) => n.getAttribute("data-node-type") === "video.gen"
    );
    const s = el?.querySelector('select[data-field="modelId"]');
    if (!s) return null;
    const vals = [...s.options].map((o) => o.value);
    return { count: vals.length, unique: new Set(vals).size, texts: [...s.options].map((o) => o.textContent) };
  });
  check(
    "视频模型下拉没有重复项（没有下拉时算通过）",
    dupCheck === null || dupCheck.count === dupCheck.unique,
    JSON.stringify(dupCheck?.texts ?? "无下拉")
  );

  console.log("");
  console.log("=== 暗色主题：第三方控件的白底必须被覆盖 ===");
  // React Flow 的 Controls / MiniMap 自带白底，只能靠 globals.css 覆盖。
  // 而手写 CSS 可能被 Lightning CSS 按浏览器目标整条裁掉，**零报错** →
  // 症状是夜间模式里突然冒出两个白方块。这组断言就是防这个静默失效。
  const darkParts = await page.evaluate(() => {
    const lum = (s) => {
      const m = s.match(/\d+/g);
      if (!m) return null;
      const [r, g, b] = m.map(Number);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const btn = document.querySelector(".react-flow__controls-button");
    const mini = document.querySelector(".react-flow__minimap");
    const body = getComputedStyle(document.body);
    return {
      count: document.querySelectorAll(".react-flow__controls-button").length,
      btnBg: btn ? getComputedStyle(btn).backgroundColor : null,
      btnLum: btn ? lum(getComputedStyle(btn).backgroundColor) : null,
      miniBg: mini ? getComputedStyle(mini).backgroundColor : null,
      miniLum: mini ? lum(getComputedStyle(mini).backgroundColor) : null,
      bodyBg: body.backgroundColor,
      bodyLum: lum(body.backgroundColor),
      bodyInkLum: lum(body.color),
    };
  });
  check("Controls 按钮存在（否则下面的断言没对象）", darkParts.count > 0, String(darkParts.count));
  check("Controls 按钮是暗底", darkParts.btnLum !== null && darkParts.btnLum < 60, `${darkParts.btnBg} 亮度 ${darkParts.btnLum?.toFixed(0)}`);
  check("MiniMap 是暗底", darkParts.miniBg !== "rgba(0, 0, 0, 0)" && darkParts.miniLum !== null && darkParts.miniLum < 60, `${darkParts.miniBg} 亮度 ${darkParts.miniLum?.toFixed(0)}`);
  check("页面底色是近黑", darkParts.bodyLum !== null && darkParts.bodyLum < 20, `${darkParts.bodyBg}`);
  check("页面文字是浅色（暗底上必须读得清）", darkParts.bodyInkLum !== null && darkParts.bodyInkLum > 180, `亮度 ${darkParts.bodyInkLum?.toFixed(0)}`);

  /*
   * 「运行全部」已经删掉（2026-10-25，人要求）。
   *
   * 这条不是防我自己手滑加回来，是防「删得只删了一半」：按钮没了但功能还在，
   * 或者某个分支里又渲染出来。删除类改动的验收标准是「入口确实不存在」，
   * 不是「我看过代码里没有」。
   */
  const runAll = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent || "").replace(/\s/g, "").includes("运行全部")
    );
    const api = btn ? btn.closest("[class]")?.className : null;
    return { found: !!btn, where: api };
  });
  check("画布上没有「运行全部」按钮（该功能已删）", !runAll.found, runAll.where ?? "");

  check("页面无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));

  await page.screenshot({ path: ".e2e-tmp/05-structure.png" });
} finally {
  await browser.close();
  const db = new Database("dev.db");
  cleanupProject(db, projectId);
  db.close();
}

console.log("");
console.log(`${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
