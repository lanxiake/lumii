#!/usr/bin/env node
/**
 * 将仓库 docs/guide/*.md 与 assets/ 同步到 apps/windows/resources/user-guides/，并生成 manifest.json。
 *
 * 用法：node apps/windows/scripts/sync-user-guides.mjs
 * 在 prebuild / dev 前执行，保证安装包与开发环境使用同一份内置手册。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(APP_ROOT, '../..')
const SOURCE_DIR = path.join(REPO_ROOT, 'docs', 'guide')
const TARGET_DIR = path.join(APP_ROOT, 'resources', 'user-guides')
const ASSETS_DIR_NAME = 'assets'

/** 手册元数据（新增指南在此登记） */
const GUIDE_CATALOG = [
  {
    id: 'desktop',
    source: 'Lumii-Desktop-User-Guide.md',
    title: 'Lumii 桌面助手使用指南',
    category: 'getting-started',
    description: '新用户入门：界面布局、必须配置、核心功能与故障排查',
    tags: ['入门', '桌面', '设置', '聊天'],
    /** 后续可设为 true，启动时写入 Wiki 内置分类 */
    seedToWiki: false,
  },
  {
    id: 'wiki',
    source: 'wiki-user-guide.md',
    title: 'Wiki 资料库使用手册',
    category: 'memory',
    description: '资料库界面、待整理、分类、搜索与 Agent 整理流程',
    tags: ['wiki', '资料库', '记忆'],
    seedToWiki: false,
  },
]

/**
 * 同步单个指南文件到 resources/user-guides/
 */
function syncGuide(entry) {
  const src = path.join(SOURCE_DIR, entry.source)
  if (!fs.existsSync(src)) {
    throw new Error(`指南源文件不存在: ${src}`)
  }
  const dest = path.join(TARGET_DIR, entry.source)
  fs.copyFileSync(src, dest)
  const stat = fs.statSync(dest)
  return {
    id: entry.id,
    title: entry.title,
    category: entry.category,
    description: entry.description,
    tags: entry.tags,
    file: entry.source,
    seedToWiki: entry.seedToWiki === true,
    updatedAt: stat.mtime.toISOString(),
  }
}

/**
 * 同步 docs/guide/assets 到 resources/user-guides/assets（截图等静态资源）
 */
function syncAssets() {
  const srcAssets = path.join(SOURCE_DIR, ASSETS_DIR_NAME)
  const destAssets = path.join(TARGET_DIR, ASSETS_DIR_NAME)
  if (!fs.existsSync(srcAssets)) {
    return 0
  }
  fs.cpSync(srcAssets, destAssets, { recursive: true })
  return fs.readdirSync(destAssets).filter((name) => {
    return fs.statSync(path.join(destAssets, name)).isFile()
  }).length
}

/**
 * 读现有 manifest 里**内容没变时可以沿用**的 generatedAt。
 *
 * 为什么不是每次都写 `new Date()`：这个字段运行时**没有任何消费方**（`user-guides-service`
 * 只读 `guides`），但每构建一次就会在 git 里制造一处假改动，多个会话并行构建时还会
 * 在 rebase 里撞冲突（2026-10-31 实撞过一次）。改成「内容变才更新」后，字段语义也
 * 更准确：它记的是最后一次**内容变更**，而不是最后一次构建。
 */
function readPreviousManifest() {
  const file = path.join(TARGET_DIR, 'manifest.json')
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return { raw, data: JSON.parse(raw) }
  } catch {
    return { raw: null, data: null }
  }
}

function main() {
  fs.mkdirSync(TARGET_DIR, { recursive: true })
  const guides = GUIDE_CATALOG.map(syncGuide)
  const assetCount = syncAssets()
  const prev = readPreviousManifest()

  // generatedAt 记「最后一次**内容**变更」，不是「最后一次构建」：
  // 它运行时没有任何消费方（user-guides-service 只读 guides），每构建一次都变
  // 只会在 git 里制造假改动、并在并行会话的 rebase 里撞冲突（2026-10-31 实撞过）。
  const generatedAt =
    prev.data && JSON.stringify(prev.data.guides) === JSON.stringify(guides) && typeof prev.data.generatedAt === 'string'
      ? prev.data.generatedAt
      : new Date().toISOString()

  const manifest = { version: 1, generatedAt, guides }
  const json = `${JSON.stringify(manifest, null, 2)}\n`
  // **沿用现有文件的行尾**。本仓库 core.autocrlf=true：检出是 CRLF，而脚本若固定写 LF，
  // `git status` 会一直显示「已修改」但 `git diff` 是空的（纯行尾差异），
  // 每次构建后都要手动 add 一次才消失。首次生成时按平台默认（Windows → CRLF）。
  const eol = prev.raw ? (prev.raw.includes('\r\n') ? '\r\n' : '\n') : process.platform === 'win32' ? '\r\n' : '\n'
  fs.writeFileSync(path.join(TARGET_DIR, 'manifest.json'), eol === '\n' ? json : json.replace(/\n/g, eol), 'utf8')
  console.log(
    `[sync-user-guides] 已同步 ${guides.length} 份指南、${assetCount} 个资源 → ${TARGET_DIR}`,
  )
}

main()
