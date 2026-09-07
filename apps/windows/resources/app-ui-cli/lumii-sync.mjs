#!/usr/bin/env node
/**
 * lumii-sync — 云同步数据导出导入 CLI
 *
 * 用法：
 *   node lumii-sync.mjs export [--type profile|wiki|memory|autonomous|all]
 *   node lumii-sync.mjs import [--type profile|wiki|memory|autonomous|all]
 *   node lumii-sync.mjs status
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 用 Node 内置 node:sqlite 包一层 better-sqlite3 风格的构造签名。
 * 与 packages/agent-runtime 的 LocalDatabase 同源，避免原生模块 ABI 版本问题。
 */
function openDb(dbPath, opts = {}) {
  return new DatabaseSync(dbPath, { readOnly: opts.readonly === true })
}

// 解析客户端数据根目录
function resolveDataRoot() {
  const env = process.env.LUMII_CLIENT_DATA_DIR?.trim()
  if (env) {
    if (env.startsWith('~')) {
      return path.resolve(env.replace(/^~(?=$|[/\\])/, os.homedir()))
    }
    return path.resolve(env)
  }
  return path.join(os.homedir(), '.lumii')
}

const LUMII_DIR = resolveDataRoot()
const SYNC_DIR = path.join(LUMII_DIR, 'sync')
const DATA_DIR = path.join(LUMII_DIR, 'data')
const WORKSPACE_DIR = path.join(LUMII_DIR, 'workspace')
const DB_PATH = path.join(DATA_DIR, 'agent-runtime.db')

// 确保目录存在
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// 复制文件
function copyFile(src, dst) {
  ensureDir(path.dirname(dst))
  fs.copyFileSync(src, dst)
}

// 递归复制目录
function copyDir(src, dst, options = {}) {
  if (!fs.existsSync(src)) return 0

  ensureDir(dst)
  let count = 0
  const entries = fs.readdirSync(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)

    if (entry.isDirectory()) {
      count += copyDir(srcPath, dstPath, options)
    } else {
      // 检查文件大小
      if (options.maxSize) {
        const stat = fs.statSync(srcPath)
        if (stat.size > options.maxSize) {
          console.log(`⚠️  跳过大文件: ${srcPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`)
          continue
        }
      }
      copyFile(srcPath, dstPath)
      count++
    }
  }
  return count
}

// ============ 导出函数 ============

function exportProfile() {
  console.log('📝 导出 Profile...')
  const profileDir = path.join(SYNC_DIR, 'profile')
  ensureDir(profileDir)

  // soul.md
  const soulSrc = path.join(DATA_DIR, 'soul.md')
  const soulDst = path.join(profileDir, 'soul.md')
  if (fs.existsSync(soulSrc)) {
    copyFile(soulSrc, soulDst)
    console.log(`  ✅ soul.md (${fs.statSync(soulDst).size} bytes)`)
  } else {
    fs.writeFileSync(soulDst, '# SOUL Who You Are\n\n(待定义)')
    console.log('  ⚠️  soul.md 不存在，创建默认文件')
  }

  // user-memory.md
  const memSrc = path.join(DATA_DIR, 'user-memory.md')
  const memDst = path.join(profileDir, 'user-memory.md')
  if (fs.existsSync(memSrc)) {
    copyFile(memSrc, memDst)
    console.log(`  ✅ user-memory.md (${fs.statSync(memDst).size} bytes)`)
  } else {
    fs.writeFileSync(memDst, '# User Memory\n\n(待记录)')
    console.log('  ⚠️  user-memory.md 不存在，创建默认文件')
  }
}

async function exportWiki() {
  console.log('📚 导出 Wiki...')
  const wikiDir = path.join(SYNC_DIR, 'wiki')
  ensureDir(wikiDir)

  if (!fs.existsSync(DB_PATH)) {
    console.log('  ⚠️  数据库不存在')
    return
  }

  // 使用 node:sqlite 导出
  try {
    const db = openDb(DB_PATH, { readonly: true })

    const wikiTables = [
      'wiki_sources',
      'wiki_pages',
      'wiki_entities',
      'wiki_observations',
      'wiki_relations',
    ]

    const data = {}
    let totalRows = 0

    for (const table of wikiTables) {
      try {
        const rows = db.prepare(`SELECT * FROM ${table}`).all()
        data[table] = rows
        totalRows += rows.length
      } catch (err) {
        console.log(`  ⚠️  表 ${table} 不存在或为空`)
        data[table] = []
      }
    }

    db.close()

    const jsonFile = path.join(wikiDir, 'data.json')
    fs.writeFileSync(jsonFile, JSON.stringify(data, null, 2))
    console.log(`  ✅ Wiki 导出成功 (${totalRows} 行，${(fs.statSync(jsonFile).size / 1024).toFixed(2)} KB)`)
  } catch (err) {
    console.log(`  ❌ Wiki 导出失败: ${err.message}`)
  }
}

