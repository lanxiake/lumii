#!/usr/bin/env node
/**
 * h3-motion.mjs — 用 MiniMax H3（视频模型）给精灵图造运动帧
 *
 * ## 为什么是视频模型
 *
 * 逐帧生图的失败是**实测**过的：`drive-gen.mjs` 那批动作图集，相邻帧有
 * 84~138% 的像素在变——比角色自身的面积还多，说明模型每一格都把角色
 * **重画**了一遍。视频模型不一样：第 N 帧是从前一段的潜空间里长出来的，
 * 时序一致性是架构自带的，不是靠提示词求来的。
 *
 * ## 走 HTTP 而不是 MCP
 *
 * MCP 工具是 agent 会话里的接口，脚本够不着、也进不了 CI。ComfyUI 自己有
 * 标准 HTTP API（/upload/image、/prompt、/history/{id}、/view），直连即可
 * 复用、可批量。地址与 MCP 保持**单一来源**：读 ~/.claude.json 里
 * comfyui-remote 的 COMFYUI_URL。
 *
 * ⚠ ComfyUI 不在本机：它跑在另一台带 4060Ti 的机器上，经 cpolar 隧道暴露
 * （本机 8180/8188 都不通，别去试）。所有请求都过公网，往返 ~0.5s。
 *
 * ## 提示词为什么这么写
 *
 * 精灵图对视频的要求跟「好看的短片」**正好相反**——它要求画面尽量别动：
 * 机位、角色位置、角色大小、背景色都必须逐帧恒定，否则抽出来的帧对不齐、
 * 抠不干净。所以锁的永远是「static locked camera / same position and size /
 * background unchanged」，只把动作留给肢体。
 *
 * 按官方三段式写（integrated_multimodal_description + overall_soundscape +
 * non_diegetic_music）。**H3 没有负面词字段**（negative 走 ConditioningZeroOut），
 * 别往里塞负面提示词。详见 workspace 的《MiniMax-H3视频提示词学习手册.md》。
 *
 * ## 档位与耗时（本机实测）
 *
 *   640×640 / 107 帧 / 20 步 ≈ 10.4 分钟（不含排队）
 *   参考：手册称 0.15MP≈6 分、0.6MP≈45 分、0.9MP≈2 小时
 *
 * **不用 Turbo LoRA**：`minimax_h3_turbo_v4_step600_ema` 挂在这套 int8 量化模型上
 * 时所有键都 `not loaded`（日志刷上百行），LoRA 一点没生效——拿它配 4 步跑，
 * 等于用 4 步跑底模。真要用，先确认日志里没有 `lora key not loaded`。
 *
 * ## 用法
 *
 *   node h3-motion.mjs gen   --char <角色> --action <动作>       # 单条
 *   node h3-motion.mjs batch --jobs "tuanzi:wave,yingtao:idle"   # 整批排队再统一收
 *   node h3-motion.mjs pull  <prompt_id> [--out <目录>]          # 把已完成的帧拉回来
 *   node h3-motion.mjs list                                      # 看队列里有什么
 *
 * `--char` 会从 CHARACTERS 里取身份/风格/底色，并按约定读首帧
 * `staged/<角色>.png`（以及同名的 .json，画布尺寸从那里来）。
 * 角色清单：pixel-cat / tuanzi / yingtao / gangyu。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// 连接：与 MCP 用同一份配置，别抄第二份 URL
// ---------------------------------------------------------------------------
function comfyUrl() {
  if (process.env.COMFYUI_URL) return process.env.COMFYUI_URL.replace(/\/$/, '')
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'))
    const url = cfg?.mcpServers?.['comfyui-remote']?.env?.COMFYUI_URL
    if (url) return url.replace(/\/$/, '')
  } catch {
    /* 配置缺失时退回默认，报错留给第一个请求 */
  }
  return 'https://cfui.cpolar.top'
}
const COMFY = comfyUrl()

const WORKSPACE = path.join(os.homedir(), '.lumii/workspace')
/** 帧的落地根目录。按 token 分子目录，避免两次生成互相覆盖。 */
export const MOTION_DIR = path.join(WORKSPACE, 'outputs/pet-motion')

// ---------------------------------------------------------------------------
// 提示词：精灵图特化的三段式
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 提示词：按 sprite_h3（fmmix/sprite_h3, MIT）的 composer v4 结构组装
// ---------------------------------------------------------------------------
//
// 这套写法的每一条都是实测换来的，别按"读起来更顺"去改：
//
//   · **背景要写「名字 + hex」**——`cyan (#00FFFF)`，不能只给 hex。
//     composer 的注释原话：a hex code alone is weak signal for the model。
//   · **构图要写死**：角色占画面高度的比例、站哪、四周留白。
//     H3 会把首帧的**大小和位置**当成机位标定，不写它就会自己重新构图。
//   · **identity 必须是 view-neutral**：不能出现"facing the camera""front view"
//     这类词——它跟朝向描述打架时，模型会干脆把角色转过去。
//   · **朝向单独一句**，并显式写「不转身」（does not turn），
//     这是堵住模型最省事的逃逸路径。
//   · **运动分三类**，每类配一句不同的锁定句（见 MOTION_CLASS）。
//     给"原地挥手"配上"可以上下移动"的锁定句，模型就会真的让它飘起来。
//   · **必须显式要求无声**：H3 是音视频联合模型，不写它会自己配环境音。

const STYLE = 'flat-vector cartoon pet sprite'

/**
 * 背景色 → 「颜色名 + hex」。
 *
 * 提示词里必须写成 `cyan (#00FFFF)` 这种形式：composer 的源码注释写着
 * *a hex code alone is weak signal for the model*。
 * 名字取最近的一个候选色，离得太远（>96）就退回 `solid #RRGGBB`——
 * 硬安一个不相干的名字比不给名字更糟。
 */
const COLOR_NAMES = [
  ['magenta', [255, 0, 255]], ['hot pink', [255, 0, 128]], ['red', [255, 0, 0]],
  ['orange', [255, 128, 0]], ['yellow', [255, 255, 0]], ['lime green', [128, 255, 0]],
  ['green', [0, 255, 0]], ['spring green', [0, 255, 128]], ['cyan', [0, 255, 255]],
  ['azure blue', [0, 128, 255]], ['blue', [0, 0, 255]], ['violet', [128, 0, 255]],
  ['white', [255, 255, 255]], ['black', [0, 0, 0]], ['grey', [128, 128, 128]],
]
const NEUTRAL_MAX_CHROMA = 48
const COLOR_NAME_MAX_DISTANCE = 96

export function backgroundWords(hex) {
  const h = hex.replace('#', '').toUpperCase()
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  const neutral = Math.max(...rgb) - Math.min(...rgb) < NEUTRAL_MAX_CHROMA
  let best = null
  let bestD = Infinity
  for (const [name, c] of COLOR_NAMES) {
    if ((Math.max(...c) - Math.min(...c) < NEUTRAL_MAX_CHROMA) !== neutral) continue
    const d = Math.hypot(c[0] - rgb[0], c[1] - rgb[1], c[2] - rgb[2])
    if (d < bestD) {
      bestD = d
      best = name
    }
  }
  return bestD > COLOR_NAME_MAX_DISTANCE ? `solid #${h}` : `${best} (#${h})`
}

/** `#00FFFF` → `[0, 255, 255]` */
export function hexToRgb(hex) {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
}

/** 默认背景。跟 stage-frame.mjs 的 --bg 必须是同一个值。 */
const BACKGROUND = { hex: '#00FFFF', words: backgroundWords('#00FFFF') }

/** 角色描述（view-neutral）。抽出来是为了复用给别的宠物时只改这一处。 */
const DEFAULT_IDENTITY =
  'a chubby cartoon cat with a round head and a big round body. The fur is flat orange with a white muzzle, ' +
  'a white chest and white paws, drawn with thick rounded dark-brown outlines. It has two large round black eyes, ' +
  'a small pink nose, and pink inner ears; the tail is short and orange with a white tip. ' +
  'Flat vector look with solid fills, no shading and no gradients.'

const _FIRST_FRAME =
  'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.'

/**
 * FL2VA 的头部：把两张参考图各自钉到一个时间点上。
 *
 * 精灵图的循环靠**条件**保证，不靠请求。I2VA 下"请回到起始姿势"只是提示词里
 * 的一句话，模型可以不理（实测樱桃那条：末尾手臂一直举着，首末包围盒
 * `162,134→317,740` vs `87,134→415,743`，根本对不上）。FL2VA 把**同一张图**
 * 同时当首帧和尾帧，闭合就成了采样的约束。
 */
const _FIRST_LAST_FRAME = (seconds) =>
  'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the ' +
  `0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the ${seconds.toFixed(2)}-second mark of the target video.`
const _POSITION_STANDING =
  'standing in the middle of the frame with clear empty space above the head and below the feet'
/** 位移类动作（跳）用这个：角色压低，给顶点留出上面的空间 */
const _POSITION_LOW = 'standing in the lower half of the frame with plenty of empty space above the head'

const _FACING_DOWN =
  'The character keeps exactly the orientation shown in <Picture 1> for the whole shot: ' +
  'facing the camera, face fully visible; the character does not turn.'

/**
 * 「身体朝镜头、**只有头**可以转」——**只给"张望 / 看过来"这一条用**。
 *
 * `_FACING_DOWN` 的结尾是「the character does not turn」，而"转头看"这个动作
 * 本身就是在转：直接拿那句配"看"的提示词是**自相矛盾**，模型会在"转头"和"不许转"
 * 之间摇摆——和 `turn` 当初被逼出来的理由一模一样，不新开一句就得不出干净的姿势。
 *
 * ⚠ 只放开**头**，明确锁住**身体**。这不是"允许转身"的松口子：身体一转，
 * 「素材默认朝右」那条硬约定就破了（`PetWanderDriver.applyFacing` 的翻转逻辑据此写死）。
 */
const _FACING_DOWN_HEAD =
  'The character keeps exactly the orientation shown in <Picture 1> for the whole shot: ' +
  'its body, shoulders, arms and feet stay facing the camera and never turn or rotate. ' +
  'Only its head and ears may turn to the left and to the right; the body never follows the head.'

/**
 * 朝向句必须**逐个动作**挑，不能一套通用。
 *
 * 原文只有"面朝镜头、脸完全可见、不许转身"那一句。走动/攀爬/爬行用的是侧身素材
 * （Shimeji 参考素材每一行都是侧身，实测镜像不对称度 34~60%，连 stand/sit 都是），
 * 拿正面那句去配侧身首帧 = 提示词跟画面直接矛盾，模型只能二选一。
 *
 * **朝右**是硬约定，不是随便挑的：渲染器的翻转逻辑写死「素材面朝右，
 * 故 facing=-1 时才翻转」（`PetWanderDriver.applyFacing`）。出成朝左，
 * 宠物往左走时会被翻成朝右——正好反了。
 */
const _FACING_SIDE =
  'The character keeps exactly the orientation shown in <Picture 1> for the whole shot: ' +
  'seen from its right side in full profile, with its head, muzzle and body all pointing to the right ' +
  'of the frame; one eye and the side of the muzzle are visible, the far side of the body is hidden. ' +
  'The character does not turn, does not face the camera, and never rotates.'

/** 贴墙（攀爬）：侧身、身体竖起来对着墙 */
const _FACING_CLING =
  'The character keeps exactly the orientation shown in <Picture 1> for the whole shot: ' +
  'seen from its right side in full profile, its body held upright and vertical, its front paws and hind paws ' +
  'all gripping and pressed against an invisible vertical surface on the right of the frame; ' +
  'one eye and the side of the muzzle are visible. ' +
  'The character does not turn, does not face the camera, and never rotates or changes its body angle.'

