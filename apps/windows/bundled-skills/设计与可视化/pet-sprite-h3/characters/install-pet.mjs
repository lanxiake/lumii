#!/usr/bin/env node
/**
 * install-pet.mjs — 把 H3 出的精灵表装进客户端
 *
 * ## 为什么走 pet-creator 技能，不自己拼图集
 *
 * 客户端要的不只是 atlas.png：还有 atlas.json（帧表）、manifest.json（动作组、
 * 锚点、命中区）、pet.json，以及**按地线对齐**、**待机首帧锚定**这些约定。
 * 这些逻辑已经在 `apps/windows/bundled-skills/…/pet-creator/run.ts` 里，
 * 而且它和主进程共用同一套工具链（经 `/pet/asset` 控制口，dev 与打包同一条路径）。
 *
 * ## 动作组按客户端既有规范（九个）
 *
 * 清单来自 `apps/windows/scripts/gen-demo-pets.mjs`：Idle / Talk / Jump /
 * Wave / Nod / Shake / Picked / Land / PlayBall。
 * 其中 **Idle 与 Talk 由技能自己加**（Talk 复用 base 批次的帧，fps 不同而已），
 * 所以这里只传 8 个批次，出来的就是九组。
 *
 * ## 两个必须先处理的输入问题
 *
 * 1. **技能自带抠底**（`cutout` op），期待"带底色的图集"。我们的表是透明的，
 *    直接喂等于让它抠一片黑——先按 staging 的底色铺回去。
 * 2. **网格是 8×1 横排**，不是 4×2。端到端工作流的 ImageStitch 链拼出来是一条
 *    横排（3072×448）。填错格线会让每格横跨两个角色，出图闸门报"S1 角色越出格线"。
 *
 * ## scale 自动换算
 *
 * `pet.json` 的 `scale` 是按**旧画布**调的，换画布必须按比例改，
 * 否则宠物在桌面上会突然变成两倍大。
 *
 * ⚠ 换算基准是**画布高度**，不是宽度。宠物在屏幕上的观感大小 = `canvas.h × scale`
 * （渲染器只拿高度算），所以换画布时该守的是高度。早先按宽度换算——旧画布
 * 144×168 与新画布 384×448 的宽高比都是 0.857，两者恰好等价，所以一直没暴露；
 * 一旦为了侧身素材把画布改宽，按宽度算会让宠物凭空缩小。
 *
 * 用法：
 *   node install-pet.mjs --id demo_cartoon_cat --dir <表目录> [--canvas 384x448] [--bg 00ccff]
 *
 * `<表目录>` 下按约定放 `<角色>-<动作>-sheet/` 子目录（端到端工作流的落点）。
 *
 * ## 装完还要补一次 `perchGaps`
 *
 * 技能不认识这个字段，而它对"爬墙/爬天花板贴不贴得上"是决定性的——不写就静默用
 * `PERCH_DEFAULTS`（Shimeji 素材的实测值）。见 `lib/perch-gaps.mjs` 与文件末尾那一段。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { measurePerchGaps } from '../lib/perch-gaps.mjs'
import { makeThumbnail } from '../lib/pet-thumbnail.mjs'
import { op } from '../lib/control.mjs'
// 末格复件检测（FL2VA「同一张图当首尾」的产物——末格必然取到那个复件）。
// 判据与实测见 lib/motion-signals.mjs 的 probeWrap。
import { probeWrap } from '../lib/motion-signals.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/**
 * 仓库根：**向上找标记目录**，不写死层数。
 *
 * 这份脚本原本住在 `verify/pet-sprite/characters/`（往上三层到仓库根），
 * 搬进技能目录后层数变了。写死 `../../..` 的后果是**静默装错位置**——
 * 路径解析出一个不存在的目录，只有真正用到时才炸。所以改成找
 * `apps/windows/bundled-skills` 这个标记。
 */
