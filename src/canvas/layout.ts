// 节点摆放的自动避让逻辑。
//
// 为什么要这个：新节点如果直接落在已有节点上，用户根本看不见它「加进来了」，
// 更糟的是连线时鼠标点中的是上层节点而不是目标 handle，表现为「连线连不上」。
// 一开始我用随机抖动做错开，但节点有 224px 宽，±110 的抖动幅度不够，仍然会压住。
// 正确做法是拿已有节点位置做碰撞检测，冲突就挪，直到找到空位。
//
// 这里是纯函数、不依赖 React 和 React Flow，所以可以单独测。

/**
 * 兜底尺寸。真实尺寸以 nodeRegistry[type].size 为准 —— 每种节点类型
 * 声明自己的尺寸（文本卡片 1024×768，图/视频/素材 1280×720），
 * 新节点按要加的类型取。
 *
 * 这两个常量只在注册表里查不到该类型时兜底，避免拿到 undefined
 * 让碰撞检测整个失效。取文本卡片那一档（1024×768）：
 * 宁可多留一点空隙，也不要让新节点压住已有节点。
 */
export const NODE_WIDTH = 1024;
export const NODE_HEIGHT = 768;

export interface Point {
  x: number;
  y: number;
}

/** 一个「已知尺寸」的矩形。x/y 是画布坐标，w/h 是**设计像素**，不是屏幕像素。 */
export interface Box extends Point {
  w: number;
  h: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * 首屏视野：用**登记尺寸**直接算出 zoom 和位置，不等浏览器测量。
 *
 * 为什么需要这个：`fitView` 必须等 react-flow 把节点量完才知道包围盒，
 * 而节点量完的那一帧就已经画出来了 —— 中间必然夹着几帧「用默认 zoom=1 画的」
 * 大图（实测 2 帧 13~17ms，人眼看得见）。这套逻辑绕开测量：
 * 尺寸从 nodeRegistry 的声明值取，节点一露面视野就已经是对的。
 *
 * 只压放大不压缩小：内容本来就装不下时该缩还得缩（`Math.min` 三段取小）。
 * 语义等价于 tldraw 的 `initialZoom: 'fit-min-100'`。
 *
 * 定位规则与原来 `fitView + 补偏移` 的结果保持一致：
 *   水平：居中（padding 只作用在水平方向，这是实测结论）
 *   垂直：先居中于整个画布，再守两个方向 —— 顶边别钻进工具栏，底边别被挤出视口，
 *         两者冲突时优先顶边（顶边被压住连名字都看不见，比底边被裁更难接受）
 *
 * 纯函数，不依赖 React 和 React Flow，可以单独测。
 */
export function fitViewportFromBoxes(
  boxes: Box[],
  canvas: { w: number; h: number },
  o: { maxHeightRatio: number; topInset: number; padding: number }
): Viewport | null {
  if (boxes.length === 0 || canvas.w <= 0 || canvas.h <= 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let tallest = 0;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
    tallest = Math.max(tallest, b.h);
  }

  const boundsW = maxX - minX;
  const boundsH = maxY - minY;
  // 兜底：包围盒算成 0 会让下面除出 Infinity，zoom 就变成「不设上限」
  const w = boundsW > 0 ? boundsW : 1;
  const h = boundsH > 0 ? boundsH : 1;

  const fitZoom = Math.min((canvas.w * (1 - 2 * o.padding)) / w, canvas.h / h);
  const capByHeight = tallest > 0 ? (o.maxHeightRatio * canvas.h) / tallest : 1;
  const zoom = Math.min(1, fitZoom, capByHeight);

  const cx = minX + boundsW / 2;
  const cy = minY + boundsH / 2;
  const x = canvas.w / 2 - cx * zoom;
  let y = canvas.h / 2 - cy * zoom;

  const top = minY * zoom + y;
  const needDown = Math.max(0, o.topInset - top);
  if (needDown > 0) {
    y += needDown;
  } else {
    const bottom = (minY + boundsH) * zoom + y;
    const needUp = Math.max(0, bottom - canvas.h);
    if (needUp > 0) y -= needUp;
  }

  return { x, y, zoom };
}

/**
 * 落库的视野。三个数都是**画布坐标（设计像素）**，与窗口尺寸无关 ——
 * 这是它能在不同大小的窗口里还原出同样构图的原因。
 */
export interface SavedViewport {
  /** 视口中心落在画布的哪个世界坐标上 */
  centerX: number;
  centerY: number;
  /**
   * 一个画布宽度覆盖多少个设计像素。等价于 `画布宽 ÷ zoom`。
   *
   * 为什么不直接存 zoom：zoom 会随窗口尺寸变，同一份内容在 1920 窗口要 0.349、
   * 在 1080 窗口要 0.196。存死 zoom 等于把当时的窗口一起存了，换屏打开就偏。
   */
  span: number;
}

/**
 * 当前视野 → 存档。与 `viewportFromSaved` 互逆（zoom 未被夹住时逐位相等）。
 *
 * `Viewport.x/y` 是 React Flow 的平移量，屏幕坐标 = 世界坐标 × zoom + x。
 * 所以「屏幕中心对应的世界坐标」= (画布宽/2 − x) ÷ zoom。
 */
export function savedFromViewport(
  vp: Viewport,
  canvas: { w: number; h: number }
): SavedViewport | null {
  if (!(vp.zoom > 0) || canvas.w <= 0 || canvas.h <= 0) return null;
  if (!Number.isFinite(vp.x) || !Number.isFinite(vp.y)) return null;
  return {
    centerX: (canvas.w / 2 - vp.x) / vp.zoom,
    centerY: (canvas.h / 2 - vp.y) / vp.zoom,
    span: canvas.w / vp.zoom,
  };
}

/**
 * 存档 → 当前窗口的视野。
 *
 * 关键在 `zoom = 画布宽 ÷ span`：窗口变宽，zoom 跟着变大，**内容占屏宽的比例不变**。
 * 所以 1920 上存下的构图，换到 1080 打开还是同样的构图，不会「只能看到一半」。
 *
 * 夹 [minZoom, maxZoom] 是必须的：存档可能来自一次极端缩放
 * （比如窗口从 2560 缩到 900 时 span 很小），不夹会算出 react-flow 不接受的 zoom。
 * 夹住之后构图会偏 —— 但这是「窗口小到装不下」的必然代价，比画不出来好。
 */
export function viewportFromSaved(
  saved: SavedViewport,
  canvas: { w: number; h: number },
  limits: { minZoom: number; maxZoom: number }
): Viewport | null {
  if (canvas.w <= 0 || canvas.h <= 0) return null;
  if (!(saved.span > 0)) return null;
  if (!Number.isFinite(saved.centerX) || !Number.isFinite(saved.centerY)) return null;

  const raw = canvas.w / saved.span;
  const zoom = Math.min(limits.maxZoom, Math.max(limits.minZoom, raw));

  return {
    x: canvas.w / 2 - saved.centerX * zoom,
    y: canvas.h / 2 - saved.centerY * zoom,
    zoom,
  };
}