/** 三类运动的锁定句。选错类别 = 模型照着错误的那句去动。 */
const MOTION_CLASS = {
  static: 'The feet stay planted at exactly the same spot for the whole shot; the character does not step, turn, or leave the ground.',
  locomotion:
    'The character moves in place: the legs and arms cycle, but the figure stays at the same spot in the frame, ' +
    'the head stays at the same height, and the figure keeps the same size — never closer to or further from the camera, never drifting sideways.',
  displacement:
    'The whole figure may rise, drop, or crouch within the frame, but it keeps the same size and the same drawn ' +
    'proportions throughout and never leaves the frame.',
  /**
   * 转身专用。**必须单独一条**：`static` 明确写了 "does not step, turn"，
   * 拿它配"转过去"的提示词 = 自相矛盾，模型会在转身与不动之间摇摆。
   * 只给姿势图那几轮用（`POSES`），循环动作不用。
   */
  turn:
    'The character may pivot on the spot and change which way it is facing during the shot, but it stays on the ' +
    'same spot on the ground, keeps the same size and the same distance from the camera, and never leaves the frame.',
  /**
   * 悬空原地专用——**下落这类"整个人离地"的循环动作**。
   *
   * 前三类都不能用，各错一半：
   * · **`static` 写着 "The feet stay planted … does not leave the ground"**，
   *   配"被击飞/在空中"的提示词是自相矛盾，模型在"离地"和"脚钉在地上"之间摇摆。
   *   （和 `turn` 当初被逼出来的理由一模一样。）
   * · **`displacement` 写着 "The whole figure may rise, drop, or crouch within the
   *   frame"**——实测模型**照做**：下落循环里角色一路升出格线，闸门报
   *   「S1 第 3、4 格越出格线，边界带 7.46%」，**头顶的信息直接丢了**。
   * · `locomotion` 的效果对（三个侧身循环都稳稳待在原地），但它的措辞是
   *   "the legs and arms cycle"（在跑），配"下落"是换了副骨头。
   *
   * ⚠ 下面这句的"不许动"部分是**逐字抄 `locomotion` 的**，不是自己另写一句更强的
   * 否定——实测差别很大：第一版 `suspended` 写的是 "it does not rise, drop, or drift
   * sideways"（更直白的否定），换上新句子重出，角色**照旧**升出格线；而 `locomotion`
   * 那句措辞在三个侧身循环上**实测都稳住了**。所以用被验证过的那句，
   * 只把"腿在蹬"换成"四肢扑腾"。
   *
   * 精灵图里**位移是引擎的事**，帧里只有悬空的姿势加小幅摆动。
   */
  suspended:
    'The figure stays at the same spot in the frame, the head stays at the same height, and the figure keeps the ' +
    'same size — never closer to or further from the camera, never rising or dropping, never drifting sideways, ' +
    'and it never leaves the frame. The limbs, ears and tail flail and wobble in the air, but the body itself does ' +
    'not change position.',
}

const _CLOSED = 'The shot ends in exactly the same pose it started in so the clip can loop.'
/** FL2VA 版：闭合点锚到 Picture 2（就是同一张 staged 图） */
const _CLOSED_LAST =
  'The shot ends as the character settles into exactly the pose, size, and composition of Picture 2 so the clip can loop.'
/**
 * 尾帧自由（`freeEnd` / I2VA）版。
 *
 * **不能沿用上面两句**：那两句都要求末帧回到首帧，而这一轮根本没接 `last_frame`，
 * 而且它存在的意义就是让末帧**不一样**（角色要转过去）。照抄会让模型在
 * "转过去"和"转回来"之间摇摆——姿势图取出来的帧就废了。
 */
const _CLOSED_FREE =
  'The shot ends in whatever pose the character has settled into by the end; the character does not return to its ' +
  'starting pose, and the last frame of the shot shows that settled pose held steady.'

/**
 * 每个动作的 **motion prose**：一段连续的话，只写动作本身。
 * 里面不能出现 I2VA 的结构标记（<Picture>/[Shot]/三段式字段名）——
 * 那些由 composer 拼，混进来会跟外层结构打架。
 *
 * 时间点写占位符 `{deadline}`，由 buildPrompt 填 MOTION_DEADLINE ——
 * 帧数一改，动作的完成时刻就得跟着改，两处分别硬编码迟早会对不上。
 */
