#!/usr/bin/env node
/**
 * 超大文件行数守卫（棘轮策略）
 *
 * 背景：项目规范要求单文件 ≤800 行，但仓库有 100+ 个存量超标文件，一次性清理不现实。
 * 上一轮重构失败的根因正是"拆完没有门禁"——apps/windows/src/main/agent-runtime/bridge.ts
 * 在 3 周内从 1483 行涨到 2717 行。
 *
 * 因此采用棘轮：**只禁止继续变大**，不要求立即拆分存量。
 * 拆分后运行 --update 收紧基线，门禁随之变严。
 *
 * 用法：
 *   node scripts/check-large-files.mjs           # 检查（CI 用）
 *   node scripts/check-large-files.mjs --update  # 重新记录基线
 *
 * 退出码：0 = 通过，1 = 有文件超出基线
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const BASELINE_PATH = join(ROOT, 'scripts', 'large-files-baseline.json')

/** 触发守卫的行数阈值，对应 AGENTS.md「单文件 800 行」 */
const THRESHOLD = 800
/** 允许的轻微增长，避免正常小改动都要重新基线 */
const ALLOWED_GROWTH = 20

const SCAN_DIRS = [
  'apps/windows/src',
  'packages/agent-runtime/src',
  'packages/browser-control/src',
  'packages/pet-core/src',
]

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'release', '__tests__'])

function isProductionSource(file) {
  if (!file.endsWith('.ts') && !file.endsWith('.tsx')) return false
  if (file.endsWith('.d.ts')) return false
  if (/\.test\.tsx?$/.test(file)) return false
  return true
}

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, acc)
    } else if (isProductionSource(entry.name)) {
      acc.push(full)
    }
  }
  return acc
}

function countLines(file) {
  const content = readFileSync(file, 'utf8')
  if (content.length === 0) return 0
  return content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0)
}

function collect() {
  const result = {}
  for (const dir of SCAN_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const lines = countLines(file)
      if (lines > THRESHOLD) {
        result[relative(ROOT, file).split(sep).join('/')] = lines
      }
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}

const current = collect()

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  const total = Object.values(current).reduce((a, b) => a + b, 0)
  console.log(`已更新基线：${Object.keys(current).length} 个文件超过 ${THRESHOLD} 行，合计 ${total} 行`)
  process.exit(0)
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`缺少基线文件 ${relative(ROOT, BASELINE_PATH)}，请先运行：node scripts/check-large-files.mjs --update`)
  process.exit(1)
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
const failures = []
const improvements = []

for (const [file, lines] of Object.entries(current)) {
  const base = baseline[file]
  if (base === undefined) {
    failures.push(`${file}: ${lines} 行（新增超标文件，阈值 ${THRESHOLD}）`)
  } else if (lines > base + ALLOWED_GROWTH) {
    failures.push(`${file}: ${base} → ${lines} 行（增长 ${lines - base}，允许 ${ALLOWED_GROWTH}）`)
  }
}

for (const [file, base] of Object.entries(baseline)) {
  const lines = current[file]
  if (lines !== undefined && lines < base) {
    improvements.push(`${file}: ${base} → ${lines} 行`)
  }
}

if (improvements.length > 0) {
  console.log('以下文件已变小，建议运行 --update 收紧基线：')
  for (const line of improvements) console.log(`  - ${line}`)
}

if (failures.length > 0) {
  console.error(`\n超大文件守卫失败（${failures.length} 项）：`)
  for (const line of failures) console.error(`  - ${line}`)
  console.error('\n处理方式：拆分该文件；若增长是刻意且合理的，运行 --update 重新基线（会在 diff 中体现）。')
  process.exit(1)
}

console.log(`超大文件守卫通过：${Object.keys(current).length} 个文件超过 ${THRESHOLD} 行，均未超出基线`)
