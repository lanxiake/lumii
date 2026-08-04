/**
 * BundledSkillsSeeder — 内置技能种子机制
 *
 * 在 app 首次安装或版本升级时，将 extraResources/bundled-skills/ 中的技能
 * 复制到 workspace/skills/，支持嵌套文件夹结构。
 *
 * 策略：
 * - 只在 app 版本变化时执行（避免每次启动都扫描）
 * - 已存在的同名技能目录不覆盖（尊重用户修改）
 * - 新增技能才写入
 * - 支持多层嵌套：分类目录/技能目录/SKILL.md
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import { createLogger } from './logger'

const log = createLogger('BundledSkillsSeeder')

export const SEED_VERSION_FILENAME = '.bundled-skills-seeded'
const BUNDLED_SKILLS_DIR_NAME = 'bundled-skills'

/** 读取上次种子时的 app 版本 */
function readLastSeededVersion(mtbotDataDir: string): string | null {
  const filePath = path.join(mtbotDataDir, SEED_VERSION_FILENAME)
  try {
    return fs.readFileSync(filePath, 'utf-8').trim()
  } catch {
    return null
  }
}

/** 写入当前 app 版本到标记文件 */
function writeSeededVersion(mtbotDataDir: string, version: string): void {
  const filePath = path.join(mtbotDataDir, SEED_VERSION_FILENAME)
  fs.writeFileSync(filePath, version, 'utf-8')
}

/** 解析 extraResources 中的 bundled-skills 目录 */
export function resolveBundledSkillsSourceDir(): string | undefined {
  // 测试/开发覆盖：环境变量优先
  const override = process.env.MTBOT_BUNDLED_SKILLS_DIR?.trim()
  if (override && fs.existsSync(override)) {
    return override
  }

  // 生产环境：process.resourcesPath/bundled-skills/
  try {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    if (resourcesPath) {
      const candidate = path.join(resourcesPath, BUNDLED_SKILLS_DIR_NAME)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  } catch {
    // ignore
  }

  // 开发环境：源码目录 apps/windows/bundled-skills/
  // __dirname = apps/windows/out/main/ (electron-vite 构建后)
  try {
    const devCandidate = path.resolve(__dirname, '..', '..', BUNDLED_SKILLS_DIR_NAME)
    if (fs.existsSync(devCandidate)) {
      return devCandidate
    }
  } catch {
    // ignore
  }

  return undefined
}

/**
 * 执行技能种子
 *
 * @param workspaceDir - 工作空间目录（workspace/skills/ 的父目录）
 * @param mtbotDataDir - 客户端数据根目录，用于存放版本标记文件（默认 ~/.lumii）
 */
export async function seedBundledSkills(
  workspaceDir: string,
  mtbotDataDir: string,
): Promise<void> {
  const currentVersion = app.getVersion()
  const lastSeededVersion = readLastSeededVersion(mtbotDataDir)

  if (lastSeededVersion === currentVersion) {
    log.info(`版本未变化 (${currentVersion})，跳过种子`)
    return
  }

  log.info(`开始种子内置技能 (${lastSeededVersion ?? 'fresh'} → ${currentVersion})`)
  console.log('[Seeder] step1: resolveBundledSkillsSourceDir')

  const sourceDir = resolveBundledSkillsSourceDir()
  console.log('[Seeder] step2: sourceDir =', sourceDir)
  if (!sourceDir) {
    log.warn('未找到 bundled-skills 源目录，跳过种子')
    return
  }

  const targetSkillsDir = path.join(workspaceDir, 'skills')
  console.log('[Seeder] step3: mkdirSync', targetSkillsDir)
  fs.mkdirSync(targetSkillsDir, { recursive: true })

  const stats = { seeded: 0, skipped: 0, failed: 0 }

  console.log('[Seeder] step4: seedDirectory start')
  // 递归扫描源目录，找到所有包含 SKILL.md 的技能目录
  await seedDirectory(sourceDir, targetSkillsDir, '', stats)
  console.log('[Seeder] step5: seedDirectory done', stats)

  if (stats.failed > 0) {
    log.warn(`${stats.failed} 个技能种子失败，下次启动将重试`)
  } else {
    log.info(`种子完成：新增 ${stats.seeded} 个，跳过 ${stats.skipped} 个（已存在）`)
    console.log('[Seeder] step6: writeSeededVersion')
    writeSeededVersion(mtbotDataDir, currentVersion)
  }
  console.log('[Seeder] done')
}

/**
 * 递归扫描源目录，将技能复制到目标目录
 * 支持两种结构：
 *   1. 直接技能：sourceDir/skillName/SKILL.md → targetDir/skillName/
 *   2. 分类嵌套：sourceDir/category/skillName/SKILL.md → targetDir/category/skillName/
 *
 * @param srcDir - 当前扫描的源目录
 * @param destDir - 对应的目标目录
 * @param relPath - 相对于 bundled-skills 根目录的路径（用于日志）
 * @param stats - 统计计数器
 */
async function seedDirectory(
  srcDir: string,
  destDir: string,
  relPath: string,
  stats: { seeded: number; skipped: number; failed: number },
): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true })
  } catch (err) {
    log.error(`读取目录失败: ${srcDir}`, err)
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const srcSubDir = path.join(srcDir, entry.name)
    const destSubDir = path.join(destDir, entry.name)
    const subRelPath = relPath ? `${relPath}/${entry.name}` : entry.name

    // 大小写不敏感查找 skill.md
    const hasSkillMd = hasSkillMdFile(srcSubDir)
    if (hasSkillMd) {
      // 这是技能目录，直接复制
      if (fs.existsSync(destSubDir)) {
        stats.skipped++
        continue
      }
      try {
        fs.mkdirSync(destDir, { recursive: true })
        console.log('[Seeder] copyDir:', srcSubDir, '->', destSubDir)
        copyDirSync(srcSubDir, destSubDir)
        console.log('[Seeder] copyDir done:', subRelPath)
        log.info(`已种子技能: ${subRelPath}`)
        stats.seeded++
      } catch (err) {
        log.error(`种子技能失败: ${subRelPath}`, err)
        stats.failed++
      }
    } else {
      // 这是分类目录，递归处理子目录
      await seedDirectory(srcSubDir, destSubDir, subRelPath, stats)
    }
  }
}

/** 检查目录中是否存在 skill.md（大小写不敏感） */
function hasSkillMdFile(dir: string): boolean {
  try {
    const files = fs.readdirSync(dir)
    return files.some((f) => f.toLowerCase() === 'skill.md')
  } catch {
    return false
  }
}

/** 递归复制目录（替代 fs.cpSync，避免 Electron 环境下的崩溃） */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true })
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}