const ACTIONS = {
  idle: {
    label: '待机呼吸',
    motionClass: 'static',
    motion:
      'The character breathes gently in place. The chest rises and falls in one slow soft breath, the head dips down ' +
      'a touch on the exhale, and the character blinks once near the middle of the shot; everything returns to the ' +
      'exact starting pose by {deadline} seconds while all four paws stay planted and the body stays in place. ' +
      'The tail sways only a little and settles back to its initial shape and position.',
  },
  wave: {
    label: '挥手',
    motionClass: 'static',
    motion:
      'The character performs one friendly wave with one front hand. The hand lifts smoothly up beside its head, ' +
      'completes one compact side-to-side wave, and comes back down to the exact starting pose by {deadline} seconds ' +
      'while both feet stay planted on the ground and the body stays in place. The head tilts slightly ' +
      'to one side during the wave and returns; the tail sways only a little and settles back to its initial ' +
      'shape and position.',
  },
  hop: {
    label: '原地跳',
    motionClass: 'displacement',
    // 头顶会不会出框，取决于**基线**而不是比例。
    //
    // 曾经想用 `--ratio 0.62` 给跳跃留空间，那是错的：pet-asset 的 normalize
    // 按「帧尺寸相同的组」共用一个倍率（`align.ts` computeNormalize，
    // `scale = canvas.h * fit / 组内最高的包围盒`），所以压低比例只会让这一组
    // **整体变小**——实测跳起来会比别的动作小 11%，切动作时一眼看得出。
    //
    // 把角色在画面里**下移**（baseline 0.856 → 0.95）不改变它的像素高度，
    // 头顶余量却从 104px 涨到 168px（576×672 画布、ratio 0.70）。
    stage: { baseline: 0.95 },
    motion:
      'The character gathers itself and hops straight up once, in place. It crouches down a little, springs up only ' +
      'slightly — the top of its head rises by barely a tenth of the frame height, and a wide empty margin stays above ' +
      'its head the whole time so the head never comes near the top edge of the frame — lands back on the same ground ' +
      'line and squashes slightly on impact, then straightens and settles into the exact starting pose by {deadline} ' +
      'seconds. The body rises and drops within the frame but keeps the same size and proportions throughout; the tail ' +
      'follows the motion and returns to its initial shape and position.',
  },
  // ---- 以下五个补客户端「九个动作」里缺的：客户端 gen-demo-pets.mjs 的清单是
  // Idle / Talk / Jump / Wave / Nod / Shake / Picked / Land / PlayBall ----
  nod: {
    label: '点头',
    motionClass: 'static',
    motion:
      'The character gives one clear nod. The head dips down smoothly and comes back up in a single calm motion, ' +
      'returning to the exact starting pose by {deadline} seconds while the body, arms and feet stay completely still. ' +
      'The eyes stay open and the tail stays still.',
  },
  shake: {
    label: '摇头',
    motionClass: 'static',
    motion:
      'The character shakes its head once from side to side: the head turns to one side, then to the other, then comes ' +
      'back to face the camera, settling into the exact starting pose by {deadline} seconds while the body, arms and ' +
      'feet stay completely still. The tail stays still.',
  },
  picked: {
    label: '被拎起',
    motionClass: 'displacement',
    motion:
      'The character is lifted up and held in the air, dangling with its limbs hanging loosely and its body swaying ' +
      'gently from side to side. It stays at the same height and the same size the whole time, never spinning or ' +
      'turning, and settles back into the exact same dangling pose it started in by {deadline} seconds so the clip ' +
      'can loop. The tail hangs straight down.',
  },
  land: {
    label: '落地',
    motionClass: 'displacement',
    motion:
      'The character drops in from above and lands. It falls a short distance in one quick motion, hits the ground, ' +
      'squashes down slightly on impact with its limbs splayed, then straightens up and settles into the exact ' +
      'starting pose by {deadline} seconds. It keeps the same size throughout and never leaves the frame.',
  },
  playball: {
    label: '玩球',
    motionClass: 'static',
    // 两处修正，都是被闸门拦下来之后定位到的：
    //
    // 1. **球的颜色必须写死**。上次 H3 自己挑了个浅蓝球，离底色 #00CCFF 只有 99
    //    （S8 的安全线是 150）——抠底容差会逼近这个距离，有穿过描边漏进角色内部的
    //    风险。写成 bright red 之后，红球到底色的距离约 414，离角色的橙/奶油/深棕
    //    调色板也都在 250 以上。
    // 2. **不能写「最后滚出画面」**。FL2VA 把同一张图同时当首帧和尾帧，末帧必须
    //    等于首帧——而首帧里球在角色跟前。原来的 prose 让球滚出去，等于让模型
    //    同时满足两个矛盾的要求，实测那批有 2 格 S1 越界。
    motion:
      'The character plays with one small bright red ball. It pats the ball with one front hand, the ball bounces a ' +
      'little in front of it, and the character follows the bounce with its head, then pats it once more and settles ' +
      'back into the exact starting pose by {deadline} seconds. The ball stays bright red, stays small, and stays on ' +
      'the ground in front of the character the whole time — it never leaves the frame and returns to exactly where ' +
      'it started. The body and feet stay in place.',
  },
  // ---- 下面两个补「自主行为」那套九组：客户端 gen-demo-pets.mjs 那套是交互动作，
  // 而走动/攀爬要的是 shimeji 那套 Idle/Walk/Sit/Talk/Fall/Picked/Jump/Climb/Crawl。
  // 缺组的后果**不是报错而是静默回落到基础待机**（PetOrchestrator.resolveAmbientGroup），
  // 于是宠物一边平移一边播待机呼吸，看起来像在滑行。 ----
  walk: {
    label: '走路',
    facing: 'side',
    pose: 'side',
    motionClass: 'locomotion',
    motion:
      'The character walks in place at a steady even pace, seen from the side: the two front legs and the two hind ' +
      'legs alternate in a clear diagonal four-legged stepping cycle, the body bobs up and down a little once per ' +
      'step, and the head stays level, while the figure stays at the same spot in the frame and stays in the same ' +
      'profile. It completes a whole number of steps and settles back into the exact starting pose by {deadline} ' +
      'seconds so the clip can loop. The tail sways a little with the rhythm and returns to its initial position.',
  },
  fall: {
    label: '下落',
    facing: 'side',
    pose: 'falling',
    // ⚠ **不是 `displacement`**：那句写着"整个人可以在画面里升起/落下/蹲下"，
    // 实测模型照做，角色一路升出格线、头顶被裁。精灵图里位移归引擎，帧里只留姿势。
    motionClass: 'suspended',
    motion:
      'The character is suspended in mid-air in a falling pose: its limbs are spread and splayed, its ears and tail ' +
      'are lifted upward as if by an airstream, and its body tilts very slightly from side to side without moving ' +
      'from the spot. It holds that pose at exactly the same height for the whole shot, never turns or spins, and ' +
      'settles back into the exact same pose it started in by {deadline} seconds so the clip can loop.',
  },
  // climb / crawl / walk 是**侧身**（`facing: 'side'|'cling'`），首帧也不是站立立绘
  // 而是各自姿势图（`pose`）。原因见 `_FACING_SIDE` 的说明——Shimeji 参考素材
  // 整行都是侧身，正面素材放进去"看起来很违和"（用户原话）。
  //
  // ⚠ 那两张姿势图**必须先单独生成**：管线只有正面立绘，而 FL2VA 把同一张图钉死在
  // 首尾两端，用正面图生成"转身侧身"会被末帧拉回来。姿势图走 `freeEnd`（I2VA）出，
  // 取中间帧 → 用 stage-frame.mjs 摆正 → 再拿它跑下面这三个循环。
  climb: {
    label: '攀爬',
    facing: 'cling',
    pose: 'cling',
    motionClass: 'locomotion',
    motion:
      'The character climbs upward in place, hand over hand: it reaches up with one front paw and grips the surface, ' +
      'pulls its body up a little, then the other front paw reaches up to take the next hold, and the hind legs step ' +
      'up in the same alternating rhythm, while the figure stays at the same spot in the frame and keeps its body ' +
      'vertical in the same profile. It completes a whole number of pulls and settles back into the exact starting ' +
      'pose by {deadline} seconds so the clip can loop. The tail sways a little with the rhythm and returns to its ' +
      'initial position.',
  },
  crawl: {
    label: '爬行',
    facing: 'side',
    pose: 'creep',
    motionClass: 'locomotion',
    motion:
      'The character creeps forward in place along a flat surface, seen from the side: the two front paws and the ' +
      'two hind legs alternate in a low four-legged stepping cycle, the body stays low and flat and close to the ' +
      'surface and the head stays at the same height, while the figure stays at the same spot in the frame and stays ' +
      'in the same profile. It completes a whole number of steps and settles back into the exact starting pose by ' +
      '{deadline} seconds so the clip can loop. The tail sways a little with the rhythm and returns to its initial ' +
      'position.',
  },
  /**
   * 坐下（**正面**）。
   *
   * 视角判据不是猜的：参考素材 `demo_shimeji_*` 的五套模型里 `Sit` 都是**正面**
   * 坐着的猫（`kind: loop`、**1 帧**）。这也和"只有走动/攀爬/爬行做侧身"的选择
   * 一致——坐下不是位移，没必要侧身。
   *
   * `static` 在这里是**对的**（不像下落）：那句 "the feet stay planted … does not
   * leave the ground" 对一只坐着的猫完全成立。
   */
  sit: {
    label: '坐下',
    pose: 'sitting',
    motionClass: 'static',
    motion:
      'The character stays sitting on its haunches facing the camera: it breathes steadily, its head bobs very ' +
      'slightly, its ears twitch once or twice and its tail tip flicks. It does not stand up, lie down, or move ' +
      'from the spot, and settles back into the exact same sitting pose it started in by {deadline} seconds so the ' +
      'clip can loop.',
  },

  // ---- 2026-09-24：设计 §8.6.2 的「需新素材」三条 + 互动/情绪反应的可见形态 ----
  //
  // 这八条**全部正面**：它们都是原地表达（打哈欠、伸懒腰、挠头、躲开、呼噜、雀跃、蔫、张望），
  // 不是位移，没有侧身的理由——和 `sit` 同理（只有走动/攀爬/爬行/下落做侧身）。
  //
  // 触发条件见 `2026-09-23-宠物智能化实施计划.md` 第二期：打哈欠 ← `idleStage === 'drowsy'`、
  // 伸懒腰 ← 从 asleep 醒来、挠头 ← `AgentActivity === 'blocked'`、
  // 躲开 ← 低 agreeableness + 低 valence 的互动请求、呼噜 ← 长按摸头、
  // 雀跃/蔫 ← §7.3 的目标完成/失败、张望 ← 鼠标靠近。
  //
  // ⚠ **一律 `static`（只有雀跃例外）**，理由与 `fall` 当初被从 `displacement` 改走同源：
  // `displacement` 那句写着"整个人可以在画面里升起/落下/蹲下"，模型**真的会照做**，
  // 于是角色顶出格线、S1 判死。精灵图里位移归引擎，帧里只留姿势。
  // 唯一要跳起来的是 `cheer`，它走的是**已经验证过的**那条路——见 `ACTIONS.cheer.stage`。

  /**
   * 打哈欠（设计 §8.6.2）。触发：`idleStage === 'drowsy'`。
   *
   * 眼睛要**同时眯上**：只张嘴不眯眼的哈欠在 8 帧里有 4 帧看不出在干嘛，
   * 而"眼一闭、嘴一张、头一仰"三件事叠起来，任何一帧都认得出。
   */
  yawn: {
    label: '打哈欠',
    motionClass: 'static',
    motion:
      'The character yawns once, slowly and sleepily. Its mouth opens wide into one long yawn while both eyes squeeze ' +
      'shut, its head tips back and up a little, its chest swells with a deep intake of breath and its ears fall back ' +
      'slightly; then the mouth closes, the eyes open again and it settles back into the exact starting pose by ' +
      '{deadline} seconds. Its body, arms and feet stay completely still and it does not step or leave the ground.',
  },

  /**
   * 伸懒腰（设计 §8.6.2 / §8.6.3「醒来先 stretch 再进入 stand」）。
   *
   * 刻意**不写"整个身子趴下去"**：那是姿态变化，`static` 锁的是"脚不许离开原地"，
   * 身子大幅下压跟它不冲突，但整只猫蹲下去会让包围盒高度骤变——归一化按组内最高算，
   * 矮帧不会被补高（这是刻意的），于是循环里看起来像缩了一下。
   * 所以做成"前爪前伸 + 背拱起 + 头低下"，四只脚都留在原地。
   */
  stretch: {
    label: '伸懒腰',
    motionClass: 'static',
    motion:
      'The character stretches lazily after waking up. It slides both front paws forward along the ground, dips its ' +
      'chest and head down low between its shoulders and arches its back, stretching its body out long; it holds the ' +
      'stretch for a moment, then pulls its front paws back in and rises, settling into the exact starting pose by ' +
      '{deadline} seconds. All four feet stay planted on the same spot, it never leaves the ground, and its ears and ' +
      'tail only move a little.',
  },

  /**
   * 挠头（设计 §8.6.2）。触发：`AgentActivity === 'blocked'` 或心情差。
   *
   * ⚠ 举起的爪子**不能高过头顶**：首帧头顶的余量就是 staging 留的那些，
   * 爪子越过头顶 = S1 越出格线，而**头顶出了框是信息已经丢了**，后期救不回来。
   * 所以写死"贴着头的侧面、不高于头顶"。
   */
  scratch: {
    label: '挠头',
    motionClass: 'static',
    motion:
      'The character raises one front paw up to the side of its own head and scratches there twice with two short ' +
      'quick strokes, tilting its head slightly toward the paw and squinting one eye; then it lowers the paw and ' +
      'settles back into the exact starting pose by {deadline} seconds. The paw stays pressed against the side of ' +
      'its head and never rises above the top of its head. Its body, hind legs and feet stay completely still and it ' +
      'does not step or leave the ground.',
  },

  /**
   * 躲开（设计 §4.4「会拒绝」的可见形态）。
   *
   * 刻意**不做"扭过脸"**：那需要一个允许转身的朝向句，而转身会碰到
   * 「素材默认朝右」那条硬约定（见 `_FACING_DOWN_HEAD` 的说明）。文档给的三个表现
   * 是「躲开、扭过脸、不动」——**取第一个就够了**，而且它是三者里最好认的。
   *
   * 缩一下、耳朵压平、眼睛闭上、头低下去：这一组在**静止的画面上**就能读出"不想理你"，
   * 不依赖前后帧的对比。做成 `once`（而不是长循环），拒绝完就自然回到待机。
   */
  dodge: {
    label: '躲开',
    motionClass: 'static',
    motion:
      'The character flinches away from the viewer. It ducks down and leans its whole body away to one side, pulls ' +
      'its head back and down between its shoulders, flattens both ears back against its head, squeezes both eyes ' +
      'shut, and then carefully straightens up and settles back into the exact starting pose by {deadline} seconds. ' +
      'Its feet stay planted on the same spot the whole time, it keeps the same size, and it never turns away or ' +
      'leaves the ground.',
  },

  /**
   * 呼噜 / 被摸头（设计 §8.3.1 长按摸头，计划 T2.4）。
   *
   * **loop**，而且首帧是**闭着眼的姿势图**（`pose: 'purring'`）——理由写在 `POSES.purring` 上：
   * FL2VA 把首帧钉在循环的首尾两端，拿睁眼的立绘当首帧的话，每一圈都会睁一次眼。
   */
  purr: {
    label: '呼噜',
    pose: 'purring',
    motionClass: 'static',
    motion:
      'The character stays settled with its eyes closed, enjoying being petted. It breathes slowly and deeply, its ' +
      'head pressing up very slightly as if leaning into an invisible hand, its tail tip swaying slowly from side to ' +
      'side and its whiskers twitching once. It keeps its eyes closed the whole time and settles back into the exact ' +
      'same pose it started in by {deadline} seconds so the clip can loop.',
  },

  /**
   * 雀跃（设计 §7.3「目标完成 → valence ↑、arousal ↑」）。
   *
   * **唯一一条走 `displacement` 的**（其余七条都是 `static`），因为它要真的跳一下。
   * 走的是 `hop` 已经验证过的那条路：`hop` 用 `stage.baseline 0.95` 把角色在画面里
   * 下移、给头顶留出 168px，才敢让 `displacement` 放开"可以在画面里升起"。
   * `stage.from: 'hop'` 直接复用那张压低版首帧——**同一张图，不重出一份**。
   *
   * "barely a tenth of the frame height" 是抄 `hop` 的原话：措辞更狠会让模型跳得更高，
   * 而 168px 的余量只够这么多。
   */
  cheer: {
    label: '雀跃',
    stage: { from: 'hop' },
    motionClass: 'displacement',
    motion:
      'The character celebrates: it gathers itself, hops straight up once with both front paws raised high and ' +
      'waving, ears perked and tail wagging fast, lands back on the same ground line, bounces once more only ' +
      'slightly, then settles into the exact starting pose by {deadline} seconds. The top of its head rises by ' +
      'barely a tenth of the frame height and a wide empty margin stays above its head the whole time, so the head ' +
      'never comes near the top edge of the frame. The body keeps the same size and proportions throughout.',
  },

  /**
   * 蔫（设计 §7.3「目标失败 → valence ↓」、§4.1.3 共情）。
   *
   * 做成 `once` 的一次"泄气"，不是待机状态的常驻变化——文档 §3.4 明确要求
   * **情绪要真的改变举止**（那是 `ambient` / `procedural` 参数的事，第二期做），
   * 这里只补**看得见的那一下**：从挺着到塌下去。
   */
  droop: {
    label: '蔫',
    motionClass: 'static',
    motion:
      'The character deflates. Its head and both ears droop down, its whole body sags a little lower, its shoulders ' +
      'slump and its tail drops to the ground; it lets out one slow heavy sigh, its chest sinking as it breathes out, ' +
      'then it slowly picks itself back up and settles into the exact starting pose by {deadline} seconds. Its feet ' +
      'stay planted on the same spot, it never lies down or leaves the ground, and its eyes stay open but half-lidded.',
  },

  /**
   * 张望（设计 §8.3.1「鼠标靠近 → 转头看鼠标」，第三期）。
   *
   * 用 `front-head` 朝向句——**这一条存在的全部理由**就是它允许"头转、身体不转"，
   * 见 `_FACING_DOWN_HEAD` 的说明。prose 里再显式说一遍"只有头在动"，
   * 两处一起堵住"整个身子跟着转过去"这条最省事的逃逸路径。
   */
  look: {
    label: '张望',
    facing: 'front-head',
    motionClass: 'static',
    motion:
      'The character looks around. Only its head turns: it turns its head and ears to one side to look, holds there ' +
      'for a moment, then turns to the other side to look, and finally turns back to face the camera, settling into ' +
      'the exact starting pose by {deadline} seconds. Its body, shoulders and feet stay completely still the whole ' +
      'time and its body never turns with its head.',
  },
}

