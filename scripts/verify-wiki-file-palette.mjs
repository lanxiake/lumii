/**
 * 校验 wikiFileExtDisplay 的令牌映射：每个扩展名的新令牌，其浅色值必须等于
 * 它原来的 hex。不一致就是映射写错了（我已经错过一次：txt 映到了兜底灰）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const RENDERER = path.resolve(import.meta.dirname, '..', 'apps/windows/src/renderer')
const SRC = path.join(RENDERER, 'pages/MemoriesPage/components/wikiFileExtDisplay.ts')
const CSS = fs.readFileSync(path.join(RENDERER, 'styles/design-system.css'), 'utf8')

// 从 git HEAD 取改动前的原文件
const original = execFileSync('git', ['show', `HEAD:apps/windows/src/renderer/pages/MemoriesPage/components/wikiFileExtDisplay.ts`], {
  encoding: 'utf8',
  cwd: path.resolve(import.meta.dirname, '..'),
})

const parseMap = (text, name) => {
  const block = text.match(new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\}`))
  if (!block) return null
  const m = new Map()
  for (const line of block[1].split('\n')) {
    const mm = line.match(/^\s*([a-z0-9.]+):\s*'([^']+)'/)
    if (mm) m.set(mm[1], mm[2])
  }
  return m
}

/** 取某个令牌在 light 块里的值 */
const tokenLight = (tok) => {
  // light 块 = 从 [data-theme="light"] 到下一个 [data-theme 或文件尾
  const start = CSS.indexOf('[data-theme="light"]')
  const rest = CSS.slice(start)
  const nextAt = rest.indexOf('[data-theme=', 10)
  const block = nextAt === -1 ? rest : rest.slice(0, nextAt)
  const m = block.match(new RegExp(`${tok.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`))
  return m ? m[1].trim().toUpperCase() : null
}

let bad = 0
for (const mapName of ['MEDIA_ICON_COLORS', 'EXT_BADGE_COLORS']) {
  const orig = parseMap(original, mapName)
  const now = parseMap(fs.readFileSync(SRC, 'utf8'), mapName)
  if (!orig || !now) {
    console.log(`${mapName}: 解析失败`)
    bad++
    continue
  }
  console.log(`\n=== ${mapName}（${now.size} 项）===`)
  for (const [key, tokStr] of now) {
    const oldHex = (orig.get(key) ?? '').toUpperCase()
    const tok = tokStr.match(/var\((--[\w-]+)\)/)?.[1]
    if (!tok) {
      console.log(`  ✗ ${key}: 不是 var() 形式 → ${tokStr}`)
      bad++
      continue
    }
    const lightVal = tokenLight(tok)
    const ok = lightVal === oldHex
    if (!ok) bad++
    console.log(`  ${ok ? '✓' : '✗'} ${key.padEnd(9)} ${oldHex} → ${tok} (light=${lightVal})`)
  }
}

// 兜底灰
const origDefault = original.match(/DEFAULT_INK = '(#[0-9a-fA-F]{6})'/)?.[1]?.toUpperCase()
const nowDefault = fs.readFileSync(SRC, 'utf8').match(/DEFAULT_INK = 'var\((--[\w-]+)\)'/)?.[1]
const dv = nowDefault ? tokenLight(nowDefault) : null
const dok = dv === origDefault
if (!dok) bad++
console.log(`\n${dok ? '✓' : '✗'} DEFAULT_INK  ${origDefault} → ${nowDefault} (light=${dv})`)

console.log(`\n${bad === 0 ? '✓ 全部映射正确（新令牌的浅色值 == 原 hex）' : `✗ ${bad} 项不匹配`}`)
process.exit(bad === 0 ? 0 : 1)
