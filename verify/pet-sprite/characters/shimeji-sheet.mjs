/**
 * shimeji-sheet.mjs — Shimeji 精灵表的**行语义**，唯一来源
 *
 * 谁需要这份知识：
 *   · `import-shimeji.mjs`  —— 切图，按行取动作
 *   · `make-preview.mjs`    —— 预览，把切出来的帧指回原表的格子
 *
 * 抽出来是因为第二个用途出现时，"第几行是什么动作"就有两个读者了。
 * 原样复制一份到预览脚本里也能跑，但表换了排布之后只有一边会改——
 * 那时预览页会把帧指到错误的行上，**画面上看不出错**（高亮的还是某个动作的格子）。
 *
 * 行的含义取自 `AI-desktop-pets` 的 `PetState` 枚举与 `SpriteConfig.DEFAULT_STATES`
 * （`spriteLine` 从 1 起）：
 *
 *   | row | 状态  | 帧数 | loop | fps |
 *   |-----|-------|------|------|-----|
 *   | 0   | STAND | 1    | ✓    | 9   |
 *   | 1   | WALK  | 4    | ✓    | 9   |
 *   | 2   | SIT   | 1    | ✓    | 9   |
 *   | 3   | GREET | 8    | ✗    | 9   |
 *   | 4   | JUMP  | 1    | ✓    | 9   |
 *   | 5   | FALL  | 3    | ✗    | 9   |
 *   | 6   | DRAG  | 1    | ✓    | 9   |
 *   | 7   | CRAWL | 8    | ✓    | 9   |
 *   | 8   | CLIMB | 8    | ✓    | 9   |
 *
 * `sheet-rows.mjs` 独立量出来的帧数**九行全部对上**（1/4/1/8/1/3/1/8/8），
 * 所以这份语义是验证过的，不是照抄的。
 */

/** 表的来处。外部项目路径，不在本仓库里——找不到时调用方自行降级 */
export const SHEET_DIR =
  process.env.SHEET_DIR ??
  'C:/myself/projects/my/open-source/AI-desktop-pets/app/src/main/res/drawable-nodpi'

/** 格边长。这套素材是固定 128 的方格，表宽高都必须是它的整数倍 */
export const CELL = 128

/** `PetState` 的行语义（0 起，与 `spriteLine - 1` 对应） */
export const ROWS = {
  STAND: 0,
  WALK: 1,
  SIT: 2,
  GREET: 3,
  JUMP: 4,
  FALL: 5,
  DRAG: 6,
  CRAWL: 7,
  CLIMB: 8,
}

/**
 * 每行的**声明帧数**，取自 `AI-desktop-pets` 的 `PetState` / `DEFAULT_STATES`。
 *
 * ⚠ 为什么不能只按「这一行有几格有内容」数帧——**踩过**：
 * `shimeji_nekojapan.png` 的第 0 行有 9 格，但 9 格的包围盒全等（45×36）、
 * 两两姿态差异 0.0，也就是**把同一帧复制填满了整行**。
 * 按内容数会得出「待机有 9 帧」，而它声明的 `frameMax` 是 1。
 * 所以这里以声明值为准，内容只用来**交叉校验**：少了报缺帧，多了当填充丢掉。
 */
export const DECLARED = {
  STAND: 1,
  WALK: 4,
  SIT: 1,
  GREET: 8,
  JUMP: 1,
  FALL: 3,
  DRAG: 1,
  CRAWL: 8,
  CLIMB: 8,
}

export const p2 = (i) => String(i).padStart(2, '0')