/** 姿势图用的朝向句：允许在片子里换姿势，换完就稳住 */
const _FACING_POSE =
  'The character begins the shot in exactly the orientation shown in <Picture 1>. It changes its pose during the ' +
  'shot as described below; once it has settled into the new pose it holds that pose steadily for the rest of the ' +
  'shot, without turning back toward the camera and without changing its body angle again.'

/** 从正面转侧身那一次专门的朝向句：这是**唯一**允许转身的一轮 */
const _FACING_TURN_SIDE =
  'The character begins the shot in exactly the orientation shown in <Picture 1> — facing the camera — and then ' +
  'turns on the spot during the shot. The turn is one smooth continuous pivot to the character\'s own right; once ' +
  'the turn is complete the character holds its new orientation and does not turn back.'

/**
 * 姿势图 —— **只用来给循环动作当首帧**，本身不进客户端。
 *
 * 为什么非得有这一档：管线的立绘是**正面**的，而走动/攀爬/爬行/下落要侧身；
 * 更要命的是 FL2VA 把同一张图钉死在首尾两端，**用正面立绘直接生成侧身循环，
 * 末帧会被强制拉回正面**——循环里就会出现"转过去→被拉回来"的来回鬼畜。
 *
 * 所以先跑一轮 `--free-end`（I2VA，不接 last_frame，末帧自由）让角色转过去 /
 * 换姿势，取中间某一帧跑 stage-frame.mjs 摆正，再拿它去跑真正的循环。
 *
 * 一张姿势图**多个动作共用**（见 `ACTIONS[x].pose`）：walk 和 crawl 都用 `side`，
 * 起始体型才一致；各跑各的会让两只猫一样大。
 *
 * `from` 指明拿哪张 staged 当首帧：`side` 从正面立绘转过去，`cling`/`fall`
 * 从已经侧身的 `side` 出发（那两张不用再转身，只是换姿势）。
 */
const POSES = {
  side: {
    label: '侧身站立',
    from: '',
    facing: 'turn-side',
    motionClass: 'turn',
    motion:
      'The character turns on the spot until it is standing in full profile, seen from its right side, with its head, ' +
      'muzzle and body all pointing to the right of the frame. It settles into that side-on stance and holds it for ' +
      'the rest of the shot, only shifting its weight slightly, and it does not turn back toward the camera.',
  },
  cling: {
    label: '侧身贴墙',
    from: 'side',
    facing: 'pose',
    motionClass: 'displacement',
    motion:
      'The character rears up and presses itself against an invisible vertical surface on the right of the frame: it ' +
      'rises onto its hind legs, its body goes upright and vertical, and all four paws grip that surface, with the ' +
      'front paws reaching high and the hind paws low. It holds that clinging stance for the rest of the shot, only ' +
      'shifting its grip slightly, and it does not slide down, let go, or turn.',
  },
  /**
   * 爬行用的低伏姿势。
   *
   * **不能拿站立那张当爬行的首帧**：抽帧是沿整段均匀取的、**含第 0 帧**，
   * 而首帧就是输入图——循环每转一圈都会在格 0 闪一下站姿。
   * 攀爬（cling）和下落（falling）各自的首帧本来就是那个姿势，只有爬行不是。
   */
  creep: {
    label: '侧身低伏',
    from: 'side',
    facing: 'pose',
    motionClass: 'displacement',
    motion:
      'The character lowers itself onto its belly: it folds its legs underneath its body and sinks down until it is ' +
      'lying low and flat in full profile, its head up and level and its body close to the ground. It holds that low ' +
      'creeping stance for the rest of the shot, only shifting slightly, and it does not stand back up or roll over.',
  },
  /**
   * ⚠ 键名**不能与 `ACTIONS` 重名**：`buildPrompt` 是 `ACTIONS[key] ?? POSES[key]`，
   * 先查 ACTIONS——重名会被**静默遮蔽**，姿势图那一轮就会拿到循环动作的 prose
   * （"末帧回到起始姿势以便循环"），跟 I2VA 尾帧自由直接矛盾。
   * 这个坑踩过一次：原本叫 `fall`，正撞上 `ACTIONS.fall`。下面有断言兜底。
   */
  falling: {
    label: '侧身下落',
    from: 'side',
    facing: 'pose',
    motionClass: 'displacement',
    motion:
      'The character is knocked off its feet and falls: it drops away from the ground in one quick motion, its limbs ' +
      'spread out and splay, its ears and tail lift upward, and it wobbles slightly as it falls. It keeps the same ' +
      'size and the same distance from the camera the whole time, and it does not land or touch the ground.',
  },
  /**
   * 正面坐姿。
   *
   * ⚠ `from: ''` = **从正面立绘出发**，不走转身那一段：坐下是**姿态变化**，
   * 不是换视角。和 `side` 一样从 `tuanzi.png` 出发，但朝向句用 `front`
   * （保持面向镜头）而不是 `turn-side`。
   *
   * `displacement` 在这里是对的：句子里的 "may rise, drop, or crouch within the
   * frame" 正好覆盖"压低身子坐下来"。循环动作那边则相反——那里必须用
   * `static`，绝不能让画面内的位移发生（见 ACTIONS.sit）。
   */
  sitting: {
    label: '正面坐姿',
    from: '',
    facing: 'front',
    motionClass: 'displacement',
    motion:
      'The character sits down: it lowers its hindquarters to the ground and settles back onto its haunches, its ' +
      'front legs straight and upright, its tail curled around beside it, its head up and still facing the camera. ' +
      'It holds that sitting pose for the rest of the shot, only breathing, and it does not stand back up or lie down.',
  },
  /**
   * 被摸头的姿势（**正面、眼睛闭着**）。2026-09-24 加，给 `ACTIONS.purr` 当首帧。
   *
   * 为什么非得单独出一张：`purr` 是**循环**，而 FL2VA 把同一张图钉死在首尾两端，
   * 所以循环每一圈都会回到首帧的姿势。首帧要是那张睁眼的站立立绘，循环就成了
   * "闭眼 → 睁眼 → 闭眼"——那是眨眼，不是"被摸得舒服得一直眯着眼"。
   * 长按摸头是**持续状态**（文档 U3 要求"有持续回应，松开恢复"），整段都得闭着眼。
   *
   * `from: ''` = 从正面立绘出发（不换视角，只换姿态），朝向句用 `front`。
   * `displacement` 和 `sitting` 同理：那句 "may rise, drop, or crouch within the frame"
   * 正好覆盖"身子压低伏下来"。
   */
  purring: {
    label: '正面闭眼伏下',
    from: '',
    facing: 'front',
    motionClass: 'displacement',
    motion:
      'The character settles down contentedly, as if a hand were resting on the top of its head: it lowers its head ' +
      'and its whole body a little, closes both eyes into happy curved slits, tips its ears back slightly and curls ' +
      'its tail around beside it. It holds that relaxed pose for the rest of the shot, only breathing, and it does ' +
      'not stand back up, open its eyes, or move from the spot.',
  },
}

// 姿势图与循环动作重名 = 静默遮蔽（见 POSES 的说明）。宁可起不来，也不要悄悄跑错提示词。
for (const k of Object.keys(POSES)) {
  if (ACTIONS[k]) throw new Error(`POSES.${k} 与 ACTIONS.${k} 重名——会被静默遮蔽，改个名字`)
}

/** 朝向句查表。键写在 `ACTIONS[x].facing` / `POSES[x].facing` 上 */
const FACING = {
  front: _FACING_DOWN,
  'front-head': _FACING_DOWN_HEAD,
  side: _FACING_SIDE,
  cling: _FACING_CLING,
  pose: _FACING_POSE,
  'turn-side': _FACING_TURN_SIDE,
}

/**
 * 角色档案：身份描述 / 风格 / 底色。
 *
 * `identity` 必须是 **view-neutral** 的——只写"从任何角度都成立"的可见特征。
 * 一旦出现 `facing the camera`、`front view`、`seen from behind` 这类词，
 * 就跟朝向句直接打架，模型的解法是把角色**转过去**（sprite_h3 的校验规则
 * 专门拦这个：identity_describes_viewpoint）。
 *
 * 底色取自各角色立绘生成时用的 key 色（见 plans.json 的 plan.background.hex），
 * **必须跟 stage-frame.mjs 的 --bg 一致**，否则提示词说的颜色跟画面里的对不上。
 */
export const CHARACTERS = {
  'pixel-cat': {
    label: '橘猫',
    background: '#00FFFF',
    style: 'flat-vector cartoon pet sprite',
    identity:
      'a chubby cartoon cat with a round head and a big round body. The fur is flat orange with a white muzzle, ' +
      'a white chest and white paws, drawn with thick rounded dark-brown outlines. It has two large round black eyes, ' +
      'a small pink nose, and pink inner ears; the tail is short and orange with a white tip. ' +
      'Flat vector look with solid fills, no shading and no gradients.',
  },
  tuanzi: {
    label: '团子（卡通猫）',
    background: '#00CCFF',
    style: 'flat-vector cartoon pet sprite',
    identity:
      'a chubby kid-friendly cartoon cat with a big round head and a round body, flat orange-and-cream fur, ' +
      'large round black eyes, a small pink nose, pink inner ears and pink paw pads, drawn with thick rounded ' +
      'dark-brown outlines and simple flat colors, no shading and no gradients.',
  },
  yingtao: {
    label: '樱桃（动漫少女）',
    background: '#00FFFF',
    style: '2D-animated cel-shaded anime game sprite',
    identity:
      'a cheerful anime girl with dark chestnut hair in twin tails and straight bangs, wearing a light-blue ' +
      'sailor-collar short-sleeve top and a navy pleated skirt. She has large bright eyes and fair skin, ' +
      'drawn in flat cel-shaded anime style with clean thin black outlines and crisp flat colors.',
  },
  gangyu: {
    label: '钢羽（机甲）',
    background: '#FF00FF',
    style: '2D-animated mecha game sprite with soft 3D shading',
    identity:
      'a mecha robot in a classic blue-white-red color scheme: a squared helmet with glowing yellow eyes, ' +
      'a red chest plate with gold trim, and wide square shoulder armor. It has a 3D-rendered look with ' +
      'metallic sheen, hard beveled edges and soft volumetric lighting.',
  },
}

/**
 * 时长。H3 的时长网格是 **17k+5**（24fps），合法值只有 22/39/56/73/90/107…
 *
 * **107（4.46 秒）= 官方模板与 sprite_h3 用的那一档**，2026-09-24 从 56 抬回这里。
 * 当初压到 56 的理由是"抽 8 帧用不上 107 帧、每帧都要过生成与抠底"，那是**按 8 帧
 * 输出**算的账；输出帧一抬到 16，那笔账就不成立了——而且 107 更靠近 H3 的训练区间
 * （~124-362），同样的动作摊在更长的片子里，帧间位移更小、抽出来的姿势更细。
 *
 * ⚠ **抬源片长必须同时抬抽帧数**，否则是"把动画放快"而不是"更细腻"：
 *   56 帧取 8  → 8 帧 @8fps 播 1.0s，源 2.33s ⇒ 快放 2.33×（既有动作都是这个手感）
 *   107 帧取 16 → 16 帧 @8fps 播 2.0s，源 4.46s ⇒ 快放 2.23×（同手感，帧数翻倍）
 * 只抬源片长不抬抽帧数（107 取 8）会变成 1.0s 播 4.46s 的动作，快放 4.5×，像抽搐。
 *
 * ⚠ **代价**：H3 的训练区间是 ~124-362 帧，107 已在区间之下，56 更低。
 * 换帧数要盯两件事：动作有没有做到一半就断（`MOTION_DEADLINE` 跟着算，见 buildPrompt），
 * 以及首末帧还能不能闭合。崩了就回退到 73。
 */
