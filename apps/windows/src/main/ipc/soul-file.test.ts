import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('soul file IO', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'lumii-soul-test-'))
    vi.resetModules()
    process.env.LUMII_CLIENT_DATA_DIR = tempDir
  })

  afterEach(() => {
    delete process.env.LUMII_CLIENT_DATA_DIR
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('writeSoulFile 写入后 readSoulFile 能读回相同内容', async () => {
    const { readSoulFile, writeSoulFile, getSoulFilePath } = await import('./plugin-ipc.js')
    const payload = '# 自定义灵魂\n\n- 更简洁\n'

    const written = await writeSoulFile(payload)
    expect(written?.updatedAt).toBeTruthy()
    expect(existsSync(getSoulFilePath())).toBe(true)
    expect(readFileSync(getSoulFilePath(), 'utf-8')).toBe(payload)

    const loaded = await readSoulFile()
    expect(loaded?.content).toBe(payload)
    expect(loaded?.updatedAt).toBeTruthy()
  })

  it('readSoulFile 在文件不存在时返回 undefined', async () => {
    const { readSoulFile } = await import('./plugin-ipc.js')
    await expect(readSoulFile()).resolves.toBeUndefined()
  })

  /**
   * 热更新链路：系统提示词每轮经 `getSoulContentLive` 同步读盘。
   *
   * 之前宿主没接这条线，用户在「记忆 → AI 灵魂」保存后界面是新内容、
   * 已存在的会话却一直用装配时的旧快照（2026-11-10 实测）。
   */
  it('readSoulContentSync 读到最新写入内容（保存后下一轮即可见）', async () => {
    const { readSoulContentSync, writeSoulFile } = await import('./plugin-ipc.js')

    await expect(readSoulContentSync()).toBeUndefined()

    await writeSoulFile('SOUL_V1')
    expect(readSoulContentSync()).toBe('SOUL_V1')

    await writeSoulFile('SOUL_V2_热更新')
    expect(readSoulContentSync()).toBe('SOUL_V2_热更新')

    // 空文件视为「没设过人格」，回退到默认模板
    await writeSoulFile('   \n  ')
    expect(readSoulContentSync()).toBeUndefined()
  })
})
