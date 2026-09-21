/**
 * sheet-prompt — 出图提示词与底色推导（**生成契约的唯一定义处**）
 *
 * 设计依据：docs/plans/客户端UI/2026-09-21-宠物精灵图生成线优化实施计划.md §二
 *
 * ## 为什么提示词要写进代码，而不是留在 SKILL.md 的散文里
 *
 * 提示词是这条生成线上**唯一**能决定出图质量的东西，而它此前散在 SKILL.md 的说明
 * 与 `verify/pet-sprite/*.txt` 的记录文件里——两处会各自漂移，且没有任何东西能测它。
 * 302Sprite 把它写成 `buildSpritePrompt()` 函数，这是它能维护住的一半原因。
 *
 * ## 与 302Sprite 的两处**故意不一致**（别照着它抄回去）
 *
 * 1. **不抄 isometric three-quarter view**。那是动作 RPG 精灵的需求：角色在格子里
 *    走来走去、越大越好。桌宠恰恰相反——正视角、固定机位、角色在格里的位置和尺寸
 *    不许变。因为渲染用的是**共同画布 + 共同锚点**：Phaser 的
 *    `load.spritesheet(key, path, fw, fh)` 只认等尺寸等原点的格子，引擎侧根本没有
 *    给单帧单独设原点或单独裁剪的手段。所以「格子形状一致」不是风格偏好，是约束。
 * 2. **多一段 MOTION**。302Sprite 的 `ANIMATION FLOW` 讲「读序即时间序、末格接首格」，
 *    Lumii 原来的提示词一个字都没有——于是「四个互不相干的姿势」被当成四格交出去，
 *    `real_dog` 的待机循环里因此出现了抬爪和低头（见优化计划 §二）。
 *
 * ## 关于「提示词里不出现阿拉伯数字」
 *
 * 计数一律走 `cnNumber()` 写中文数字。这是照 302Sprite 的做法先规避：它把
 * 「不许出现数字」同时写进创作段与技术段，理由是模型容易把提示词里的数字画成格子编号。
 * **本仓库没有实测到这个现象**（`real_dog` 那批提示词里就写着 `2x2`，出图里没有数字），
 * 规避的代价为零，所以照做——但别把它当成已验证的结论。
 *
 * **例外只有一个**：BACKGROUND 段里的 `#rrggbb`。底色必须给准，用文字描述颜色反而更糟
 * （实测写 `#D9218F` 产出仍在 `#d11b89`–`#db1782` 波动，但至少同色系是对的）。
 * 所以「提示词里无阿拉伯数字」这条判据要**排除 BACKGROUND 那一行**。
 */

import { colorDistance, formatHexColor, parseHexColor, type RGB } from './cutout.js'

/**
 * 底色与角色色的最小安全距离。
 *
 * 抠底是连通性 flood fill，`tuneSolid()` 会把容差自动抬到「再抬一格就泄漏」的前一档
 * （真实素材实测落在 180–191）。容差一旦 ≥ 描边色距底色的距离，flood fill 就穿过描边
 * 漏进角色内部——实测误差从 0.00028 暴涨 300 倍。真实素材的描边距底色实测 191–201，
 * 所以 150 是「比实测最差情况再留一档余量」的保守线。
 */
export const BG_MIN_SAFE_DISTANCE = 150

/** 没给角色配色时的兜底底色：一直用的洋红，别在这里顺手换掉 */
const FALLBACK_BG = '#d9218f'

export interface BackgroundPick {
  /** 建议底色（`#rrggbb`） */
  hex: string
  /** 该底色到最近角色色的 RGB 欧氏距离 */
  minDistance: number
  /** 最近的那个角色色（`#rrggbb`） */
  nearest: string
  /** `minDistance < BG_MIN_SAFE_DISTANCE` ⇒ 角色配色几乎占满色空间，换谁都危险 */
  safe: boolean
}

/** 候选底色的通道步长：6 档/通道 = 216 个候选，够密，且顺序固定 ⇒ 结果可复现 */
const BG_CANDIDATE_STEP = 51

/**
 * 从角色配色里挑一个「离所有角色色都够远」的底色。
 *
 * 这是 SKILL.md 那条硬约束（「底色必须与角色所有颜色保持明显区别」）的**代码化**：
 * 以前它只是一句写给 Agent 的话，而 Agent 是 LLM——它能描述颜色，但算不出距离。
 * 题目本身是确定性的，就该交给代码。
 *
 * 候选按固定顺序遍历、平手时取更饱和的，所以同一个配色永远得到同一个结果。
 */