const DEFAULT_FRAMES = 107
/** 抽帧数（输出帧数）。**必须与 DEFAULT_FRAMES 成对改**，见上面的换算。 */
const DEFAULT_PICKS = 16

/**
 * 组装完整提示词（H3 官方三段式）。
 *
 * 句子顺序照着 composer v4：首帧锚定 → 开场（风格+构图）→ 身份 → 朝向 →
 * 动作起手 → 运动类别锁定 → 循环闭合 → 背景/镜头/静音收尾。
 */
export function buildPrompt(action, scene = {}, { loopAnchor = 'first-last', seconds = DEFAULT_FRAMES / 24, figureRatio = 0.7, baselineRatio = 0.856 } = {}) {
  const A = ACTIONS[action] ?? POSES[action]
  if (!A) throw new Error(`未知动作 ${action}，可选：${[...Object.keys(ACTIONS), ...Object.keys(POSES)].join(' / ')}`)
  const identity = scene.identity || DEFAULT_IDENTITY
  const style = scene.style || STYLE
  const bg = scene.background ? backgroundWords(scene.background) : BACKGROUND.words
  // 位置描述必须跟画面里的事实一致，否则等于让模型自己猜该信哪句
  // （这里曾按 motionClass 判，结果给占 70% 高的角色写了 "standing in the lower half"）。
  // 两个触发条件：角色本身压得低（ratio ≤ 0.65），或者**基线被推到了底边**
  // （跳跃用，见 ACTIONS.hop.stage 的说明——那种情况下角色不高但整体靠下）。
  const position = figureRatio <= 0.65 || baselineRatio >= 0.9 ? _POSITION_LOW : _POSITION_STANDING
  // 高度百分比也**从参数算**，不写死。写死过一次"seventy percent"，
  // 后来调 ratio 时这句话没跟着改，提示词就跟画面矛盾了。
  const heightWord = `${Math.round(figureRatio * 100)} percent`

  /**
   * 动作 prose 里的完成时刻 —— **从片长算，不写死**。
   *
   * 早先这里是个常量 `'2.10'`（配 56 帧 = 2.33 秒的片子）。源片长一改，
   * "2.10 秒完成"就成了一句跟画面无关的话：片长抬到 4.46 秒而 deadline 不动，
   * 模型会在前半段就把动作做完，剩下两秒无事可做——而**提示词里没有任何地方
   * 提示这个矛盾**，只有在抽出来的帧上才看得出来（中段开始重复）。
   *
   * 取 90% 是留一口气给"稳住并回到起始姿势"那一句（FL2VA 要求末帧等于首帧，
   * 动作卡在最后一帧才收尾会跟闭合条件打架）。
   */
  const deadline = (seconds * 0.9).toFixed(2)

  const body = [
    `[Shot 1] 2D-animated, ${style}; the character shown in <Picture 1> begins in the exact starting pose, ` +
      `at exactly the same size and framing as in <Picture 1>: the figure fills about ${heightWord} of the ` +
      `frame height, ${position}, centered horizontally on a flat ${bg} background.`,
    `Preserve the exact visual identity without redesign: ${identity}`,
    FACING[A.facing || 'front'],
    `The camera holds a static shot. ${A.motion.replaceAll('{deadline}', deadline)}`,
    MOTION_CLASS[A.motionClass],
    loopAnchor === 'first-last' ? _CLOSED_LAST : loopAnchor === 'first' ? _CLOSED_FREE : _CLOSED,
    `The background stays a single flat ${bg} colour edge to edge, with no floor, shadow, scenery, text, or props. ` +
      `The full body stays visible in one continuous shot with no cuts, transitions, zooms, or camera movement. ` +
      `The complete video is silent throughout, with no dialogue, vocalization, ambience, sound effects, or music.`,
  ]

  return [
    loopAnchor === 'first-last' ? _FIRST_LAST_FRAME(seconds) : _FIRST_FRAME,
    '',
    `integrated_multimodal_description: ${body.join(' ')}`,
    '',
    'overall_soundscape: N/A',
    '',
    'non_diegetic_music: N/A',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 工作流：I2V + Turbo LoRA → PNG 序列
// ---------------------------------------------------------------------------

const MODELS = {
  unet: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  vae: 'minimax_h3_video_vae_fp16.safetensors',
  turbo: 'minimax_h3_turbo_v4_step600_ema.safetensors',
}

/**
 * 建图。跟 sprite_h3 pinned 的 `workflows/minimax_h3/i2v/workflow.api.json`
 * 同构（那是 Comfy Org 官方模板的扁平化），只改一处：
 *
 *   出口从 SaveVideo 换成 **SaveImage** —— 要的是帧序列，不是 mp4。
 *   官方模板其实两条都接（sprite_h3 加的那个 SaveImage 就是干这个的），
 *   这里干脆只留帧。mp4 没有任何用途，过一道编码只会凭空多一次有损转换。
 *
 * **不加 Turbo LoRA**：官方模板和 sprite_h3 都用 20 步底模。实测
 * `minimax_h3_turbo_v4_step600_ema` 挂在这套 int8 量化模型上时
 * **所有键都 not loaded**（日志刷屏几十行），LoRA 一点没生效——
 * 拿它配 4 步跑，等于用 4 步跑底模，出来画面中段整片发灰。
 * 真要用它，先确认日志里没有 `lora key not loaded`。
 */
export function buildGraph({ image, prompt, width = 640, height = 640, length = DEFAULT_FRAMES, steps = 20, seed = 0, useTurbo = false, prefix = 'petmotion/out', freeEnd = false }) {
  // ⚠ 节点引用必须是 **[字符串 id, 输出序号]**。写成数字 id（[11, 0]）时
  // ComfyUI 会回一个很难读的 400：`Exception when validating node: 12`，
  // 而报错节点列的是**下游**那个（13）——照着报错找会找到错的节点上去。
  const ref = (id, out = 0) => [String(id), out]
  const g = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: MODELS.unet, weight_dtype: 'default' } },
    3: { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.clip, device: 'default', type: 'minimax' } },
    4: { class_type: 'VAELoader', inputs: { vae_name: MODELS.vae } },
    5: { class_type: 'LoadImage', inputs: { image } },
    6: {
      class_type: 'MiniMaxH3ImageToVideo',
      // FL2VA：**同一张图**同时当首帧和尾帧。循环闭合由条件强制，而不是在
      // 提示词里"请求"模型回到起点——实测请求不管用（樱桃那批末尾手臂一直
      // 举着，首末包围盒 `162,134→317,740` vs `87,134→415,743`）。
      //
      // `freeEnd` 反过来用：**不接 last_frame**（I2VA），让末帧自由。
      // 专门用来生成"起始姿势"——管线的立绘是**正面**的，而走动/攀爬/爬行要侧身，
      // 得先让模型把角色**转过去**；FL2VA 下末帧被钉回正面，转过去也会被拉回来。
      // 这种片子只取中间某一帧当新首帧，循环闭合交给**后一轮**的 FL2VA。
      inputs: {
        clip: ref(3),
        vae: ref(4),
        first_frame: ref(5),
        ...(freeEnd ? {} : { last_frame: ref(5) }),
        prompt,
        width,
        height,
        length,
      },
    },
    7: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    9: { class_type: 'RandomNoise', inputs: { noise_seed: seed || Math.floor(Math.random() * 1e9) } },
    11: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ref(9), guider: ref(10), sampler: ref(7), sigmas: ref(8), latent_image: ref(6, 1) } },
    12: { class_type: 'VAEDecode', inputs: { samples: ref(11), vae: ref(4) } },
    13: { class_type: 'SaveImage', inputs: { images: ref(12), filename_prefix: prefix } },
  }
  // Turbo LoRA 插在 UNET 与采样器之间：BasicScheduler 与 BasicGuider 都要吃
  // **加过 LoRA 的** model，漏掉任一个都会静默走回 20 步的底模行为。
  const modelSrc = useTurbo ? ref(2) : ref(1)
  if (useTurbo) {
    g[2] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ref(1), lora_name: MODELS.turbo, strength_model: 1 } }
  }
  g[8] = { class_type: 'BasicScheduler', inputs: { model: modelSrc, scheduler: 'simple', steps, denoise: 1 } }
  g[10] = { class_type: 'BasicGuider', inputs: { model: modelSrc, conditioning: ref(6) } }
  return g
}

// ---------------------------------------------------------------------------
// 端到端工作流：生成 + 抠底 + 抽帧 + 拼表，一次跑完直接出精灵表
// ---------------------------------------------------------------------------

/**
 * 建「一步到位」的工作流：H3 生成 → 抽帧 → 抠底 → 缩放 → 横向拼成精灵表 → 存一张 PNG。
 *
 * 跟 `buildGraph` 的区别是**后处理搬进了图里**：不再需要把几十张 PNG 拉回本地、
 * 再跑一遍 cut/snap/pick/sheet 四个脚本。代价是外面看不到中间帧，
 * 好在 ComfyUI 的 UI 里能直接看到每一步。
 *
 * ## 抠底为什么用色键而不是 BiRefNet
 *
 * mor-o 那条管线用 `BiRefNetRMBG`（语义分割）——因为它的输入是**实拍视频**，
 * 背景不可预测。我们的场景正相反：首帧的底色是**我们自己铺的精确 #00FFFF**，
 * H3 也守着它（实测逐帧漂移 ≤2）。这种前提下色键**比语义分割更准**，
 * 而且不吃显存、不用下模型。sprite_h3 用的也是自己实现的色键。
 *
 * ## 两个约定要对上，否则角色会变透明
 *
 * ComfyUI 的 mask 语义不统一：
 *   · `ColorToMask` 把**匹配到的颜色**（我们的背景）记成 1
 *   · `JoinImageWithAlpha` 的 alpha 是「1 = 透明」
 * 我们要的正是「背景透明」，所以**这里不需要 InvertMask**。
 * （mor-o 那条要 invert，因为 BiRefNet 的 1 是**角色**——两组语义正好相反，
 *  照抄它的图会得到一张「角色透明、背景不透明」的废片。）
 *
 * ## 格子尺寸要跟画布同比例
 *
 * 帧是 640×640 或 480×864，直接缩到 128×128 会把竖版角色压扁。
 * 格子宽按 `cellH × canvasW / canvasH` 算，保持原比例。
 */
