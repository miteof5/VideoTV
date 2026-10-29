"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  useReactFlow,
  useStoreApi,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCanvasStore } from "@/stores/canvasStore";
import { useRunStore } from "@/stores/runStore";
import { useUiStore } from "@/stores/uiStore";
import { NODE_STATUS, NODE_TYPE } from "@/lib/constants";
import { useRunStream } from "@/hooks/useRunStream";
import { RunStatus } from "@/canvas/RunStatus";
import { AssetLibrary, type AssetItem } from "@/canvas/AssetLibrary";
import { RunHistory } from "@/canvas/RunHistory";
import { addableTypes, nodeRegistry } from "@/canvas/nodeRegistry";
import { reactFlowNodeTypes } from "@/canvas/nodeTypes";
import {
  fitViewportFromBoxes,
  savedFromViewport,
  viewportFromSaved,
  NODE_WIDTH,
  NODE_HEIGHT,
  type Box,
  type SavedViewport,
  type Viewport,
} from "@/canvas/layout";
import type { CanvasNode } from "@/canvas/types";
import type { NodeRuntime } from "@/stores/runStore";

/**
 * 画布上浮着的工具栏（左上「+ 节点」、右上「已保存」）占掉的顶部高度。
 *
 * 它是浮层，不占布局 —— 对 React Flow 来说视口就是整个矩形，
 * 所以取景时内容会一头钻进工具栏底下。
 * 96 = 工具栏实测高度（按钮 20px 字 + 上下 padding ≈ 56）+ 40 的呼吸空间。
 * 工具栏再改样式时记得回来看这个数。
 */
const FLOATING_UI_H = 96;

/**
 * 首屏取景时，内容**最多占画布高度的比例**。
 *
 * 为什么需要这个上限：`fitView` 的职责是「把包围盒尽量放满视口」。
 * 多节点项目包围盒大、算出来是缩小，没问题；但**空项目加的第一个节点**
 * 包围盒就是它自己 —— fitView 会把这张卡片放大到几乎顶满视口。
 * 人截图反馈「太突脸」，实测 1080×680 窗口下 zoom 0.732、占视口高 89.5%。
 *
 * 为什么用「占视口高的比例」而不是固定 zoom：
 * 同一张 1024×768 的卡片，1080 宽窗口里 0.732 就顶满，1920 宽窗口里 1.0 才占 74.7%。
 * 固定 zoom 只能照顾一种窗口 —— 大屏上偏小、小屏上偏大。按比例算则**观感一致**，
 * 代价是同一个项目在不同窗口里 zoom 不同。人已拍板取这条。
 *
 * 0.34 这个数是从人的截图里反推的：卡片 446×335 像素，宽高比正好是 1024×768 的 0.436 倍，
 * 画布可见高 984 → 335/984 = 34%。人原话「我希望默认能达到这个比例」。
 * （上一版是 0.64，取自「3 节点项目打开时占高 65% 的观感」；看真实窗口后要求再收一半。）
 *
 * 只**限制放大**，不限制缩小：内容本来就装不下时（多节点项目）fitView 该缩还得缩，
 * 这个上限算出的是大于实际 zoom 的值，`Math.min` 之后不产生影响。
 */
const FIRST_VIEW_MAX_H = 0.34;

/**
 * 首屏内容的水平留白比例。
 *
 * 0.12 是沿用 `fitView({ padding })` 时期的值，不能随手改：
 * 实测 React Flow 的 padding **只作用在水平方向**（垂直方向顶边仍会落在 −1.4px），
 * 所以垂直方向的避让是靠 `FLOATING_UI_H` 另算的，跟这个数无关。
 */
const FIRST_VIEW_PADDING = 0.12;

/**
 * 画布缩放的硬边界，**读存档时也要用同一组数夹一次**。
 *
 * 下限 0.15：一张 1280 宽的节点缩到 0.15 还有 192px，认得出是哪张图，
 * 再小就只剩一个色块（详见下面 minZoom 那段历史）。
 * 上限 2：React Flow 的默认值，再大只是像素化，看不出更多信息。
 *
 * 为什么读存档必须夹：存档里的 span 是「上一个窗口」算出来的。
 * 窗口从 2560 缩到 900 之后再打开，`画布宽 ÷ span` 可能算出 0.09 ——
 * 那是 react-flow 不接受的 zoom，写进去会被库自己夹回来，
 * 但夹的动作发生在 onMove 之后，等于先画一帧错的再纠正。
 * 自己先夹，第一帧就是对的。
 */
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2;

/**
 * 连线的粗细，单位是**屏幕像素**（不是画布坐标）。
 *
 * 为什么要单独写一个常量、而不是直接在 CSS 里写 `stroke-width: 1`：
 * 连线画在 `.react-flow__viewport` 里，那个 div 带 `transform: scale(zoom)`，
 * 所以 stroke-width 的每一 px 都会被缩放吃掉。实测 4 节点项目首屏 zoom 0.173，
 * `stroke-width: 1` 在屏幕上只剩 **0.17px** —— 抗锯齿把它摊成一道极淡的影，
 * 看着像「线快没了」，而且它不是颜色问题：把颜色调到纯白也只是更淡的白。
 *
 * 试过 `vector-effect: non-scaling-stroke`（SVG 规范里专门干这个的），
 * **在这儿无效**：它只抵消 SVG 内部的变换（viewBox / path transform），
 * 而 React Flow 的缩放来自外层 div 的 CSS transform。实测加与不加都是 0.17px。
 *
 * 所以走社区的另一条标准做法：**运行时把 zoom 除回去**
 * `strokeWidth = 期望屏幕宽 / zoom`，写进库自己的变量 `--xy-edge-stroke-width`
 * （`@xyflow/react` 的 `style.css` 里是
 * `stroke-width: var(--xy-edge-stroke-width, var(--xy-edge-stroke-width-default))`，
 * 这是官方留的扩展点 —— 比覆盖选择器可靠，库改版也不会失效）。
 *
 * 取 1.5：0.17px 的问题是「看不见」，1.5px 在暗底上是一条清楚的实线，
 * 又不至于像 2px 那样有「描边」感。改这一个数就能整体调粗细。
 */
const EDGE_SCREEN_W = 1.5;

/**
 * 两个 viewport 是不是「同一个取景」。
 *
 * 容差按**屏幕像素**给：zoom 差 0.001 在 720 高的画布上是 0.7px，
 * 平移差 0.5 设计像素在 zoom 0.3 时是 0.15 屏幕像素 —— 都看不出来。
 * 定义在模块顶层是为了身份稳定：写成组件内的箭头函数，
 * `applyCamera` 每次渲染都会换一个引用，那个 effect 就会每帧重跑一遍。
 */
function sameViewport(a: Viewport, b: Viewport): boolean {
  return (
    Math.abs(a.zoom - b.zoom) < 0.001 &&
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5
  );
}

/**
 * 上一次量到的画布矩形，连同**量的时候**的窗口尺寸。
 *
 * 为什么要缓存：客户端跳转重新挂载时，ref 还没挂上 DOM（实测 render 阶段
 * `canvasRef.current` 是 null），但 react-flow 的第一帧就在这次 render 里定下来。
 * 而「画布 = 窗口 − 固定外框」，外框（header 高度）不会因为切页面而变，
 * 所以用差值就能把画布尺寸还原出来，窗口在这期间被改过大小也算得准。
 *
 * 只在这一处更新，读到的地方只有 `estimatedCanvasBox`。
 */