function findRepoRoot(start) {
  let d = start
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(d, 'apps/windows/bundled-skills'))) return d
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  return null
}
/**
 * 无仓库投放（本机部署）的回退：仓库找不到时不 throw——
 * RUN_TS 退到技能树旁边的 pet-creator 部署副本（只要 node 内置模块 + 控制口，
 * node24 可直接跑 .ts）；RESOURCES 退到 ~/.lumii/pet-models（已安装包就是
 * 旧 scale / personaAddon 的现实来源，语义等价：都是"上一版这只宠物的清单"）。
 */
const REPO = findRepoRoot(HERE)
const RUN_TS = REPO
  ? path.join(REPO, 'apps/windows/bundled-skills/设计与可视化/pet-creator/run.ts')
  : path.resolve(HERE, '..', '..', 'pet-creator', 'run.ts')
const DATA_ROOT = process.env.LUMII_CLIENT_DATA_DIR?.trim() || path.join(os.homedir(), '.lumii')
const RESOURCES = REPO
  ? path.join(REPO, 'apps/windows/resources/pet-models')
  : path.join(DATA_ROOT, 'pet-models')

/**
 * 客户端既有的九个动作。`group: null` = 走 base 槽（技能据此生成 Idle/Talk）。
 *
 * ⚠ 这里有**两套九动作规范**，别混：
 *   · 交互那套（`gen-demo-pets.mjs`）：Idle/Talk/Jump/Wave/Nod/Shake/Picked/Land/PlayBall
 *   · 行为那套（Shimeji 参考素材）：Idle/Walk/Sit/Talk/Fall/Picked/Jump/Climb/Crawl
 * 缺行为那套的组**不报错**——`PetOrchestrator.resolveAmbientGroup` 找不到组就静默
 * 回落到基础待机，于是宠物一边平移一边播呼吸，看起来像在滑行。
 * 团子两套都装，共 11 组（Idle/Talk 由技能补，Talk 复用 base 帧）。
 */
