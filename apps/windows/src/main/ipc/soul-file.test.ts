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
})
