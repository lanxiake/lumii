/**
 * sprite-manifest — 精灵图模型清单格式 v1 与校验（pet-core，零依赖）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §5.2
 *
 * 本模块是「**清单是数据不是代码**」这条安全边界的落点。宠物清单可能来自用户导入
 * 或 Agent 生成，若不严加校验就交给渲染层解释，等于开放了任意代码执行面。
 * 因此校验必须：
 *   - 只接受有限数值参数（复用 procedural-motion 的 validateProceduralParams）
 *   - 拒绝未知字段（防止夹带）
 *   - **一次报出全部错误**，而不是发现第一个就返回（便于作者一次改完）
 *
 * 纯函数、零依赖，客户端运行时与构建期工具链共用同一份实现。
 */

import type { ProceduralParams } from "../render/procedural-motion.js";
import { validateProceduralParams } from "../render/procedural-motion.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * 一帧的声明。
 *
 * **增量语义**：只写本帧``变化``的槽位，未写的沿用上一帧。分层方案下
 * `{ face: { eyes: "happy" } }` 即一次表情切换，不必复制整套帧数据。
 */
export interface SpriteFrameRef {
  /** base 槽的图集条目名 */
  base?: string
  /** 其它槽位 → 部件名（如 { face: { eyes: "eye_happy", mouth: "m1" } }） */
  [slot: string]: unknown
}

export type SpriteAnimationKind = "loop" | "once"

/** 动画数据来源：frames=帧序列；procedural=运行时原语合成 */
export type SpriteAnimationSource = "frames" | "procedural"

export interface SpriteAnimation {
  /** 动作组名（对应 PetCoreRenderer.playMotion 的 group） */
  group: string
  /** 组内序号，省略时由数组顺序决定 */
  index?: number
  kind: SpriteAnimationKind
  /** 省略时按是否含 frames 推断 */
  source?: SpriteAnimationSource
  /** 帧序列的播放帧率 */
  fps?: number
  /** 帧序列（procedural 型可省略） */
  frames?: SpriteFrameRef[]
  /** 程序化原语参数（可与 frames 并存，实现「帧序列 + 程序化叠加」） */
  params?: ProceduralParams
  /** kind=once 时必填：播完回到哪个组 */
  next?: string
}

export type SpriteSlotKind = "whole-frame" | "layered"

export interface SpriteSlotDef {
  kind: SpriteSlotKind
  /** layered 槽在图内的定位坐标（相对 canvas 左上角） */
  at?: [number, number]
  /** layered 槽的部件表：部件类别 → 可选的部件名列表 */
  parts?: Record<string, string[]>
}

export interface SpriteHitArea {
  id: string
  /** 生效的动画组；省略表示全部 */
  frames?: string[]
  /** 多边形顶点（相对 canvas 左上角） */
  points: [number, number][]
}

