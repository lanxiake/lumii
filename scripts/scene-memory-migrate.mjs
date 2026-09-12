#!/usr/bin/env node
/**
 * 场景记忆存量迁移（一次性辅助工具）
 *
 * 把 user-memory.md 中「仅对某个项目/技能成立」的条目迁移到场景记忆文件：
 * - 有目录项目：<项目目录>/.lumii/memory.md
 * - 无目录项目：<dataRoot>/data/scene-memory/project-<key>.md
 * 路径规则与 apps/windows/src/main/agent-runtime/scene-memory-store.ts 保持一致。
 *
 * 用法：
 *   node scripts/scene-memory-migrate.mjs                        # dry-run：列出候选条目，生成 plan 模板
 *   node scripts/scene-memory-migrate.mjs --plan <file.json>     # 预览将执行的操作（不写入）
 *   node scripts/scene-memory-migrate.mjs --plan <file.json> --apply   # 执行（写前自动 .bak 备份）
 *
 * plan 文件格式：
 * {
 *   "migrations": [
 *     { "section": "项目偏好", "match": "二十四史", "key": "二十四史学习规划", "name": "二十四史学习规划", "aliases": ["二十四史"] },
 *     { "section": "项目偏好", "match": "picture-book-studio", "key": "picture-book-studio", "name": "picture-book-studio", "path": "E:/some/repo" }
 *   ]
 * }
 * - section：全局文件中被迁移条目所在的 `## ` 节标题（子串匹配）
 * - match：被迁移条目的特征子串（`- ` 条目行包含它）
 * - key：场景键（文件名 slug，中文/字母数字/连字符）
 * - aliases：可选，消息命中别名（对话中出现即加载该场景记忆；项目名较长时建议给简称）
 * - path：可选，项目目录；提供时写入 <path>/.lumii/memory.md
 * apply 时会同步登记注册表（_registry.json），否则命中解析找不到该场景。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const log = (msg) => console.log(`[scene-migrate] ${msg}`)

function resolveDataRoot() {
  const env = process.env.LUMII_CLIENT_DATA_DIR?.trim()
  if (env) return path.resolve(env.startsWith('~') ? env.replace(/^~/, os.homedir()) : env)
  return path.join(os.homedir(), '.lumii')
}

function userMemoryPath(dataRoot) {
  return path.join(dataRoot, 'data', 'user-memory.md')
}

function sceneFilePath(dataRoot, key, projectPath) {
  if (projectPath) return path.join(projectPath, '.lumii', 'memory.md')
  return path.join(dataRoot, 'data', 'scene-memory', `project-${key}.md`)
}

function registryPath(dataRoot) {
  return path.join(dataRoot, 'data', 'scene-memory', '_registry.json')
}

/**
 * 登记/更新注册表项目（命中匹配依赖注册表；与 scene-memory-store.ts 的
 * ProjectEntry 结构保持一致）。
 */
function upsertRegistryProject(dataRoot, migration) {
  const p = registryPath(dataRoot)
  let registry = { projects: [] }
  if (fs.existsSync(p)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'))
      if (parsed && Array.isArray(parsed.projects)) registry = parsed
    } catch {
      registry = { projects: [] }
    }
  }
  const aliases = Array.from(
    new Set(
      [migration.name, ...(migration.aliases ?? []), ...(migration.path ? [migration.path] : [])].filter(
        Boolean,
      ),
    ),
  )
  const existing = registry.projects.find((x) => x.key === migration.key)
  if (existing) {
    existing.aliases = Array.from(new Set([...(existing.aliases ?? []), ...aliases]))
    existing.lastActiveAt = Date.now()
  } else {
    registry.projects.push({
      key: migration.key,
      name: migration.name,
      aliases,
      path: migration.path ?? null,
      lastActiveAt: Date.now(),
    })
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(registry, null, 2) + '\n', 'utf-8')
  return aliases
}

/** 按 `## ` 标题切分（返回 [{ title|null, lines }]） */
function splitSections(content) {
  const lines = content.split(/\r?\n/)
  const sections = []
  let current = { title: null, lines: [] }
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line)
    if (m) {
      sections.push(current)
      current = { title: m[1].trim(), lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  sections.push(current)
  return sections
}

function parseArgs(argv) {
  const args = { plan: null, apply: false }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--plan') args.plan = argv[++i]
    else if (argv[i] === '--apply') args.apply = true
  }
  return args
}