const ACTIONS = [
  { key: 'idle', group: null, label: '待机呼吸', kind: 'loop', slot: 'base', nameKey: 'body' },
  // ---- 交互 ----
  { key: 'wave', group: 'Wave', label: '挥手', kind: 'once', next: 'Idle' },
  { key: 'hop', group: 'Jump', label: '跳跃', kind: 'once', next: 'Idle' },
  { key: 'nod', group: 'Nod', label: '点头', kind: 'once', next: 'Idle' },
  { key: 'shake', group: 'Shake', label: '摇头', kind: 'once', next: 'Idle' },
  { key: 'picked', group: 'Picked', label: '被拎起', kind: 'loop' },
  { key: 'land', group: 'Land', label: '落地', kind: 'once', next: 'Idle' },
  { key: 'playball', group: 'PlayBall', label: '玩球', kind: 'once', next: 'Idle' },
  // ---- 行为（自主走动/攀爬那套）----
  // 这四个必须是 loop：驱动会在同一个姿态上停几十秒（实测一次攀爬 30 秒），
  // 播 `once` 的话动作放完就僵住。
  { key: 'walk', group: 'Walk', label: '走路', kind: 'loop' },
  { key: 'fall', group: 'Fall', label: '下落', kind: 'loop' },
  { key: 'climb', group: 'Climb', label: '攀爬', kind: 'loop' },
  /**
   * ⚠ `invertY` —— 这一行**必须**垂直翻转，别人不许抄。
   *
   * `Crawl` 只在天花板上播（`PetWanderDriver` 里 `onActivity('crawl')` 只有
   * 「沿上边缘爬行」那一处），所以那一行素材得是**倒挂**的：脚朝上贴着天花板、
   * 头朝下。Shimeji 那套的作者就是那么画的（`import-shimeji.mjs` 的 CRAWL 行
   * 不翻转，因为它本来就是脚底向上的），而 H3 出的这一行是**正的**
   * （`POSES.creep` 写的是"趴在地上"，模型照做）。
   *
   * 不翻会怎样：宠物**头朝上吊在天花板上**，与用户报的"反了，应该底部朝上、
   * 头部朝下"完全一致。翻早了也不行——`import-shimeji.mjs` 里记着一次：
   * 给本来就是倒挂的素材再翻一次，同样头朝上。
   */
  /**
   * ⚠ `flipX` —— 这一行**必须**水平镜像（2026-09-25 加，月兔）。
   *
   * 约定是硬的：**素材一律朝右画**（`PetWanderDriver.applyFacing` 写死
   * "素材面朝右，故 facing=-1 时才翻转"）。而这一行的素材**画成了朝左**——
   * 提示词里明写着 `facing the right of the frame`，模型没听。
   * 用户看到的说法是「运动方向反了」：往右爬时脸朝左。
   *
   * 判据不是观感，是量的（`lib/motion-signals.mjs` 的 `probeFacing`，
   * 两个独立信号 + 负对照）：眼睛偏移 **−10.0%**、头+耳的最高列落在 **0.27**（左端）；
   * 同角色的 walk / fall 读 **+35.7% / +39.3%**（朝右基准），idle 读近 0（负对照）。
   *
   * 为什么不重渲：镜像是一张 16 格的本地翻转，**零 GPU**；重渲要十几分钟，
   * 而且不保证模型这次肯听话（它就是没听才画反的）。
   * ⚠ 但**不要**把这个当常规手段——新角色仍应在**出图侧**就画对（见 SKILL.md 的朝向规则），
   * 这里是"已经烧掉的钱把它救回来"。
   */
  { key: 'crawl', group: 'Crawl', label: '爬行', kind: 'loop', invertY: true, flipX: true, side: true },
  // 参考素材（demo_shimeji_*）里 Sit 是**正面**坐姿、`kind: loop`、**1 帧**。
  // 我们出的是 8 帧的呼吸循环（同一套管线，首帧是自己的坐姿），比单帧静止好看，
  // 而且**不用**为它开特例（单帧要改 install 的 cols，还会换掉格尺寸→换组）。
  { key: 'sit', group: 'Sit', label: '坐下', kind: 'loop' },

  // ---- 2026-09-24：设计 §8.6.2 的「需新素材」三条 + 互动/情绪反应的可见形态 ----
  //
  // 来源逐条：
  //   · Yawn / Stretch / Scratch —— 设计 §8.6.2 唯一标了「需新素材」的三条
  //   · Dodge  —— §4.4「会拒绝」的表现列（躲开 / 扭过脸 / 不动，取了「躲开」）
  //   · Purr   —— §8.3.1「长按摸头」+ 计划 T2.4（文档称「零素材」，那是指复用 Live2D 的
  //               `calm` 表情；精灵图**没有表情层**（团子 `emotionMap` 是空的），只能靠动作组）
  //   · Cheer / Droop —— §7.3 目标完成 / 失败的可见形态
  //   · Look   —— §8.3.1「鼠标靠近 → 转头看鼠标」（第三期）
  //
  // ⚠ **`cols: 16`**：这八条出图时抽的是 16 帧（`h3-motion.mjs` 的 `DEFAULT_PICKS`），
  // 而既有 13 条是 8 帧。格数**必须逐条对**——要么切出来的格子横跨两个角色
  // （出图闸门会报 S1），要么 `names` 数量与网格不符（`pet-creator` 直接抛错）。
  //
  // ⚠ **`fps` 不等于"越快越好"**：回放时长 = 帧数 ÷ fps。源片是 4.46 秒，
  // 16 帧 @8fps 播 2.0 秒（快放 2.23×，与既有动作同一手感）；躲开是**闪避**，
  // 2 秒太拖，给它 14fps（1.14 秒）；呼噜是**持续状态**的慢循环，6fps（2.67 秒）。
  { key: 'yawn', group: 'Yawn', label: '打哈欠', kind: 'once', next: 'Idle', cols: 16 },
  { key: 'stretch', group: 'Stretch', label: '伸懒腰', kind: 'once', next: 'Idle', cols: 16 },
  { key: 'scratch', group: 'Scratch', label: '挠头', kind: 'once', next: 'Idle', cols: 16 },
  { key: 'dodge', group: 'Dodge', label: '躲开', kind: 'once', next: 'Idle', cols: 16, fps: 14 },
  { key: 'cheer', group: 'Cheer', label: '雀跃', kind: 'once', next: 'Idle', cols: 16, fps: 10 },
  { key: 'droop', group: 'Droop', label: '蔫', kind: 'once', next: 'Idle', cols: 16 },
  { key: 'look', group: 'Look', label: '张望', kind: 'once', next: 'Idle', cols: 16 },
  // 呼噜是 loop：长按期间要一直播，播完不能僵住（与 Walk/Climb/Crawl/Fall 同一条规矩）
  { key: 'purr', group: 'Purr', label: '呼噜', kind: 'loop', cols: 16, fps: 6 },
]