export function pickBackgroundColor(characterColors: string[]): BackgroundPick {
  const palette = characterColors
    .map((c) => parseHexColor(c))
    .filter((c): c is RGB => c !== null)
  if (palette.length === 0) {
    throw new Error(
      '需要至少一个合法的角色配色（#rrggbb）才能推底色——' +
        '把角色身上出现过的颜色都列进来，尤其是描边线的颜色',
    )
  }

  let best: { rgb: RGB; minDistance: number; nearest: RGB } | null = null
  for (let r = 0; r <= 255; r += BG_CANDIDATE_STEP) {
    for (let g = 0; g <= 255; g += BG_CANDIDATE_STEP) {
      for (let b = 0; b <= 255; b += BG_CANDIDATE_STEP) {
        const cand: RGB = [r, g, b]
        let minDistance = Number.POSITIVE_INFINITY
        let nearest = palette[0]!
        for (const c of palette) {
          const d = colorDistance(cand, c)
          if (d < minDistance) {
            minDistance = d
            nearest = c
          }
        }
        if (best === null || minDistance > best.minDistance) {
          best = { rgb: cand, minDistance, nearest }
        }
      }
    }
  }

  const pick = best!
  return {
    hex: formatHexColor(pick.rgb),
    minDistance: Math.round(pick.minDistance),
    nearest: formatHexColor(pick.nearest),
    safe: pick.minDistance >= BG_MIN_SAFE_DISTANCE,
  }
}

/** 无参时的默认底色（调用方没给配色时的退路，跟着 `pickBackgroundColor` 一起报 safe=false） */
export function fallbackBackground(): BackgroundPick {
  return { hex: FALLBACK_BG, minDistance: -1, nearest: '', safe: false }
}

const CN_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/** 0–99 的中文数字（提示词里不出现阿拉伯数字，见文件头） */
export function cnNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(n)
  if (n < 10) return CN_DIGIT[n]!
  const tens = Math.floor(n / 10)
  const ones = n % 10
  const head = tens === 1 ? '十' : `${CN_DIGIT[tens]}十`
  return ones === 0 ? head : `${head}${CN_DIGIT[ones]}`
}

/**
 * 一批图的语义。
 *
 * - `motion`：**一段动作**的几个先后瞬间，读序即时间序（`Idle` / `Wave` 这类动作组）
 * - `expression`：**几款表情差分**，每格是同一姿势同一机位、只有某个部位不同
 *
 * 两者不能共用一套说法：动作批要的是「每格是上一格的下一时刻」，
 * 表情批要的恰恰相反——「每格除了那一个部位之外**逐像素一致**」。
 * 早先把表情批也按动作批的模板发出去，那等于让模型去编时间顺序。
 */
export type SheetKind = 'motion' | 'expression'

export interface SheetPromptOptions {
  /** 默认 `motion` */
  kind?: SheetKind
  cols: number
  rows: number
  /** 这一段动作叫什么（如「挥手」）。整张图只表现这一个动作 */
  action: string
  /**
   * 动作的**经过**：一格一格地描述这段动作怎么走（如「抬起 → 左摆 → 回摆 → 落下」）。
   * 仅 `kind: 'motion'` 用。
   */
  motion?: string
  /** 变化的部位名（如「眼睛」「嘴」）。仅 `kind: 'expression'` 用 */
  part?: string
  /** 按读序排列的各格取值（如 `['睁眼','闭眼','笑眼','难过']`）。仅 `kind: 'expression'` 用 */
  variants?: string[]
  /** 角色与动作的文字描述（创作段），由 Agent 自己写 */
  character: string
  /** 底色，建议来自 `pickBackgroundColor()` */
  background: string
}

/**
 * 组装一张出图提示词：技术契约（固定模板）+ 创作段（Agent 写）。
 *
 * 两段分离是 302Sprite 的做法，好处是技术负担集中在一处、可测；
 * 而「不许在创作段提网格/数字」这条规则也才有意义——否则创作段会去抢技术段的活。
 */
