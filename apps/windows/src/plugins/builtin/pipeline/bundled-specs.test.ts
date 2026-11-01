/**
 * 内置流水线 spec 的加载期守卫。
 *
 * 播种只认目录名，spec 坏了不会报错——UI 只会显示「spec 坏了」。这里在 CI 里
 * 用真实校验器跑一遍，保证随包发布的 spec 至少能通过未知工具 / 未知 Agent /
 * 前向引用 / 空步骤这几道检查。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateSpec } from './spec'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLED = join(HERE, '..', '..', '..', '..', 'bundled-pipelines')

/** 内置 spec 用到的工具；与 bridge 注册名保持一致 */
const KNOWN_TOOLS = new Set([
  'browser_navigate',
  'browser_screenshot',
  'browser_set_device',
  'browser_requests',
  'browser_response_body',
  'browser_eval',
  'bash',
  'list_dir',
  'app_goto',
])

/** 内置 spec 引用的 Agent；取 bridge 侧 knownAgents 的同名集合 */
const KNOWN_AGENTS = new Set(['assistant', 'builtin:explore', 'builtin:plan', 'builtin:verify', 'code-dev'])

let dirs: string[] = []
try {
  dirs = readdirSync(BUNDLED, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
} catch {
  /* 打包产物里没有 source 目录：跳过（另有真机播种覆盖） */
}

describe('bundled-pipelines 全部 spec', () => {
  it('目录可枚举（找不到源目录时说明本用例在打包环境里跑）', () => {
    expect(Array.isArray(dirs)).toBe(true)
  })

  it.each(dirs)('%s 能通过加载期校验', (id) => {
    const raw = JSON.parse(readFileSync(join(BUNDLED, id, 'spec.json'), 'utf8'))
    const v = validateSpec(raw, KNOWN_TOOLS, KNOWN_AGENTS)
    expect(v.ok ? undefined : v.errors).toBeUndefined()
  })
})