/**
 * 点击命中区 → 动作组。
 *
 * 内置宠物（shimeji 那批）一律映射到 `Jump`，团子没有 `Jump`（跳跃会被出图闸门
 * 以「头顶出格」拦下），所以改映射到**已经装进去的**组：摸头点头、摸身体挥手。
 *
 * 不给这张表的后果是**点击静默无效**，不是报错：渲染器的兜底链是
 * `hitArea名 → Tap → tap → TapBody → idleMotionFallbackGroup`，团子一个都没有，
 * 一路走到 `return`。日志只有一行 `[triggerTapMotion] 命中映射=无`。
 * 三个键：`HitAreaHead`/`HitAreaBody` 是命中区推出来的 id，`body` 是旧版约定。
 */
const TAP_MOTIONS = {
  HitAreaHead: 'Nod',
  HitAreaBody: 'Wave',
  body: 'Wave',
}

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}
const id = opt('id')
const sheetDir = opt('dir')
const charKey = opt('char', 'tuanzi')
if (!id || !sheetDir) {
  console.error('用法：node install-pet.mjs --id <客户端目录名> --dir <表目录> [--char tuanzi] [--canvas 384x448]')
  process.exit(1)
}
const [cw, ch] = opt('canvas', '384x448').split('x').map(Number)
/**
 * 默认网格与回放帧率。**逐条动作可以用 `cols` / `fps` 覆盖**（见 `ACTIONS` 里的说明）：
 * 2026-09-24 起新出的八条是 16 帧，既有 13 条是 8 帧，两套网格在同一批里并存。
 */
const COLS = Number(opt('cols', 8))
const ROWS = Number(opt('rows', 1))
const FPS = Number(opt('fps', 8))

/**
 * 特效层（`--fx-dir`，2026-09-24）。
 *
 * 渲染器早就支持 `manifest.slots`（分层特效叠在角色身上、可开关、跟身体缩放），
 * 但我们的安装器只发 base 批次，slots 永远是 `{}`——光尘、花环这些特效只能
 * 烤死在每个动作帧里。这里补一条独立批次走非 base 的槽：
 * run.ts 会把它打进**同一张图集**（同一套 normalize/锚点空间），并在
 * `manifest.slots` 里生成 `{kind:'layered', at:[0,0], parts:{<cat>:[帧名…]}}`。
 * `at` 在 run.ts 侧写死 [0,0]，覆盖在安装后补（和 perchGaps 同一段、同一个写者）。
 *
 * 用法：`--fx-dir <表目录> [--fx-slot fx] [--fx-cat aura] [--fx-cols 8] [--fx-fps 8] [--fx-at 0,-12]`
 */
const FX = opt('fx-dir')
  ? {
      dir: opt('fx-dir'),
      slot: opt('fx-slot', 'fx'),
      cat: opt('fx-cat', 'aura'),
      cols: Number(opt('fx-cols', 8)),
      rows: Number(opt('fx-rows', 1)),
      fps: Number(opt('fx-fps', 8)),
      at: (opt('fx-at', '0,0') || '0,0').split(',').map((v) => Math.round(Number(v))),
    }
  : null

/**
 * 图集单边上限（像素）。
 *
 * 图集是**一张**贴图，`maxCols` 固定为 8 时高度 = ⌈帧数/8⌉ × 格高（这里是 448），
 * 帧数一多就成了一条细长的竖条：104 帧已是 4480×5824，再加 8 条 16 帧（128 帧）
 * 会到 **12992px**——越过不少 GPU 的 8192 上限，**一超整张图集建不出纹理、宠物直接不显示**。
 *
 * 8192 是 DX10 时代的保底值（DX11+ 保证 16384），按保底的来。
 * 列数由这里算出来交给打包器（`pet-creator` 的 `maxCols`），图集于是始终接近方形。
 */
