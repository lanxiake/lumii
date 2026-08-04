/**
 * SkillExporter - 技能导出为 .ocskill 文件
 *
 * 将本地安装的技能打包为 .ocskill 格式，包含：
 * - ocskill.json: 元数据 + SHA-256 完整性校验
 * - skill/: 技能文件目录
 *
 * .ocskill 文件本质是一个 tar.gz 归档
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'

/** 日志 */
const log = {
  info: (...args: unknown[]) => console.log('[SkillExporter]', ...args),
  error: (...args: unknown[]) => console.error('[SkillExporter]', ...args),
  warn: (...args: unknown[]) => console.warn('[SkillExporter]', ...args),
}

/**
 * .ocskill 元数据格式
 */
export interface OcskillMeta {
  /** 格式版本 */
  format: 'ocskill/1.0'
  /** 技能信息 */
  skill: {
    id: string
    name: string
    description?: string
    version: string
    author?: string
    runtime: 'typescript' | 'javascript' | 'python' | 'shell'
  }
  /** 包完整性校验 */
  integrity: {
    /** 技能文件内容的 SHA-256 */
    hash: string
    /** 技能目录内文件总数 */
    fileCount: number
  }
  /** 导出元数据 */
  exported: {
    /** 导出时间 ISO 8601 */
    at: string
    /** 导出平台 */
    platform: string
    /** 应用版本 */
    appVersion: string
  }
}

/**
 * 递归列出目录中所有文件的相对路径
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
 *
 * 按文件名排序后，依次将文件名和内容喂入 hash
 */
function hashDirectory(dir: string): { hash: string; fileCount: number } {
  const files = listFilesRecursive(dir)
  const hasher = crypto.createHash('sha256')

  for (const file of files) {
    hasher.update(file)
    const content = fs.readFileSync(path.join(dir, file))
    hasher.update(content)
  }

  return {
    hash: hasher.digest('hex'),
    fileCount: files.length,
  }
}

/**
 * 递归复制目录
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true })
  const entries = await fs.promises.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else {
      await fs.promises.copyFile(srcPath, destPath)
    }
  }
}

/**
 * 技能导出器
 */
export class SkillExporter {
  /**
   * 将本地安装的技能导出为 .ocskill 文件
   *
   * @param skillDir - 技能安装目录（包含 skill.json）
   * @param outputPath - 输出文件路径（.ocskill）
   * @returns 导出结果
   */
  async exportSkill(
    skillDir: string,
    outputPath: string,
  ): Promise<{
    success: boolean
    outputPath?: string
    fileSize?: number
    error?: string
  }> {
    log.info('开始导出技能', { skillDir, outputPath })

    try {
      // 1. 验证源目录存在
      const dirExists = fs.existsSync(skillDir)
      if (!dirExists) {
        return { success: false, error: `技能目录不存在: ${skillDir}` }
      }

      // 2. 读取并验证 skill.json
      const manifestPath = path.join(skillDir, 'skill.json')
      if (!fs.existsSync(manifestPath)) {
        return { success: false, error: '技能目录中缺少 skill.json 清单文件' }
      }

      const manifestContent = await fs.promises.readFile(manifestPath, 'utf-8')
      const manifest = JSON.parse(manifestContent) as {
        id: string
        name: string
        description?: string
        version: string
        author?: string
        runtime: 'typescript' | 'javascript' | 'python' | 'shell'
      }

      // 3. 创建临时打包目录
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocskill-export-'))

      try {
        // 4. 复制技能文件到 skill/ 子目录
        const skillSubDir = path.join(tempDir, 'skill')
        await copyDir(skillDir, skillSubDir)

        // 5. 计算技能目录的 SHA-256
        const { hash, fileCount } = hashDirectory(skillSubDir)

        // 6. 生成 ocskill.json 元数据
        const meta: OcskillMeta = {
          format: 'ocskill/1.0',
          skill: {
            id: manifest.id,
            name: manifest.name,
            description: manifest.description,
            version: manifest.version,
            author: manifest.author,
            runtime: manifest.runtime,
          },
          integrity: {
            hash,
            fileCount,
          },
          exported: {
            at: new Date().toISOString(),
            platform: os.platform(),
            appVersion: '1.0.0',
          },
        }

        await fs.promises.writeFile(
          path.join(tempDir, 'ocskill.json'),
          JSON.stringify(meta, null, 2),
        )

        // 7. 使用 tar 打包为 .tgz
        const tar = await import('tar')
        await tar.c(
          {
            gzip: true,
            file: outputPath,
            cwd: tempDir,
          },
          ['ocskill.json', 'skill'],
        )

        // 8. 获取输出文件大小
        const stat = await fs.promises.stat(outputPath)

        log.info('技能导出成功', {
          skillId: manifest.id,
          outputPath,
          fileSize: stat.size,
        })

        return {
          success: true,
          outputPath,
          fileSize: stat.size,
        }
      } finally {
        // 清理临时目录
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error('技能导出失败', { error: errorMessage })
      return { success: false, error: errorMessage }
    }
  }
}
