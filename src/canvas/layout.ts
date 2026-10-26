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
 * 从 preferred 开始找一块不压住任何已有节点的位置。
 * 冲突时向右下螺旋挪动，最多尝试 24 次；实在找不到就返回最后一次的候选。
 */
export function findFreeSpot(
  occupied: Point[],
  preferred: Point,
  width = NODE_WIDTH,
  height = NODE_HEIGHT
): Point {
  const candidate: Point = { ...preferred };

  for (let i = 0; i < 24; i++) {
    const hit = occupied.some(
      (p) =>
        // 两个矩形重叠的充要条件：水平方向有交集 且 垂直方向有交集
        Math.abs(p.x - candidate.x) < width &&
        Math.abs(p.y - candidate.y) < height
    );
    if (!hit) return candidate;

    // 向右下错开：横向加半格、纵向加一整格，形成瀑布式排布
    candidate.x += width / 2;
    candidate.y += height * 0.62;
  }

  return candidate;
}