/**
 * 出哪些动作组。
 *
 * `Idle` 用**单帧 STAND** 而不是某个循环行：单帧正好把「角色动不动」全部交给
 * 程序化原语（`bob`/`breathe`），这是 Lumii 的一条核心下注，值得单独验。
 * `WALK` 那 4 帧则提供一条**真·多帧循环**，用来验逐帧时长与循环衔接。
 *
 * `Sit` / `Fall` / `Picked` 是 2026-09-21 为**自主行为**（R9）补的：
 * 桌宠要能自己坐下、掉落、被拎起来。组名不是随手取的——
 * `Picked` 正是 `PetOrchestrator.playConventionalMotion('Picked')` 找的名字，
 * 命名对上，`setPicked(true)` 那条既有链路不用改一行就能播。
 *
 * 三个「不」：
 * - `Fall` **是 loop 不是 once**：`once` 的语义是"播完回 next"，可掉落的结束时间是
 *   **物理事实**（什么时候落地），不是动画时长。这 3 帧只有 333ms，用 once 会出现
 *   「还在空中就站起来了」。参考项目的 FALL 就是 `loop=false` + 播完即切走，
 *   实测表现正是落地前姿势就没了。用 loop 让下落全程姿势正确，落地由物理层切走。
 * - `Fall` **不 pin**：Idle Pin 的语义是"首末帧锚到待机让接回不跳"，
 *   而掉落的末帧不是待机，锚了反而会闪一下。
 * - `params` 只给**长时间维持**的姿态（Idle/Sit）。走路的 4 帧本身就是动画，
 *   再叠浮动会变成"边抖边走"。
 */
export const GROUPS = [
  {
    group: 'Idle',
    from: 'STAND',
    kind: 'loop',
    fps: 9,
    clip: (id) => `${id}_stand_00`,
    // 单帧待机靠程序化原语活起来——「AI 出静态部件 + 代码做动画」那条下注的落点
    params: (h) => ({ bob: Math.max(1, Math.round(h * 0.06)), breathe: 1.02, sway: 1.5 }),
  },
  { group: 'Walk', from: 'WALK', kind: 'loop', fps: 9, clip: (id, i) => `${id}_walk_${p2(i)}` },
  {
    group: 'Sit',
    from: 'SIT',
    kind: 'loop',
    fps: 9,
    clip: (id, i) => `${id}_sit_${p2(i)}`,
    // 坐着要比站着更静：只有呼吸，没有晃动
    params: () => ({ breathe: 1.015 }),
  },
  { group: 'Talk', from: 'STAND', kind: 'loop', fps: 9, clip: (id) => `${id}_stand_00` },
  // 一次性动作的两端会由 idlePin 换成待机首帧（见下）
  {
    group: 'Wave',
    from: 'GREET',
    kind: 'once',
    next: 'Idle',
    fps: 9,
    pin: true,
    clip: (id, i) => `${id}_greet_${p2(i)}`,
  },
  { group: 'Fall', from: 'FALL', kind: 'loop', fps: 9, clip: (id, i) => `${id}_fall_${p2(i)}` },
  { group: 'Picked', from: 'DRAG', kind: 'loop', fps: 9, clip: (id, i) => `${id}_drag_${p2(i)}` },
  // 跳跃：素材只有 **1 帧**（"跳起来"的瞬间姿势，底边比别的行高 28px）。
  // 所以用 `holdMs` 把它停久一点——一次蹦跳本来就是个瞬间，但"蹦"要看得见。
  // 700ms → 300ms：单帧动作停太久反而像卡住，300ms 是"看得见又干脆"的量级。
  {
    group: 'Jump',
    from: 'JUMP',
    kind: 'once',
    next: 'Idle',
    fps: 9,
    holdMs: 300,
    clip: (id, i) => `${id}_jump_${p2(i)}`,
  },
  // 攀爬：爬到程序主窗口的边缘上（见 `pet-core` 的 `perch`）。两行各 8 帧，
  // 是这套素材里帧数最多的动作——爬行本来就比走路需要更多中间帧才不显得跳。
  { group: 'Climb', from: 'CLIMB', kind: 'loop', fps: 9, clip: (id, i) => `${id}_climb_${p2(i)}` },
  // `flipY`：CRAWL 行在素材里是**正着横躺**的猫（头在左上、腿在左下），而它的用途是
  // **倒挂在天花板下**。参考项目 `SpriteAnimationView.calculateFlip` 的注释也是这么说的
  // ——"垂直翻转：因为是倒挂着的，头朝下"（它代码里那句 `false` 是它自己的 bug）。
  // 在切图期翻好，运行时就不必再管朝向，锚点语义也和别的行统一（内容贴帧底）。
  {
    group: 'Crawl',
    from: 'CRAWL',
    kind: 'loop',
    fps: 9,
    flipY: true,
    clip: (id, i) => `${id}_crawl_${p2(i)}`,
  },
]
