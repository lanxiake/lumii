/**
 * perch — 攀附在程序主窗口上（pet-core，零依赖）
 *
 * 「宠物爬到 Lumii 主窗口的边缘上」这件事的几何与状态迁移。与 `ambient`/`locomotion`
 * 同一分工：这里只回答"该不该吸、吸上去了之后往哪走、什么时候掉下来"，不碰渲染器。
 *
 * ## 素材已经替我们做了姿势
 *
 * 实测 `shimeji_caneko.png` 的逐帧包围盒：CLIMB 行是 **36 宽 × 62 高**（竖长），
 * CRAWL 行是 **63 宽 × 40 高**（横扁）。也就是说这两行**本来就是画成爬墙/爬天花板的**，
 * 不需要任何旋转——渲染层只要把它们摆到对应位置就行。
 *
 * ## 锚点的语义在攀爬时会变
 *
 * 平地上锚点 = 脚底中心，`(x, y)` 就是"宠物站在哪"。
 * 爬墙时锚点仍指同一个点，但**竖长姿势的内容底边距锚点有一段空隙**（CLIMB 行的底边
 * 在格内 y≈108，而全表地线是 127）——那 19px 是素材自己留的，缩放后按比例放大。
 * 所以爬墙时宠物与墙面之间会有约 `19 × scale` 的缝，`PERCH_GAP_RATIO` 就是用来补它的。
 *
 * 约束（务必保持）：本包为纯 TS，禁止 import 任何运行时依赖。
 */

/** 攀附目标：程序主窗口在**宠物窗口坐标**下的矩形 */
export interface PerchRect {
  x: number
  y: number
  width: number
  height: number
}

/** 贴在哪条边上。`wall` 用 left/right 指哪面墙，`ceiling` 用 left/right 指从哪一侧上来 */
export type PerchSide = 'left' | 'right'

/** 攀附姿态（不在攀附时为 null） */
export type PerchState =
  | { kind: 'wall'; side: PerchSide }
  | { kind: 'ceiling'; side: PerchSide }
  | null

export interface PerchConfig {
  /**
   * 吸附判定的水平距离（像素）。
   *
   * 太大 → 宠物在离窗口还很远的地方就突然吸上去，像被吸尘器拽走；
   * 太小 → 走路的速度可能让它在两帧之间跨过判定区（60px/s × 16ms ≈ 1px，所以 24 足够宽松）。
   */
  attachDistance: number
  /** 爬升速度（像素/秒）。比走路慢：爬是费力的事，比走路还快会显得轻飘 */
  climbSpeed: number
  /**
   * 爬行时身体与墙面之间留的空隙，**按模型高度的比例**给。
   *
   * 实测 CLIMB 行的内容底边距全表地线 19/128 ≈ 0.148，取这个量级即可贴身。
   * 用比例而不是像素：换一只体型不同的宠物不用重新调。
   */
  gapRatio: number
}

export const PERCH_DEFAULTS: PerchConfig = {
  attachDistance: 24,
  climbSpeed: 45,
  gapRatio: 0.15,
}

/**
 * 判断地面上的宠物是否应当吸附上去。
 *
 * 三个条件缺一不可：
 * 1. 宠物**在窗口下方**——窗口底边得高于宠物（否则宠物是在窗口内部走，没有"边上"可爬）
 * 2. 水平距离在 `attachDistance` 内
 * 3. 窗口得**足够高**（`minHeight`），太扁的窗口爬上去没有意义，而且立刻就到顶了
 *
 * @returns 该吸附的那一侧；不该吸附返回 null
 */
export function tryAttach(
  petX: number,
  petY: number,
  rect: PerchRect | null,
  cfg: PerchConfig = PERCH_DEFAULTS,
  minHeight = 120,
): PerchSide | null {
  if (!rect || rect.height < minHeight || rect.width <= 0) return null
  // 宠物必须站在窗口底边之下——留一点余量，贴着底边也算"在下方"
  if (rect.y + rect.height > petY + cfg.attachDistance) return null

  const leftDist = Math.abs(petX - rect.x)
  const rightDist = Math.abs(petX - (rect.x + rect.width))
  if (leftDist <= cfg.attachDistance && leftDist <= rightDist) return 'left'
  if (rightDist <= cfg.attachDistance) return 'right'
  return null
}

