/**
 * SkillImporter - 从 .ocskill 文件导入技能
 *
 * 解压 .ocskill 文件，验证 SHA-256 完整性，
 * 调用 LocalSkillStore.installFromDirectory() 安装
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import type { LocalSkillStore } from './skill-store'
import type { OcskillMeta } from './skill-exporter'
import { createLogger } from './logger'

/** 日志 */
const log = createLogger('SkillImporter')

/** 支持的格式版本 */
const SUPPORTED_FORMAT = 'ocskill/1.0'

/**
 * 递归列出目录中所有文件的相对路径（已排序）
 */
function listFilesRecursive(dir: string, base = ''): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const relativePath = base ? path.join(base, entry.name) : entry.name
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(path.join(dir, entry.name), relativePath))
    } else {
      files.push(relativePath)
    }
  }

  return files.toSorted()
}

/**
 * 计算目录中所有文件的组合 SHA-256
 */
function hashDirectory(dir: string): string {
  const files = listFilesRecursive(dir)
  const hasher = crypto.createHash('sha256')

  for (const file of files) {
    hasher.update(file)
    const content = fs.readFileSync(path.join(dir, file))
    hasher.update(content)
  }

  return hasher.digest('hex')
}

/**
 * 技能导入器
 */
export class SkillImporter {
  constructor(private readonly skillStore: LocalSkillStore) {}

  /**
   * 从 .ocskill 文件导入技能
   *
   * @param ocskillPath - .ocskill 文件路径
   * @returns 导入结果
   */
  async importSkill(ocskillPath: string): Promise<{
    success: boolean
    skillId?: string
    skillName?: string
    error?: string
  }> {
    log.info('开始导入技能', { ocskillPath })

    // 1. 验证文件存在和扩展名
    if (!ocskillPath.endsWith('.ocskill')) {
      return { success: false, error: '文件必须是 .ocskill 格式' }
    }

    if (!fs.existsSync(ocskillPath)) {
      return { success: false, error: `文件不存在: ${ocskillPath}` }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocskill-import-'))

    try {
      // 2. 解压 .ocskill 文件
      const tar = await import('tar')
      await tar.x({ file: ocskillPath, cwd: tempDir })

      // 3. 读取 ocskill.json
      const metaPath = path.join(tempDir, 'ocskill.json')
      if (!fs.existsSync(metaPath)) {
        return { success: false, error: '无效的 .ocskill 文件：缺少 ocskill.json' }
      }

      const meta: OcskillMeta = JSON.parse(
        await fs.promises.readFile(metaPath, 'utf-8'),
      )

      // 4. 验证格式版本
      if (meta.format !== SUPPORTED_FORMAT) {
        return {
          success: false,
          error: `不支持的格式版本: ${meta.format}（当前支持 ${SUPPORTED_FORMAT}）`,
        }
      }

      // 5. 验证 skill 目录存在
      const skillSubDir = path.join(tempDir, 'skill')
      if (!fs.existsSync(skillSubDir)) {
        return { success: false, error: '无效的 .ocskill 文件：缺少 skill 目录' }
      }

      // 6. SHA-256 完整性校验
      const actualHash = hashDirectory(skillSubDir)
      if (actualHash !== meta.integrity.hash) {
        log.error('SHA-256 校验失败', {
          expected: meta.integrity.hash,
          actual: actualHash,
        })
        return {
          success: false,
          error: `SHA-256 完整性校验失败：文件可能已损坏`,
        }
      }

      // 7. 调用 skillStore 安装
      const installResult = await this.skillStore.installFromDirectory(skillSubDir)
      if (!installResult.success) {
        return { success: false, error: installResult.error }
      }

      log.info('技能导入成功', {
        skillId: meta.skill.id,
        skillName: meta.skill.name,
        version: meta.skill.version,
      })

      return {
        success: true,
        skillId: meta.skill.id,
        skillName: meta.skill.name,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error('技能导入失败', { error: errorMessage })
      return { success: false, error: errorMessage }
    } finally {
      // 清理临时目录
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }

  /**
   * 预览 .ocskill 文件内容（不安装）
   *
   * @param ocskillPath - .ocskill 文件路径
   * @returns 元数据或错误
   */
  async previewSkill(ocskillPath: string): Promise<{
    meta: OcskillMeta | null
    error?: string
  }> {
    log.info('预览 .ocskill 文件', { ocskillPath })

    if (!fs.existsSync(ocskillPath)) {
      return { meta: null, error: `文件不存在: ${ocskillPath}` }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocskill-preview-'))

    try {
      const tar = await import('tar')
      // 只解压 ocskill.json
      await tar.x({
        file: ocskillPath,
        cwd: tempDir,
        filter: (p: string) => p === 'ocskill.json',
      })

      const metaPath = path.join(tempDir, 'ocskill.json')
      if (!fs.existsSync(metaPath)) {
        return { meta: null, error: '无效的 .ocskill 文件：缺少 ocskill.json' }
      }

      const meta: OcskillMeta = JSON.parse(
        await fs.promises.readFile(metaPath, 'utf-8'),
      )

      return { meta }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { meta: null, error: errorMessage }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
}
