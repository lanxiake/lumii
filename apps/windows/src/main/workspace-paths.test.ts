/**
 * workspace-paths 单测
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetActiveWorkspaceDirGetterForTest,
  ensureWorkspaceTempLayout,
  resolveActiveWorkspaceDir,
  resolveRecordingsDir,
  resolveScreenshotTempDir,
  resolveWorkspaceTempDir,
  setActiveWorkspaceDirGetter,
} from './workspace-paths'

describe('workspace-paths', () => {
  let ws: string

  afterEach(() => {
    _resetActiveWorkspaceDirGetterForTest()
    if (ws) fs.rmSync(ws, { recursive: true, force: true })
  })

  it('getter 挂在 globalThis 槽位（云同步外部扩展是另一份模块拷贝）', () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-ws-'))
    setActiveWorkspaceDirGetter(() => ws)

    const slot = (globalThis as Record<symbol, unknown>)[
      Symbol.for('lumii.workspace-paths.active-workspace-getter')
    ] as { get: (() => string) | null }
    // 退回模块级变量时，外部 bundle 的那份永远读不到主进程注入的 getter，
    // 会静默同步到默认工作空间（不报错，只是同步了错目录）
    expect(slot?.get?.()).toBe(ws)
  })

  it('跟随注入的工作空间目录，并自动创建 temp/recordings、temp/screenshots', () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-ws-'))
    setActiveWorkspaceDirGetter(() => ws)

    expect(resolveActiveWorkspaceDir()).toBe(path.resolve(ws))

    const tempDir = resolveWorkspaceTempDir()
    expect(tempDir).toBe(path.join(path.resolve(ws), 'temp'))
    expect(fs.existsSync(tempDir)).toBe(true)

    const rec = resolveRecordingsDir()
    expect(rec).toBe(path.join(tempDir, 'recordings'))
    expect(fs.existsSync(rec)).toBe(true)

    const shots = resolveScreenshotTempDir()
    expect(shots).toBe(path.join(tempDir, 'screenshots'))
    expect(fs.existsSync(shots)).toBe(true)
  })

  it('删除 temp 后再次 resolve 会重建', () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-ws-'))
    setActiveWorkspaceDirGetter(() => ws)
    const rec = resolveRecordingsDir()
    fs.rmSync(path.join(ws, 'temp'), { recursive: true, force: true })
    expect(fs.existsSync(rec)).toBe(false)
    const again = resolveRecordingsDir()
    expect(again).toBe(rec)
    expect(fs.existsSync(again)).toBe(true)
  })

  it('ensureWorkspaceTempLayout 对指定根生效', () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-ws-'))
    ensureWorkspaceTempLayout(ws)
    expect(fs.existsSync(path.join(ws, 'temp', 'recordings'))).toBe(true)
    expect(fs.existsSync(path.join(ws, 'temp', 'screenshots'))).toBe(true)
  })
})
