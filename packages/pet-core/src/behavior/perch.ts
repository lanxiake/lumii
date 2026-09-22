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
 * ## 锚点的语义在攀爬时会变，而且**每一行变得不一样**
 *
 * 平地上锚点 = 脚底中心，`(x, y)` 就是"宠物站在哪"，内容也正好贴到帧底。
 * 攀爬的两行则各自留了大片空白，**两行的留白还不一样**——这是实测出来的
 * （`sheet-rows.mjs` 量包围盒 + 逐帧反查内容位置），不是猜的：
 *
 *   | 行    | 内容在帧内的位置        | 距锚点（帧底中心） | 用途 |
 *   | ----- | ----------------------- | ------------------ | ---- |
 *   | CLIMB | 右边贴帧右缘，竖向 36×62 | 右侧 55px / 底 18px | 贴墙 |
 *   | CRAWL | **未翻转**，脚底向上、内容贴帧顶 | 内容顶边距锚点 127px | 倒挂 |
 *
 * **早先这里只有一个 `gapRatio = 0.15`**，是把"素材留白"当成了一个统一的量——
 * 结果爬墙时宠物压在窗口上 36px、爬到顶转爬行时整个飘到窗口上沿以上
 * （`ceilingY` 的符号也写反了：宠物在窗口**下方**倒挂，锚点该比上沿大）。
 * 两个方向、两个量，一个比例表达不了。
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
   * 爬墙时**身体侧边与墙面的缝隙**，按模型高度（画布高 × 缩放）的比例给。
   *
   * 实测 `shimeji_*.png` 的 CLIMB 行：内容右边缘距锚点 55px，帧高 128 → 0.43。
   * 五只猫是同一作者同一规格画的，共用这个值；`import-shimeji.mjs` 切图时会**断言**
   * 这一点，素材换了会在导入期报错，而不是等到运行时才发现宠物压在窗口上。
   */
  wallGapRatio: number
  /**
   * 爬天花板时**锚点到窗口上沿的距离**，按模型高度（画布高 × 缩放）的比例。
   *
   * 这个比值实际是「**CRAWL 行的内容顶边离锚点（帧底）有多远**」：内容顶边贴到
   * 窗口上沿，锚点自然落在它下方这么远。数值由切图期从素材实测
   * （`import-shimeji.mjs` 的 `perchGaps`，五只猫同一规格，共用这个值）。
   *
   * ⚠️ CRAWL 行**不做垂直翻转**（2026-09-21 改）：素材本身就是**脚底向上**画好的
   * 倒挂姿态（内容贴帧**顶**），所以这个比值接近 1（实测 127/128 ≈ 0.992），
   * 而不是"一个内容高"那么小。曾经在切图期翻转过一次——宠物于是**头朝上吊在
   * 天花板上**，方向正好反了。
   *
   * 注意方向：宠物是**倒挂在窗口上沿之下**的，所以锚点比上沿**大**（见 `ceilingY`）。
   */
  ceilingGapRatio: number
}

export const PERCH_DEFAULTS: PerchConfig = {
  attachDistance: 24,
  climbSpeed: 45,
  wallGapRatio: 0.43,
  // 兜底值。实际运行时由 manifest 的 `perchGaps.ceiling` 覆盖（见 PetWanderDriver），
  // 素材换了会自己跟着变；这里跟的是这套 Shimeji 素材的实测值。
  ceilingGapRatio: 0.99,
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
  const gap = modelHeight * cfg.wallGapRatio
  // 左墙：宠物在墙的**外侧**（左边），所以锚点往左挪一个缝隙；
  // 右墙反之。这个方向搞反的话宠物会整个压在窗口内容上。
  return side === 'left' ? rect.x - gap : rect.x + rect.width + gap
}

/**
 * 天花板（窗口上边缘）对应的锚点 y —— 宠物**倒挂在上沿之下**。
 *
 * 所以是**加**不是减：锚点（帧底）落在上沿下方「内容顶边到锚点的距离」处，
 * 于是**内容顶边正好贴上沿**。CRAWL 行未做翻转，内容本身就贴帧顶，
 * 这个距离约等于整个画布高（见 `ceilingGapRatio` 的说明）。
 * 早先写成 `rect.y - gap` 时，宠物会飘到窗口上沿**以上**（实测在 208，
 * 而上沿是 250）。
 */
