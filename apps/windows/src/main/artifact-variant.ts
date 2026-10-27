/**
 * 图片同源变体（P2 T5）
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §4 / T5
 *
 * 只做「同 prompt / 模型 / 尺寸再生成一张」：产出落**源图同目录**的新文件，
 * 登记一条本地编辑索引（action=variant、derivedFrom=源路径）。
 * 不提供 seed / 局部重绘 / 扩图 / 去背景（D9：本机没有这些参数）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ArtifactEditFailure } from '../shared/artifact-edit-types'
import type {
  ArtifactVariantResult,
  CreateVariantInput,
} from '../shared/artifact-variant-types'
import { kindOf } from '../shared/artifact-rules'
import { recordVariantEdit, resolveEditTarget } from './artifact-edit'

const MAX_PROMPT_CHARS = 4000
const MAX_INSTRUCTION_CHARS = 500
const MAX_DIMENSION = 8192
const MAX_NAME_ATTEMPTS = 50

export interface GenerateImageInfo {
  filePath: string
  width: number
  height: number
  model: string
  revisedPrompt: string
}

export interface GenerateImageParams {
  prompt: string
  modelId: string
  width?: number
  height?: number
  /** 工作区相对目录 */
  outputDir?: string
}

function fail(
  error: string,
  code: ArtifactEditFailure['code'] = 'unavailable',
): ArtifactEditFailure {
  return { ok: false, error, code }
}

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时间 HHmmss（文件名里给人看的时间） */
function clockStamp(date: Date): string {
  return `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

function dimension(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_DIMENSION
    ? value
    : undefined
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs)
    return true
  } catch {
    return false
  }
}

/** 同目录 `-variant-<HHmmss>`；重名加序号 */
async function pickVariantName(
  dirAbs: string,
  base: string,
  ext: string,
  stamp: string,
): Promise<{ name: string; abs: string }> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`
    const name = `${base}-variant-${stamp}${suffix}${ext}`
    const abs = path.join(dirAbs, name)
    if (!(await exists(abs))) return { name, abs }
  }
  throw Object.assign(new Error('同目录下同名变体过多，请稍后再试'), {
    code: 'NAME_CONFLICT',
  })
}

/**
 * 生成一张同源变体。
 *
 * `generateImage` 由 IPC 层注入（bridge.generateImage），便于单测替换。
 */
export async function createImageVariant(opts: {
  workspaceDir: string
  input: CreateVariantInput
  generateImage: (params: GenerateImageParams) => Promise<GenerateImageInfo>
  /** 文件名里的时间戳（测试注入；缺省当前时间） */
  now?: Date
  registerFile?: (info: {
    editId: string
    sessionKey: string | null
    path: string
    absPath: string
    bytes: number
    derivedFrom: string
  }) => void
}): Promise<ArtifactVariantResult | ArtifactEditFailure> {
  const { input } = opts
  const target = await resolveEditTarget(opts.workspaceDir, input.path)
  if (!target) return fail('源图片不存在或不在工作区内', 'invalid-path')
  if (kindOf(target.rel) !== 'image') return fail('只有图片可以生成同源变体', 'invalid-path')

  const model = typeof input.model === 'string' ? input.model.trim() : ''
  if (!model || model.length > 200) {
    return fail('缺少生图模型参数，无法复现（这张图没有声明模型）', 'invalid-scope')
  }
  const sourcePrompt =
    typeof input.sourcePrompt === 'string' ? input.sourcePrompt.trim().slice(0, MAX_PROMPT_CHARS) : ''
  if (!sourcePrompt) {
    return fail('缺少原始提示词，无法复现（这张图没有声明提示词）', 'invalid-scope')
  }
  const instruction =
    typeof input.instruction === 'string'
      ? input.instruction.trim().slice(0, MAX_INSTRUCTION_CHARS)
      : ''
  const prompt = instruction ? `${sourcePrompt}\n修改要求：${instruction}` : sourcePrompt

  const width = dimension(input.width)
  const height = dimension(input.height)
  if (
    (input.width !== undefined && width === undefined) ||
    (input.height !== undefined && height === undefined)
  ) {
    return fail('尺寸参数非法（需要 1–8192 的整数）', 'invalid-scope')
  }
  const outputDir = path.posix.dirname(target.rel)
  const sourceDirAbs = path.dirname(target.abs)
  const base = path.basename(target.rel, path.extname(target.rel))
  const sourceExt = path.extname(target.rel).toLowerCase()

  let generated: GenerateImageInfo
  try {
    generated = await opts.generateImage({
      prompt,
      modelId: model,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      outputDir,
    })
  } catch (err) {
    return fail(err instanceof Error ? err.message : '图片生成失败')
  }

  if (!generated || typeof generated.filePath !== 'string' || !generated.filePath) {
    return fail('图片生成没有返回文件路径')
  }
  const generatedAbs = path.resolve(target.root, ...generated.filePath.split('/'))
  if (!inside(target.root, generatedAbs)) {
    return fail('图片生成结果不在工作区内', 'invalid-path')
  }

  // 同目录、`<源文件名>-variant-<HHmmss>.<ext>`；重名加序号
  const generatedExt = path.extname(generated.filePath).toLowerCase()
  const ext = generatedExt || sourceExt || '.png'
  const stamp = clockStamp(opts.now ?? new Date())
  let picked: { name: string; abs: string }
  try {
    picked = await pickVariantName(sourceDirAbs, base, ext, stamp)
    await fs.rename(generatedAbs, picked.abs)
  } catch (err) {
    // 重命名失败不留半成品：把生成结果删掉，避免多出一份「跑偏」的文件
    await fs.rm(generatedAbs, { force: true }).catch(() => undefined)
    return fail(err instanceof Error ? err.message : '保存变体失败')
  }

  let bytes = 0
  try {
    const stat = await fs.stat(picked.abs)
    if (!stat.isFile() || stat.size === 0) return fail('变体文件没有写出来')
    bytes = stat.size
  } catch (err) {
    return fail(err instanceof Error ? err.message : '读取变体文件失败')
  }

  const variantRel = path
    .relative(target.root, picked.abs)
    .split(path.sep)
    .join('/')
  const recorded = await recordVariantEdit({
    workspaceDir: target.root,
    sessionKey: input.sessionKey ?? null,
    path: variantRel,
    derivedFrom: target.rel,
    bytes,
  })
  if (recorded) {
    try {
      opts.registerFile?.({
        editId: recorded.editId,
        sessionKey: input.sessionKey ?? null,
        path: variantRel,
        absPath: picked.abs,
        bytes,
        derivedFrom: target.rel,
      })
    } catch {
      // 登记失败只影响「全部」作用域，不影响文件本身
    }
  }

  return {
    ok: true,
    path: variantRel,
    editId: recorded?.editId ?? '',
    bytes,
    ...(recorded ? {} : { warning: '变体已生成，但没记入本地修改索引' }),
  }
}
