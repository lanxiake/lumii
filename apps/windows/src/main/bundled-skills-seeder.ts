/**
 * BundledSkillsSeeder — 内置技能种子机制
 *
 * 将 extraResources/bundled-skills/ 中的技能复制到 workspace/skills/，
 * 支持嵌套文件夹结构。
 *
 * 策略：
 * - **用户没改过的同名技能会被更新**（靠 `<技能目录>/.bundled-skill-hash` 里的基线判定）
 * - 用户改过的保留不动（尊重用户修改）
 * - 源目录里新增的技能每次启动都会补上
 * - 已从 bundled-skills 下线的技能从 workspace 删掉
 * - 支持多层嵌套：分类目录/技能目录/SKILL.md
 *
 * ## 为什么不能只写「已存在就不覆盖」
 *
 * 那样写的后果是**修好的技能永远到不了老用户**：`pet-creator` 的 `run.ts` 是
 * App 自己的提示词点名要用的工具，它一旧，Agent 每次执行都多跑一次 `align`
 * （实测把 48×56 撑成 48×57）、没有 `blink`、`bob` 写死。而老用户的工作区里
 * 那份是首次安装时种下的，之后**再也不会更新**。
 *
 * 于是记一份**基线哈希**：种子时把源目录的哈希写进技能目录里。下次启动时
 * - 目录里的哈希 == 基线 ⇒ 用户没动过 ⇒ 用新版覆盖
 * - 目录里的哈希 != 基线 ⇒ 用户改过 ⇒ 保留，只在日志里说一声
 *
 * **没有基线的老目录仍然跳过**：分不清「用户改过」与「只是旧」，
 * 而覆盖用户的东西是不可逆的。这是这次改动有意留下的边界。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import { createLogger } from './logger'

const log = createLogger('BundledSkillsSeeder')

export const SEED_VERSION_FILENAME = '.bundled-skills-seeded'
/** 每个技能目录里的基线哈希文件名（记的是**上次种子时源目录**的哈希） */
export const SKILL_BASELINE_FILENAME = '.bundled-skill-hash'
const BUNDLED_SKILLS_DIR_NAME = 'bundled-skills'

/**
 * 已从 bundled-skills 下线的技能（相对根目录路径，启动时从 workspace 清掉）。
 *
 * 2026-08-15 激进内置集：通用生产力 + H3 视频 + 小红书流水线；其余垂直/同质包全部下线。
 */
export const RETIRED_BUNDLED_SKILLS: readonly string[] = [
  // —— 历史下线 ——
  '产品与项目管理/product-manager-toolkit',
  '电商与营销/ecommerce-copywriter',
  '电商与营销/ecommerce-video-marketing',
  '电商与营销/pet-commerce-creator',
  '电商与营销/product-marketing-copywriter',
  '设计与可视化/pop-up-book-illustration',
  '设计与可视化/web-design-analyzer',
  '设计与可视化/web-to-app',
  '语音与音频/qwen3-asr-assistant',
  '语音与音频/sherpa-onnx-tts',
  '语音与音频/tts-voice-synthesis',
  // —— 2026-08-15 激进瘦身 ——
  // '技能管理/skillnet', // 2026-08-18 恢复：需要作为技能搜索入口
  '内容创作与发布/douyin-content-pipeline',
  '内容创作与发布/wechat-content-pipeline',
  '内容创作与发布/hotspot-publisher',
  '文档与分析/paper-analysis-assistant',
  '文档与分析/stock-analysis',
  '文档与分析/tencent-docs',
  '文化创作/poetry-music-visual',
  '智能体协作/multi-agent-meeting',
  '电商与营销/product-video-creator',
  '视频创作/historical-interview-scripts',
  '视频创作/historical-science-video-prod',
  '视频创作/three-body-video-creator',
  '视频创作/video-creation-collaborator',
  '视频创作/video-creation-pro',
  '视频创作/video-creation-suite',
  '视频创作/video-frame-extractor',
  '视频创作/video-recreation',
  '视频创作/viral-video-copywriting',
  '数字人与视频配音/agentkit-multimedia-shopping',
  '数字人与视频配音/digital-avatar-shopping-video',
  '数字人与视频配音/dream-video-prompt-generator',
  '数字人与视频配音/infinitetalk',
  '数字人与视频配音/infinitetalk-shopping-avatar',
]

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

  const stats = { seeded: 0, skipped: 0, failed: 0, pruned: 0, refreshed: 0 }

  console.log('[Seeder] step4: pruneRetired start')
  pruneRetiredBundledSkills(targetSkillsDir, stats)
  console.log('[Seeder] step5: seedDirectory start')
  await seedDirectory(sourceDir, targetSkillsDir, '', stats)
  console.log('[Seeder] step6: seedDirectory done', stats)

  if (stats.failed > 0) {
    log.warn(`${stats.failed} 个技能种子失败，下次启动将重试`)
  } else {
    log.info(
      `种子完成：新增 ${stats.seeded} 个，更新 ${stats.refreshed} 个，跳过 ${stats.skipped} 个（已存在且未改动的才会更新），下线 ${stats.pruned} 个`,
    )
    console.log('[Seeder] step7: writeSeededVersion')
    writeSeededVersion(mtbotDataDir, currentVersion)
  }
  console.log('[Seeder] done')
}