export function buildSheetPrompt(o: SheetPromptOptions): string {
  const kind = o.kind ?? 'motion'
  const cols = cnNumber(o.cols)
  const rows = cnNumber(o.rows)
  const total = cnNumber(o.cols * o.rows)
  return [
    'STRICT TECHNICAL REQUIREMENTS FOR THIS IMAGE:',
    '',
    `FORMAT: 一张图，等分为${rows}行${cols}列的方格。每格尺寸完全相同、严格对齐、无间隙、无重叠。`,
    '',
    'FORBIDDEN: 图中任何位置都不得出现文字、数字、字母、标点、编号、标签、水印、签名、',
    'UI 元素、网格线、边框、分隔线。整张图里只有角色本身。',
    '',
    ...(kind === 'motion'
      ? [
          'CONSISTENCY: 所有格子必须是同一只角色。体型、配色、画风、细节程度完全一致。',
          '角色在每格里的位置和大小完全相同——脚踩在同一条水平线上，身体中线对齐格子的竖直中线。',
          '角色完整落在格内，任何部位都不得碰到或越过格子边界。',
        ]
      : [
          'CONSISTENCY: 所有格子必须是同一只角色、**同一个姿势、同一个取景、同一个大小**。',
          `各格之间只有${o.part ?? '面部'}不同，其余每一处（四肢位置、身体轮廓、描边、配色）`,
          '都必须逐像素一致——差别大到能看出是两张不同的画，这一批就废了。',
          '角色在每格里的位置和大小完全相同——脚踩在同一条水平线上，身体中线对齐格子的竖直中线。',
          '角色完整落在格内，任何部位都不得碰到或越过格子边界。',
        ]),
    '',
    'CAMERA: 正视角，角色正面朝向观众，全身可见（头顶到脚底）。',
    '机位固定，不俯视、不仰视、不旋转。',
    '',
    `BACKGROUND: 整张图的背景是纯色 ${o.background}，无渐变、无纹理、无图案、无阴影、无地面、无投影。`,
    '该颜色与角色所有颜色（特别是描边线）保持明显区别。',
    '',
    ...(kind === 'motion'
      ? [
          'MOTION: 格子按阅读顺序（从左到右、从上到下）排列，代表**一段连续动作**的先后瞬间。',
          '每一格是这段动作的一个**关键姿态**。相邻格之间必须有**一眼就能看出**的姿态变化',
          '（肢体位置明显不同），否则连起来播像是没动。',
          '但也不要跳到别的动作上去：全部格子必须能连成同一个动作，最末一格要能无缝接回最初一格。',
          // 这条抄自 hatch-pet 的 row_prompt：他们实测靠它压住「每帧重画一遍」
          '**在格子内部挪动姿势，不要逐格把角色重画得更大或更小**；',
          '同一行里角色的表观大小与脚底基线必须保持不变。',
          `全部${total}格合起来只表现一个动作：${o.action}。`,
          ...(o.motion ? [`这个动作的经过是：${o.motion}`, `把这段经过按时间均分到${total}格里，一格一个瞬间。`] : []),
        ]
      : [
          `FACES: 格子按阅读顺序（从左到右、从上到下）排列，每格是同一只角色的${o.part ?? '面部'}的一种样子。`,
          '这不是动作的先后顺序，而是**并列的几种表情**——身体姿势不要跟着变。',
          ...(o.variants && o.variants.length > 0
            ? [`按顺序依次是：${o.variants.join('、')}。`]
            : []),
          `全部${total}格合起来是同一个角色的${total}种${o.part ?? '面部'}版本，供后续做表情切换用。`,
        ]),
    '',
    'CHARACTER AND ANIMATION DIRECTION:',
    o.character,
  ].join('\n')
}

const ARABIC_DIGIT = /[0-9]/
const TECHNICAL_WORDS = ['网格', '像素', '帧', '格子', '图片生成', '分辨率', '画布']

/**
 * 检查创作段有没有越界。
 *
 * 这两条规则以前只写在 SKILL.md 里「请 Agent 遵守」，而 Agent 是 LLM——
 * 它可能照着写也可能不照。规则是确定性的，就顺手验一遍，把提醒做在出图之前
 * （出一次图要一分钟和一次真金白银，返工代价不对等）。
 *
 * 只报警告不报错：命中了未必真的出问题，但值得让 Agent 自己看一眼。
 */
export function checkCharacterDirection(text: string): string[] {
  const warnings: string[] = []
  if (ARABIC_DIGIT.test(text)) {
    warnings.push('创作段里出现了阿拉伯数字——模型容易把它画成格子编号，改成中文数字或去掉')
  }
  const hit = TECHNICAL_WORDS.filter((w) => text.includes(w))
  if (hit.length > 0) {
    warnings.push(`创作段里提到了技术词（${hit.join('、')}）——这些交给固定模板说，创作段只讲角色与动作`)
  }
  return warnings
}

