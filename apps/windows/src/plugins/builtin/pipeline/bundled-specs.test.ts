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
  'file_write',
  /** 逆向工具链插件（com.lumii.reverse）提供；关掉插件时该流水线会在第一步失败 */
  'reverse_probe',
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

  /**
   * 描述里不许出现占位符名。
   *
   * 2026-11-02 真机踩到：`exe-clone` 的描述写着「跑之前把 __TARGET__ 与 __SLUG__ 换成真实值」，
   * 用户替换之后这句话变成「跑之前把 C:/…/LiteShell.exe 与 liteshell-clone 换成真实值」——
   * Agent 读完以为自己还没填，回头去查 spec、查目录、查进程，绕了半小时。
   *
   * 占位符名是对**作者**说的，不是对**运行时的读者**说的。替换之后仍然要读得通。
   */
  it.each(dirs)('%s 的描述里不含占位符名（替换后读起来自相矛盾）', (id) => {
    const raw = JSON.parse(readFileSync(join(BUNDLED, id, 'spec.json'), 'utf8'))
    const desc: string = typeof raw.description === 'string' ? raw.description : ''
    const found = desc.match(/__[A-Z][A-Z0-9_]*__/g) ?? []
    expect(found, `description 里出现占位符 ${found.join(', ')}——改成「先替换 spec 里的占位符」这种不点名的说法`).toEqual([])
  })
})
