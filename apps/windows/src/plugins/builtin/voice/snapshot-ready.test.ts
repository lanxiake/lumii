/**
 * snapshot 就绪判定：未完成目录不得标为 downloaded
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const DOWNLOAD_COMPLETE_MARKER = '.lumii-complete'

/**
 * 与 model-manager 一致的权重探测（单测内联，避免拉 Electron）
 */
function hasModelWeightFiles(modelDir: string): boolean {
  if (!fs.existsSync(modelDir)) return false
  const entries = fs.readdirSync(modelDir)
  return entries.some((name) => {
    const lower = name.toLowerCase()
    return (
      lower.endsWith('.safetensors') ||
      lower.endsWith('.bin') ||
      lower.endsWith('.onnx') ||
      lower === 'model.safetensors.index.json'
    )
  })
}

/**
 * 判定 dir/snapshot 模型是否真正就绪
 */
function isDirModelReady(modelDir: string, requiredFiles: string[]): boolean {
  if (!fs.existsSync(modelDir)) return false
  const markerOk = fs.existsSync(path.join(modelDir, DOWNLOAD_COMPLETE_MARKER))
  const filesOk = requiredFiles.every((f) => fs.existsSync(path.join(modelDir, f)))
  return markerOk && filesOk && hasModelWeightFiles(modelDir)
}

describe('snapshot 就绪判定', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-snap-ready-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('仅有 config.json 时不得就绪（暂停误判场景）', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), '{}')
    expect(isDirModelReady(tmp, ['config.json'])).toBe(false)
  })

  it('有权重但无完成标记时不得就绪', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), '{}')
    fs.writeFileSync(path.join(tmp, 'model.safetensors'), 'x')
    expect(isDirModelReady(tmp, ['config.json'])).toBe(false)
  })

  it('完成标记 + config + 权重 → 就绪', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), '{}')
    fs.writeFileSync(path.join(tmp, 'model.safetensors'), 'x')
    fs.writeFileSync(path.join(tmp, DOWNLOAD_COMPLETE_MARKER), '{}')
    expect(isDirModelReady(tmp, ['config.json'])).toBe(true)
  })
})