const ATLAS_MAX_DIM = 8192

const dir = path.join(RESOURCES, id)
const pet = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf-8'))
const oldManifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
const scale = Number(opt('scale', 0)) || (pet.scale * oldManifest.canvas.h) / ch
const prefix = id.replace(/^demo_/, '').split('_').pop()

// 技能自带抠底，期待带底色的图集；我们的表是透明的，先铺回底色
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-install-'))
const bgHex = '#' + opt('bg', '00ccff')

const batches = []
/** 真正装进去的组名，用来过滤点击映射——映射到一个不存在的组同样静默无效 */
const installedGroups = new Set()
/** 装进去的总帧数，用来算图集列数（见 ATLAS_MAX_DIM） */
let totalFrames = 0
for (const a of ACTIONS) {
  const sub = path.join(sheetDir, `${charKey}-${a.key}-sheet`)
  if (!fs.existsSync(sub)) {
    // 缺一个动作不该让整包装不上——先装有的，缺的下次补齐
    console.warn(`  ⚠ 跳过 ${a.group || 'Idle'}（找不到 ${sub}）`)
    continue
  }
  // ⚠ **明确取 `f0000.png`**，不要靠 `sort()[0]` 撞运气：这个目录同时也是
  // `pose-pick --emit` 的默认落点，混进别的 png 时"排序第一个"是谁就看名字了
  // （`f0000` 排在 `pick-*` 前面纯属巧合，改个前缀就会静默装错图）。
  const pngs = fs.readdirSync(sub).filter((f) => f.endsWith('.png'))
  if (!pngs.length) {
    console.warn(`  ⚠ 跳过 ${a.group || 'Idle'}（${sub} 里没有 png）`)
    continue
  }
  if (pngs.length > 1) {
    console.warn(`  ⚠ ${path.basename(sub)} 里有 ${pngs.length} 个 png（${pngs.join(', ')}）——按约定只该有 f0000.png`)
  }
  let src = path.join(sub, pngs.includes('f0000.png') ? 'f0000.png' : pngs.sort()[0])
  const nameKey = a.nameKey || a.group.toLowerCase()
  if (a.group) installedGroups.add(a.group)

  // 逐条动作的网格与帧率（见 ACTIONS 的说明）：格数必须与出图时的抽帧数一致。
  // 列数优先读表自带的 f0000.json（硬规则 15：列数由生产侧声明，别让下游猜）。
  let tableCols = null
  try {
    tableCols = JSON.parse(fs.readFileSync(path.join(sub, 'f0000.json'), 'utf8')).cols ?? null
  } catch {
    /* 老表没有 json，走 ACTIONS 表 */
  }
  if (tableCols && a.cols && tableCols !== a.cols) {
    console.warn(`  ⚠ ${path.basename(sub)}：f0000.json 报 ${tableCols} 列，ACTIONS 写的是 ${a.cols}——以 f0000.json 为准`)
  }
  let cols = tableCols ?? a.cols ?? COLS
  const rows = a.rows ?? ROWS

  // —— 循环组的末格复件（FL2VA「同一张图当首尾」的产物）——
  //
  // 抽帧含第 0 帧、末帧又被钉回首帧，于是**末格必然取到那个复件**；留在表里
  // 每次循环到那一格都会顿一下。判据见 `lib/motion-signals.mjs` 的 `probeWrap`：
  // **三条同时成立才丢**（对齐 MAD < 6、明显比「0↔末-1」低一半以上、包围盒差 <6%
  // 且位移 ≤6px）——少一条就宁可保留，**丢错一格会把循环跳变做得更糟**。
  //
  // ⚠ **必须在 `flatten` 之前、拿原始表判**。flatten 会把透明区填成纯底色，
  // 而绿底的亮度是 150、这一身银白又都是高亮度 —— 两者亮度接近，比对被压平，
  // 连"其实一直在动"的组也会被误判成复件（实测 Climb 从 25.99 掉到 2.6，
  // 于是它被错丢了一格）。`probeWrap` 的阈值是按**带 alpha 的原表**标定的。
  let droppedLast = false
  if (a.kind === 'loop' && cols > 2) {
    const w = await probeWrap(src, cols)
    if (w.ok && w.dup) {
      const meta = await sharp(src).metadata()
      const cw = Math.floor(meta.width / cols)
      const trimmed = path.join(workDir, `${id}-${a.key}-wrap.png`)
      await sharp(src)
        .extract({ left: 0, top: 0, width: cw * (cols - 1), height: meta.height })
        .png()
        .toFile(trimmed)
      src = trimmed
      console.log(
        `     ↳ 末格是首格的复件（MAD ${w.dEnd} vs 末-1 ${w.dPrev}）→ 丢掉：${cols} → ${cols - 1} 格`,
      )
      cols -= 1
      droppedLast = true
    }
  }

  // 翻转与铺底要在**切格之前**做：表是 N×1 横排，`flip()`/`flop()` 把整幅镜像，
  // 等价于每一格各自就地翻转（列不变，格不会串位）；与 `flatten` 的先后无关
  // ——一个是几何操作、一个只改 alpha。两个镜像**互相正交**（`flip` 上下、
  // `flop` 左右），同时开也没有先后问题。
  const flat = path.join(workDir, `${id}-${a.key}-flat.png`)
  let img = sharp(src)
  if (a.invertY) img = img.flip()
  if (a.flipX) img = img.flop()
  await img.flatten({ background: bgHex }).png().toFile(flat)

  const frames = cols * rows
  const fps = a.fps ?? FPS
  totalFrames += frames

  batches.push({
    file: flat,
    cols,
    rows,
    slot: a.slot || 'base',
    action: a.label,
    ...(a.group
      ? { group: a.group, kind: a.kind, ...(a.next ? { next: a.next } : {}), fps }
      : {}),
    names: Array.from({ length: frames }, (_, i) => `${prefix}_${nameKey}_${String(i).padStart(2, '0')}`),
    durationsMs: Array.from({ length: frames }, () => Math.round(1000 / fps)),
  })
  console.log(
    `  ${(a.group || 'Idle(base)').padEnd(12)} ← ${path.basename(path.dirname(src))}/${path.basename(src)}` +
      `  ${cols}格 @${fps}fps（${(cols / fps).toFixed(2)}s）` +
      (a.invertY ? '（已垂直翻转 → 倒挂）' : '') +
      (a.flipX ? '（已水平镜像 → 朝右）' : '') +
      (droppedLast ? '（丢了末格复件）' : ''),
  )
}

