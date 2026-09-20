/**
 * commands — validate / install / cutout 三个子命令的实现。
 *
 * 这一层只负责「读盘 → 交给 pet-core 判断 → 落盘」，不做判断本身。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  PET_PACKAGE_ENVELOPE,
  PET_PACKAGE_MANIFEST,
  planPetInstall,
  validatePetPackage,
  type PetInstallPlan,
  type PetPackageIssue,
  type PetPackageValidation,
  type SpriteManifest,
} from '@mtbot/pet-core'
import type { AlphaInfo } from './image.js'
import { inspectAlpha, readRgba, writeRgbaPng } from './image.js'
import {
  colorDistance,
  cutout,
  estimateBackground,
  alphaBBox,
  formatHexColor,
  parseHexColor,
  type CutoutOptions,
  type RGB,
  type SolidTuning,
} from './cutout.js'
import { installPackage, listFilesRecursive, readJson, type InstallOutcome } from './io.js'

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

export interface PackageReadResult {
  files: string[]
  manifestRaw: unknown
  petRaw: unknown
  atlasRaw?: unknown
  atlasHasAlpha?: boolean
  atlasInfo?: AlphaInfo
  /** 读盘阶段的问题（清单/信封/图集缺失或不可解析） */
  readErrors: PetPackageIssue[]
}

const isString = (v: unknown): v is string => typeof v === 'string'

/** 读一个包目录，尽量把校验所需的信息凑齐；缺什么记在 readErrors 里而不是抛异常 */
export async function readPackage(pkgDir: string): Promise<PackageReadResult> {
  const readErrors: PetPackageIssue[] = []
  const files = await listFilesRecursive(pkgDir)

  const manifestPath = join(pkgDir, PET_PACKAGE_MANIFEST)
  const manifestRead = await readJson(manifestPath)
  if (!manifestRead.exists) {
    readErrors.push({ path: PET_PACKAGE_MANIFEST, message: '缺少清单文件' })
  } else if (manifestRead.error) {
    readErrors.push({ path: PET_PACKAGE_MANIFEST, message: manifestRead.error })
  }
  const manifestRaw = manifestRead.value

  const petRead = await readJson(join(pkgDir, PET_PACKAGE_ENVELOPE))
  if (petRead.error) readErrors.push({ path: PET_PACKAGE_ENVELOPE, message: petRead.error })

  const result: PackageReadResult = {
    files,
    manifestRaw,
    petRaw: petRead.value,
    readErrors,
  }

  if (manifestRaw && typeof manifestRaw === 'object' && !Array.isArray(manifestRaw)) {
    const m = manifestRaw as Record<string, unknown>

    if (isString(m.atlasJson)) {
      const atlasRead = await readJson(join(pkgDir, m.atlasJson))
      if (atlasRead.error) readErrors.push({ path: 'atlasJson', message: atlasRead.error })
      if (atlasRead.exists) result.atlasRaw = atlasRead.value
    }

    if (isString(m.atlas) && files.includes(m.atlas)) {
      try {
        const info = await inspectAlpha(join(pkgDir, m.atlas))
        result.atlasInfo = info
        result.atlasHasAlpha = info.hasTransparency
      } catch (err) {
        readErrors.push({ path: 'atlas', message: `图像读取失败：${(err as Error).message}` })
      }
    }
  }

  return result
}

export interface ValidateOutcome extends PetPackageValidation {
  pkgDir: string
  files: string[]
  atlasInfo?: AlphaInfo
}

