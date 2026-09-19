/**
 * @vitest-environment node
 */
/**
 * 数据根解析的当前行为规格（T3.7 合并前先固定）。
 *
 * 两个函数 `resolveClientStateDir` / `resolveWindowsClientDataRoot` 是逐字重复的
 * 两份实现（连 `expandUserPath` 辅助函数都一样）。按 D20「先补单测再重构」，
 * 这里先把行为钉住——**合并后这些用例必须原样通过**，那就是「行为不变」的证据。
 *
 * 注意两个函数都有**进程级缓存**，一旦被调用过就固定住。因此每个用例都要先
 * `vi.resetModules()` 重新加载模块，否则第二个用例会读到第一个的缓存结果。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'

const originalEnv = process.env.LUMII_CLIENT_DATA_DIR

/** 重新加载模块，绕开进程级缓存 */
async function loadBoth() {
  vi.resetModules()
  const paths = await import('./paths')
  const root = await import('./client-data-root')
  return {
    resolveClientStateDir: paths.resolveClientStateDir,
    resolveWindowsClientDataRoot: root.resolveWindowsClientDataRoot,
  }
}

describe('数据根解析（两个导出名必须一致）', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.LUMII_CLIENT_DATA_DIR
    else process.env.LUMII_CLIENT_DATA_DIR = originalEnv
  })

  it('默认落在 ~/.lumii（两个导出名给同一结果）', async () => {
    delete process.env.LUMII_CLIENT_DATA_DIR
    const { resolveClientStateDir, resolveWindowsClientDataRoot } = await loadBoth()

    const expected = path.join(os.homedir(), '.lumii')
    expect(resolveClientStateDir()).toBe(expected)
    expect(resolveWindowsClientDataRoot()).toBe(expected)
  })

  it('LUMII_CLIENT_DATA_DIR 可覆盖（两个导出名一致）', async () => {
    process.env.LUMII_CLIENT_DATA_DIR = '/custom/data/dir'
    const { resolveClientStateDir, resolveWindowsClientDataRoot } = await loadBoth()

    expect(resolveClientStateDir()).toBe('/custom/data/dir')
    expect(resolveWindowsClientDataRoot()).toBe('/custom/data/dir')
  })

  it('~ 开头按家目录展开', async () => {
    process.env.LUMII_CLIENT_DATA_DIR = '~/my-lumii'
    const { resolveClientStateDir, resolveWindowsClientDataRoot } = await loadBoth()

    const expected = path.join(os.homedir(), 'my-lumii')
    expect(resolveClientStateDir()).toBe(expected)
    expect(resolveWindowsClientDataRoot()).toBe(expected)
  })

  it('相对路径被解析成绝对路径', async () => {
    process.env.LUMII_CLIENT_DATA_DIR = 'relative-data'
    const { resolveClientStateDir } = await loadBoth()

    expect(path.isAbsolute(resolveClientStateDir())).toBe(true)
  })

  it('首尾空白被裁掉，空白值视同未设置', async () => {
    process.env.LUMII_CLIENT_DATA_DIR = '   '
    const { resolveClientStateDir } = await loadBoth()

    expect(resolveClientStateDir()).toBe(path.join(os.homedir(), '.lumii'))
  })

  it('结果被缓存：同一次加载内多次调用返回同一值', async () => {
    delete process.env.LUMII_CLIENT_DATA_DIR
    const { resolveClientStateDir } = await loadBoth()

    const first = resolveClientStateDir()
    // 改变环境变量不会影响已缓存的结果——这是收敛前的既定语义
    process.env.LUMII_CLIENT_DATA_DIR = '/changed/after/cache'
    expect(resolveClientStateDir()).toBe(first)
  })

  it('两个导出名指向同一个实现（合并后仍须满足）', async () => {
    delete process.env.LUMII_CLIENT_DATA_DIR
    const { resolveClientStateDir, resolveWindowsClientDataRoot } = await loadBoth()

    expect(resolveClientStateDir()).toBe(resolveWindowsClientDataRoot())
  })
})
