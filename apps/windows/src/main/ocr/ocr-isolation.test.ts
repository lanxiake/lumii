/**
 * @vitest-environment node
 *
 * 护栏：OCR 主进程编排不得静态拉入 onnxruntime（避免第三份 DLL 进主进程）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const OCR_DIR = path.join(__dirname)

describe('OCR 主进程隔离护栏', () => {
  it('主进程编排源码不出现 onnxruntime-node / esearch-ocr require', () => {
    const mainOnly = [
      'ocr-service.ts',
      'create-default-ocr-service.ts',
      'ocr-fork-transport.ts',
      'attach-local-ocr.ts',
      'local-ocr-for-recognize.ts',
      'ocr-model-downloader.ts',
      'ocr-scanned-document.ts',
    ]
    for (const file of mainOnly) {
      const src = fs.readFileSync(path.join(OCR_DIR, file), 'utf-8')
      // 允许路径字符串（私有 runtime 目录名），禁止真正 import/require 进主进程
      expect(src, file).not.toMatch(/from ['"]onnxruntime-node['"]/)
      expect(src, file).not.toMatch(/require\(['"]onnxruntime-node['"]\)/)
      expect(src, file).not.toMatch(/from ['"]esearch-ocr['"]/)
      expect(src, file).not.toMatch(/require\(['"]esearch-ocr['"]\)/)
    }
  })

  it('worker 入口才加载推理依赖', () => {
    const worker = fs.readFileSync(path.join(OCR_DIR, 'ocr-worker-main.ts'), 'utf-8')
    expect(worker).toMatch(/esearch-ocr|onnxruntime-node/)
  })
})