async function exportMemories() {
  console.log('🧠 导出记忆...')
  const memoryDir = path.join(SYNC_DIR, 'memory')
  ensureDir(memoryDir)

  if (!fs.existsSync(DB_PATH)) {
    console.log('  ⚠️  数据库不存在')
    return
  }

  try {
    const db = openDb(DB_PATH, { readonly: true })

    const memories = db.prepare(`
      SELECT id, agent_id, user_id, category, content,
             importance, tags, created_at, last_used,
             use_count, is_archived
      FROM agent_memories
      WHERE is_archived = 0
      ORDER BY created_at ASC
    `).all()

    db.close()

    const jsonlFile = path.join(memoryDir, 'agent-memories.jsonl')
    const lines = memories.map((m) => JSON.stringify(m)).join('\n')
    fs.writeFileSync(jsonlFile, lines)
    console.log(`  ✅ 记忆导出成功 (${memories.length} 条)`)
  } catch (err) {
    console.log(`  ❌ 记忆导出失败: ${err.message}`)
  }
}

async function exportAutonomous() {
  console.log('🤖 导出自主进化数据...')
  const autoDir = path.join(SYNC_DIR, 'autonomous')
  ensureDir(autoDir)

  if (!fs.existsSync(DB_PATH)) {
    console.log('  ⚠️  数据库不存在')
    return
  }

  try {
    const db = openDb(DB_PATH, { readonly: true })

    const tables = {
      'autonomous_goals': "WHERE status != 'completed' AND status != 'failed'",
      'autonomous_satisfaction_scores': 'ORDER BY created_at DESC LIMIT 100',
      'autonomous_approval_settings': '',
      'autonomous_diaries': 'ORDER BY created_at DESC LIMIT 50',
    }

    let totalRows = 0

    for (const [table, filter] of Object.entries(tables)) {
      try {
        const rows = db.prepare(`SELECT * FROM ${table} ${filter}`).all()
        const jsonFile = path.join(autoDir, `${table}.json`)
        fs.writeFileSync(jsonFile, JSON.stringify(rows, null, 2))
        totalRows += rows.length
        console.log(`  ✅ ${table}: ${rows.length} 行`)
      } catch (err) {
        console.log(`  ⚠️  表 ${table} 不存在或为空`)
        const jsonFile = path.join(autoDir, `${table}.json`)
        fs.writeFileSync(jsonFile, '[]')
      }
    }

    db.close()
    console.log(`  ✅ 自主数据导出成功 (${totalRows} 行)`)
  } catch (err) {
    console.log(`  ❌ 自主数据导出失败: ${err.message}`)
  }
}

function exportWorkspace() {
  console.log('📁 导出用户文件...')

  const srcFiles = path.join(WORKSPACE_DIR, 'files')
  const dstFiles = path.join(SYNC_DIR, 'workspace/files')
  if (fs.existsSync(srcFiles)) {
    const count = copyDir(srcFiles, dstFiles)
    console.log(`  ✅ workspace/files: ${count} 个文件`)
  } else {
    console.log('  ⚠️  workspace/files 不存在')
  }

  const srcOutputs = path.join(WORKSPACE_DIR, 'outputs')
  const dstOutputs = path.join(SYNC_DIR, 'workspace/outputs')
  if (fs.existsSync(srcOutputs)) {
    const count = copyDir(srcOutputs, dstOutputs, { maxSize: 1 * 1024 * 1024 }) // 1MB
    console.log(`  ✅ workspace/outputs: ${count} 个文件 (<1MB)`)
  } else {
    console.log('  ⚠️  workspace/outputs 不存在')
  }
}

function generateManifest() {
  const manifest = {
    version: '1.0',
    timestamp: new Date().toISOString(),
    generator: 'lumii-sync CLI',
  }

  const manifestFile = path.join(SYNC_DIR, '.sync-manifest.json')
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  console.log(`\n📋 同步清单已生成`)
}

// ============ 导入函数 ============