/** 某一侧墙面在画布上的 x（宠物锚点该贴的位置） */
export function wallX(rect: PerchRect, side: PerchSide, cfg: PerchConfig = PERCH_DEFAULTS, modelHeight = 0): number {
  const gap = modelHeight * cfg.gapRatio
  // 左墙：宠物在墙的**外侧**（左边），所以锚点往左挪一个缝隙；
  // 右墙反之。这个方向搞反的话宠物会整个压在窗口内容上。
  return side === 'left' ? rect.x - gap : rect.x + rect.width + gap
}

/** 天花板（窗口上边缘）在画布上的 y —— 宠物贴在它上方 */
export function ceilingY(rect: PerchRect, cfg: PerchConfig = PERCH_DEFAULTS, modelHeight = 0): number {
  return rect.y - modelHeight * cfg.gapRatio
}

export interface ClimbStep {
  y: number
  /** 是否已经爬到窗口顶（该转为爬天花板了） */
  reachedTop: boolean
}

/**
 * 沿墙向上爬一步。
 *
 * 到顶判定用 `<= rect.y` 而不是 `<`：正好停在顶端那一帧也算到顶，
 * 否则会多爬一步、越过头顶。
 */
export function stepClimb(
  y: number,
  rect: PerchRect,
  dtSec: number,
  cfg: PerchConfig = PERCH_DEFAULTS,
  modelHeight = 0,
): ClimbStep {
  const top = ceilingY(rect, cfg, modelHeight)
  const next = y - cfg.climbSpeed * Math.max(0, dtSec)
  if (next <= top) return { y: top, reachedTop: true }
  return { y: next, reachedTop: false }
}

export interface CrawlStep {
  x: number
  /** 是否爬到了窗口另一角（该掉下去了） */
  reachedEnd: boolean
}

/**
 * 沿窗口上边缘爬一步。
 *
 * **走到另一角就掉下去**，不在顶上折返：折返会让宠物永远赖在窗口上，
 * 而"爬到头掉下来"是参考项目里那个更有生命感的收尾。
 */
export function stepCrawl(
  x: number,
  rect: PerchRect,
  side: PerchSide,
  dtSec: number,
  cfg: PerchConfig = PERCH_DEFAULTS,
): CrawlStep {
  // 从左墙上来的，向右爬；从右墙上来的，向左爬
  const dir = side === 'left' ? 1 : -1
  const next = x + cfg.climbSpeed * dir * Math.max(0, dtSec)

  if (side === 'left') {
    const end = rect.x + rect.width
    if (next >= end) return { x: end, reachedEnd: true }
    return { x: next, reachedEnd: false }
  }
  if (next <= rect.x) return { x: rect.x, reachedEnd: true }
  return { x: next, reachedEnd: false }
}

/**
 * 攀附时是否该松手。
 *
 * 三种情况：目标没了（窗口被隐藏/最小化/关闭）、窗口被拖走了导致宠物悬空、
 * 窗口变得太矮。任何一种都应当让宠物掉下来——**留在原地会显得它悬在空中**。
 */
export function shouldLetGo(
  state: PerchState,
  rect: PerchRect | null,
  petX: number,
  petY: number,
  cfg: PerchConfig = PERCH_DEFAULTS,
  minHeight = 120,
): boolean {
  if (!state) return false
  if (!rect || rect.height < minHeight) return true

  if (state.kind === 'wall') {
    // 墙面跑了：宠物贴着的那条边已经不在脚下
    const target = wallX(rect, state.side, cfg)
    return Math.abs(petX - target) > cfg.attachDistance * 4
  }
  // 天花板上：窗口整个移开了
  return petY < rect.y - rect.height || petY > rect.y + cfg.attachDistance * 4
}
