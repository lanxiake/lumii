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

function main() {
  fs.mkdirSync(TARGET_DIR, { recursive: true })
  const guides = GUIDE_CATALOG.map(syncGuide)
  const assetCount = syncAssets()
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    guides,
  }
  fs.writeFileSync(path.join(TARGET_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(
    `[sync-user-guides] 已同步 ${guides.length} 份指南、${assetCount} 个资源 → ${TARGET_DIR}`,
  )
}

main()