let lastCanvasBox: { w: number; h: number; winW: number; winH: number } | null = null;

function rememberCanvasBox(w: number, h: number) {
  if (w > 0 && h > 0) {
    lastCanvasBox = { w, h, winW: window.innerWidth, winH: window.innerHeight };
  }
}

function estimatedCanvasBox(): { w: number; h: number } | null {
  if (!lastCanvasBox) return null;
  const w = lastCanvasBox.w + (window.innerWidth - lastCanvasBox.winW);
  const h = lastCanvasBox.h + (window.innerHeight - lastCanvasBox.winH);
  return w > 0 && h > 0 ? { w, h } : null;
}

function CanvasInner({ initialViewport }: { initialViewport: SavedViewport | null }) {
  const projectId = useCanvasStore((s) => s.projectId);
  // 订阅运行流。整个画布只有这一处订阅 —— 事件进来后由 runStore 分发，
  // 各个节点按自己的 id 去取，不需要每个节点各开一条 SSE。
  useRunStream();
  // 逐项订阅：这样只有真正变化的那一项才会触发重渲染。
  // 如果写成 useCanvasStore() 整体解构，任何字段变动都会重渲染整个画布。
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const dirty = useCanvasStore((s) => s.dirty);
  const revision = useCanvasStore((s) => s.revision);
  const lastError = useCanvasStore((s) => s.lastError);
  const onNodesChange = useCanvasStore((s) => s.onNodesChange);
  const onEdgesChange = useCanvasStore((s) => s.onEdgesChange);
  const onConnect = useCanvasStore((s) => s.onConnect);
  const addNode = useCanvasStore((s) => s.addNode);
  const setError = useCanvasStore((s) => s.setError);

  const setDragging = useUiStore((s) => s.setDragging);
  const { screenToFlowPosition, deleteElements, fitView, setViewport, getViewport } =
    useReactFlow();
  const [saving, setSaving] = useState(false);

  /**
   * 首屏取景：让**第一个出现的节点**一露面就停在「占画布高 34%」这一档。
   *
   * 先纠正一个容易写歪的因果：它服务的时刻**不是「打开项目」**。
   * 新项目进来是一张空画布，这一刻没有任何东西可取景；真正发生的是
   * 「用户加了第一个节点」—— 视野就该定在 34% 这个比例上，
   * 而不是把这张 1024×768 的卡片顶满屏幕。
   * 34% 是**默认状态本身**，不是「帮用户找到节点在哪」的兜底。
   *
   * 多节点时同一个公式按包围盒缩小（见 `Math.min` 三段），
   * 那是公式的自然结果，不是这段代码的目的。
   *
   * 为什么不用 `<ReactFlow fitView>` 这个 prop：
   * 它会在**第一个节点测量完成**时就执行一次。以前所有节点都是 400×250、
   * 挨得又近，看不出问题；图像节点改成「按图片尺寸」之后，一张 402×720 的竖图
   * 加上旁边的节点，第一个节点的包围盒和整张图的包围盒差得很远 ——
   * 结果打开项目时画布只对着第一个节点对齐，其余节点跑到屏幕外面，
   * 画布上看起来是空的。这**不报错**，只会让人以为项目丢了。
   *
    * 所以等 `nodesInitialized`（所有节点都量过了）再自己调一次 fitView。
   * 只做一次：之后用户自己缩放、平移，不能被重新对齐抢走。
   *
   * ### 为什么 fitView 之后还要手动往下推一下
   *
   * `fitView` 只知道「视口是个矩形」，不知道画布上浮着一层工具栏
   * （左上「+ 节点」、右上「已保存」），它们占掉顶部约 90px。
   * 内容是居中铺进去的，包围盒一大，顶边就会落在 y ≈ 0 甚至负数 ——
   * 症状是**打开项目第一眼看不见最上面那个节点的头部**，
   * 而画布本身一切正常，只有平移一下才看得见。
   *
   * padding 不能解决这件事：实测 `padding: 0.12` 只在**水平**方向留了白
   * （translate.x 恰好是视口宽的 12%），垂直方向内容顶边仍落在 -1.4px。
   * 与其去猜它的内部算法，不如自己算一次「顶边现在在哪」再补偏移 ——
   * 语义直接，工具栏高度将来变了也只改 FLOATING_UI_H 一个数。
   */
  const nodeCount = nodes.length;

  /*
   * 首屏取景 / 还原存档的**介入判据**。
   *
   * 判据不是「这段 effect 跑过没有」，而是「相机现在还是不是出厂状态」
   * —— 这一条是 2026-10-26 人报的 bug 换来的：
   *
   * 现象：点「← 返回」回首页，再点同一个项目进来，画面变成 zoom=1 的突脸，
   * 而且之后怎么都不恢复，只有整页刷新（F5）才对。而 F5 恰好是对的，
   * 所以第一次排查时被「刷新就好」误导成数据没存下来 —— 其实库里三个数好端端的。
   *
   * 根因：Next 的段缓存会保留组件实例的 hooks 状态（实测同一个实例 id 贯穿两次进入，
   * 中间只有 effect 卸载/重挂），**但 react-flow 的相机被重置成了默认 `{x:0,y:0,zoom:1}`**。
   * 于是「跑过就锁死」的 `didFitRef` 还是 true，还原逻辑直接被挡在门外 ——
   * 锁在，相机没了。
   *
   * 更早的 2026-10-24 那次是同一个病根的反面：空画布把「取景机会」吃掉、
   * 锁提前上死，加节点后停在 zoom=1，**刷新才好**。
   *
   * 两次的共同教训：**任何「只做一次」的 ref 锁，都假定「ref 的生命周期 == 相机状态的生命周期」，
   * 而这个假定在路由缓存 / StrictMode / 热替换下都不成立。**
   * 所以判据换成可观测的状态：相机是否还停在 `{x:0,y:0,zoom:1}`。
   *   - 是出厂状态 → 没人动过，该介入（还原存档，或按 34% 取景）
   *   - 不是出厂状态 → 用户已经自己看过这张图了，**永不再抢**
   *
   * 唯一代价：用户恰好手动把画布拖回原点、且 zoom 正好是 1 时，
   * 会被当成「没动过」再介入一次（跳到存档视野）。凑到这个数值需要刻意为之，接受。
   */
  const FACTORY = 1e-6;
  const isFactoryCamera = (v: { x: number; y: number; zoom: number }) =>
    Math.abs(v.zoom - 1) < FACTORY && Math.abs(v.x) < 0.5 && Math.abs(v.y) < 0.5;

  // 画布容器的引用。新节点要落在「画布可见区域」的中心，
  // 而右侧属性面板占掉 300px，用 window.innerWidth 算出来的中心会偏到面板底下。
  // 首屏取景也要拿它量画布尺寸（算「内容最多占多高」），所以声明必须在使用之前。
  const canvasRef = useRef<HTMLDivElement>(null);

  /**
   * 把「屏幕上的线宽」同步到 CSS 变量（当前 zoom 已知时调用）。
   *
   * 为什么直接改 DOM 的 style 而不是用 state：
   * 缩放过程中 `onMove` **每一帧都会触发**，走 state 等于每帧重渲染整个画布
   * （节点、边、面板全在里面）。而这里要改的只是一个 CSS 变量，
   * 直接 `setProperty` 只让浏览器重绘那几条线，不碰 React。
   *
   * 变量设在 `canvasRef` 这个外层 div 上（不是 `.react-flow` 根节点），
   * CSS 自定义属性会向下继承，所以 `.react-flow__edge-path` 依然读得到，
   * 而我们不必去拿 React Flow 内部的 DOM 引用。
   */
  const syncEdgeWidth = useCallback((zoom: number) => {
    const el = canvasRef.current;
    if (!el || !(zoom > 0)) return;
    const w = `${(EDGE_SCREEN_W / zoom).toFixed(3)}px`;
    el.style.setProperty("--xy-edge-stroke-width", w);
    // 拖拽中那条跟随鼠标的线也要一起 —— 否则「拖的时候细、松手后变粗」
    el.style.setProperty("--xy-connectionline-stroke-width", w);
  }, []);

  /*
   * 首帧相机：让第一次 paint 就是「对的画面」。
   *
   * ### 这一次修的是什么
   *
   * 点「← 返回」再点同一个项目进来（客户端跳转），实测逐帧记录（1600×1000，
   * 存档 zoom=0.1827）：
   *
   *   dt= 75ms   zoom=1.0000   节点 2 个可见，首节点屏幕宽 1024   ← 突脸
   *   dt= 84ms   zoom=0.1827   首节点屏幕宽 187                   ← 已缩回
   *
   * 也就是**只有一帧**画错，之后被 `applyCamera` 的重试推回去了。
   * 那一帧能被人看见，要两个条件同时成立：
   *
   *   ① 挂载时 react-flow 的 store 被重置成 `transform = [0,0,1]`；
   *   ② canvasStore 里还留着上一次的节点（带 `measured`）→ react-flow 认为量过了，
   *      第一帧就画出来，于是满尺寸地铺在 zoom=1 的画布上。
   *
   * （整页加载 F5 时 ② 不成立：store 是空的 / 节点还没量过，那一帧什么都没有，
   * 所以 F5 一直是好的 —— 这就是「刷新就好」的来历。）
   *
   * ### 两条腿，各管一段（少一条都不行）
   *
   * react-flow 的 `Viewport` 组件用**挂载时读到的 store transform** 当第一帧的
   * style，`defaultViewport` 又只在 ZoomPane 的 `useEffect`（paint 之后）里生效。
   * 单独用任一条都不够，实测各有一个后果：
   *
   *   - 只写 store、不传 `defaultViewport` → d3 初始化把它打回 `[0,0,1]`，
   *     相机**永久停在 1.0**（比原来的 bug 更糟，反向验证红 4 条）；
   *   - 只传 `defaultViewport` → 正确性依赖「passive effect 抢在 paint 之前」，
   *     7 次里会红 1 次（帧间跳 993px）。
   *
   * 所以：render 阶段算出目标交给 `defaultViewport`（管 d3 别回退），
   * layout effect 里把同一个值写进 store（管第一帧 paint 之前就位）。
   * 写 store 不能放 render —— 会报 `Cannot update a component while rendering`。
   *
   * ### 为什么能在这里算出画布尺寸
   *
   * 缓存了「上次量到的画布矩形 + 当时的窗口尺寸」（见 `lastCanvasBox`），
   * 用差值还原。拿不到缓存（本次会话第一次加载）就不猜，交给原来的自动取景 ——
   * 那种情况节点还没量过，本来也不会画出那一帧。
   */
  const rfStore = useStoreApi();
  const firstCam = (() => {
    // 相机不是出厂状态 = 这个相机还活着（同段路由直接换项目时不会重置）。
    // 这时候不能写 store：d3 里存着另一份 transform，写 store 只会让两边不同步，
    // 下一次滚轮会跳。这种情况本轮的修法不管，留给上一层的还原逻辑。
    const [tx, ty, tz] = rfStore.getState().transform;
    if (!isFactoryCamera({ x: tx, y: ty, zoom: tz })) return null;
    if (!initialViewport) return null;

    const box = estimatedCanvasBox();
    if (!box) return null;

    const cam = viewportFromSaved(initialViewport, box, {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
    });
    if (!cam) return null;

    return cam;
  })();

  /*
   * 真正把它写进相机：layout effect 里，赶在 paint 之前。
   *
   * 为什么不直接在上面那个 IIFE 里写 store：React 会报
   * 「Cannot update a component while rendering a different component」
   * —— 写 store 会同步通知订阅者，而订阅者里有 React 组件（实测会报 error）。
   * 挪进 layout effect 就没有这个问题，而且依然在 paint 之前。
   *
   * 为什么这里要用**实测**的画布尺寸再算一遍：上面给 `defaultViewport` 的值
   * 只能是缓存的估算（render 阶段 ref 还没挂上）。估算公式对「窗口变没变」是准的，
   * 但对「外框高度变没变」不设防 —— 所以真正落地的那一下用 clientWidth/Height，
   * 顺便把缓存刷新成最新。
   */
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    rememberCanvasBox(el.clientWidth, el.clientHeight);
    if (!firstCam || !initialViewport) return;

    const cam = viewportFromSaved(
      initialViewport,
      { w: el.clientWidth, h: el.clientHeight },
      { minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM }
    );
    if (cam) rfStore.setState({ transform: [cam.x, cam.y, cam.zoom] });
    // 种子相机的线宽也要在第一帧就对上，不等 onMove
    syncEdgeWidth(cam?.zoom ?? firstCam.zoom);
    // 只在挂载时做一次：之后相机归用户、归 applyCamera 的重试
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * 相机重试的状态。
   *
   * `cameraRetry` 存着「还没把相机放到目标位置」的那次重试定时器；
   * `userMovedRef` 一旦置位就再也不自动改相机了（用户接管）。
   */
  const cameraRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userMovedRef = useRef(false);

  const cancelCameraRetry = useCallback(() => {
    if (cameraRetry.current) {
      clearTimeout(cameraRetry.current);
      cameraRetry.current = null;
    }
  }, []);

  /**
   * 把相机放到目标位置 —— 并且**放到真的生效为止**（有界重试）。
   *
   * 为什么不能只调一次 `setViewport`：
   *
   * 从首页点项目卡片进来（客户端跳转）时，这段 effect 跑得比 react-flow
   * 把平移缩放那一层挂上 DOM 更早。那一刻 `setViewport` 是**静默空操作** ——
   * 不报错、不抛异常、store 里的值纹丝不动（实测调用后立刻读回来还是 `zoom=1`）。
   * 于是「关掉再进来还是同一个画面」在这条路径上完全失效，也就是人报的
   * 「点返回再点进来，画面变成突脸」。整页加载（F5）没有这个窗口期，
   * 所以第一次排查时它看起来是好的 —— 这也是它容易被漏掉的原因。
   *
   * 实测迟到一次（50ms）就生效，这里给 20 次 × 50ms = 1s 的余量，
   * 每次重试前先读一遍当前相机：一旦到位就停，绝不反复推。
   *
   * `userMovedRef` 是刹车：重试窗口期内用户要是自己拖了画布，
   * 立刻放弃，绝不在人手上抢镜头。
   */
  const applyCamera = useCallback(
    (target: Viewport) => {
      cancelCameraRetry();
      let tries = 0;

      const attempt = () => {
        cameraRetry.current = null;
        if (userMovedRef.current) return;

        if (sameViewport(getViewport(), target)) return; // 已经到位
        setViewport(target, { duration: 0 });

        /*
         * 头几次用 16ms（≈一帧）追，因为窗口期通常只有一两帧；
         * 之后放宽到 80ms，覆盖慢机器上挂载更迟的情况。
         * 上限 1 秒多一点：再久就不是「晚一拍」而是真出问题了，
         * 继续推只会跟用户抢镜头。
         */
        if (++tries >= 30) return;
        cameraRetry.current = setTimeout(attempt, tries < 16 ? 16 : 80);
      };

      attempt();
    },
    [cancelCameraRetry, getViewport, setViewport]
  );

  // 卸载时把重试停掉，避免定时器在组件消失后还在推相机
  useEffect(() => cancelCameraRetry, [cancelCameraRetry]);

  /*
   * 视野落库。
   *
   * ### 为什么用 `onMoveEnd` 而不是 `onMove`
   *
   * `onMove` 缩放时**每一帧**都会进来（线宽那个回调就在那儿）。在这里发请求，
   * 拖一次画布会打几十个 PUT。`onMoveEnd` 是「一次拖动 / 一次滚轮手势结束」，
   * 和人对「一次操作」的直觉完全对得上 —— 不需要自己发明一个防抖窗口来猜意图。
   *
   * 还是留了 250ms 的防抖：连续滚 5 格滚轮时 d3-zoom 会分几次 end，
   * 不留一道会把它们当成五次操作。250 是「手势之间的停顿」量级，
   * 再短挡不住连发，再长会让用户刚松手就关掉页面时丢掉这一次。
   *
   * ### 为什么同值不发
   *
   * 打开项目时也会走一次（人拍板：自动取景算一次实际操作）。
   * 但第二次在同一个窗口打开同一个项目，算出来的三个数和库里一模一样 ——
   * 白发一个请求没有意义。用 1 位小数去重：0.1 设计像素的差别
   * 在屏幕上量不出来（zoom 0.34 时是 0.034 屏幕像素）。
   */
  const viewportSave = useRef<{ timer: ReturnType<typeof setTimeout> | null; lastKey: string }>({
    timer: null,
    lastKey: "",
  });

  const scheduleViewportSave = useCallback(
    (vp: Viewport) => {
      const el = canvasRef.current;
      if (!el || !projectId) return;

      // 用**当前**画布尺寸算存档，不是上次的 —— 否则窗口缩放之后再操作，
      // 存进去的 span 会是旧窗口的，还原时就偏了。
      const saved = savedFromViewport(vp, { w: el.clientWidth, h: el.clientHeight });
      if (!saved) return;

      const key = `${saved.centerX.toFixed(1)}|${saved.centerY.toFixed(1)}|${saved.span.toFixed(1)}`;
      if (key === viewportSave.current.lastKey) return;

      if (viewportSave.current.timer) clearTimeout(viewportSave.current.timer);
      viewportSave.current.timer = setTimeout(() => {
        viewportSave.current.lastKey = key;
        void fetch(`/api/projects/${projectId}/viewport`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(saved),
        })
          .then((res) => {
            // 失败就把 lastKey 清掉，让下一次操作能重试同一组数。
            // 不清的话，写失败之后用户再怎么拖（只要回到同一位置）都不会再写。
            if (!res.ok) viewportSave.current.lastKey = "";
          })
          .catch(() => {
            viewportSave.current.lastKey = "";
          });
        // 不弹任何错误提示：视野不是内容。丢了最多回到稍早一点的视角，
        // 而每拖一下画布弹一条「保存失败」比丢视野烦得多。
      }, 250);
    },
    [projectId]
  );

  /**
   * 把节点转成「已知尺寸的矩形」，供首屏取景算包围盒。
   *
   * 尺寸三级取值，顺序不能换：
   *   ① `measured` —— 浏览器量过的真值，最准（节点里躺着的图片会改变真实高度）
   *   ② `data.naturalW/H` —— 落库的产物像素，打开已有项目时用它
   *   ③ 注册表里的声明尺寸 —— 前两者都没有时用它
   *
   * ③ 是关键：它让首屏**完全不需要等测量**，这是「加节点不闪一下」的前提。
   * 少了它，tallest 会算成 0 → 上限变成「不设上限」→ 又回到突脸。
   */
  const boxesOf = (list: CanvasNode[]): Box[] =>
    list.map((n) => {
      const declared = n.type ? nodeRegistry[n.type]?.size : undefined;
      const mw = n.measured?.width ?? 0;
      const mh = n.measured?.height ?? 0;
      const nw = n.data?.naturalW;
      const nh = n.data?.naturalH;
      return {
        x: n.position.x,
        y: n.position.y,
        w:
          mw > 0
            ? mw
            : typeof nw === "number" && nw > 0
              ? nw
              : (declared?.w ?? NODE_WIDTH),
        h:
          mh > 0
            ? mh
            : typeof nh === "number" && nh > 0
              ? nh
              : (declared?.h ?? NODE_HEIGHT),
      };
    });

  /*
   * 真正解决闪烁的是**不再等 `nodesInitialized`**，不是下面那个 hook 的种类。
   *
   * 旧写法等 `nodesInitialized`（= 全部节点都量完）才取景。可节点一旦量完就立刻
   * 从 hidden 变 visible，而 `fitView` 还要再等一帧 —— 这中间必然夹着几帧
   * 「用默认 zoom=1 画出来」的大图（实测 2 帧 13~17ms，人眼看得见）。
   *
   * 现在改成：节点一进 store 就用**登记尺寸**算出 viewport，完全绕开测量。
   * 时间线变成「设 viewport → 节点量完 → 变 visible」，视野早就位了。
   *
   * 用 `useLayoutEffect` 只是多加一层保险（DOM 更新后、paint 前跑，比 useEffect 早）。
   * 实测在这个场景下换成 useEffect 也测不出突脸帧 —— 因为节点本来就要 hidden
   * 一两帧才显形，那点余量够用了。但哪天给节点声明了 width（会让第一帧就 visible）
   * 这层保险就是唯一挡着的，所以留着。
   *
   * 对应 xyflow 官方讨论 #2973 里社区的标准做法：
   * 「布局 + 取景 + 翻 visible 放在同一次更新里」—— 库已经帮我们管了 visible，
   * 我们要做的就是别把取景推迟到测量之后。
   */
  useLayoutEffect(() => {
    if (nodeCount === 0) return; // 空画布：没有可框的东西，等节点出现再说

    /*
     * 相机已经不是出厂状态 = 有人看过这张图了（用户拖过、缩过、点过 fitView，
     * 或者上一次介入已经把视野放好了）。那就别再动它 —— 这一条同时替代了
     * 原来那把「只跑一次」的锁，理由见上面 `isFactoryCamera` 那段。
     */
    if (!isFactoryCamera(getViewport())) return;

    /*
     * 相机回到出厂状态 = 这次挂载拿到的是一个全新的相机
     * （整页加载，或路由缓存把组件留下、把相机重置了）。
     * 上一轮「用户已经接管」的记忆随之作废 —— 不然后果是：
     * 用户拖过一次画布 → 回首页 → 再进来，相机明明是出厂状态却因为
     * 那个残留标记而拒绝还原，又变回突脸。
     *
     * 只在没有重试在飞的时候清：重试在飞说明这一轮的介入还没落地，
     * 此时清掉刹车有可能把「用户刚按下的拖动」也一起清掉。
     */
    if (!cameraRetry.current) userMovedRef.current = false;

    const el = canvasRef.current;
    const canvas = {
      w: el?.clientWidth ?? window.innerWidth,
      h: el?.clientHeight ?? window.innerHeight,
    };

    /*
     * ① 有存档 → 还原，**不再看节点摆在哪**。
     *
     * 这是「关掉再进来还是同一个画面」的全部实现。取景从此退化成
     * 只服务「相机没被人碰过又有节点」这一种情况；一旦项目有过视野，
     * 构图由人决定，不由节点包围盒决定。
     *
     * 包括「存档中心其实是一片空地」这种情况 —— 人明确说不用兜。
     * 逻辑上也确实不该兜：加节点和拖节点都不改相机，相机凭什么自己动。
     * 想回到全览，按左下角的 fitView。
     */
    if (initialViewport) {
      const restored = viewportFromSaved(initialViewport, canvas, {
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
      });
      if (restored) {
        applyCamera(restored);
        syncEdgeWidth(restored.zoom);
        /*
         * 还原也算一次实际操作（人拍板：打开就定型）。
         *
         * 这里主动调一次，不指望 react-flow 的 `onMoveEnd` 被程序化
         * `setViewport` 触发 —— 那是库的实现细节，升级一版就可能静默失效，
         * 症状是「老项目再也不写存档」，而且不报错。
         * （实测 v12 程序化 setViewport 会补发一次 `onMoveEnd`，event 为 null；
         * 两条路都写同一组数，`scheduleViewportSave` 里按 key 去重，不会重复请求。）
         */
        scheduleViewportSave(restored);
        return;
      }
      // 存档不合法（span ≤ 0、坐标不是有限数）就落到下面走自动取景，
      // 相当于「这条存档坏了，当没有」。
    }

    // ② 没有存档 → 首屏取景（加第一个节点时定在 34% 那一档）
    const vp = fitViewportFromBoxes(boxesOf(nodes), canvas, {
      maxHeightRatio: FIRST_VIEW_MAX_H,
      topInset: FLOATING_UI_H,
      padding: FIRST_VIEW_PADDING,
    });
    if (vp) {
      applyCamera(vp);
      // 首屏也要同步一次：onMove 通常会在程序化 setViewport 之后触发，
      // 但不依赖它 —— 早几十毫秒把线画对，总比「先细一下再变粗」好。
      syncEdgeWidth(vp.zoom);
      // 自动取景也写一次（人拍板）。这条让「打开没动过的老项目」立刻定型。
      scheduleViewportSave(vp);
    }
    // isFactoryCamera 是每次现算的纯判断，不需要进依赖数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeCount, nodes, initialViewport, applyCamera, syncEdgeWidth, scheduleViewportSave]);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [runsOpen, setRunsOpen] = useState(false);

  /**
   * 节点 id → 名字。运行历史用它把事件里的 nodeId 说成人话。
   *
   * 用 useMemo 而不是每次渲染重建：画布拖拽时这里每秒重渲染几十次，
   * 新对象会让运行历史跟着重渲染（虽然它只是被传了个 prop）。
   */
  const labelOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const n of nodes) m[n.id] = String(n.data.label ?? "");
    return m;
  }, [nodes]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // canvasRef 已在首屏取景那段之前声明（取景要用它量画布高度）

  const save = useCallback(async () => {
    const s = useCanvasStore.getState();
    if (!s.projectId) return;

    // 运行态（产物、状态）在另一个 store 里，保存时要一起读
    const runtime = useRunStore.getState().runtime;

    // 记下本次保存对应的版本。请求飞在路上时用户可能又改了东西，
    // 那种情况下不能把 dirty 清掉（详见 canvasStore 里 revision 的注释）。
    const revisionAtSave = s.revision;

    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${s.projectId}/graph`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodes: s.nodes.map((n) => {
            /*
             * 产物引用跟着一起发。
             *
             * 服务端只在「这一行要新建」时采用它（撤销把删掉的节点放回来），
             * 已有行永远由 Worker 写这两列 —— 保存画布不该改变运行结果。
             * 但撤销之后那一行确实已经没了，不带这个就只剩一个空节点。
             */
            const rt = runtime[n.id];
            return {
              id: n.id,
              type: n.type ?? "",
              positionX: Math.round(n.position.x),
              positionY: Math.round(n.position.y),
              data: n.data,
              outputAssetId: rt?.output?.assetId ?? null,
              status: rt?.status ?? (typeof n.data.status === "string" ? n.data.status : null),
            };
          }),
          edges: s.edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            targetHandle: e.targetHandle ?? "",
          })),
        }),
      });
      if (res.ok) s.markSaved(revisionAtSave);
    } finally {
      setSaving(false);
    }
  }, []);

  // 防抖持久化：最后一次改动后 800ms 内没有新改动才发请求。
  // 拖拽过程中会派发几十次变更，但只会落库一次。
  // 依赖 revision 而不是 nodes/edges：revision 只在结构性改动时递增，
  // 纯选中节点不会白白重置定时器。
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(save, 800);
    return () => clearTimeout(timer);
  }, [dirty, revision, save]);

  /**
   * 双击连线 = 断开它。
   *
   * ### 为什么用原生捕获监听，而不是 ReactFlow 的 onEdgeDoubleClick
   *
   * 两个原因，缺一不可：
   *
   * 1. **要挡住画布缩放**。d3-zoom 的 dblclick 监听挂在画布容器（本元素的后代）上，
   *    不拦的话双击连线会顺带把画布放大一级。
   * 2. **但不能用 React 的合成事件去拦**。React 17+ 把事件委托到 root container，
   *    那个容器在本元素**外层**；在捕获阶段 stopPropagation 会把冒泡一起掐断，
   *    结果 React 自己的 onEdgeDoubleClick 永不执行 ——
   *    线没断，还以为监听写错了。
   *
   * 所以一个监听干两件事：截住事件 + 直接删边。
   */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const onDoubleClick = (e: MouseEvent) => {
      const g = (e.target as HTMLElement | null)?.closest(".react-flow__edge");
      const edgeId = g?.getAttribute("data-id");
      if (!edgeId) return;

      e.stopPropagation();
      // 走 deleteElements 而不是自己改数组：它会把 change 回灌给 onEdgesChange，
      // store 与数据库因此始终一致，不会出现"界面没了、库里还在"。
      deleteElements({ edges: [{ id: edgeId }] });
    };

    el.addEventListener("dblclick", onDoubleClick, true);
    return () => el.removeEventListener("dblclick", onDoubleClick, true);
  }, [deleteElements]);

  /**
   * Ctrl+Z 撤销 / Ctrl+Shift+Z（或 Ctrl+Y）重做。
   *
   * ### 为什么输入框里要让给浏览器
   *
   * 在输入框里按 Ctrl+Z，用户的意图是「撤回我刚打的字」。抢过来的话，
   * 改一段提示词想撤回打字，结果撤掉的是画布上的一个节点 ——
   * 而且这个误操作本身还能再被撤销一次，因果彻底乱了。
   *
   * ### 为什么挂在 window 上而不是画布容器
   *
   * 删除节点之后焦点常常落在 body 上（被删掉的那个按钮已经不在 DOM 里），
   * 挂在容器上的话那次 Ctrl+Z 会落空 —— 而「删完马上按撤销」正是最需要它的时刻。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key !== "z" && key !== "y") return;

      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      ) {
        return;
      }

      e.preventDefault();
      const store = useCanvasStore.getState();
      if (key === "y" || e.shiftKey) store.redo();
      else store.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 错误提示 3 秒后自动消失
  useEffect(() => {
    if (!lastError) return;
    const timer = setTimeout(() => setError(null), 3000);
    return () => clearTimeout(timer);
  }, [lastError, setError]);

  // 上传浮窗按 Esc 关掉。它是浮在画布上的一块东西，没有别的地方可点，
  // 不给键盘出口的话只能再点一次加号 —— 而用户未必想得起来。
  useEffect(() => {
    if (!uploadOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUploadOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [uploadOpen]);

  /**
   * 在当前画面中央加一个节点。**不做避让**。
   *
   * 2026-10-26 人拍板：新节点永远落在正中央，允许压住已有节点。
   * 理由有两条 —— 加东西的时候画面不该自己动；新节点在最上层，
   * 本来就看得出来它是刚加进来的。
   *
   * 这条决定废掉了原来的「向右下螺旋找空位」（`findFreeSpot`，24 次尝试）。
   * 那个算法当初存在的理由是「新节点压住旧节点，用户会以为没加上」——
   * 现在用另一种方式解决：视野不动，节点就出现在你正看着的地方。
   *
   * ### 唯一的例外：同批次
   *
   * 一次上传 5 个文件会连着调 5 次。如果每次都用同一个中心点，
   * 5 个节点会**精确落在同一个坐标**上 —— 视觉上只多出最上面那个，
   * 另外 4 个完整压在底下，用户会以为只成功了 1 个然后重传一遍。
   * 所以同批次按索引沿右下对角错开（`batchIndex`），
   * 单次点击时 batchIndex 恒为 0，永远精确居中。
   */
  const addNodeAtCenter = useCallback(
    (type: string, overrides?: Record<string, unknown>, batchIndex = 0) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      const center = screenToFlowPosition({
        x: (rect?.left ?? 0) + (rect?.width ?? window.innerWidth) / 2,
        y: (rect?.top ?? 0) + (rect?.height ?? window.innerHeight) / 2,
      });

      const size = nodeRegistry[type]?.size;
      const w = size?.w ?? NODE_WIDTH;
      const h = size?.h ?? NODE_HEIGHT;

      /*
       * 错开 0.3 个节点宽，纵向按同一比例（h/w）跟着走，保持对角方向。
       * 0.3 是怎么来的：1280 宽的卡片错开 384 设计像素，
       * 在 34% 的首屏缩放下屏幕上是 130px —— 认得出是两张，又不散开。
       * 5 个文件排下来偏 1.2 个卡宽（1536 设计像素），
       * 首屏一个画布宽能装 5648 设计像素，装得下。
       */
      const offset = batchIndex * w * 0.3;

      addNode(
        type,
        {
          x: center.x - w / 2 + offset,
          y: center.y - h / 2 + offset * (h / w),
        },
        overrides
      );
    },
    [screenToFlowPosition, addNode]
  );

  const handleAdd = (type: string) => addNodeAtCenter(type);

  /**
   * 「添加到画布」：把资产库里的一个文件变成一张素材节点卡片。
   *
   * 为什么复用 MEDIA_ASSET 而不是给资产库单开一种节点：
   * 它和用户上传的素材是**同一种东西**（一张图 / 一段视频），
   * 下游连线、尺寸计算、能否当首帧这些判断都已经按 `media.asset` 写好了。
   * 单开一种类型就要在 nodeRegistry、portRules、尺寸三处各加一份一模一样的声明。
   *
   * 名字用「图片 10-26 12:03」而不是空着：Asset 表里没有原始文件名
   * （生成产物本来就没有名字），留空的话卡片头部会显示「未命名文件」，
   * 十几个未命名文件并排放在画布上，分不清哪个是哪个。
   */
  const handleAddFromLibrary = (asset: AssetItem) => {
    const d = new Date(asset.createdAt);
    const pad = (n: number) => String(n).padStart(2, "0");
    const stem = `${asset.kind === "video" ? "视频" : "图片"} ${pad(
      d.getMonth() + 1
    )}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    addNodeAtCenter(NODE_TYPE.MEDIA_ASSET, {
      label: stem,
      assetId: asset.id,
      assetKind: asset.kind,
      assetMime: asset.mimeType,
      assetSize: asset.sizeBytes,
      assetName: stem,
      // 素材是「已经就绪」的东西，不是待生成 —— 和上传保持同一套状态
      status: NODE_STATUS.SUCCEEDED,
    });
    // 收起抽屉：新卡片落在画布中央，抽屉盖住右半边，
    // 不关的话用户看不到「点完之后发生了什么」。
    setAssetsOpen(false);
  };

  /**
   * 上传素材。
   *
   * 逐个上传而不是攒成一个批量请求：一个文件失败不该拖垮其余的。
   * 失败的文件单独收集成一条错误提示，成功的照常落到画布上。
   */
  const uploadFiles = async (list: FileList | null) => {
    if (!projectId || !list || list.length === 0) return;

    const files = Array.from(list);
    const failed: string[] = [];
    // 同批次内的序号：第 1 个精确居中，第 2 个起沿右下错开（见 addNodeAtCenter）。
    // 只数**成功**的 —— 失败的文件没有节点，不该占一个位，否则画布上会出现
    // 一段没有节点的空档，用户会以为那里有个看不见的东西。
    let batchIndex = 0;

    setUploading(true);
    try {
      for (const file of files) {
        try {
          const fd = new FormData();
          fd.append("file", file);

          const res = await fetch(`/api/projects/${projectId}/assets`, {
            method: "POST",
            body: fd,
          });
          const body = await res.json().catch(() => ({}));

          if (!res.ok) {
            throw new Error(body?.error ?? `上传失败（HTTP ${res.status}）`);
          }

          /*
           * status 直接给 succeeded：素材是「已经就绪」的东西，不是待生成。
           * 它 capability 为 null，永远不会被调度执行 ——
           * 状态点要是显示「待运行」，用户会等着它跑。
           */
          addNodeAtCenter(NODE_TYPE.MEDIA_ASSET, {
            label: stripExt(body.name) || "素材",
            assetId: body.assetId,
            assetKind: body.kind,
            assetMime: body.mimeType,
            assetSize: body.sizeBytes,
            assetName: body.name,
            status: NODE_STATUS.SUCCEEDED,
          }, batchIndex++);
        } catch (err) {
          failed.push(
            `${file.name}：${err instanceof Error ? err.message : "上传失败"}`
          );
        }
      }
    } finally {
      setUploading(false);
      // 清空 input 的值，否则再选同一个文件不会触发 change 事件
      if (fileInputRef.current) fileInputRef.current.value = "";
    }

    if (failed.length > 0) setError(failed.join("；"));
    else setUploadOpen(false);
  };

  const statusText = saving ? "保存中…" : dirty ? "未保存" : "已保存";

  return (
    // 以前这里是一个 flex 行：画布 + 右侧 300px 属性面板。
    // 面板拆掉后画布吃满整个宽度 —— 顺带也解掉一个老问题：
    // handleAdd 用容器中心算新节点位置，以前那个中心会被面板挤偏。
    <div ref={canvasRef} className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        defaultViewport={firstCam ?? undefined}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        /*
         * 线宽跟着缩放反算（见 EDGE_SCREEN_W 那段）。缩放过程中每帧都会进来，
         * 所以回调里只改 CSS 变量、不碰 state。
         */
        onMove={(_, v) => syncEdgeWidth(v.zoom)}
        // 一次平移 / 缩放**结束**时落库视野（防抖 + 去重都在 scheduleViewportSave 里）。
        // 不挂在 onMove 上：那是每一帧。
        onMoveEnd={(_e, v) => scheduleViewportSave(v)}
        // 拖动期间记下是谁在动，卡片据此收起浮出的面板。
        // 松手必须清掉：不然下一次选中任何节点，它的面板都不会出现。
        /*
         * 用户接管相机的信号。
         *
         * 实测 react-flow v12：程序化 `setViewport` 也会触发本回调，
         * 但 event 是 null；真实手势（拖拽 / 滚轮）event 是有值的。
         * 所以「event 非空」= 人在动相机 —— 从此不再自动改视野，
         * 正在重试的 `applyCamera` 也立刻刹车。
         */
        onMoveStart={(e) => {
          if (!e) return;
          userMovedRef.current = true;
          cancelCameraRetry();
        }}
        onNodeDragStart={(_, node) => setDragging(node.id)}
        onNodeDragStop={() => setDragging(null)}
        // 双击断开连接的是上面的原生捕获监听，不在这里 —— 见那段注释
        nodeTypes={reactFlowNodeTypes}
        // 不用 fitView prop：它只对着第一个量完的节点对齐（见上面 `isFactoryCamera` 那段），
        // 而且它发生在 paint 之后，会先画出「默认 zoom=1」那一帧。
        // 首屏对齐改由上面那个 useLayoutEffect 负责（用登记尺寸算，不等测量）。
        // 手动 fitView 也没了：它内部还要再等一帧，同样会露馅。
        deleteKeyCode={["Backspace", "Delete"]}
        /*
         * minZoom 必须显式给，默认的 0.5 现在太小了。
         *
         * React Flow 的 fitView 会把缩放夹在 [minZoom, maxZoom] 之间。
         * 节点还是 400×250 的时候，四五个节点的包围盒缩到 0.6~0.7 就装下了，
         * 永远碰不到 0.5 这个下限，所以默认值一直没暴露问题。
         *
         * 节点放大到 1280×720 之后，同样四个节点的包围盒需要 0.34 才装得下，
         * fitView 想缩但被 0.5 卡住 —— 结果**打开项目就有一半节点在屏幕外**，
         * 画布看着像空的，而且不报任何错。症状和「项目丢了」一模一样。
         *
         * 0.15 是给「以后节点更多 / 图更大」留的余量：
         * 一张占位 1280 宽的节点缩到 0.15 还有 192px，认得出是哪张图，
         * 再小就只剩一个色块了。上限仍然由 fitView 的 maxZoom: 1 兜着。
         */
        minZoom={MIN_ZOOM}
        // 显式给上限，不依赖 React Flow 的默认值 —— 读存档时的夹取（viewportFromSaved）
        // 用的是同一个常量，两边必须一致，否则存档能算出库不接受的 zoom。
        maxZoom={MAX_ZOOM}
        className="bg-[color:var(--surface-0)]"
      >
        {/* 网格线要**暗**：浅灰 #e5e5e5 在近黑底上会变成一张刺眼的白网。
            #262626 是「有网格但不抢戏」的那一档。 */}
        <Background gap={16} size={1} color="#262626" />
        <Controls />
        {/*
          小地图：右下角、缩小、半透明、**不吃鼠标事件**。

          这块东西已经连续咬过三次：
            ① 在右下角时盖住新节点的 handle（findFreeSpot 只往右下挪，
               所以右下角正是新节点最常去的地方）；
            ② 挪到左下角后盖住文本节点面板里的输入框（点不进去、打不了字）；
            ③ 挪到右上角后和「已保存」挤在一起。
          四个角全都有主：左上 + 节点、右上保存（运行状态条出现时还要再挤）、
          左下缩放控件、右下被避让算法占据。所以位置只是把伤害挪来挪去，不是解法。

          真正的解法是 `pointer-events: none` —— 它变成一张纯装饰的缩略图，
          任何落在它身上的点击都穿透到底下的节点、handle、输入框。
          代价是小地图不能再拖动/点击跳转（pannable / zoomable 一并去掉，
          留着也是骗人的：看得见却点不动比不能点更难受）。

          视觉遮挡仍然存在，所以缩小到 150×100 并降到 0.7 透明度 ——
          它是辅助信息，不该在画布上抢戏。
        */}
        <MiniMap
          position="bottom-right"
          /*
           * 小地图的默认配色是「白底 + 浅灰遮罩」，在近黑画布上会变成一块白斑。
           *
           * 两个坑：
           *   ① 底色必须用 `bgColor` prop，不能写在 style 里 —— MiniMap 内部把
           *      bgColor 设成 svg 的 fill，它盖过 style 的 backgroundColor，
           *      只写 style 是**看不出错了**的（还是白的）。
           *   ② maskColor 默认 `rgb(240,240,240,0.7)` 是浅灰，压在深底上反而变亮，
           *      要换成黑。
           * 0.55 而不是 0.8：压太狠会看不出缩略图里的节点分布。
           */
          style={{
            width: 150,
            height: 100,
            pointerEvents: "none",
            opacity: 0.7,
            borderRadius: 6,
          }}
          bgColor="var(--surface-1)"
          maskColor="rgba(0,0,0,0.55)"
          nodeColor="#3d3d3d"
          nodeStrokeColor="#5c5c5c"
        />
      </ReactFlow>

      {/*
        资产库面板。它和画布是兄弟关系，不在 <ReactFlow> 里面 ——
        那样它会被画布的缩放变换一起缩掉，字和缩略图跟着 zoom 变小。
          放在外面，它永远是一块固定屏幕尺寸的界面。
      */}
      <AssetLibrary
        projectId={projectId}
        open={assetsOpen}
        onClose={() => setAssetsOpen(false)}
        onAddToCanvas={handleAddFromLibrary}
      />

      {/*
        运行历史。和资产库同一个位置、同一种手感 —— 两者都是「翻已经发生的事」。
        同时只会开一个：两个抽屉叠在右边互相盖住，看起来像坏了。
        打开才挂载：内部状态（展开了哪一条、拉过的明细）随卸载复位。
      */}
      {runsOpen && (
        <RunHistory
          projectId={projectId}
          onClose={() => setRunsOpen(false)}
          labelOf={labelOf}
        />
      )}

      <div className="absolute left-4 top-4 z-10 flex items-center gap-1.5 rounded-lg border border-[color:var(--line-1)] bg-[color:var(--surface-glass)] p-1.5 shadow-sm backdrop-blur">
        {addableTypes.map((def) => (
          <button
            key={def.type}
            onClick={() => handleAdd(def.type)}
            title={def.hint}
            className="rounded-md px-2.5 py-1.5 text-[length:var(--fs-meta)] font-medium text-[color:var(--ink-1)] transition-colors hover:bg-[color:var(--surface-3)]"
          >
            + {def.label}
          </button>
        ))}

        {/*
          资产库：**故意不放进上面那个 map 里**。
          左边三个是「往画布上放一个新节点」，资产库是「翻这个项目已经有过的文件」，
          两种动作用的是完全不同的心智 —— 混在一个循环里，以后加一种节点类型，
          用户会看到一个越排越长的工具条，而资产库跟着一起变位置。
          中间这条竖线就是为了让它们看起来不是一类东西。
        */}
        <span
          aria-hidden
          className="mx-0.5 h-5 w-px shrink-0 bg-[color:var(--line-2)]"
        />
        <button
          type="button"
          data-action="open-assets"
          data-open={assetsOpen ? "1" : "0"}
          onClick={() => {
            setRunsOpen(false);
            setAssetsOpen((v) => !v);
          }}
          title="这个项目里出现过的所有图片和视频"
          className={[
            "rounded-md px-2.5 py-1.5 text-[length:var(--fs-meta)] font-medium transition-colors",
            assetsOpen
              ? "bg-[color:var(--surface-3)] text-[color:var(--ink-1)]"
              : "text-[color:var(--ink-2)] hover:bg-[color:var(--surface-3)] hover:text-[color:var(--ink-1)]",
          ].join(" ")}
        >
          资产库
        </button>
        <button
          type="button"
          data-action="open-runs"
          data-open={runsOpen ? "1" : "0"}
          onClick={() => {
            setAssetsOpen(false);
            setRunsOpen((v) => !v);
          }}
          title="这个项目跑过的每一次：状态、花了多少、失败在哪"
          className={[
            "rounded-md px-2.5 py-1.5 text-[length:var(--fs-meta)] font-medium transition-colors",
            runsOpen
              ? "bg-[color:var(--surface-3)] text-[color:var(--ink-1)]"
              : "text-[color:var(--ink-2)] hover:bg-[color:var(--surface-3)] hover:text-[color:var(--ink-1)]",
          ].join(" ")}
        >
          运行历史
        </button>
      </div>

      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <div className="rounded-md border border-[color:var(--line-1)] bg-[color:var(--surface-glass)] px-2.5 py-1.5 text-[length:var(--fs-meta)] text-[color:var(--ink-2)] shadow-sm backdrop-blur">
          {statusText}
        </div>
        <RunStatus />
      </div>

      {/*
        底部中央的加号浮窗：上传素材的唯一入口。
        放在底部中央是因为它和左上角的「+ 节点」是两种不同性质的入口 ——
        「建空节点」在左、「放进已有的东西」在中间，各占一头不打架。

        它是 absolute 定位、不占画布布局，所以不会把画布挤小。
      */}
      <div className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 flex-col items-center">
        {uploadOpen && (
          <div
            data-upload-panel
            className="mb-2.5 w-80 rounded-xl border border-[color:var(--line-2)] bg-[color:var(--surface-1)] p-2 shadow-[0_8px_30px_rgba(0,0,0,0.6)]"
          >
            <button
              type="button"
              data-action="pick-file"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[color:var(--line-3)] bg-[color:var(--btn-bg)] px-3 py-2.5 text-[length:var(--fs-control)] font-medium text-white transition-colors hover:bg-[color:var(--btn-bg-hover)] disabled:cursor-not-allowed disabled:bg-[color:var(--btn-disabled-bg)] disabled:text-[color:var(--btn-disabled-ink)]"
            >
              {uploading ? "上传中…" : "选择图片或视频"}
            </button>
            <p className="px-1 pt-2 text-[length:var(--fs-meta)] leading-relaxed text-[color:var(--ink-3)]">
              上传后直接加到画布。图片 ≤ 20MB，视频 ≤ 150MB。
            </p>
          </div>
        )}

        <button
          type="button"
          data-action="toggle-upload"
          data-open={uploadOpen ? "1" : "0"}
          title={uploadOpen ? "收起上传" : "上传素材"}
          aria-expanded={uploadOpen}
          onClick={() => setUploadOpen((v) => !v)}
          disabled={uploading}
          className={[
            "flex h-11 w-11 items-center justify-center rounded-full text-xl leading-none text-white shadow-lg transition-all",
            // 底部这个 + 号是圆形主按钮：暗色下同样保留黑底 + 浅描边，
            // 展开时用 surface-3 提示「按下去过」。
            "border border-[color:var(--line-3)]",
            uploadOpen
              ? "rotate-45 bg-[color:var(--surface-3)]"
              : "bg-[color:var(--btn-bg)] hover:bg-[color:var(--btn-bg-hover)]",
            uploading ? "cursor-wait opacity-60" : "",
          ].join(" ")}
        >
          {uploading ? "·" : "+"}
        </button>

        {/* 真实的文件选择器。accept 只是给系统对话框的默认筛选，不是校验 ——
            真正的类型判断在服务端，用户把「所有文件」切回来也照样过不去。 */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          data-upload-input
          onChange={(e) => uploadFiles(e.target.files)}
        />
      </div>

      {lastError && (
        // 上移到加号浮窗之上，否则两者会叠在一起（都在底部中央）
        //
        // data-error-banner 是给自动化验收用的：靠文案断言太脆，
        // 换一句话测试就挂；靠 class 更脆。显式暴露一个语义属性，
        // 测试和文案就解耦了。
        <div
          data-error-banner="1"
          className="absolute bottom-20 left-1/2 z-20 -translate-x-1/2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-[length:var(--fs-meta)] text-red-700 shadow-sm"
        >
          {lastError}
        </div>
      )}
    </div>
  );
}

/** 去掉文件名的扩展名，用作节点默认名字 */
function stripExt(name: string) {
  return name.replace(/\.[^.]+$/, "").slice(0, 40);
}

export interface CanvasProps {
  projectId: string;
  initialNodes: CanvasNode[];
  initialEdges: {
    id: string;
    source: string;
    target: string;
    targetHandle?: string;
  }[];
  /**
   * 上次运行留下的节点状态与产物。
   * 没有它的话刷新页面后画布会回到一片"待运行"，
   * 明明刚才生成好的图和视频还在库里，用户却看不见。
   */
  initialRuntime: Record<string, NodeRuntime>;
  /**
   * 上次离开时的视野。null = 这个项目从没存过视野，走首屏自动取景。
   *
   * 由服务端从 Project 表三列读出来，和节点数据同一次查询 ——
   * 这一点很关键：视野必须在节点出现的那一帧就位，否则会先按 fitView
   * 画一帧再跳过去（就是首屏取景那段注释里讲的「突脸帧」）。
   * 存在 localStorage 里做不到这件事，它是异步读的。
   */
  initialViewport: SavedViewport | null;
}

export function Canvas({
  projectId,
  initialNodes,
  initialEdges,
  initialRuntime,
  initialViewport,
}: CanvasProps) {
  const init = useCanvasStore((s) => s.init);
  const hydrate = useRunStore((s) => s.hydrate);
  const initializedFor = useRef<string | null>(null);

  // 服务端数据 → 客户端 store。
  // 用 projectId 做幂等判断而不是依赖数组：否则父组件任何一次重渲染
  // 都会把 store 重置回服务端快照，用户正在拖的节点会被弹回去。
  useEffect(() => {
    if (initializedFor.current === projectId) return;
    initializedFor.current = projectId;
    init(projectId, initialNodes, initialEdges);
    hydrate(initialRuntime);
  }, [projectId, initialNodes, initialEdges, initialRuntime, init, hydrate]);

  return (
    <ReactFlowProvider>
      <CanvasInner initialViewport={initialViewport} />
    </ReactFlowProvider>
  );
}
