/**
 * @vitest-environment node
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  downloadOcrModelsIfNeeded,
  ensureOcrModelsReady,
  resolveOcrMirrorBase,
} from './ocr-model-downloader.js'
import { OCR_MODEL_COMPLETE_MARKER, OCR_REQUIRED_LOCAL_FILES } from './ocr-model-manifest.js'

describe('ocr-model-downloader', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    vi.unstubAllEnvs()
  })

  /**
   * 创建临时模型根目录。
   */
  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-ocr-'))
    dirs.push(dir)
    return dir
  }

  it('resolveOcrMirrorBase 优先 LUMII_HF_ENDPOINT', () => {
    vi.stubEnv('LUMII_HF_ENDPOINT', 'https://example.test/')
    expect(resolveOcrMirrorBase()).toBe('https://example.test')
  })

  it('已就绪时 downloadOcrModelsIfNeeded 返回 false 且不调用下载', async () => {
    const modelDir = makeTempDir()
    for (const name of OCR_REQUIRED_LOCAL_FILES) {
      fs.writeFileSync(path.join(modelDir, name), 'x')
    }
    fs.writeFileSync(path.join(modelDir, OCR_MODEL_COMPLETE_MARKER), 'ok')

    const downloadFile = vi.fn()
    const downloaded = await downloadOcrModelsIfNeeded({
      modelDir,
      downloadFile,
    })
    expect(downloaded).toBe(false)
    expect(downloadFile).not.toHaveBeenCalled()
  })

  it('缺失时按清单下载并写完成标记', async () => {
    const modelDir = makeTempDir()
    const downloadFile = vi.fn(async (_url: string, dest: string) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, 'model-bytes')
    })

    const downloaded = await downloadOcrModelsIfNeeded({
      modelDir,
      downloadFile,
      mirrorBase: 'https://hf-mirror.com',
    })
    expect(downloaded).toBe(true)
    expect(downloadFile).toHaveBeenCalled()
    for (const name of OCR_REQUIRED_LOCAL_FILES) {
      expect(fs.existsSync(path.join(modelDir, name))).toBe(true)
    }
    expect(fs.existsSync(path.join(modelDir, OCR_MODEL_COMPLETE_MARKER))).toBe(true)
  })

  it('ensureOcrModelsReady 在下载后仍缺文件时抛错', async () => {
    const modelDir = makeTempDir()
    await expect(
      ensureOcrModelsReady({
        modelDir,
        downloadFile: async () => {
          /* 故意不写文件 */
        },
        mirrorBase: 'https://hf-mirror.com',
      }),
    ).rejects.toThrow(/缺失|未就绪/)
  })
})