export function ceilingY(rect: PerchRect, cfg: PerchConfig = PERCH_DEFAULTS, modelHeight = 0): number {
  return rect.y + modelHeight * cfg.ceilingGapRatio
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
  modelHeight = 0,
): boolean {
  if (!state) return false
  if (!rect || rect.height < minHeight) return true

  // 两条边共用一个判据：**宠物离它该在的那条线太远了**。
  //
  // `modelHeight` 必须与 `attachPerch` 传的一致：两边补偿不同的话，宠物刚吸附
  // 就会被判成"已脱离"——差值恰好是一个缝隙，而阈值只有 96px。
  const target =
    state.kind === 'wall'
      ? wallX(rect, state.side, cfg, modelHeight)
      : ceilingY(rect, cfg, modelHeight)
  const dist = state.kind === 'wall' ? Math.abs(petX - target) : Math.abs(petY - target)
  return dist > cfg.attachDistance * 4
}

// ---------------------------------------------------------------------------
// 屏幕边缘
// ---------------------------------------------------------------------------

/**
 * 屏幕边缘的攀附（宠物在视口**内侧**贴边）。
 *
 * 与主窗口的区别是**方向相反**：爬窗口时宠物在窗口**外面**，爬屏幕时它在屏幕**里面**。
 * 所以不能共用 `wallX` —— 那条公式按"锚点在矩形外侧"写死了。
 *
 * 判定也简单得多：视口就是整个可视区域，宠物永远"在它的下方"（因为它在里面），
 * 只需要比水平距离。顶边不参与吸附——宠物站在地面线上，够不着屏幕顶。
 *
 * ## 两条判据取近的那条，缺一不可
 *
 * · **离屏幕边**：捕捉"用户把宠物拖到边上放下"。这是最自然的攀爬入口，
 *   用户拎到屏幕边，本来就带着"放这儿"的意图。
 * · **离墙线**：捕捉"宠物**自己**走到边上"。见下。
 *
 * ⚠️ 只有第一条时，宠物**永远吸不上屏幕墙**（2026-09-22 实测）：走路的可达边界是
 * `walkBoundsOf` 的 `anchorX × scale`（那只猫是 114px，因为它要保证**内容**不出屏），
 * 而吸附要求 `petX ≤ attachDistance`（离屏幕边 24px 内）——两个区间**没有交集**。
 * 于是自主走动够不到判定区，只有拖拽与"从天花板掉下来"（掉落不受走路边界约束）
 * 才吸得上。用户的原话是「可以在屏幕边缘运行」，而它自己走不过去。
 *
 * 取"离墙线"那条之后：可达下限 114 与墙线（`modelHeight × wallGapRatio` ≈ 95）
 * 只差 19，落在 24 的判定区内，走动即可触发。吸附时的位移也只有那 19px，
 * 比原来"从 24 瞬移到 95"（71px）还更平滑。
 *
 * `modelHeight` 省略（0）时墙线退化为屏幕边缘本身，两条判据重合，与旧行为一致。
 */
export function tryAttachScreen(
  petX: number,
  petY: number,
  viewport: { width: number; height: number },
  cfg: PerchConfig = PERCH_DEFAULTS,
  minHeight = 120,
  modelHeight = 0,
): PerchSide | null {
  if (viewport.height < minHeight || viewport.width <= 0) return null
  // 宠物不在视口纵向范围内时不判（拖到屏幕外的中间态）
  if (petY < 0 || petY > viewport.height) return null

  const leftDist = Math.min(petX, Math.abs(petX - screenWallX(viewport, 'left', cfg, modelHeight)))
  const rightDist = Math.min(
    viewport.width - petX,
    Math.abs(petX - screenWallX(viewport, 'right', cfg, modelHeight)),
  )
  if (leftDist <= cfg.attachDistance && leftDist <= rightDist) return 'left'
  if (rightDist <= cfg.attachDistance) return 'right'
  return null
}

/**
 * 屏幕左/右边缘对应的锚点 x。
 *
 * 宠物在**内侧**，所以是"离边一个缝隙"而不是"往边外挪一个缝隙"——
 * 与 `wallX` 的加减方向正好相反。
 */
export function screenWallX(
  viewport: { width: number },
  side: PerchSide,
  cfg: PerchConfig = PERCH_DEFAULTS,
  modelHeight = 0,
): number {
  const gap = modelHeight * cfg.wallGapRatio
  return side === 'left' ? gap : viewport.width - gap
}

/**
 * 把锚点夹进视口内。
 *
 * 主窗口**贴着屏幕边**时（用户常这么摆），`wallX` 会算出屏幕外的坐标——
 * 宠物于是爬到看不见的地方去。参考项目对这种情形是每帧 `coerceIn`，这里同义：
 * 夹住位置，**不动状态**（它仍然认为自己贴着那面墙，只是贴不到了）。
 */
export function clampToViewport(
  x: number,
  y: number,
  viewport: { width: number; height: number },
  margin = 0,
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(x, margin), Math.max(margin, viewport.width - margin)),
    y: Math.min(Math.max(y, margin), Math.max(margin, viewport.height - margin)),
  }
}
