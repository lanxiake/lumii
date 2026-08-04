/**
 * SkillWrapper - 单文件脚本自动包装为技能
 *
 * 将单个脚本文件（.ts/.js/.py/.sh/.ps1/.bat/.cmd）自动包装为
 * 包含 skill.json 的技能目录，便于通过 LocalSkillStore 安装。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { SkillManifest } from './skill-store'

/** 日志 */
const log = {
  info: (...args: unknown[]) => console.log('[SkillWrapper]', ...args),
  error: (...args: unknown[]) => console.error('[SkillWrapper]', ...args),
  debug: (...args: unknown[]) => console.log('[SkillWrapper:Debug]', ...args),
}

/** 扩展名到 runtime 的映射 */
const EXTENSION_RUNTIME_MAP: Record<string, SkillManifest['runtime']> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.py': 'python',
  '.sh': 'shell',
  '.bash': 'shell',
  '.ps1': 'shell',
  '.bat': 'shell',
  '.cmd': 'shell',
}

/**
 * 从文件路径推断 runtime 类型
 *
 * @param filePath - 文件路径（仅使用扩展名）
 * @returns runtime 类型，不支持的扩展名返回 null
 */
export function inferRuntime(filePath: string): SkillManifest['runtime'] | null {
  const ext = path.extname(filePath).toLowerCase()
  return EXTENSION_RUNTIME_MAP[ext] ?? null
}

/** 包装选项 */
export interface WrapOptions {
  /** 源脚本文件的绝对路径 */
  filePath: string
  /** 输出目录（技能目录将创建在此目录下） */
  outputDir: string
  /** 可选的元数据覆盖 */
  meta?: {
    name?: string
    description?: string
  }
}

/** 包装结果 */
export interface WrapResult {
  /** 是否成功 */
  success: boolean
  /** 生成的技能目录路径 */
  skillDir?: string
  /** 生成的技能清单 */
  manifest?: SkillManifest
  /** 错误信息 */
  error?: string
}

/**
 * 将单文件脚本包装为技能目录
 *
 * 流程：
 * 1. 验证文件存在且扩展名受支持
 * 2. 创建临时技能目录
 * 3. 复制脚本文件
 * 4. 生成 skill.json
 *
 * @returns 包装结果，包含技能目录路径和清单
 */
export async function wrapSingleFile(opts: WrapOptions): Promise<WrapResult> {
  const { filePath, outputDir, meta } = opts

  log.info('包装单文件脚本', { filePath, outputDir })

  // 1. 验证文件存在
  try {
    await fs.promises.access(filePath)
  } catch {
    return { success: false, error: `文件不存在: ${filePath}` }
  }

  // 2. 推断 runtime
  const runtime = inferRuntime(filePath)
  if (!runtime) {
    const ext = path.extname(filePath).toLowerCase()
    return { success: false, error: `不支持的文件类型: ${ext}` }
  }

  // 3. 从文件名生成 ID 和名称
  const baseName = path.basename(filePath, path.extname(filePath))
  const sanitizedBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '-')
  const timestamp = Date.now()
  const skillId = `wrapped-${sanitizedBase}-${timestamp}`
  const skillName = meta?.name ?? baseName

  // 4. 创建技能目录
  const skillDir = path.join(outputDir, skillId)

  try {
    await fs.promises.mkdir(skillDir, { recursive: true })

    // 5. 复制脚本文件
    const entryName = path.basename(filePath)
    const destPath = path.join(skillDir, entryName)
    await fs.promises.copyFile(filePath, destPath)

    // 6. 生成 manifest
    const manifest: SkillManifest = {
      id: skillId,
      name: skillName,
      description: meta?.description,
      version: '1.0.0',
      entry: entryName,
      runtime,
    }

    // 7. 写入 skill.json
    await fs.promises.writeFile(
      path.join(skillDir, 'skill.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    )

    log.info('单文件脚本包装完成', {
      skillId,
      skillDir,
      runtime,
    })

    return { success: true, skillDir, manifest }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    log.error('单文件脚本包装失败', { error: errorMessage })
    return { success: false, error: errorMessage }
  }
}