export function buildSheetGraph({
  image,
  prompt,
  width = 640,
  height = 640,
  frames = DEFAULT_FRAMES,
  steps = 20,
  seed = 0,
  picks = 8,
  // 448 = 客户端 `demo_anime_girl` 的格高（384×448，宽高比 0.857）。
  // 128 那一档角色只有 96px，放大就糊——用户反馈过。
  cellH = 448,
  key = [0, 255, 255],
  threshold = 30,
  prefix = 'petmotion/sheet',
  /**
   * 尾帧自由（I2VA）。**姿势图那一轮必须开**——它的目的就是让末帧和首帧**不一样**
   * （角色要转过去 / 换姿势），接上 `last_frame` 会被钉回首帧，整轮作废。
   * 循环动作保持 false（FL2VA），见节点 6 的说明。
   */
  freeEnd = false,
}) {
  const ref = (id, out = 0) => [String(id), out]
  const cellW = Math.max(16, Math.round((cellH * width) / height))

  const g = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: MODELS.unet, weight_dtype: 'default' } },
    3: { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.clip, device: 'default', type: 'minimax' } },
    4: { class_type: 'VAELoader', inputs: { vae_name: MODELS.vae } },
    5: { class_type: 'LoadImage', inputs: { image } },
    6: {
      class_type: 'MiniMaxH3ImageToVideo',
      // FL2VA：**同一张图**同时当首帧和尾帧，循环闭合由条件强制。
      //
      // ⚠ 这一行原本是**漏掉的**（只有 first_frame）。而 buildPrompt 默认走
      // `loopAnchor: 'first-last'`，写的是「Picture 2 对齐 N 秒」「末帧回到
      // Picture 2 的姿势、大小与构图」——**Picture 2 根本不存在**，等于提示词
      // 单方面承诺了一件图里没接线的事。`buildGraph` 一直是对的，只有这里漏了。
      //
      // 补上之后提示词才和实际条件一致。实测代价：模型必须回到起点，
      // 动作幅度可能比 I2VA 小一点——换来的是闭合从"请求"变成"约束"。
      inputs: {
        clip: ref(3),
        vae: ref(4),
        first_frame: ref(5),
        // 姿势图那一轮不接：目的就是让末帧和首帧不一样（见 freeEnd 的说明）
        ...(freeEnd ? {} : { last_frame: ref(5) }),
        prompt,
        width,
        height,
        length: frames,
      },
    },
    7: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    8: { class_type: 'BasicScheduler', inputs: { model: ref(1), scheduler: 'simple', steps, denoise: 1 } },
    9: { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    10: { class_type: 'BasicGuider', inputs: { model: ref(1), conditioning: ref(6) } },
    11: { class_type: 'SamplerCustomAdvanced', inputs: { noise: ref(9), guider: ref(10), sampler: ref(7), sigmas: ref(8), latent_image: ref(6, 1) } },
    12: { class_type: 'VAEDecode', inputs: { samples: ref(11), vae: ref(4) } },

    // 抽帧：randomness=0 就是沿整段**均匀**取 picks 张（KJNodes 的语义）。
    // min/max_distance 只在 randomness>0 时参与，但节点仍然会校验它们的范围
    // （上限 4096），所以别图省事填个大数。
    20: {
      class_type: 'RandomImageFromBatch',
      inputs: { input: ref(12), start_index: 0, end_index: -1, num_frames: picks, randomness: 0, min_distance: 1, max_distance: 1024, seed: 0 },
    },
    // 色键。`invert: false` —— 这个方向是**实测**出来的，而且两次实测不一致，
    // 所以别照着任何文档推：
    //   · 384×384 / picks=4 的小样：invert=true → 背景透明（对）
    //   · 576×672 / picks=8 的真跑：invert=true → **角色透明**（反了）
    // 两次代码完全相同，只有 key 色（#00FFFF vs #00CCFF）、分辨率和 picks 不同。
    // ComfyUI 这几组 mask 语义**互不统一**（BiRefNet 的 1 是角色、JoinImageWithAlpha
    // 的 1 是透明、ColorToMask 又是第三套），唯一可靠的判据是**跑完看 alpha 占比**：
    // 背景该占六七成透明，角色占两三成不透明。反了就翻这个开关。
    21: { class_type: 'ColorToMask', inputs: { images: ref(20), invert: false, red: key[0], green: key[1], blue: key[2], threshold, per_batch: picks } },
    22: { class_type: 'MaskToImage', inputs: { mask: ref(21) } },
    23: { class_type: 'ImageScale', inputs: { image: ref(22), upscale_method: 'lanczos', width: cellW, height: cellH, crop: 'disabled' } },
    24: { class_type: 'ImageToMask', inputs: { image: ref(23), channel: 'red' } },
    // 颜色与遮罩各自缩放（lanczos 出来的半透明边正好当抗锯齿）
    25: { class_type: 'ImageScale', inputs: { image: ref(20), upscale_method: 'lanczos', width: cellW, height: cellH, crop: 'disabled' } },
    26: { class_type: 'JoinImageWithAlpha', inputs: { image: ref(25), alpha: ref(24) } },
  }

  // 拆成单帧再横向拼——ImageStitch 一次只吃两张，所以串成一条链
  for (let i = 0; i < picks; i++) {
    g[100 + i] = { class_type: 'ImageFromBatch', inputs: { image: ref(26), batch_index: i, length: 1 } }
  }
  let last = 100
  for (let i = 1; i < picks; i++) {
    const sid = 200 + i - 1
    g[sid] = {
      class_type: 'ImageStitch',
      inputs: { image1: ref(last), image2: ref(100 + i), direction: 'right', match_image_size: true, spacing_width: 0, spacing_color: 'white' },
    }
    last = sid
  }
  g[300] = { class_type: 'SaveImage', inputs: { images: ref(last), filename_prefix: prefix } }
  return { graph: g, cell: { w: cellW, h: cellH } }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function api(pathname, init, { retries = 4 } = {}) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`${COMFY}${pathname}`, init)
      if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
      return res
    } catch (err) {
      // 隧道会抖（实测 ECONNRESET: Client network socket disconnected before
      // secure TLS connection was established）。HTTP 状态码是**服务器**回的，
      // 重试没意义；网络错才重试。区分这两类，不然一个 400 会被重试四次。
      if (/HTTP \d/.test(err.message)) throw err
      lastErr = err
      if (i < retries) await sleep(2000 * (i + 1))
    }
  }
  throw lastErr
}

/** 上传首帧。ComfyUI 的 /upload/image 要 multipart，字段名固定是 image。 */
export async function uploadImage(filePath, asName) {
  const buf = fs.readFileSync(filePath)
  const name = asName || path.basename(filePath)
  const fd = new FormData()
  fd.append('image', new Blob([buf], { type: 'image/png' }), name)
  fd.append('overwrite', 'true')
  const r = await (await api('/upload/image', { method: 'POST', body: fd })).json()
  return r.name || name
}

export async function submit(graph) {
  const r = await (await api('/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'lumii-pet-sprite' }),
  })).json()
  if (r.error) throw new Error(`提交被拒：${JSON.stringify(r).slice(0, 500)}`)
  return r.prompt_id
}

export async function history(promptId) {
  const h = await (await api(`/history/${promptId}`)).json()
  return h[promptId] || null
}