// —— 特效层批次（见 FX 定义的说明）：slot ≠ base，run.ts 会把它们登记进 slots ——
if (FX) {
  const fxSrc = path.join(FX.dir, 'f0000.png')
  if (!fs.existsSync(fxSrc)) {
    console.error(`✗ 特效层表找不到：${fxSrc}（约定只吃 f0000.png）`)
    process.exit(1)
  }
  const fxFlat = path.join(workDir, `${id}-fx-${FX.slot}-${FX.cat}-flat.png`)
  await sharp(fxSrc).flatten({ background: bgHex }).png().toFile(fxFlat)
  const frames = FX.cols * FX.rows
  totalFrames += frames
  batches.push({
    file: fxFlat,
    cols: FX.cols,
    rows: FX.rows,
    slot: FX.slot,
    category: FX.cat,
    action: `FX·${FX.slot}:${FX.cat}`,
    names: Array.from({ length: frames }, (_, i) => `${prefix}_fx_${FX.cat}_${String(i).padStart(2, '0')}`),
    durationsMs: Array.from({ length: frames }, () => Math.round(1000 / FX.fps)),
  })
  console.log(`  FX:${FX.slot}     ← ${path.basename(FX.dir)}  ${FX.cols}格 @${FX.fps}fps（部件类别 ${FX.cat}）`)
}

const tapMotions = Object.fromEntries(
  Object.entries(TAP_MOTIONS)
    .filter(([, g]) => installedGroups.has(g))
    .map(([area, g]) => [area, { [g]: 0 }]),
)
if (Object.keys(tapMotions).length === 0) {
  console.warn('  ⚠ 点击映射为空（Nod/Wave 都没装）——点击宠物不会有反应')
}

