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
  throw new Error(`从 ${start} 往上找不到仓库根（标记：apps/windows/bundled-skills）`)
}
const REPO = findRepoRoot(HERE)
const RUN_TS = path.join(REPO, 'apps/windows/bundled-skills/设计与可视化/pet-creator/run.ts')
const RESOURCES = path.join(REPO, 'apps/windows/resources/pet-models')

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
  { key: 'crawl', group: 'Crawl', label: '爬行', kind: 'loop', invertY: true },
  // 参考素材（demo_shimeji_*）里 Sit 是**正面**坐姿、`kind: loop`、**1 帧**。
  // 我们出的是 8 帧的呼吸循环（同一套管线，首帧是自己的坐姿），比单帧静止好看，
  // 而且**不用**为它开特例（单帧要改 install 的 cols，还会换掉格尺寸→换组）。
  { key: 'sit', group: 'Sit', label: '坐下', kind: 'loop' },
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
const COLS = Number(opt('cols', 8))
const ROWS = Number(opt('rows', 1))
const FRAMES = COLS * ROWS
const FPS = Number(opt('fps', 8))

const dir = path.join(RESOURCES, id)
const pet = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf-8'))
const oldManifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
const scale = Number(opt('scale', 0)) || (pet.scale * oldManifest.canvas.h) / ch
const prefix = id.replace(/^demo_/, '').split('_').pop()

// 技能自带抠底，期待带底色的图集；我们的表是透明的，先铺回底色
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-install-'))
const bgHex = '#' + opt('bg', '00ccff')
const durations = Array.from({ length: FRAMES }, () => Math.round(1000 / FPS))

const batches = []
/** 真正装进去的组名，用来过滤点击映射——映射到一个不存在的组同样静默无效 */
const installedGroups = new Set()
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
  const src = path.join(sub, pngs.includes('f0000.png') ? 'f0000.png' : pngs.sort()[0])
  const flat = path.join(workDir, `${id}-${a.key}-flat.png`)
  // 翻转要在**切格之前**做：表是 8×1 横排，`flip()` 把整幅上下镜像，
  // 等价于每一格各自就地翻转（列不变，格不会串位）。
  // 与 `flatten` 的先后无关——一个是几何操作、一个只改 alpha。
  const prepped = a.invertY ? sharp(src).flip() : sharp(src)
  await prepped.flatten({ background: bgHex }).png().toFile(flat)
  const nameKey = a.nameKey || a.group.toLowerCase()
  if (a.group) installedGroups.add(a.group)
  batches.push({
    file: flat,
    cols: COLS,
    rows: ROWS,
    slot: a.slot || 'base',
    action: a.label,
    ...(a.group ? { group: a.group, kind: a.kind, ...(a.next ? { next: a.next } : {}), fps: FPS } : {}),
    names: Array.from({ length: FRAMES }, (_, i) => `${prefix}_${nameKey}_${String(i).padStart(2, '0')}`),
    durationsMs: durations,
  })
  console.log(
    `  ${a.group || 'Idle(base)'} ← ${path.basename(path.dirname(src))}/${path.basename(src)}` +
      (a.invertY ? '（已垂直翻转 → 倒挂）' : ''),
  )
}

const tapMotions = Object.fromEntries(
  Object.entries(TAP_MOTIONS)
    .filter(([, g]) => installedGroups.has(g))
    .map(([area, g]) => [area, { [g]: 0 }]),
)
if (Object.keys(tapMotions).length === 0) {
  console.warn('  ⚠ 点击映射为空（Nod/Wave 都没装）——点击宠物不会有反应')
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
  batches,
}
console.log(`\n装 ${id}：画布 ${cw}×${ch}、scale ${pet.scale} → ${params.scale}（旧画布 ${oldManifest.canvas.w}×${oldManifest.canvas.h}）`)
console.log(`${batches.length} 个批次 → 客户端九组（Idle/Talk 由技能补）\n`)

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

  // ---- 补写 perchGaps（技能不认识这个字段）----
  //
  // 见 `lib/perch-gaps.mjs` 的长注释：不写的话 `pet-core` 会**静默**用
  // `PERCH_DEFAULTS`——那是 Shimeji 那套素材的实测值，套在 H3 这套上宠物
  // 离墙 47px、离天花板 108px，看着像被电梯带着走而不是在爬。
  //
  // 为什么放在这一步而不是传给技能：`perchGaps` 是「锚点到接触面的距离 ÷ 画布高」，
  // 而画布坐标空间**只有归一化之后才有**（倍率取决于组内最高包围盒）。要在这里算
  // 就得把 `computeNormalize` 抄一遍——抄错不报错，只表现为宠物贴不到墙。
  // **量装好的图集**是唯一不会说谎的做法。
  //
  // `packageDir` 与 `installedDir` 都要写：技能先产出包、校验、再 install 到用户目录，
  // 两处各有一份 manifest.json，只补一份会让"重装一次"把改动抹掉。
  for (const dir of [result.packageDir, result.installedDir]) {
    if (!dir || !fs.existsSync(path.join(dir, 'manifest.json'))) continue
    try {
      const gaps = await measurePerchGaps(dir)
      if (!gaps) {
        console.log(`  · ${dir} 没有 Climb/Crawl 两组，不写 perchGaps`)
        continue
      }
      const p = path.join(dir, 'manifest.json')
      const m = JSON.parse(fs.readFileSync(p, 'utf-8'))
      m.perchGaps = { wall: gaps.wall, ceiling: gaps.ceiling }
      fs.writeFileSync(p, JSON.stringify(m, null, 2))
      console.log(`  · ${dir} → perchGaps { wall: ${gaps.wall}, ceiling: ${gaps.ceiling} }`)
      for (const w of gaps.warnings) console.log(`    ⚠ ${w}`)
    } catch (err) {
      // 攀附几何只影响爬墙/爬天花板这两件事，缺了是退化不是致命——但必须**说出来**
      console.error(`  ⚠ ${dir} 的 perchGaps 没量出来：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  process.exit(code || 0)
})