/** 校验一个包（只读，不写任何字节） */
export async function runValidate(pkgDir: string): Promise<ValidateOutcome> {
  const pkg = await readPackage(pkgDir)
  const result = validatePetPackage(pkg.manifestRaw, {
    files: pkg.files,
    atlasRaw: pkg.atlasRaw,
    atlasHasAlpha: pkg.atlasHasAlpha,
  })

  // 读盘阶段的问题与校验问题合并上报：作者看到的是「这个包一共有哪些问题」
  const errors = [...pkg.readErrors, ...result.errors]
  // 清单都读不出来时，没必要再报一堆「引用不存在」的下游错误
  const deduped = pkg.readErrors.some((e) => e.path === PET_PACKAGE_MANIFEST)
    ? [...pkg.readErrors, ...result.errors.filter((e) => e.path !== 'atlas' && e.path !== 'atlasJson')]
    : errors

  return {
    ...result,
    ok: deduped.length === 0,
    errors: deduped,
    pkgDir,
    files: pkg.files,
    atlasInfo: pkg.atlasInfo,
  }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export interface InstallCommandOutcome {
  ok: boolean
  validation: ValidateOutcome
  plan?: PetInstallPlan
  install?: InstallOutcome
  /** 安装阶段的致命错误（校验通过但搬运失败） */
  error?: string
}

/**
 * 两段式安装：先 validate，通过才搬。
 *
 * 校验不通过时**一个字节都不写**，并如实返回校验结果。
 */
export async function runInstall(
  pkgDir: string,
  targetDir: string,
): Promise<InstallCommandOutcome> {
  const validation = await runValidate(pkgDir)
  if (!validation.ok || !validation.manifest) return { ok: false, validation }

  const pkg = await readPackage(pkgDir)
  const plan = planPetInstall(
    validation.manifest as SpriteManifest,
    pkg.files,
    pkg.petRaw,
  )
  for (const w of plan.warnings) validation.warnings.push(w)

  try {
    const install = await installPackage({ pkgDir, targetDir, plan })
    return { ok: true, validation, plan, install }
  } catch (err) {
    return { ok: false, validation, plan, error: (err as Error).message }
  }
}

// ---------------------------------------------------------------------------
// cutout
// ---------------------------------------------------------------------------

export interface CutoutCommandOptions extends CutoutOptions {
  /** 指定背景色 `#rrggbb`；省略时自动估计 */
  bg?: string
}

export interface CutoutOutcome {
  input: string
  output: string
  width: number
  height: number
  /** 实际使用的背景色 */
  background: RGB
  /** 背景色是估出来的还是指定的 */
  backgroundSource: 'estimated' | 'explicit'
  tuning: SolidTuning
  opaqueCount: number
  semiCount: number
  /** 残留背景占比（抠完仍不透明且颜色贴近底色的像素） */
  residualRatio: number
  /** 主体包围盒（null = 抠完什么都没有，整个部件报废） */
  bbox: { x: number; y: number; w: number; h: number } | null
  warnings: string[]
}

/** 抠底。会写入 output —— 调用方须确保 output 是用户可见且可覆盖的位置。 */
export async function runCutout(
  input: string,
  output: string,
  opts: CutoutCommandOptions = {},
): Promise<CutoutOutcome> {
  const warnings: string[] = []
  const { data, width, height } = await readRgba(input)

  let background: RGB
  let backgroundSource: 'estimated' | 'explicit'
  if (opts.bg) {
    const parsed = parseHexColor(opts.bg)
    if (!parsed) throw new Error(`背景色格式不合法："${opts.bg}"（应为 #rrggbb）`)
    background = parsed
    backgroundSource = 'explicit'
  } else {
    background = estimateBackground(data, width, height)
    backgroundSource = 'estimated'
  }

  const result = cutout(data, width, height, background, {
    tLow: opts.tLow,
    tSolid: opts.tSolid,
  })

  // 残留背景：抠完仍不透明、但颜色贴近底色的像素。
  // 底色与描边过近时 flood fill 只能取很小的容差，背景就冲不干净，在这里现形。
  const tLow = opts.tLow ?? 25
  let residual = 0
  const total = width * height
  for (let i = 0; i < total; i++) {
    if (result.data[i * 4 + 3] < 250) continue
    const c: RGB = [result.data[i * 4], result.data[i * 4 + 1], result.data[i * 4 + 2]]
    if (colorDistance(c, background) <= tLow) residual++
  }
  const residualRatio = total > 0 ? residual / total : 0

  const box = alphaBBox(result.data, width, height)

  if (result.tuning.leakAt !== null && result.tuning.leakAt <= 40) {
    warnings.push(
      `描边与底色过近：容差 ${result.tuning.leakAt} 时就穿透了描边（安全余量过薄）。` +
        `建议生成时换一个与角色所有颜色（尤其描边）距离更远的底色。`,
    )
  }
  if (residualRatio > 0.01) {
    warnings.push(
      `残留背景 ${(residualRatio * 100).toFixed(1)}% —— 底色可能不够纯净，或与角色颜色过近`,
    )
  }
  if (!box) {
    warnings.push('抠完没有任何不透明像素：整个部件报废，请检查输入图与背景色')
  }

  await writeRgbaPng(output, result.data, width, height)

  return {
    input,
    output,
    width,
    height,
    background,
    backgroundSource,
    tuning: result.tuning,
    opaqueCount: result.opaqueCount,
    semiCount: result.semiCount,
    residualRatio,
    bbox: box ? { x: box.minX, y: box.minY, w: box.w, h: box.h } : null,
    warnings,
  }
}

/** 供 CLI 打印：把背景色转成 `#rrggbb` */
export const describeBackground = (c: RGB): string => formatHexColor(c)

/** 目录是否看起来像一个宠物安装包（供 CLI 友善提示） */
export async function looksLikePackage(dir: string): Promise<boolean> {
  try {
    await fs.access(join(dir, PET_PACKAGE_MANIFEST))
    return true
  } catch {
    return false
  }
}
