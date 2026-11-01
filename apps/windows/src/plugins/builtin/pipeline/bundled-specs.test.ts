/**
 * 内置流水线 spec 的加载期守卫。
 *
 * 播种只认目录名，spec 坏了不会报错——UI 只会显示「spec 坏了」。这里在 CI 里
 * 用真实校验器跑一遍，保证随包发布的 spec 至少能通过未知工具 / 前向引用 / 空步骤三道检查。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateSpec } from './spec'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLED = join(HERE, '..', '..', '..', '..', 'bundled-pipelines')

/** web-clone-evidence 用到的工具；与 bridge-browser-tools.ts 的注册名保持一致 */
const BROWSER_TOOLS = new Set([
  'browser_navigate',
  'browser_screenshot',
  'browser_set_device',
  'browser_requests',
  'browser_eval',
])

describe('bundled-pipelines/web-clone-evidence', () => {
  it('spec 能通过加载期校验（工具名存在、无前向引用、步骤非空）', () => {
    const raw = JSON.parse(
      readFileSync(join(BUNDLED, 'web-clone-evidence', 'spec.json'), 'utf8'),
    )
    const v = validateSpec(raw, BROWSER_TOOLS)
    expect(v.ok ? undefined : v.errors).toBeUndefined()
  })
})