export interface SpriteManifest {
  id: string
  rendererType: "sprite"
  /** 像素风：渲染层据此选 nearest 采样并做整数倍缩放吸附 */
  pixelArt?: boolean
  canvas: { w: number; h: number }
  /** 锚点（相对 canvas 左上角），通常是脚底中心 */
  anchor: [number, number]
  /** 图集图片文件名 */
  atlas: string
  /** 图集索引 JSON 文件名 */
  atlasJson: string
  /** 槽位定义；整个字段省略即退化为「整体帧」方案 */
  slots?: Record<string, SpriteSlotDef>
  animations: SpriteAnimation[]
  /** 口型档位（对应图集条目名），档数由模型自定 */
  mouthLevels?: string[]
  hitAreas?: SpriteHitArea[]
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

export interface ManifestValidationError {
  /** 可定位的路径，如 animations[1].frames[0].base */
  path: string
  message: string
}

export type ManifestValidation =
  | { ok: true; manifest: SpriteManifest }
  | { ok: false; errors: ManifestValidationError[] }

export interface ManifestValidationOptions {
  /**
   * 图集内实际存在的条目名。提供时校验帧/部件引用是否都存在。
   * 省略则跳过交叉校验 —— 纯函数得以在没有图集的环境下单独使用。
   */
  atlasFrames?: string[]
  /** 实际存在的文件名。提供时校验 atlas / atlasJson 是否都存在。 */
  assets?: string[]
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0

const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v)

/** 顶层与动画对象的已知字段，用于拒绝夹带 */
const MANIFEST_KEYS = new Set([
  "id", "rendererType", "pixelArt", "canvas", "anchor", "atlas", "atlasJson",
  "slots", "animations", "mouthLevels", "hitAreas",
])
const ANIMATION_KEYS = new Set([
  "group", "index", "kind", "source", "fps", "frames", "params", "next",
])
const SLOT_KEYS = new Set(["kind", "at", "parts"])
const FRAME_RESERVED = new Set(["base"])

/**
 * 校验精灵图清单。
 *
 * @param input 待校验的原始值（通常来自清单 JSON）
 * @param options 提供图集/文件信息时做交叉引用校验；省略则只校验自身结构
 */
export function validateSpriteManifest(
  input: unknown,
  options: ManifestValidationOptions = {},
): ManifestValidation {
  const errors: ManifestValidationError[] = []

  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: "", message: `清单必须是对象，收到 ${describe(input)}` }] }
  }

  // ---- 未知顶层字段（防止夹带）----
  for (const key of Object.keys(input)) {
    if (!MANIFEST_KEYS.has(key)) {
      errors.push({ path: key, message: `未知字段 "${key}"` })
    }
  }

  // ---- 基本标识 ----
  if (!isNonEmptyString(input.id)) {
    errors.push({ path: "id", message: "id 必须是非空字符串" })
  }
  if (input.rendererType !== "sprite") {
    errors.push({ path: "rendererType", message: `rendererType 必须是 "sprite"，收到 ${describe(input.rendererType)}` })
  }
  if (!isNonEmptyString(input.atlas)) {
    errors.push({ path: "atlas", message: "atlas 必须是非空字符串（图集图片文件名）" })
  }
  if (!isNonEmptyString(input.atlasJson)) {
    errors.push({ path: "atlasJson", message: "atlasJson 必须是非空字符串（图集索引文件名）" })
  }
  if (input.pixelArt !== undefined && typeof input.pixelArt !== "boolean") {
    errors.push({ path: "pixelArt", message: "pixelArt 必须是布尔值" })
  }

  // ---- canvas 与 anchor ----
  const canvas = input.canvas
  if (!isPlainObject(canvas) || !isPositiveInt(canvas.w) || !isPositiveInt(canvas.h)) {
    errors.push({ path: "canvas", message: "canvas 必须是 { w, h } 且均为正整数" })
  }
  const anchor = input.anchor
  if (!Array.isArray(anchor) || anchor.length !== 2 || !anchor.every(isFiniteNumber)) {
    errors.push({ path: "anchor", message: "anchor 必须是 [x, y] 两个有限数值" })
  } else if (isPlainObject(canvas) && isPositiveInt(canvas.w) && isPositiveInt(canvas.h)) {
    const [ax, ay] = anchor as [number, number]
    if (ax < 0 || ax > canvas.w || ay < 0 || ay > canvas.h) {
      errors.push({
        path: "anchor",
        message: `anchor (${ax}, ${ay}) 超出 canvas 范围 ${canvas.w}×${canvas.h}`,
      })
    }
  }

  // ---- 槽位 ----
  const slotPartNames: { path: string; name: string }[] = []
  if (input.slots !== undefined) {
    if (!isPlainObject(input.slots)) {
      errors.push({ path: "slots", message: "slots 必须是对象" })
    } else {
      for (const [slotName, slot] of Object.entries(input.slots)) {
        const p = `slots.${slotName}`
        if (!isPlainObject(slot)) {
          errors.push({ path: p, message: "槽位定义必须是对象" })
          continue
        }
        for (const key of Object.keys(slot)) {
          if (!SLOT_KEYS.has(key)) errors.push({ path: `${p}.${key}`, message: `未知字段 "${key}"` })
        }
        if (slot.kind !== "whole-frame" && slot.kind !== "layered") {
          errors.push({ path: `${p}.kind`, message: `kind 必须是 "whole-frame" 或 "layered"，收到 ${describe(slot.kind)}` })
        }
        if (slot.kind === "layered") {
          const at = slot.at
          if (!Array.isArray(at) || at.length !== 2 || !at.every(isFiniteNumber)) {
            errors.push({ path: `${p}.at`, message: "layered 槽必须有 at: [x, y]" })
          }
          if (!isPlainObject(slot.parts)) {
            errors.push({ path: `${p}.parts`, message: "layered 槽必须有 parts 部件表" })
          } else {
            for (const [partCat, names] of Object.entries(slot.parts)) {
              if (!Array.isArray(names) || names.some((n) => !isNonEmptyString(n))) {
                errors.push({ path: `${p}.parts.${partCat}`, message: "部件名列表必须是非空字符串数组" })
                continue
              }
              for (const n of names) slotPartNames.push({ path: `${p}.parts.${partCat}`, name: n })
            }
          }
        }
      }
    }
  }

  // ---- 动画 ----
  const frameNames: { path: string; name: string }[] = []
  const groupNames = new Set<string>()
  /** 已占用的 (group, index)，用于检出重复声明 */
  const usedSlots = new Map<string, string>()
  /** 已声明的分层槽位名：帧引用只能落在这些槽位上（base 除外，它是内建的） */
  const declaredSlots = new Set(
    isPlainObject(input.slots) ? Object.keys(input.slots).filter((k) => k !== "base") : [],
  )

  if (!Array.isArray(input.animations) || input.animations.length === 0) {
    errors.push({ path: "animations", message: "animations 必须是非空数组" })
  } else {
    input.animations.forEach((anim, i) => {
      const p = `animations[${i}]`
      if (!isPlainObject(anim)) {
        errors.push({ path: p, message: "动画定义必须是对象" })
        return
      }
      for (const key of Object.keys(anim)) {
        if (!ANIMATION_KEYS.has(key)) errors.push({ path: `${p}.${key}`, message: `未知字段 "${key}"` })
      }

      if (!isNonEmptyString(anim.group)) {
        errors.push({ path: `${p}.group`, message: "group 必须是非空字符串" })
      } else {
        groupNames.add(anim.group)
      }

      if (anim.kind !== "loop" && anim.kind !== "once") {
        errors.push({ path: `${p}.kind`, message: `kind 必须是 "loop" 或 "once"，收到 ${describe(anim.kind)}` })
      }
      if (anim.source !== undefined && anim.source !== "frames" && anim.source !== "procedural") {
        errors.push({ path: `${p}.source`, message: `source 必须是 "frames" 或 "procedural"，收到 ${describe(anim.source)}` })
      }
      if (anim.index !== undefined && !(Number.isInteger(anim.index) && (anim.index as number) >= 0)) {
        errors.push({ path: `${p}.index`, message: "index 必须是非负整数" })
      }
      // 同组内 index 必须唯一。显式 index 与自动编号混用时重号会让一个动画悄悄顶掉另一个，
      // 运行时按 index 取动画，作者只会看到「我写的动作没生效」。
      if (isNonEmptyString(anim.group) && Number.isInteger(anim.index) && (anim.index as number) >= 0) {
        const key = `${anim.group}#${anim.index}`
        const prevAt = usedSlots.get(key)
        if (prevAt) {
          errors.push({
            path: `${p}.index`,
            message: `组 "${anim.group}" 的 index ${anim.index} 与 ${prevAt} 重复（同组内 index 必须唯一）`,
          })
        } else {
          usedSlots.set(key, p)
        }
      }
      if (anim.fps !== undefined && !(isFiniteNumber(anim.fps) && anim.fps > 0)) {
        errors.push({ path: `${p}.fps`, message: "fps 必须是正数" })
      }
      if (anim.kind === "once" && !isNonEmptyString(anim.next)) {
        errors.push({ path: `${p}.next`, message: 'kind="once" 的动画必须声明 next（播完回到哪个组）' })
      }

      // params 安全校验 —— 复用原语模块的实现，保证单一落点
      if (anim.params !== undefined) {
        const pv = validateProceduralParams(anim.params)
        if (!pv.ok) {
          for (const msg of pv.errors) errors.push({ path: `${p}.params`, message: msg })
        }
      }

      // frames 结构
      const hasFrames = anim.frames !== undefined
      if (hasFrames) {
        if (!Array.isArray(anim.frames) || anim.frames.length === 0) {
          errors.push({ path: `${p}.frames`, message: "frames 必须是非空数组" })
        } else {
          anim.frames.forEach((fr, fi) => {
            const fp = `${p}.frames[${fi}]`
            if (!isPlainObject(fr)) {
              errors.push({ path: fp, message: "帧必须是对象" })
              return
            }
            const keys = Object.keys(fr)
            if (keys.length === 0) {
              errors.push({ path: fp, message: "帧不能是空对象（至少声明一个槽位）" })
            }
            if ("base" in fr && !isNonEmptyString(fr.base)) {
              errors.push({ path: `${fp}.base`, message: "base 必须是非空字符串" })
            } else if (isNonEmptyString(fr.base)) {
              frameNames.push({ path: `${fp}.base`, name: fr.base })
            }
            // 其余槽位引用
            for (const [k, v] of Object.entries(fr)) {
              if (FRAME_RESERVED.has(k)) continue
              // 引用未声明的槽位是静默失败：运行时找不到槽位会直接忽略这一项，
              // 作者只会看到「我写的表情没生效」。宁可在这里挡住。
              if (!declaredSlots.has(k)) {
                errors.push({
                  path: `${fp}.${k}`,
                  message: `槽位 "${k}" 未在 slots 中声明（可用的槽位：${["base", ...declaredSlots].join(" / ")}）`,
                })
                continue
              }
              if (typeof v === "string") {
                if (!isNonEmptyString(v)) {
                  errors.push({ path: `${fp}.${k}`, message: `槽位 "${k}" 的部件名必须是非空字符串` })
                } else {
                  frameNames.push({ path: `${fp}.${k}`, name: v })
                }
              } else if (isPlainObject(v)) {
                for (const [partCat, partName] of Object.entries(v)) {
                  if (!isNonEmptyString(partName)) {
                    errors.push({ path: `${fp}.${k}.${partCat}`, message: "部件名必须是非空字符串" })
                  } else {
                    frameNames.push({ path: `${fp}.${k}.${partCat}`, name: partName })
                  }
                }
              } else {
                errors.push({ path: `${fp}.${k}`, message: `槽位 "${k}" 必须是字符串或部件对象` })
              }
            }
          })
        }
      }

      // 既无 frames 又无 params（且未声明 procedural）→ 空动画
      if (!hasFrames && anim.params === undefined) {
        errors.push({ path: p, message: "动画必须至少有 frames 或 params 之一" })
      }
    })
  }

  // ---- 口型档位 ----
  const mouthNames: { path: string; name: string }[] = []
  if (input.mouthLevels !== undefined) {
    if (!Array.isArray(input.mouthLevels) || input.mouthLevels.length === 0) {
      errors.push({ path: "mouthLevels", message: "mouthLevels 必须是非空数组" })
    } else {
      input.mouthLevels.forEach((n, i) => {
        if (!isNonEmptyString(n)) {
          errors.push({ path: `mouthLevels[${i}]`, message: "口型档位名必须是非空字符串" })
        } else {
          mouthNames.push({ path: `mouthLevels[${i}]`, name: n })
        }
      })
    }
  }

  // ---- hitAreas ----
  if (input.hitAreas !== undefined) {
    if (!Array.isArray(input.hitAreas)) {
      errors.push({ path: "hitAreas", message: "hitAreas 必须是数组" })
    } else {
      input.hitAreas.forEach((ha, i) => {
        const p = `hitAreas[${i}]`
        if (!isPlainObject(ha)) {
          errors.push({ path: p, message: "hitArea 必须是对象" })
          return
        }
        if (!isNonEmptyString(ha.id)) errors.push({ path: `${p}.id`, message: "id 必须是非空字符串" })
        const pts = ha.points
        if (!Array.isArray(pts) || pts.length < 3 || !pts.every((q) => Array.isArray(q) && q.length === 2 && q.every(isFiniteNumber))) {
          errors.push({ path: `${p}.points`, message: "points 必须是至少 3 个 [x, y] 顶点" })
        }
      })
    }
  }

  // ---- 交叉引用（仅在提供图集/文件信息时校验）----
  if (options.atlasFrames) {
    const known = new Set(options.atlasFrames)
    for (const { path, name } of [...frameNames, ...mouthNames, ...slotPartNames]) {
      if (!known.has(name)) {
        errors.push({ path, message: `图集中不存在条目 "${name}"` })
      }
    }
  }
  if (options.assets) {
    const known = new Set(options.assets)
    for (const key of ["atlas", "atlasJson"] as const) {
      const v = input[key]
      if (isNonEmptyString(v) && !known.has(v)) {
        errors.push({ path: key, message: `文件不存在："${v}"` })
      }
    }
  }

  // ---- 跨动画引用：next 指向的组必须存在 ----
  if (Array.isArray(input.animations)) {
    input.animations.forEach((anim, i) => {
      if (!isPlainObject(anim)) return
      const next = anim.next
      if (isNonEmptyString(next) && groupNames.size > 0 && !groupNames.has(next)) {
        errors.push({ path: `animations[${i}].next`, message: `next 指向的组 "${next}" 不存在` })
      }
    })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, manifest: input as unknown as SpriteManifest }
}

/** 供错误信息用的类型描述（不泄露内容，只说明类型） */
function describe(v: unknown): string {
  if (v === null) return "null"
  if (v === undefined) return "undefined"
  if (Array.isArray(v)) return "数组"
  if (typeof v === "function") return "函数"
  if (typeof v === "string") return `字符串("${v.slice(0, 20)}")`
  return typeof v
}