function dryRun(dataRoot, content) {
  const sections = splitSections(content)
  log(`个人记忆文件：${userMemoryPath(dataRoot)}`)
  log(`共 ${sections.length} 个分节。各节条目如下（请为「仅对某项目/技能成立」的条目生成迁移 plan）：`)
  console.log('')
  for (const s of sections) {
    if (!s.title) continue
    const items = s.lines.filter((l) => /^\s*-\s+/.test(l))
    console.log(`## ${s.title}（${items.length} 条）`)
    for (const item of items) {
      const text = item.replace(/^\s*-\s+/, '')
      console.log(`  - ${text.length > 80 ? text.slice(0, 80) + '…' : text}`)
    }
    console.log('')
  }
  const template = {
    migrations: [
      {
        section: '项目偏好',
        match: '（待迁移条目的特征子串）',
        key: '（场景键 slug）',
        name: '（显示名）',
      },
    ],
  }
  log('填写迁移计划文件后可执行：--plan <file> 预览，再加 --apply 落盘。模板：')
  console.log('')
  console.log(JSON.stringify(template, null, 2))
}

function loadPlan(planPath) {
  const raw = fs.readFileSync(path.resolve(planPath), 'utf-8')
  const plan = JSON.parse(raw)
  if (!Array.isArray(plan.migrations) || plan.migrations.length === 0) {
    throw new Error('plan.migrations 为空')
  }
  for (const m of plan.migrations) {
    if (!m.section || !m.match || !m.key || !m.name) {
      throw new Error(`plan 条目缺少字段：${JSON.stringify(m)}`)
    }
  }
  return plan
}

function runMigration(dataRoot, content, plan, apply) {
  const sections = splitSections(content)
  const moved = [] // { migration, entries[] }
  const newSections = sections.map((s) => ({ title: s.title, lines: [...s.lines] }))

  for (const m of plan.migrations) {
    const section = newSections.find((s) => s.title && s.title.includes(m.section))
    if (!section) throw new Error(`未找到分节：## ${m.section}`)

    const entries = []
    const kept = []
    for (const line of section.lines) {
      if (/^\s*-\s+/.test(line) && line.includes(m.match)) {
        entries.push(line.trim())
      } else {
        kept.push(line)
      }
    }
    if (entries.length === 0) throw new Error(`分节「${m.section}」中未找到包含「${m.match}」的条目`)

    const hasContent = kept.some((l) => l.trim() && !/^##\s+/.test(l))
    section.lines = hasContent ? kept : []
    moved.push({ migration: m, entries })
  }

  // 重建全局文件（去掉变空的节及其多余空行）
  const rebuilt = []
  for (const s of newSections) {
    if (s.title === null && s.lines.every((l) => !l.trim())) continue
    if (s.title !== null && s.lines.length === 0) continue
    if (s.title !== null) rebuilt.push(s.lines.join('\n'))
    else rebuilt.push(s.lines.join('\n'))
  }
  let nextContent = rebuilt.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'

  console.log('')
  log('===== 迁移计划 =====')
  for (const { migration, entries } of moved) {
    const target = sceneFilePath(dataRoot, migration.key, migration.path ?? null)
    const aliases = [migration.name, ...(migration.aliases ?? [])].join('、')
    console.log(`\n→ 目标场景：${migration.name}（${target}）`)
    console.log(`   命中别名（消息中出现即加载）：${aliases}`)
    for (const e of entries) console.log(`   迁移: ${e.length > 90 ? e.slice(0, 90) + '…' : e}`)
  }
  console.log('\n===== 全局文件变化预览 =====')
  console.log(nextContent)

  if (!apply) {
    log('以上为预览（未写入）。确认无误后加 --apply 执行。')
    return
  }

  // 执行写入
  const umPath = userMemoryPath(dataRoot)
  if (fs.existsSync(umPath)) fs.copyFileSync(umPath, `${umPath}.bak`)

  for (const { migration, entries } of moved) {
    const target = sceneFilePath(dataRoot, migration.key, migration.path ?? null)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak`)
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8').trimEnd() : ''
    const block = `## 约定\n\n${entries.join('\n')}\n`
    const next = existing ? `${existing}\n\n${block}` : block
    fs.writeFileSync(target, next, 'utf-8')
    const aliases = upsertRegistryProject(dataRoot, migration)
    log(`已写入场景文件：${target}（+${entries.length} 条；命中别名：${aliases.join('、')}）`)
  }

  fs.writeFileSync(umPath, nextContent, 'utf-8')
  log(`已更新全局个人记忆（旧内容备份于 ${umPath}.bak）`)
  log('迁移完成。')
}

function main() {
  const args = parseArgs(process.argv)
  const dataRoot = resolveDataRoot()
  const umPath = userMemoryPath(dataRoot)

  if (!fs.existsSync(umPath)) {
    log(`未找到个人记忆文件：${umPath}`)
    process.exit(1)
  }
  const content = fs.readFileSync(umPath, 'utf-8')

  if (!args.plan) {
    dryRun(dataRoot, content)
    return
  }
  const plan = loadPlan(args.plan)
  runMigration(dataRoot, content, plan, args.apply)
}

main()