function importProfile() {
  console.log('📝 导入 Profile...')
  const profileDir = path.join(SYNC_DIR, 'profile')

  if (!fs.existsSync(profileDir)) {
    console.log('  ⚠️  profile 目录不存在')
    return
  }

  const soulSrc = path.join(profileDir, 'soul.md')
  const soulDst = path.join(DATA_DIR, 'soul.md')
  if (fs.existsSync(soulSrc)) {
    copyFile(soulSrc, soulDst)
    console.log(`  ✅ soul.md`)
  }

  const memSrc = path.join(profileDir, 'user-memory.md')
  const memDst = path.join(DATA_DIR, 'user-memory.md')
  if (fs.existsSync(memSrc)) {
    copyFile(memSrc, memDst)
    console.log(`  ✅ user-memory.md`)
  }
}

async function importWiki() {
  console.log('📚 导入 Wiki...')
  const jsonFile = path.join(SYNC_DIR, 'wiki/data.json')

  if (!fs.existsSync(jsonFile)) {
    console.log('  ⚠️  wiki/data.json 不存在')
    return
  }

  try {

    const content = fs.readFileSync(jsonFile, 'utf-8')
    const data = JSON.parse(content)

    let totalRows = 0

    for (const [table, rows] of Object.entries(data)) {
      if (!Array.isArray(rows) || rows.length === 0) continue

      const row = rows[0]
      const columns = Object.keys(row)
      const placeholders = columns.map(() => '?').join(', ')

      const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO ${table} (${columns.join(', ')})
        VALUES (${placeholders})
      `)

      for (const r of rows) {
        const values = columns.map((col) => r[col])
        insertStmt.run(...values)
        totalRows++
      }
    }

    db.close()
    console.log(`  ✅ Wiki 导入成功 (${totalRows} 行)`)
  } catch (err) {
    console.log(`  ❌ Wiki 导入失败: ${err.message}`)
  }
}

async function importMemories() {
  console.log('🧠 导入记忆...')
  const jsonlFile = path.join(SYNC_DIR, 'memory/agent-memories.jsonl')

  if (!fs.existsSync(jsonlFile)) {
    console.log('  ⚠️  agent-memories.jsonl 不存在')
    return
  }

  try {
    const db = openDb(DB_PATH, { readonly: true })

    const lines = content.split('\n').filter((l) => l.trim())

    let imported = 0

    const upsertStmt = db.prepare(`
      INSERT INTO agent_memories (
        id, agent_id, user_id, category, content,
        importance, tags, created_at, last_used,
        use_count, is_archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        importance = excluded.importance,
        last_used = MAX(excluded.last_used, agent_memories.last_used),
        use_count = agent_memories.use_count + excluded.use_count,
        content = excluded.content
    `)

    for (const line of lines) {
      const memory = JSON.parse(line)
      upsertStmt.run(
        memory.id,
        memory.agent_id,
        memory.user_id,
        memory.category,
        memory.content,
        memory.importance,
        memory.tags,
        memory.created_at,
        memory.last_used,
        memory.use_count,
        memory.is_archived,
      )
      imported++
    }

    db.close()
    console.log(`  ✅ 记忆导入成功 (${imported} 条)`)
  } catch (err) {
    console.log(`  ❌ 记忆导入失败: ${err.message}`)
  }
}

async function importAutonomous() {
  console.log('🤖 导入自主进化数据...')
  const autoDir = path.join(SYNC_DIR, 'autonomous')

  if (!fs.existsSync(autoDir)) {
    console.log('  ⚠️  autonomous 目录不存在')
    return
  }

  try {
    const db = openDb(DB_PATH, { readonly: true })

    const files = [
      'autonomous_goals.json',
      'autonomous_satisfaction_scores.json',
      'autonomous_approval_settings.json',
      'autonomous_diaries.json',
    ]

    let imported = 0

    for (const file of files) {
      const filePath = path.join(autoDir, file)
      if (!fs.existsSync(filePath)) continue

      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const rows = JSON.parse(content)
        if (!Array.isArray(rows) || rows.length === 0) continue

        const table = file.replace('.json', '')
        const row = rows[0]
        const columns = Object.keys(row)
        const placeholders = columns.map(() => '?').join(', ')

        const insertStmt = db.prepare(`
          INSERT OR REPLACE INTO ${table} (${columns.join(', ')})
          VALUES (${placeholders})
        `)

        for (const r of rows) {
          const values = columns.map((col) => r[col])
          insertStmt.run(...values)
          imported++
        }
      } catch (err) {
        console.log(`  ⚠️  导入 ${file} 失败: ${err.message}`)
      }
    }

    db.close()
    console.log(`  ✅ 自主数据导入成功 (${imported} 行)`)
  } catch (err) {
    console.log(`  ❌ 自主数据导入失败: ${err.message}`)
  }
}

function importWorkspace() {
  console.log('📁 导入用户文件...')

  const srcFiles = path.join(SYNC_DIR, 'workspace/files')
  const dstFiles = path.join(WORKSPACE_DIR, 'files')
  if (fs.existsSync(srcFiles)) {
    const count = copyDir(srcFiles, dstFiles)
    console.log(`  ✅ workspace/files: ${count} 个文件`)
  } else {
    console.log('  ⚠️  workspace/files 不存在')
  }

  const srcOutputs = path.join(SYNC_DIR, 'workspace/outputs')
  const dstOutputs = path.join(WORKSPACE_DIR, 'outputs')
  if (fs.existsSync(srcOutputs)) {
    const count = copyDir(srcOutputs, dstOutputs)
    console.log(`  ✅ workspace/outputs: ${count} 个文件`)
  } else {
    console.log('  ⚠️  workspace/outputs 不存在')
  }
}

// ============ 状态检查 ============

function showStatus() {
  console.log('📊 云同步状态\n')

  console.log(`🏠 Lumii 目录: ${LUMII_DIR}`)
  console.log(`☁️  Sync 目录: ${SYNC_DIR}`)
  console.log(`💾 数据库: ${DB_PATH}\n`)

  // 检查 sync 目录
  if (fs.existsSync(SYNC_DIR)) {
    console.log('✅ Sync 目录存在')

    // 统计大小
    const size = getFolderSize(SYNC_DIR)
    console.log(`   大小: ${(size / 1024 / 1024).toFixed(2)} MB\n`)

    // 检查各部分
    const parts = ['profile', 'wiki', 'memory', 'autonomous', 'workspace']
    for (const part of parts) {
      const dir = path.join(SYNC_DIR, part)
      if (fs.existsSync(dir)) {
        const size = getFolderSize(dir)
        console.log(`   ✅ ${part}: ${(size / 1024).toFixed(2)} KB`)
      } else {
        console.log(`   ❌ ${part}: 不存在`)
      }
    }

    // 检查 Git
    console.log('')
    const gitDir = path.join(SYNC_DIR, '.git')
    if (fs.existsSync(gitDir)) {
      console.log('✅ Git 仓库已初始化')
      try {
        const result = execSync('git log --oneline -1', { cwd: SYNC_DIR, encoding: 'utf8' })
        console.log(`   最近提交: ${result.trim()}`)
      } catch {
        console.log('   ⚠️  无提交历史')
      }
    } else {
      console.log('❌ Git 仓库未初始化')
    }
  } else {
    console.log('❌ Sync 目录不存在（尚未导出数据）')
  }
}

function getFolderSize(dir) {
  let size = 0
  if (!fs.existsSync(dir)) return 0

  const files = fs.readdirSync(dir)
  for (const file of files) {
    const filePath = path.join(dir, file)
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      if (file !== '.git') {
        size += getFolderSize(filePath)
      }
    } else {
      size += stat.size
    }
  }
  return size
}

// ============ 主逻辑 ============

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]
  const flags = {}

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      const value = args[i + 1]
      if (value && !value.startsWith('--')) {
        flags[key] = value
        i++
      } else {
        flags[key] = true
      }
    }
  }

  const type = flags.type || 'all'

  try {
    if (command === 'export') {
      console.log('🚀 开始导出数据\n')
      ensureDir(SYNC_DIR)

      if (type === 'all' || type === 'profile') await exportProfile()
      if (type === 'all' || type === 'wiki') await exportWiki()
      if (type === 'all' || type === 'memory') await exportMemories()
      if (type === 'all' || type === 'autonomous') await exportAutonomous()
      if (type === 'all') await exportWorkspace()
      if (type === 'all') generateManifest()

      console.log('\n✅ 导出完成')
      console.log(`\n导出目录: ${SYNC_DIR}`)
    } else if (command === 'import') {
      console.log('🚀 开始导入数据\n')

      if (type === 'all' || type === 'profile') await importProfile()
      if (type === 'all' || type === 'wiki') await importWiki()
      if (type === 'all' || type === 'memory') await importMemories()
      if (type === 'all' || type === 'autonomous') await importAutonomous()
      if (type === 'all') await importWorkspace()

      console.log('\n✅ 导入完成')
    } else if (command === 'status') {
      showStatus()
    } else {
      console.log('用法:')
      console.log('  node lumii-sync.mjs export [--type profile|wiki|memory|autonomous|all]')
      console.log('  node lumii-sync.mjs import [--type profile|wiki|memory|autonomous|all]')
      console.log('  node lumii-sync.mjs status')
      process.exit(1)
    }
  } catch (err) {
    console.error(`\n❌ 错误: ${err.message}`)
    console.error(err.stack)
    process.exit(1)
  }
}

main()
