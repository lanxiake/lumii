/**
 * 验证 agentColor 的稳定性：同名 agent 在改动前后取到**同一数组下标**。
 * 数组长度与顺序不变 → 下标不变 → 同色 invariant 保住。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const REL = 'apps/windows/src/renderer/pages/AgentsPage/views/types.ts'

const extractPalette = (text) => {
  const m = text.match(/const PALETTE = \[([\s\S]*?)\]/)
  if (!m) return null
  // 元素可能一行多个，用全局匹配取引号内的值
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
}

const before = extractPalette(execFileSync('git', ['show', `HEAD:${REL}`], { encoding: 'utf8', cwd: ROOT }))
const after = extractPalette(fs.readFileSync(path.join(ROOT, REL), 'utf8'))

console.log(`改动前调色板长度 ${before.length}：`, before.join(', '))
console.log(`改动后调色板长度 ${after.length}：`, after.join(', '))
console.log(`长度一致：${before.length === after.length ? '✓' : '✗'}\n`)

/** 与源码里相同的哈希 */
const hashOf = (name) => {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  return Math.abs(hash)
}

const NAMES = [
  'assistant', 'code-dev', 'main', 'default', '灵栖', '研究员', '写手',
  'a', 'b', 'test-agent', 'Agent-1', '数据分析师', '产品经理', '运维',
]
let bad = 0
console.log('agent 名            下标  改动前色            改动后令牌')
console.log('─'.repeat(72))
for (const n of NAMES) {
  const i = hashOf(n) % before.length
  const j = hashOf(n) % after.length
  const same = i === j
  if (!same) bad++
  console.log(`${n.padEnd(18)} ${String(i).padStart(3)}  ${before[i].padEnd(18)} ${after[j]}  ${same ? '' : '✗ 下标变了'}`)
}
console.log(`\n${bad === 0 ? '✓ 全部同名 agent 下标不变（同色 invariant 保住）' : `✗ ${bad} 个下标变了`}`)
process.exit(bad === 0 ? 0 : 1)
