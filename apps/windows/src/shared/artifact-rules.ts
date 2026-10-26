/**
 * 产物分类规则的**唯一实现**（main / renderer 共用）。
 *
 * - 工作台 rail 用它区分成品 / 中间产物；
 * - 清理服务用它决定「哪些能删」（认不出的一律 deliverable，策略保守）；
 * - 技能规范（P1）只描述规则，不另写一份代码。
 *
 * 纯函数、无 IO，路径一律是**工作区相对路径**（posix 分隔）。
 */

import type { ArtifactKind } from '@mtbot/agent-runtime/browser'

export type ArtifactRole = 'deliverable' | 'intermediate' | 'ephemeral' | 'internal'

export interface ClassifyInput {
  path: string
}

/** kind 的联合类型只有一份（agent-runtime 契约），这里只做扩展名映射 */
export type { ArtifactKind }

const INTERNAL_SEGMENTS = new Set(['.git', 'node_modules', '.cache', '.lumii'])
const INTERNAL_SUFFIXES = ['.lumii-ref', '.tmp', '.lumii-artifact.json']
/** 中间产物目录段：parts / parts-10 / normalized / frames */
const INTERMEDIATE_SEGMENT = /^parts[^/]*$|^normalized$|^frames$/
/** 中间产物文件名：cut-13.png（只认词根，不命中 cutting-board.png） */
const INTERMEDIATE_FILE = /^cut-/

/** 取小写扩展名（无扩展名返回空串） */
export function extOf(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

function segmentsOf(filePath: string): string[] {
  return filePath.split('/').filter(Boolean)
}

function isHidden(segment: string): boolean {
  return segment.startsWith('.') && segment.length > 1
}

export function classifyArtifact(input: ClassifyInput): ArtifactRole {
  const path = input.path.replace(/\\/g, '/')
  const segments = segmentsOf(path)
  const base = segments[segments.length - 1] ?? ''

  // 临时目录优先：temp/ 下无论什么扩展名都是可再生的
  if (segments[0] === 'temp') return 'ephemeral'

  for (const segment of segments) {
    if (INTERNAL_SEGMENTS.has(segment) || isHidden(segment)) return 'internal'
  }
  for (const suffix of INTERNAL_SUFFIXES) {
    if (base.toLowerCase().endsWith(suffix)) return 'internal'
  }

  for (const segment of segments) {
    if (INTERMEDIATE_SEGMENT.test(segment)) return 'intermediate'
  }
  if (INTERMEDIATE_FILE.test(base)) return 'intermediate'

  return 'deliverable'
}

const EXT_KIND: Record<string, ArtifactKind> = {
  // 图片
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  svg: 'image',
  // 视频
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mkv: 'video',
  avi: 'video',
  // 音频
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  flac: 'audio',
  aac: 'audio',
  // 文档
  md: 'doc',
  mdx: 'doc',
  txt: 'doc',
  pdf: 'doc',
  doc: 'doc',
  docx: 'doc',
  // 幻灯片 / 表格
  ppt: 'slides',
  pptx: 'slides',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  // 站点
  html: 'site',
  htm: 'site',
  // 代码
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  py: 'code',
  rs: 'code',
  go: 'code',
  java: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  cs: 'code',
  sh: 'code',
  json: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  xml: 'code',
  css: 'code',
  scss: 'code',
  less: 'code',
  sql: 'code',
  lua: 'code',
  rb: 'code',
  php: 'code',
  swift: 'code',
  kt: 'code',
  vue: 'code',
  astro: 'code',
  // 归档
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  rar: 'archive',
  '7z': 'archive',
}

export function kindOf(filePath: string): ArtifactKind {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'other'
  return EXT_KIND[base.slice(dot + 1).toLowerCase()] ?? 'other'
}

/**
 * 工具名 → 用户能懂的阶段名。
 * 认不出返回 undefined：UI 只显示「执行中」，**不猜**。
 */
export function stageOfTool(toolName: string): string | undefined {
  const name = toolName.toLowerCase()
  if (name.includes('image_generate') || name.includes('image_edit')) return '生成图片'
  if (name.includes('enqueue_workflow') || name.includes('comfyui')) return '渲染视频'
  if (name.includes('ffmpeg')) return '编码视频'
  if (name.includes('pptx') || name.includes('slide')) return '生成幻灯片'
  // 只认写文件类工具名：`todo_write` 不是「撰写文档」
  const isWriteTool =
    name === 'write' ||
    name === 'write_file' ||
    name === 'edit' ||
    name === 'edit_file' ||
    name === 'apply_patch' ||
    name.endsWith('__write') ||
    name.endsWith('__edit')
  if (isWriteTool) return '撰写文档'
  if (name.includes('bash') || name.includes('exec') || name.includes('shell')) return '执行命令'
  if (
    name.includes('read') ||
    name.includes('glob') ||
    name.includes('grep') ||
    name.includes('search')
  ) {
    return '读取资料'
  }
  return undefined
}

/** 中间产物折叠阈值：低于它按成品展示，避免「3 个也算中间」的过度折叠 */
export const INTERMEDIATE_FOLD_THRESHOLD = 20