/**
 * 图集列数：让**宽和高都留在 `ATLAS_MAX_DIM` 以内**，同时尽量保持方形。
 *
 * 固定 8 列时高度 = ⌈帧数/8⌉ × 格高，帧数一多就是一条竖条，早晚越过贴图上限；
 * 列数随帧数长，两个方向才一起受控。取 `max` 里的 `COLS` 是**不让列数比原来少**——
 * 减列只会让高度更长，与目的相反。
 */
const maxColsByWidth = Math.floor(ATLAS_MAX_DIM / cw)
const rowsPerAtlas = Math.floor(ATLAS_MAX_DIM / ch)
const packCols = Math.min(maxColsByWidth, Math.max(COLS, Math.ceil(totalFrames / rowsPerAtlas)))
if (packCols * rowsPerAtlas < totalFrames) {
  console.warn(
    `  ⚠ ${totalFrames} 帧塞不进 ${packCols}×${rowsPerAtlas}（上限 ${packCols * rowsPerAtlas}）：` +
      `图集会越过单边 ${ATLAS_MAX_DIM}px。要么少几条动作、要么缩小画布（⚠ 缩小画布 = 宠物变小，` +
      `必须同步改 scale）。`,
  )
}

const params = {
  action: 'build',
  id,
  name: pet.name,
  canvas: { w: cw, h: ch },
  anchor: [Math.round(cw / 2), ch - 6],
  scale: Number(scale.toFixed(4)),
  personaAddon: pet.personaAddon,
  tapMotions,
  maxCols: packCols,
  batches,
}
console.log(`\n装 ${id}：画布 ${cw}×${ch}、scale ${pet.scale} → ${params.scale}（旧画布 ${oldManifest.canvas.w}×${oldManifest.canvas.h}）`)
console.log(`${batches.length} 个批次 / ${totalFrames} 帧 → 客户端动作组（Idle/Talk 由技能补）`)
console.log(
  `图集按 ${packCols} 列摆 → 预计 ${packCols * cw}×${Math.ceil(totalFrames / packCols) * ch}（单边上限 ${ATLAS_MAX_DIM}）\n`,
)

