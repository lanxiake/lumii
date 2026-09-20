/**
 * 第 10 片静态验证：证明替换的语义等价性。
 *
 * 对每一处替换，验证：令牌在 dark 下的实值 == 被替换掉的字面量。
 * 成立则该处在 dark 主题下视觉零变化，light/eye-care 下自动跟随（这是本片目的）。
 */
import fs from 'node:fs'
import path from 'node:path'

const RENDERER = path.resolve(import.meta.dirname, '..', 'apps/windows/src/renderer')

/** 令牌 → dark 下的期望值（来源：design-system.css 全局固定区） */
const EXPECT = {
  '--mt-error': '#ef4444',
  '--mt-success': '#22c55e',
  '--mt-warning': '#f59e0b',
  '--mt-success-light': '#86efac',
  '--mt-warning-light': '#fde047',
  '--mt-warning-dark': '#b45309',
  '--mt-accent-300': '#93c5fd',
  '--mt-accent-400': '#60a5fa',
  '--mt-accent-500': '#3b82f6',
  '--mt-accent-600': '#2563eb',
  '--mt-accent-700': '#1d4ed8',
  '--mt-violet': '#8b5cf6',
  '--mt-sky-500': '#0ea5e9',
  '--mt-error-rgb': '239, 68, 68',
  '--mt-success-rgb': '34, 197, 94',
  '--mt-warning-rgb': '245, 158, 11',
}

const css = ['design-system.css', 'tokens.css']
  .map((f) => fs.readFileSync(path.join(RENDERER, 'styles', f), 'utf8'))
  .join('\n')
let bad = 0
console.log('令牌                    期望值        实际值        结论')
console.log('─'.repeat(72))
for (const [tok, want] of Object.entries(EXPECT)) {
  // 匹配 `--tok: value;`（取第一处定义，即全局固定区那次）
  const re = new RegExp(`^\\s*${tok.replace(/[-]/g, '\\-')}\\s*:\\s*([^;]+);`, 'm')
  const m = css.match(re)
  const got = m ? m[1].trim() : '(未找到)'
  const ok = got.toLowerCase() === want.toLowerCase()
  if (!ok) bad++
  console.log(`${tok.padEnd(22)} ${want.padEnd(13)} ${got.padEnd(13)} ${ok ? '✓' : '✗ 不匹配'}`)
}
console.log(`\n${bad === 0 ? '✓ 全部匹配 —— 替换在 dark 主题下零视觉变化' : `✗ ${bad} 处不匹配`}`)
process.exit(bad === 0 ? 0 : 1)