/** 列出这次执行产出的图片文件（按文件名排序 = 时间顺序）。 */
export function outputFiles(entry) {
  const files = []
  for (const o of Object.values(entry.outputs || {})) {
    for (const im of o.images || []) if (/\.png$/i.test(im.filename)) files.push(im)
  }
  return files.sort((a, b) => a.filename.localeCompare(b.filename))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从 history 条目里挖出死因。只报"失败了"没有用——得知道是出错还是被打断。 */
function describeFailure(entry) {
  const msgs = entry?.status?.messages ?? []
  const err = msgs.find((m) => m[0] === 'execution_error')
  if (err) {
    const d = err[1] ?? {}
    return `执行出错：${d.exception_type ?? ''} ${d.exception_message ?? ''}（节点 ${d.node_id} ${d.node_type ?? ''}）`
  }
  const itr = msgs.find((m) => m[0] === 'execution_interrupted')
  if (itr) {
    const d = itr[1] ?? {}
    return `被中断（跑到节点 ${d.node_id} ${d.node_type ?? ''} 时）——通常是别的客户端调了 /interrupt 或清了队列`
  }
  return `任务失败，但 history 里没给出原因（status=${entry?.status?.status_str}）`
}

/** 这个 prompt 还在 ComfyUI 的队列里吗（运行中或排队中） */
async function inQueue(promptId) {
  const q = await (await api('/queue')).json()
  return [...(q.queue_running || []), ...(q.queue_pending || [])].some((x) => x[1] === promptId)
}

/**
 * 等任务跑完。
 *
 * 判据是 `/history` 里 `status.completed`，不是"文件出现了"——SaveImage 边跑边写，
 * 先落盘的那几十张看起来"已经有产物了"，其实后面还在生成（记忆「别量还在写的产物」）。
 *
 * ⚠ **判「没完成」不等于判「还在跑」**。这个函数原本只认 `completed`，于是两种
 * 永远等不到的情况会一路干等到 45 分钟超时，而真正的死因一次都没被读出来：
 *   · **失败的任务 `completed` 永远是 false**——实测三个任务被别的客户端
 *     `/interrupt` 打断（其中一个只跑了 101 秒），批处理空转了 20 分钟。
 *   · **任务从 history 和队列里同时消失**——ComfyUI 重启会清空两者。
 * 所以「没完成」要再分三种：还在跑 / 已经死了 / 不知道去哪了。
 *
 * ⚠ **超时必须从"轮到它跑"算，不能从"提交"算**（2026-09-24 修，实测踩到）。
 * 它原本是 `Date.now() - t0`，`t0` 是提交时刻——于是**排队时间被算进了执行预算**：
 * 一次批量里排第 8 位的任务，前面 7 个各跑十几分钟，它**还没轮到就已经超时**
 * （实测 purr 那条：干等 44 分钟全是排队，报「等待超时（45 分钟）」，而它随后
 * 照常跑完了）。两个时钟必须分开：
 *   · **排队**只受 `queueTimeoutMs` 约束（默认 4 小时，防"永远不轮到"）
 *   · **执行**才受 `timeoutMs` 约束（真正要防的是跑着跑着挂住）
 */
export async function waitDone(promptId, { timeoutMs = 45 * 60 * 1000, queueTimeoutMs = 4 * 60 * 60 * 1000, onTick } = {}) {
  const t0 = Date.now()
  /** 第一次观察到它出现在 `queue_running` 的时刻。null = 还在排队（或还没观察到） */
  let runStartedAt = null
  let consecutiveErrors = 0
  let consecutiveMissing = 0
  for (;;) {
    // 只有**查询本身**失败才吞掉重试；下面的判定必须在 try 外面，
    // 否则自己抛的 "任务失败了" 会被 catch 当成"查不到状态"又咽回去。
    let e = null
    let queryFailed = null
    try {
      e = await history(promptId)
    } catch (err) {
      queryFailed = err
    }

    if (queryFailed) {
      // 查不到 ≠ 没在跑。任务在 ComfyUI 那边照常执行，这边只是问不到；
      // 连续失败很多次才认定是真出问题了。
      consecutiveErrors++
      if (consecutiveErrors > 25) throw new Error(`连续 ${consecutiveErrors} 次查不到状态：${queryFailed.message}`)
    } else {
      consecutiveErrors = 0
      if (e?.status?.completed) return e
      if (e?.status?.status_str === 'error') throw new Error(describeFailure(e))
      if (e) {
        consecutiveMissing = 0
      } else if (++consecutiveMissing % 5 === 0) {
        // 每 60 秒才问一次队列：正常跑着的任务在 history 里也是查不到的
        // （history 只在结束时才写），别每个 tick 都去戳。
        // 队列查询自己失败时按"还在"处理——宁可多等，不可误杀。
        const still = await inQueue(promptId).catch(() => true)
        if (!still) throw new Error(`任务从 history 与队列里都消失了（${promptId}）——ComfyUI 可能重启过`)
      }
    }

    // 还没轮到它：只盯"排了多久"。只在排队阶段问队列，跑起来之后不再多打请求。
    if (runStartedAt === null) {
      const running = await isRunning(promptId).catch(() => false)
      if (running) {
        runStartedAt = Date.now()
        const queuedFor = Math.round((runStartedAt - t0) / 1000)
        if (queuedFor >= 12) console.log(`  （排队 ${queuedFor}s 后轮到它跑）`)
      } else if (Date.now() - t0 > queueTimeoutMs) {
        throw new Error(
          `排队超时（${(queueTimeoutMs / 60000) | 0} 分钟仍未轮到）——队列是不是被别的客户端堵住了？`,
        )
      }
    }

    const ranFor = Date.now() - (runStartedAt ?? Date.now())
    if (runStartedAt !== null && ranFor > timeoutMs) {
      throw new Error(`执行超时（跑了 ${(timeoutMs / 60000) | 0} 分钟还没完）`)
    }
    onTick?.(((Date.now() - t0) / 1000) | 0)
    await sleep(12000)
  }
}

/** 这个 prompt 是不是**正在跑**（在 `queue_running` 里，不是 pending） */
async function isRunning(promptId) {
  const q = await (await api('/queue')).json()
  return (q.queue_running || []).some((x) => x[1] === promptId)
}

/** 把帧逐张拉回本地。过隧道，~0.5s 一张，124 张大约一分钟。 */
export async function pullFrames(entry, outDir, { onProgress } = {}) {
  const files = outputFiles(entry)
  fs.mkdirSync(outDir, { recursive: true })
  const written = []
  for (const [i, im] of files.entries()) {
    const q = new URLSearchParams({ filename: im.filename, type: im.type || 'output' })
    if (im.subfolder) q.set('subfolder', im.subfolder)
    const buf = Buffer.from(await (await api(`/view?${q}`)).arrayBuffer())
    // PNG 魔数校验：隧道断流时可能拿到半张或一个 HTML 错误页，别把它当帧写下去
    if (buf.length < 100 || buf.readUInt32BE(0) !== 0x89504e47) {
      throw new Error(`第 ${i} 张不是合法 PNG（${buf.length}B，开头 ${buf.subarray(0, 8).toString('hex')}）`)
    }
    const dest = path.join(outDir, `f${String(i).padStart(4, '0')}.png`)
    fs.writeFileSync(dest, buf)
    written.push(dest)
    onProgress?.(i + 1, files.length)
  }
  return written
}

/**
 * 在拼条目录里写一份**网格说明**（`f0000.json`）。
 *
 * 为什么需要：下游要在**已经落盘的拼条**上复原"一格是多少像素"，而这件事
 * **从图本身推不出来**——任何约数都几何自洽。以前只有一个 8 列的规矩，于是
 * `sheet-canvas.mjs` 把 8 写成了默认值；2026-09-24 起抽帧数从 8 提到 16，
 * 同一个角色下 8 列与 16 列的表**并存**，那个默认值就不成立了：
 * 对 16 列的表按 8 列切，每"格"横跨两个角色，量出来的画布宽度是错的
 * （而错的方向是**量不出"装不下"**，只会装完发现被裁）。
 *
 * 写在这里而不是让下游猜：拼条是**本脚本产的**，格数只有它知道。
 */
export function writeSheetGrid(outDir, cols, rows = 1) {
  fs.writeFileSync(
    path.join(outDir, 'f0000.json'),
    JSON.stringify({ cols, rows, generator: 'h3-motion' }, null, 2) + '\n',
  )
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i === -1 ? d : argv[i + 1]
}
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

/**
 * 解析某个动作该用哪张 staged 首帧、哪个底色。
 *
 * 默认所有动作共用 `<角色>.png`；只有声明了 `stage` 的动作才要自己的那张
 * （目前只有 hop，见 `ACTIONS.hop.stage`）。文件名带动作名，**不覆盖**
 * 共用的那张——否则跑一次 hop 就会把别的动作的首帧也改成压低版。
 *
 * 比例与基线**从 staging 元数据里读**，不在这里再写一遍：stage-frame.mjs 已经
 * 把它实际用的值记进 json 了，两处各存一份迟早对不上，而这里的值会直接进提示词
 * （见 buildPrompt 的位置句），对不上就是提示词跟画面矛盾。
 */
/**
 * 读一张 staged 的画布尺寸。
 *
 * 生成画布必须**跟 staging 时选的一致**：H3 会把首帧按 `width`/`height` 缩放，
 * 比例对不上角色就被拉伸。stage-frame.mjs 是按客户端宠物格的宽高比（0.857）
 * 选画布的（矮胖用方图、高瘦用竖版），所以绝不能在外面拍一个 640×640 的默认值。
 */
function stagedCanvas(stem) {
  const metaPath = path.join(MOTION_DIR, 'staged', `${stem}.json`)
  if (!fs.existsSync(metaPath)) {
    throw new Error(`缺少 staged/${stem}.json —— 先跑 stage-frame.mjs 产出这张首帧`)
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
  return { w: Number(meta.canvas.w), h: Number(meta.canvas.h) }
}

function resolveStage(charId, action, prof) {
  const A = ACTIONS[action]
  if (!A) throw new Error(`未知动作 ${action}，可选：${Object.keys(ACTIONS).join(' / ')}`)
  // 首帧的选择顺序：显式姿势图 > 借用别的动作的机位 > 自己的 stage 覆盖 > 共用的站立立绘
  //
  // `stage.from` 是"**同一张图，不重出一份**"：`cheer` 要跳，所以需要 `hop` 那张
  // 把角色压低（baseline 0.95）的首帧；两张图的姿势完全一样，重出一份只会多一个
  // 会各自漂移的副本。用名字显式声明依赖，比复制文件强——复制出来的那份没人知道
  // 它跟 hop 是同一个机位，改了 hop 的 baseline 也不会跟着变。
  const stem = A.pose
    ? `${charId}-${A.pose}`
    : A.stage?.from
      ? `${charId}-${A.stage.from}`
      : A.stage && (A.stage.ratio || A.stage.baseline)
        ? `${charId}-${action}`
        : charId
  const src = path.join(MOTION_DIR, 'staged', `${stem}.png`)
  const metaPath = path.join(MOTION_DIR, 'staged', `${stem}.json`)
  if (!fs.existsSync(src) || !fs.existsSync(metaPath)) {
    if (A.pose) {
      throw new Error(
        `缺少 staged/${stem}.png —— 「${A.label}」要的是**${A.pose === 'cling' ? '侧身贴墙' : '侧身'}**首帧，` +
          `而管线的立绘是正面的。先出一张姿势图：用 gen 加 --free-end（I2VA，末帧自由）让它转过去，` +
          `取中间某一帧跑 stage-frame.mjs 摆正。`,
      )
    }
    if (A.stage?.from) {
      throw new Error(
        `缺少 staged/${stem}.png —— 「${A.label}」借用的是 \`${A.stage.from}\` 的机位（stage.from），` +
          `先把那个动作的首帧摆出来。`,
      )
    }
    const hint = A.stage?.baseline
      ? ` --baseline ${A.stage.baseline}`
      : A.stage?.ratio
        ? ` --ratio ${A.stage.ratio}`
        : ''
    throw new Error(`缺少 staged/${stem}.png 或 .json —— 先跑 stage-frame.mjs${hint}`)
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
  return {
    src,
    meta,
    bg: A.background || prof.background,
    ratio: Number(meta.figureHeightRatio),
    baseline: Number(meta.baselineRatio),
  }
}

if (isMain) {
  if (cmd === 'gen') {
    const charId = flag('char')
    const prof = charId ? CHARACTERS[charId] : null
    if (charId && !prof) throw new Error(`未知角色 ${charId}，可选：${Object.keys(CHARACTERS).join(', ')}`)
    const action = flag('action', 'idle')
    /**
     * 首帧。姿势图的 `from` 决定从哪张 staged 出发：
     * `side` 用 `from: ''`（正面立绘），`cling`/`fall` 用 `from: 'side'`（已经侧身那张）。
     * 不这样的话后两张会又从头转身一次，多绕一步且容易抖。
     */
    const pose = POSES[action]
    const fromStem = pose ? (pose.from ? `${charId}-${pose.from}` : charId) : charId
    const imagePath =
      flag('image') || (prof ? path.join(MOTION_DIR, 'staged', `${fromStem}.png`) : null)
    if (!imagePath) throw new Error('用法：node h3-motion.mjs gen --char <角色> --action <动作>  （或 --image <首帧.png>）')
    // 画布**从 staging 元数据读**，与 batch/sheet 同源。
    // 曾经在这里拍了个 `640x640` 默认值——而 tuanzi 的 staged 是 576×672，
    // 比例对不上会把角色**横向拉伸**，而且出图看着"没报错"。踩过一次。
    const canvas = stagedCanvas(fromStem)
    const [w, h] = (flag('size') || `${canvas.w}x${canvas.h}`).split('x').map(Number)
    // --free-end：不接 last_frame（I2VA）。姿势图专用，见 POSES 的说明。
    const freeEnd = argv.includes('--free-end')
    // 档案给默认，显式参数覆盖
    const scene = prof ? { identity: prof.identity, style: prof.style, background: prof.background } : {}
    if (flag('identity')) scene.identity = flag('identity')
    if (flag('style')) scene.style = flag('style')
    if (flag('bg')) scene.background = flag('bg')
    const graph = buildGraph({
      image: '__UPLOAD__',
      prompt: buildPrompt(action, scene, {
        seconds: Number(flag('frames', DEFAULT_FRAMES)) / 24,
        // 尾帧自由时不能写"末帧对齐 Picture 2"——那张图根本没接进去
        loopAnchor: freeEnd ? 'first' : 'first-last',
      }),
      width: w,
      height: h,
      length: Number(flag('frames', DEFAULT_FRAMES)),
      steps: Number(flag('steps', 20)),
      seed: Number(flag('seed', 0)),
      useTurbo: flag('turbo', 'false') === 'true',
      freeEnd,
    })
    const token = flag('token', `cat-${action}`)
    graph[13].inputs.filename_prefix = `petmotion/${token}`
    console.log(`上传首帧 ${imagePath}（${freeEnd ? 'I2VA 末帧自由' : 'FL2VA 首尾同图'}）…`)
    graph[5].inputs.image = await uploadImage(imagePath, flag('as', 'pet-motion-first.png'))
    console.log('提交工作流 …')
    const id = await submit(graph)
    console.log(`prompt_id = ${id}`)
    console.log(`等它跑完（约 2~6 分钟；turbo ${graph[8].inputs.steps} 步 @ ${w}×${h} / ${graph[6].inputs.length} 帧）`)
    const entry = await waitDone(id, {
      onTick: (s) => {
        if (s % 60 < 12) console.log(`  …${s}s`)
      },
    })
    const outDir = path.join(MOTION_DIR, token)
    console.log(`拉帧 → ${outDir}`)
    const frames = await pullFrames(entry, outDir, {
      onProgress: (i, n) => {
        if (i % 20 === 0 || i === n) console.log(`  ${i}/${n}`)
      },
    })
    console.log(`✓ ${frames.length} 帧落在 ${outDir}`)
    console.log(`prompt_id 记住：${id}（重拉用 pull）`)
  } else if (cmd === 'sheet') {
    // 端到端：生成 + 抠底 + 抽帧 + 拼表，一次跑完直接出一张精灵表
    const charId = flag('char')
    const prof = charId ? CHARACTERS[charId] : null
    if (!prof) throw new Error(`用法：node h3-motion.mjs sheet --char <角色> --action <动作>（角色：${Object.keys(CHARACTERS).join(', ')}）`)
    const action = flag('action', 'idle')
    const st = resolveStage(charId, action, prof)
    const meta = st.meta
    const [w, h] = flag('size') ? flag('size').split('x').map(Number) : [meta.canvas.w, meta.canvas.h]
    const frames = Number(flag('frames', DEFAULT_FRAMES))
    const picks = Number(flag('picks', DEFAULT_PICKS))
    const cellH = Number(flag('cell', 448))
    const token = flag('token', `${charId}-${action}-sheet`)

    const { graph, cell } = buildSheetGraph({
      image: await uploadImage(st.src, path.basename(st.src)),
      prompt: buildPrompt(
        action,
        { identity: prof.identity, style: prof.style, background: st.bg },
        { seconds: frames / 24, figureRatio: st.ratio, baselineRatio: st.baseline },
      ),
      width: w,
      height: h,
      frames,
      steps: Number(flag('steps', 20)),
      seed: Number(flag('seed', 0)),
      picks,
      cellH,
      key: hexToRgb(st.bg),
      threshold: Number(flag('threshold', 30)),
      prefix: `petmotion/${token}`,
    })
    console.log(`提交 ${token}（${w}×${h} / ${frames} 帧 / 抽 ${picks} 帧 → ${cell.w}×${cell.h} 格子）`)
    const id = await submit(graph)
    console.log(`prompt_id = ${id}，等它跑完…`)
    const entry = await waitDone(id, {
      onTick: (t) => {
        if (t % 120 < 12) console.log(`  …${t}s`)
      },
    })
    const files = outputFiles(entry)
    console.log('产出:', files.map((f) => f.filename).join(', '))
    const outDir = path.join(MOTION_DIR, token)
    const saved = await pullFrames(entry, outDir, { onProgress: () => {} })
    writeSheetGrid(outDir, picks)
    console.log(`✓ 精灵表 → ${saved.join(', ')}`)
  } else if (cmd === 'pose') {
    // 姿势图也走**同一套组合图**（生成 → 抠底 → 抽帧 → 拼条 → 存一张）。
    //
    // 原来这里走的是 `gen`（纯出帧，节点 1~13），把 56 张全拉回本地再挑。
    // 那样只有一个好处：候选帧多。代价是把 56 张 PNG 拖过 cpolar 隧道，
    // 而且和正式动作走的不是同一条链路。改成组合图之后：
    //   · 过一次隧道只拉 **1 张**（拼条），传输量降两个数量级
    //   · 抠底在 ComfyUI 里做（和正式动作同一套 ColorToMask 参数）
    //   · 抽帧交给 `RandomImageFromBatch(randomness=0)`，沿整段均匀取 picks 张
    // 代价是候选从 56 降到 picks（默认 16）——实测稳定段本身就有 30+ 帧，
    // 16 张采样能落进去 4~5 张，够挑。真不够就加大 --picks 重跑。
    const charId = flag('char')
    const prof = charId ? CHARACTERS[charId] : null
    if (!prof) throw new Error(`用法：node h3-motion.mjs pose --char <角色> --action <姿势>（姿势：${Object.keys(POSES).join(', ')}）`)
    const action = flag('action')
    const P = POSES[action]
    if (!P) throw new Error(`未知姿势 ${action}，可选：${Object.keys(POSES).join(' / ')}`)
    // `from` 空 = 从正面立绘出发（转身那一轮）；否则从已经侧身的那张出发（换姿势）
    const fromStem = P.from ? `${charId}-${P.from}` : charId
    const src = path.join(MOTION_DIR, 'staged', `${fromStem}.png`)
    if (!fs.existsSync(src)) throw new Error(`首帧不在：${src}`)
    const canvas = stagedCanvas(fromStem)
    const frames = Number(flag('frames', DEFAULT_FRAMES))
    const picks = Number(flag('picks', 16))
    const token = flag('token', `${charId}-pose-${action}`)
    const { graph, cell } = buildSheetGraph({
      image: await uploadImage(src, `${fromStem}.png`),
      // 尾帧自由那一轮不能写"末帧回到 Picture 2"——那张图根本没接进去
      prompt: buildPrompt(
        action,
        { identity: prof.identity, style: prof.style, background: prof.background },
        { seconds: frames / 24, loopAnchor: 'first' },
      ),
      width: canvas.w,
      height: canvas.h,
      frames,
      steps: Number(flag('steps', 20)),
      seed: Number(flag('seed', 0)),
      picks,
      cellH: Number(flag('cell', 448)),
      key: hexToRgb(prof.background),
      threshold: Number(flag('threshold', 30)),
      prefix: `petmotion/${token}`,
      // 姿势图必须尾帧自由，否则角色转过去会被末帧钉回正面
      freeEnd: true,
    })
    console.log(`提交 ${token}（${canvas.w}×${canvas.h} / ${frames} 帧 / 均匀抽 ${picks} 帧 → ${cell.w}×${cell.h} 拼条）`)
    const id = await submit(graph)
    console.log(`prompt_id = ${id}，等它跑完…`)
    const entry = await waitDone(id, { onTick: (t) => t % 120 < 12 && console.log(`  …${t}s`) })
    const outDir = path.join(MOTION_DIR, token)
    const saved = await pullFrames(entry, outDir, { onProgress: () => {} })
    writeSheetGrid(outDir, picks)
    console.log(`✓ 拼条 ${picks} 格 → ${saved.join(', ')}`)
    console.log(`挑帧：node pose-pick.mjs ${outDir} --cols ${picks} --pick ${P.pick ?? 'desc'}`)
  } else if (cmd === 'batch') {
    // 一次把整批动作排进 ComfyUI 队列，再统一收。
    // 好处是**不让队列空转**：单任务 gen 是"提交—等待—拉帧"的串行流程，
    // 两次生成之间那几十秒的排队/收尾时间全浪费了。
    const jobs = flag('jobs', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [charId, action] = s.split(':')
        if (!charId || !action) throw new Error(`任务格式应为 <角色>:<动作>，收到 "${s}"`)
        if (!CHARACTERS[charId]) throw new Error(`未知角色 ${charId}，可选：${Object.keys(CHARACTERS).join(', ')}`)
        if (!ACTIONS[action]) throw new Error(`未知动作 ${action}，可选：${Object.keys(ACTIONS).join(', ')}`)
        return { charId, action }
      })
    if (!jobs.length) throw new Error('用法：node h3-motion.mjs batch --jobs "tuanzi:wave,tuanzi:idle,pixel-cat:hop"')
    const steps = Number(flag('steps', 20))
    const frames = Number(flag('frames', DEFAULT_FRAMES))
    // --sheet：走端到端图（生成+抠底+抽帧+拼表一次完成），产出是**一张精灵表**，
    // 不是上百张原始帧。中间产物一个都不落盘，省掉每轮几百 MB 的清理。
    // ⚠ 用 argv.includes 而不是 flag('sheet')：`--sheet` 是**无值标志**，
    // 而 flag() 读的是它后面那个参数——标志放在命令末尾时后面什么都没有，
    // 于是拿到 undefined、判定恒为 false（踩过：整批任务静默走了分步模式，
    // 产出 8×56 张原始帧而不是 8 张精灵表）。
    const sheetMode = argv.includes('--sheet')
    const uploaded = new Map()

    const submitted = []
    for (const job of jobs) {
      const prof = CHARACTERS[job.charId]
      // 每个动作各自解析首帧与底色（hop 有自己的压低版首帧，见 resolveStage）。
      // 画布从 staging 元数据读——它按角色比例选过形状（矮胖用方图、高瘦用竖版），
      // 这里再拍一个默认值会让细高角色缩成一条
      const st = resolveStage(job.charId, job.action, prof)
      const meta = st.meta
      const [w, h] = flag('size') ? flag('size').split('x').map(Number) : [meta.canvas.w, meta.canvas.h]
      // **按 staged 文件缓存**，不能按角色：hop 用的是另一张图，
      // 用角色当键会把别的动作的首帧顶掉
      const uploadKey = path.basename(st.src)
      if (!uploaded.has(uploadKey)) {
        uploaded.set(uploadKey, await uploadImage(st.src, uploadKey))
      }
      const token = sheetMode ? `${job.charId}-${job.action}-sheet` : `${job.charId}-${job.action}`
      const prompt = buildPrompt(
        job.action,
        { identity: prof.identity, style: prof.style, background: st.bg },
        { seconds: frames / 24, figureRatio: st.ratio, baselineRatio: st.baseline },
      )
      const graph = sheetMode
        ? buildSheetGraph({
            image: uploaded.get(uploadKey),
            prompt,
            width: w,
            height: h,
            frames,
            steps,
            seed: Number(flag('seed', 0)),
            picks: Number(flag('picks', DEFAULT_PICKS)),
            cellH: Number(flag('cell', 448)),
            key: hexToRgb(st.bg),
            threshold: Number(flag('threshold', 30)),
            prefix: `petmotion/${token}`,
          }).graph
        : buildGraph({
            image: uploaded.get(job.charId),
            prompt,
            width: w,
            height: h,
            length: frames,
            steps,
            seed: Number(flag('seed', 0)),
            useTurbo: false,
            prefix: `petmotion/${token}`,
          })
      const id = await submit(graph)
      console.log(`提交 ${token.padEnd(24)} → ${id}`)
      submitted.push({ ...job, token, id })
    }
    console.log(`\n${submitted.length} 个任务已入队。ComfyUI 会按顺序跑，全程约 ${submitted.length * 15}~${submitted.length * 30} 分钟\n`)

    const results = []
    for (const s of submitted) {
      try {
        const entry = await waitDone(s.id, {
          onTick: (t) => {
            if (t % 300 < 12) console.log(`  ${s.token} …${t}s`)
          },
        })
        const framesOut = await pullFrames(entry, path.join(MOTION_DIR, s.token), {
          onProgress: (i, n) => {
            if (i % 30 === 0 || i === n) console.log(`  ${s.token} 拉帧 ${i}/${n}`)
          },
        })
        // 只有拼表模式才写网格：非拼表模式落的是**原始帧序列**，一帧一个文件，
        // 没有"一格是多少像素"这回事
        if (sheetMode) writeSheetGrid(path.join(MOTION_DIR, s.token), Number(flag('picks', DEFAULT_PICKS)))
        console.log(`✓ ${s.token} ${framesOut.length} 帧`)
        results.push({ ...s, ok: true, count: framesOut.length })
      } catch (err) {
        console.error(`✗ ${s.token}: ${err.message}`)
        results.push({ ...s, ok: false, error: err.message })
      }
    }
    console.log('\n=== 汇总 ===')
    for (const r of results) {
      console.log(r.ok ? `✓ ${r.token.padEnd(24)} ${r.count} 帧` : `✗ ${r.token.padEnd(24)} ${r.error}`)
    }
    if (results.some((r) => !r.ok)) process.exitCode = 1
  } else if (cmd === 'pull') {
    const id = argv[1]
    if (!id) throw new Error('用法：node h3-motion.mjs pull <prompt_id> [--out <目录>]')
    const entry = await history(id)
    if (!entry) throw new Error(`history 里没有 ${id}`)
    if (!entry.status?.completed) throw new Error(`还没完成：${entry.status?.status_str || 'running'}`)
    const outDir = flag('out', path.join(MOTION_DIR, id.slice(0, 8)))
    const frames = await pullFrames(entry, outDir, { onProgress: (i, n) => i % 20 === 0 && console.log(`  ${i}/${n}`) })
    console.log(`✓ ${frames.length} 帧 → ${outDir}`)
  } else if (cmd === 'list') {
    const q = await (await api('/queue')).json()
    console.log('运行中:', (q.queue_running || []).map((x) => x[1]).join(', ') || '(无)')
    console.log('排队中:', (q.queue_pending || []).map((x) => x[1]).join(', ') || '(无)')
  } else {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf-8').split('*/')[0].replace(/^#!.*\n/, ''))
  }
}