const child = spawn(process.execPath, [RUN_TS], {
  env: { ...process.env, SKILL_PARAMS: JSON.stringify(params) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => (out += d))
child.stderr.on('data', (d) => (out += d))
child.on('close', async (code) => {
  const line = out.split('\n').find((l) => l.startsWith('__SKILL_RESULT__:'))
  if (!line) {
    console.log(`技能没有返回结果标记（退出码 ${code}）。原始输出末段：`)
    console.log(out.slice(-2000))
    process.exit(code || 1)
  }
  let result = null
  try {
    result = JSON.parse(line.slice('__SKILL_RESULT__:'.length))
  } catch {
    console.log('结果解析失败:', line.slice(0, 800))
    process.exit(code || 1)
  }
  console.log('技能返回:', JSON.stringify(result, null, 2).slice(0, 2000))

  // ---- 补写 perchGaps 与缩略图（技能不认识这两样）----
  //
  // 见 `lib/perch-gaps.mjs` 的长注释：不写的话 `pet-core` 会**静默**用
  // `PERCH_DEFAULTS`——那是 Shimeji 那套素材的实测值，套在 H3 这套上宠物
  // 离墙 47px、离天花板 108px，看着像被电梯带着走而不是在爬。
  //
  // 为什么放在这一步而不是传给技能：`perchGaps` 是「锚点到接触面的距离 ÷ 画布高」，
  // 而画布坐标空间**只有归一化之后才有**（倍率取决于组内最高包围盒）。要在这里算
  // 就得把 `computeNormalize` 抄一遍——抄错不报错，只表现为宠物贴不到墙。
  // **量装好的图集**是唯一不会说谎的做法。
  const pkgDir = result.packageDir
  if (!pkgDir || !fs.existsSync(path.join(pkgDir, 'manifest.json'))) {
    console.error('  ⚠ 技能没回 packageDir，perchGaps 与缩略图都没补')
    process.exit(code || 0)
  }
  // slots 的 `at` 偏移：run.ts 建 slots 时写死 [0,0]（那是给"贴在锚点原位"的部件
  // 准备的默认值）。环绕光尘要抬到头顶附近，只能在这里覆盖——同一个写者、同一次写盘。
  if (FX) {
    try {
      const p = path.join(pkgDir, 'manifest.json')
      const m = JSON.parse(fs.readFileSync(p, 'utf-8'))
      const def = m.slots && m.slots[FX.slot]
      if (def) {
        def.at = FX.at
        fs.writeFileSync(p, JSON.stringify(m, null, 2))
        console.log(`  · slot ${FX.slot} 的 at → [${FX.at.join(', ')}]（覆盖 run.ts 默认的 [0, 0]）`)
      } else {
        console.warn(`  ⚠ manifest.slots 里没有 "${FX.slot}"——特效层批次没被 run.ts 登记，检查 --fx-slot/--fx-cat`)
      }
    } catch (err) {
      console.error(`  ⚠ slot 的 at 偏移没写上：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  try {
    const gaps = await measurePerchGaps(pkgDir)
    if (!gaps) {
      console.log(`  · ${pkgDir} 没有 Climb/Crawl 两组，不写 perchGaps`)
    } else {
      const p = path.join(pkgDir, 'manifest.json')
      const m = JSON.parse(fs.readFileSync(p, 'utf-8'))
      m.perchGaps = { wall: gaps.wall, ceiling: gaps.ceiling }
      fs.writeFileSync(p, JSON.stringify(m, null, 2))
      console.log(`  · perchGaps { wall: ${gaps.wall}, ceiling: ${gaps.ceiling} }`)
      for (const w of gaps.warnings) console.log(`    ⚠ ${w}`)
    }
  } catch (err) {
    // 攀附几何只影响爬墙/爬天花板这两件事，缺了是退化不是致命——但必须**说出来**
    console.error(`  ⚠ perchGaps 没量出来：${err instanceof Error ? err.message : String(err)}`)
  }

  // 缩略图：概览页右下角那块「虚拟人」卡片靠注册表的 `thumbnailUrl` 显示形象，
  // **精灵图模型一个都没有**（内置注册表里三只 Live2D 有 `runtime/icon.png`，
  // 三只 sprite 全空），于是卡片一直只画一个占位图标——用户报的"没显示当前被选中的
  // 宠物形象"就是它。这里从**装好的图集**上裁一张出来，两处都不会说谎。
  try {
    const thumb = await makeThumbnail(pkgDir, id)
    const petJson = path.join(pkgDir, 'pet.json')
    const env = JSON.parse(fs.readFileSync(petJson, 'utf-8'))
    // ⚠ 路径必须**带上模型目录名**：解析侧是按「用户宠物目录」拼的
    // （见 pet-model-resolver 的 toUserUrl），写成裸文件名会去找
    // `~/.lumii/pet-models/thumbnail.png`。内置注册表那三条也是这个写法。
    env.thumbnailUrl = `${id}/${thumb.file}`
    fs.writeFileSync(petJson, JSON.stringify(env, null, 2))
    console.log(`  · 缩略图 ${thumb.file}（${thumb.w}×${thumb.h}，取 ${thumb.from} 首帧）`)
  } catch (err) {
    console.error(`  ⚠ 缩略图没做出来：${err instanceof Error ? err.message : String(err)}`)
  }

  // **再装一次**：上面对 `packageDir` 的两处改动（清单的 perchGaps、信封的
  // thumbnailUrl）都要进用户目录**和注册表**。注册表条目由 `install` 从信封归一化出来，
  // 自己去改 registry.json 属于第三个写者，下次重装就被冲掉——重装一遍是最短的诚实路径。
  try {
    const again = await op('install', { dir: pkgDir })
    console.log(again?.ok ? '  · 已按补写后的包重装（清单 + 注册表）' : `  ⚠ 重装失败：${again?.error ?? '未知'}`)
  } catch (err) {
    console.error(`  ⚠ 重装失败：${err instanceof Error ? err.message : String(err)}`)
  }
  process.exit(code || 0)
})
