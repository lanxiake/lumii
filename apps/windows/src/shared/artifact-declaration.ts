/**
 * 产物声明的解析与校验（main / renderer 共用，纯函数）。
 *
 * 数据来源两处：
 * 1. 工具结果 `result.details.artifacts`（或 MCP 透传的 `details.structuredContent.artifacts`）；
 * 2. 成品旁边的 `<name>.lumii-artifact.json` 侧车（给没有工具层的技能用，如 PPT）。
 *
 * 这里**只校验形状**；kind/role 的路径规则仍由 artifact-rules.ts 负责。
 */

import type {
  ArtifactDeclaration,
  ArtifactKind,
  ArtifactMeta,
} from '@mtbot/agent-runtime/browser'

export const MAX_DECLARATIONS = 50

const KINDS: ReadonlySet<string> = new Set<ArtifactKind>([
  'image',
  'image-set',
  'video',
  'audio',
  'doc',
  'slides',
  'sheet',
  'site',
  'code',
  'archive',
  'other',
])

/** 工作区相对路径归一化；绝对路径、盘符、`..` 一律拒绝 */
export function normalizeArtifactPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized) return null
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('//')) {
    return null
  }
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..')) return null
  return segments.join('/')
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function sanitizeArtifactMeta(raw: unknown): ArtifactMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Record<string, unknown>
  const meta: ArtifactMeta = {}
  const width = positiveNumber(input.width)
  const height = positiveNumber(input.height)
  const durationSec = positiveNumber(input.durationSec)
  const pages = positiveNumber(input.pages)
  const words = positiveNumber(input.words)
  const bytes = positiveNumber(input.bytes)
  const model = readText(input.model)
  const prompt = readText(input.prompt)
  if (width !== undefined) meta.width = width
  if (height !== undefined) meta.height = height
  if (durationSec !== undefined) meta.durationSec = durationSec
  if (pages !== undefined) meta.pages = pages
  if (words !== undefined) meta.words = words
  if (bytes !== undefined) meta.bytes = bytes
  if (model !== undefined) meta.model = model
  if (prompt !== undefined) meta.prompt = prompt
  if (input.params && typeof input.params === 'object' && !Array.isArray(input.params)) {
    const params: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(input.params as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'boolean') params[key] = value
      else if (typeof value === 'number' && Number.isFinite(value)) params[key] = value
    }
    if (Object.keys(params).length > 0) meta.params = params
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}

function sanitizeDeclaration(raw: unknown): ArtifactDeclaration | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const kind = typeof input.kind === 'string' && KINDS.has(input.kind) ? (input.kind as ArtifactKind) : null
  if (!kind) return null
  const path = normalizeArtifactPath(input.path)
  const remoteUrl = typeof input.remoteUrl === 'string' ? input.remoteUrl : undefined
  if (!path && !remoteUrl) return null
  const role =
    input.role === 'deliverable' || input.role === 'intermediate' ? input.role : undefined
  const declaration: ArtifactDeclaration = { kind }
  if (path) declaration.path = path
  if (remoteUrl) declaration.remoteUrl = remoteUrl
  if (role) declaration.role = role
  const title = readText(input.title)
  if (title) declaration.title = title
  const cover = normalizeArtifactPath(input.cover)
  if (cover) declaration.cover = cover
  const meta = sanitizeArtifactMeta(input.meta)
  if (meta) declaration.meta = meta
  return declaration
}

/** 从工具结果里读声明；`details` 缺失/形状不对时返回空数组（派生兜底） */
export function readDeclarations(result: unknown): ArtifactDeclaration[] {
  if (!result || typeof result !== 'object') return []
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return []
  const record = details as Record<string, unknown>

  const candidates: unknown[] = []
  if (Array.isArray(record.artifacts)) candidates.push(...record.artifacts)
  // MCP proxy 透传的 structuredContent（可选通道）
  const structured = record.structuredContent
  if (structured && typeof structured === 'object') {
    const nested = (structured as Record<string, unknown>).artifacts
    if (Array.isArray(nested)) candidates.push(...nested)
  }

  const out: ArtifactDeclaration[] = []
  for (const candidate of candidates.slice(0, MAX_DECLARATIONS)) {
    const declaration = sanitizeDeclaration(candidate)
    if (declaration) out.push(declaration)
  }
  return out
}

/** 侧车 `<name>.lumii-artifact.json` 的内容 */
export interface ArtifactSidecar {
  kind?: ArtifactKind
  title?: string
  meta?: ArtifactMeta
}

export function parseSidecar(text: string): ArtifactSidecar | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const sidecar: ArtifactSidecar = {}
    if (typeof record.kind === 'string' && KINDS.has(record.kind)) {
      sidecar.kind = record.kind as ArtifactKind
    }
    const title = readText(record.title)
    if (title) sidecar.title = title
    const meta = sanitizeArtifactMeta(record.meta)
    if (meta) sidecar.meta = meta
    return Object.keys(sidecar).length > 0 ? sidecar : null
  } catch {
    return null
  }
}

/** 侧车文件名：`a.pptx` → `a.pptx.lumii-artifact.json` */
export function sidecarPathFor(relativePath: string): string {
  return `${relativePath}.lumii-artifact.json`
}