export interface SheetBatchSpec {
  /** 默认 `motion`。表情/口型差分批要显式写 `expression` */
  kind?: SheetKind
  /** 这段动作叫什么，会进提示词的 MOTION 段，也是文件名的一部分 */
  action: string
  /** 这段动作的经过（见 `SheetPromptOptions.motion`）。`motion` 批强烈建议给 */
  motion?: string
  /** 变化的部位名（如「眼睛」）。`expression` 批用 */
  part?: string
  /** 按读序排列的各格取值（如 `['睁眼','闭眼']`）。`expression` 批用 */
  variants?: string[]
  cols: number
  rows: number
}

export interface SheetPlanBatch extends SheetBatchSpec {
  /** 出图文件名，直接交给 image_generate 的 filename 参数 */
  filename: string
  prompt: string
  warnings: string[]
}

export interface SheetPlanInput {
  /** 角色与画风描述（创作段）。每个批次会各自接上本批次的动作描述 */
  character: string
  /** 角色身上出现过的颜色（含描边），用来推底色 */
  characterColors: string[]
  /** 底色；不给就按 `characterColors` 推 */
  background?: string
  /** 每段动作一个批次。**一批 = 一个动作组**，格 = 这段动作的关键帧 */
  batches: SheetBatchSpec[]
}

export interface SheetPlan {
  background: BackgroundPick
  batches: SheetPlanBatch[]
  /** 汇总的警告（含每个批次的） */
  warnings: string[]
}

/**
 * 由动作清单渲染出整份出图计划：一个动作一批，每批一张 N×M 图集。
 *
 * 这是「一批 = 一个动作组」这条契约的落点（优化计划 §二）：
 * 以前一批里塞四个互不相干的姿势，切出来的帧没法当序列播。
 */
export function buildSheetPlan(input: SheetPlanInput): SheetPlan {
  if (input.batches.length === 0) throw new Error('至少要有一个批次（一段动作）')
  const background = input.background
    ? { ...fallbackBackground(), hex: input.background, minDistance: -1 }
    : pickBackgroundColor(input.characterColors)

  const allWarnings: string[] = []
  if (!background.safe) {
    allWarnings.push(
      `底色 ${background.hex} 离最近的角色色只有 ${background.minDistance}（安全线 ${BG_MIN_SAFE_DISTANCE}）` +
        `——抠底容差会逼近这个距离，有穿过描边漏进角色内部的风险`,
    )
  }

  const batches = input.batches.map((b, i) => {
    if (!Number.isInteger(b.cols) || b.cols < 1 || !Number.isInteger(b.rows) || b.rows < 1) {
      throw new Error(`批次「${b.action}」的网格不合法：${b.cols}×${b.rows}`)
    }
    const prompt = buildSheetPrompt({
      kind: b.kind,
      cols: b.cols,
      rows: b.rows,
      action: b.action,
      motion: b.motion,
      part: b.part,
      variants: b.variants,
      character: input.character,
      background: background.hex,
    })
    // 动作名、经过、各格取值与创作段都会原样进提示词，都得过一遍
    const warnings = [
      ...checkCharacterDirection(b.action),
      ...(b.motion ? checkCharacterDirection(b.motion).map((w) => `动作经过：${w}`) : []),
      ...checkCharacterDirection(input.character),
    ]
    if ((b.kind ?? 'motion') === 'motion') {
      if (!b.motion) {
        warnings.push(
          '这个批次没给 motion（动作经过）——只给动作名的话，模型容易把几格画成互不相干的姿势，' +
            '而格子的读序就是时间序',
        )
      }
    } else {
      if (!b.part) warnings.push('expression 批次没给 part（变化的部位名）——提示词会退化成「面部」')
      const want = b.cols * b.rows
      if (!b.variants || b.variants.length === 0) {
        warnings.push(`expression 批次没给 variants（各格取值）——模型只能自己编 ${want} 种`)
      } else if (b.variants.length !== want) {
        warnings.push(
          `variants 有 ${b.variants.length} 项，与网格 ${b.cols}×${b.rows}（${want} 格）不符`,
        )
      }
    }
    allWarnings.push(...warnings.map((w) => `批次「${b.action}」：${w}`))
    return {
      ...b,
      filename: `pet-sheet-${i + 1}.png`,
      prompt,
      warnings,
    }
  })

  return { background, batches, warnings: allWarnings }
}