/**
 * 从 workspace/skills 删除已下线的内置技能；分类目录空了也一并去掉
 */
export function pruneRetiredBundledSkills(
  targetSkillsDir: string,
  stats: { pruned: number },
): void {
  for (const relPath of RETIRED_BUNDLED_SKILLS) {
    const dest = path.join(targetSkillsDir, ...relPath.split('/'))
    if (!fs.existsSync(dest)) continue
    try {
      fs.rmSync(dest, { recursive: true, force: true })
      stats.pruned++
      log.info(`已下线技能: ${relPath}`)
      removeEmptyParentDir(dest, targetSkillsDir)
    } catch (err) {
      log.warn(`下线技能失败: ${relPath}`, err)
    }
  }
}

/** 技能删完后，空的分类目录也清掉 */
function removeEmptyParentDir(removedDir: string, skillsRoot: string): void {
  const parent = path.dirname(removedDir)
  if (parent === skillsRoot) return
  try {
    if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent)
  } catch {
    // 目录非空或已不存在
  }
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
  stats: { seeded: number; skipped: number; failed: number; refreshed: number },
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
      if (fs.existsSync(destSubDir)) {
        if (!refreshUnmodifiedSkill(srcSubDir, destSubDir, subRelPath)) {
          stats.skipped++
          continue
        }
        stats.refreshed++
        continue
      }
      try {
        fs.mkdirSync(destDir, { recursive: true })
        console.log('[Seeder] copyDir:', srcSubDir, '->', destSubDir)
        copyDirSync(srcSubDir, destSubDir)
        writeBaseline(destSubDir, srcSubDir)
        console.log('[Seeder] copyDir done:', subRelPath)
        log.info(`已种子技能: ${subRelPath}`)
        stats.seeded++
      } catch (err) {
        log.error(`种子技能失败: ${subRelPath}`, err)
        // 半途失败的目录如果不删掉，下次启动会因为「已存在」而永远跳过它
        // （现在还会因为「没有基线」而跳过），那份技能就再也种不进来了
        try {
          fs.rmSync(destSubDir, { recursive: true, force: true })
        } catch {
          /* 清理失败就算了，至少日志里有记录 */
        }
        stats.failed++
      }
    } else {
      // 这是分类目录，递归处理子目录
      await seedDirectory(srcSubDir, destSubDir, subRelPath, stats)
    }
  }
}

/**
 * 目录内容哈希：按**相对路径排序**后把「路径 + 内容」逐个喂进 sha256。
 *
 * 排序不可省——`readdirSync` 的顺序不保证稳定，不排序会让同一份内容算出两个哈希，
 * 于是「没改过」被误判成「改过」，技能从此不再更新。这也是为什么不能只哈希内容。
 */
export function hashDirectory(dir: string): string {
  const hash = createHash('sha256')
  const walk = (current: string, rel: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      // 基线文件本身不算内容，否则写进去的一刻哈希就变了
      if (entry.name === SKILL_BASELINE_FILENAME) continue
      const abs = path.join(current, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(abs, relPath)
      } else {
        hash.update(relPath)
        hash.update('\0')
        hash.update(fs.readFileSync(abs))
        hash.update('\0')
      }
    }
  }
  walk(dir, '')
  return hash.digest('hex')
}

function writeBaseline(destDir: string, srcDir: string): void {
  try {
    fs.writeFileSync(path.join(destDir, SKILL_BASELINE_FILENAME), hashDirectory(srcDir), 'utf-8')
  } catch (err) {
    // 写不上基线只是「下次会当成用户改过、不再更新」，不影响本次种子
    log.warn(`写基线哈希失败: ${destDir}`, err)
  }
}

/**
 * 已存在的技能目录：没被用户改过就用新版覆盖，改过就保留。
 *
 * @returns 是否刷新了
 */
function refreshUnmodifiedSkill(srcDir: string, destDir: string, relPath: string): boolean {
  const baselinePath = path.join(destDir, SKILL_BASELINE_FILENAME)
  let baseline: string | null = null
  try {
    baseline = fs.readFileSync(baselinePath, 'utf-8').trim()
  } catch {
    // 没有基线：多是这次改动之前种下的老目录。分不清「改过」与「只是旧」，
    // 按保守处理——保留，只记一行日志
    log.info(`技能无基线哈希，按「用户可能改过」保留不更新: ${relPath}`)
    return false
  }

  let current: string
  try {
    current = hashDirectory(destDir)
  } catch (err) {
    log.warn(`计算技能哈希失败，保留不更新: ${relPath}`, err)
    return false
  }

  if (current !== baseline) {
    log.info(`技能已被用户修改，保留不更新: ${relPath}`)
    return false
  }

  try {
    // 先删再拷：新版可能删掉了某些文件，直接覆盖会留下旧文件
    fs.rmSync(destDir, { recursive: true, force: true })
    copyDirSync(srcDir, destDir)
    writeBaseline(destDir, srcDir)
    log.info(`技能未改动，已更新到新版: ${relPath}`)
    return true
  } catch (err) {
    log.error(`更新技能失败: ${relPath}`, err)
    return false
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
