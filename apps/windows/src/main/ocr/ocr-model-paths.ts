/**
 * OCR 模型 / 运行时路径解析。
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from '../client-data-root.js'
import {
  OCR_MODEL_COMPLETE_MARKER,
  OCR_MODEL_RELATIVE_DIR,
  OCR_ORT_RUNTIME_RELATIVE_DIR,
  OCR_REQUIRED_LOCAL_FILES,
} from './ocr-model-manifest.js'

/**
 * 解析 OCR 模型落盘目录。
 */
export function resolveOcrModelDir(dataRoot = resolveWindowsClientDataRoot()): string {
  return path.join(dataRoot, OCR_MODEL_RELATIVE_DIR)
}

/**
 * 解析 OCR 私有 onnxruntime-node 目录。
 */
export function resolveOcrOrtRuntimeDir(dataRoot = resolveWindowsClientDataRoot()): string {
  return path.join(dataRoot, OCR_ORT_RUNTIME_RELATIVE_DIR)
}

/**
 * 判断模型文件与完成标记是否齐全。
 */
export function isOcrModelReady(modelDir = resolveOcrModelDir()): boolean {
  if (!fs.existsSync(path.join(modelDir, OCR_MODEL_COMPLETE_MARKER))) return false
  return OCR_REQUIRED_LOCAL_FILES.every((name) => fs.existsSync(path.join(modelDir, name)))
}
