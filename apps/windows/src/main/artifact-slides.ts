/**
 * PPT 页级编辑（P2 T4）
 *
 * 页列表：jszip 直接读 OOXML（不依赖 Python）。
 * 单页写回：受管 Python + python-pptx 脚本（`resources/scripts/pptx_page_edit.py`），
 * 只改目标页的标题/正文文本框；候选稿走 artifact-edit 的 propose/apply/undo。
 */

import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import JSZip from 'jszip'
import type { ArtifactEditFailure } from '../shared/artifact-edit-types'
import type {
  ProposeSlideEditInput,
  SlideDepsInfo,
  SlideEditProposal,
  SlideEditSpec,
  SlideOutlineItem,
  SlideOutlineResult,
} from '../shared/artifact-slide-types'
import { proposeFileEdit, resolveEditTarget } from './artifact-edit'
import type { SingleTurnRunner } from './artifact-edit-llm'
import { detectSystemPython, getBundledPythonExe, hasPackage } from './python-env'

const OUTLINE_TTL_MS = 30_000
const DEPS_TTL_MS = 60_000
const MAX_PPTX_BYTES = 200 * 1024 * 1024
const PYTHON_TIMEOUT_MS = 120_000

interface OutlineCacheEntry {
  mtimeMs: number
  size: number
  slides: SlideOutlineItem[]
}

const outlineCache = new Map<string, OutlineCacheEntry>()

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
}

function slideNumberOf(name: string): number {
  const match = /slide(\d+)\.xml$/.exec(name)
  return match ? Number.parseInt(match[1]!, 10) : 0
}

/** 读 PPT 页列表；坏文件返回可读错误 */
export async function readSlideOutline(absPath: string): Promise<SlideOutlineResult> {
  let stat
  try {
    stat = await fs.stat(absPath)
  } catch {
    return { ok: false, error: '文件不存在' }
  }
  if (!stat.isFile() || stat.size > MAX_PPTX_BYTES) {
    return { ok: false, error: '不是可编辑的 PPTX 文件' }
  }
  const cached = outlineCache.get(absPath)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { ok: true, slides: cached.slides, deps: await depsForOutline() }
  }

  try {
    const zip = await JSZip.loadAsync(await fs.readFile(absPath))
    const names = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => slideNumberOf(a) - slideNumberOf(b))
    if (names.length === 0) return { ok: false, error: 'PPTX 里没有幻灯片' }

    const slides: SlideOutlineItem[] = []
    for (let index = 0; index < names.length; index += 1) {
      const file = zip.file(names[index]!)
      if (!file) continue
      const xml = await file.async('string')
      const texts: string[] = []
      const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g
      let match: RegExpExecArray | null
      while ((match = re.exec(xml)) !== null) {
        const value = decodeXmlText(match[1] ?? '').trim()
        if (value) texts.push(value)
      }
      slides.push({
        index,
        title: texts[0] ?? '',
        lines: texts,
        shapes: (xml.match(/<p:sp(?:\s|>)/g) ?? []).length,
      })
    }
    outlineCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, slides })
    return { ok: true, slides, deps: await depsForOutline() }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : '解析 PPTX 失败',
    }
  }
}

let depsCache: { at: number; info: SlideDepsInfo & { python?: string } } | null = null

async function depsForOutline(): Promise<SlideDepsInfo> {
  const deps = await checkPptxDeps()
  return { ok: deps.ok, ...(deps.reason ? { reason: deps.reason } : {}) }
}

function resolveScriptPath(): string {
  // 测试/诊断可显式指定脚本；生产走 extraResources
  if (process.env.LUMII_PPTX_EDIT_SCRIPT) {
    return path.resolve(process.env.LUMII_PPTX_EDIT_SCRIPT)
  }
  if (app?.isPackaged) return path.join(process.resourcesPath, 'scripts', 'pptx_page_edit.py')
  return path.join(__dirname, '../../resources/scripts/pptx_page_edit.py')
}

interface ProcessResult {
  code: number
  stdout: string
  stderr: string
}

function runProcess(command: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      finish(-1)
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 65_536) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 65_536) stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      stderr += err.message
      finish(-1)
    })
    child.on('close', (code) => finish(code ?? -1))
  })
}

/** 受管 Python + python-pptx 是否可用；结果缓存 60s */
export async function checkPptxDeps(): Promise<SlideDepsInfo & { python?: string }> {
  const now = Date.now()
  if (depsCache && now - depsCache.at <= DEPS_TTL_MS) return depsCache.info

  let python: string | null = null
  if (process.platform === 'win32') {
    const bundled = getBundledPythonExe()
    if (!existsSync(bundled)) {
      const info = { ok: false, reason: '受管 Python 未安装，无法编辑 PPT（技能首次运行会安装）' }
      depsCache = { at: now, info }
      return info
    }
    python = bundled
  } else {
    python = detectSystemPython()
    if (!python) {
      const info = { ok: false, reason: '未找到 python3，无法编辑 PPT' }
      depsCache = { at: now, info }
      return info
    }
  }

  // 不能只看 bundled site-packages：本机 python-pptx 装在用户 site-packages
  // (%APPDATA%\Python\Python311\site-packages)，hasPackage 会误报缺失。
  // 以解释器实际能否 import 为准；能导入时跳过探测（快路径）。
  if (!hasPackage('pptx') || process.platform !== 'win32') {
    const probe = await runProcess(python, ['-c', 'import pptx'], 10_000)
    if (probe.code !== 0) {
      const info = {
        ok: false,
        reason:
          process.platform === 'win32'
            ? '受管 Python 缺少 python-pptx，请先运行一次 PPT 技能安装依赖'
            : 'python3 缺少 python-pptx，无法编辑 PPT',
      }
      depsCache = { at: now, info }
      return info
    }
  }

  const info = { ok: true, python }
  depsCache = { at: now, info }
  return info
}

function parseSpecOutput(stdout: string): Record<string, unknown> | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!) as Record<string, unknown>
    } catch {
      // 继续找上一行
    }
  }
  return null
}

/** 跑 Python 单页写回；失败抛出可读错误 */
export async function runPptxPageEdit(opts: {
  python: string
  inputAbs: string
  outputAbs: string
  slideIndex: number
  spec: SlideEditSpec
}): Promise<{ slideCount: number }> {
  const script = resolveScriptPath()
  if (!existsSync(script)) throw new Error('PPT 编辑脚本缺失')
  const result = await runProcess(
    opts.python,
    [
      script,
      '--input',
      opts.inputAbs,
      '--output',
      opts.outputAbs,
      '--slide',
      String(opts.slideIndex),
      '--spec',
      JSON.stringify(opts.spec),
    ],
    PYTHON_TIMEOUT_MS,
  )
  const parsed = parseSpecOutput(result.stdout)
  if (result.code !== 0 || !parsed || parsed.ok !== true) {
    const message =
      (typeof parsed?.error === 'string' && parsed.error) ||
      result.stderr.trim().slice(0, 300) ||
      `PPT 编辑脚本退出码 ${result.code}`
    throw new Error(message)
  }
  return { slideCount: Number(parsed.slideCount ?? 0) }
}

function stripJsonFence(raw: string): string {
  let text = raw.trim()
  const fence = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/)
  if (fence) text = (fence[1] ?? '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

function fail(error: string, code: ArtifactEditFailure['code'] = 'unavailable'): ArtifactEditFailure {
  return { ok: false, error, code }
}

function normalizeCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 单页改写：LLM 只产出目标页的标题/要点 JSON，再由 python-pptx 写回候选 */
export async function proposeSlideEdit(opts: {
  workspaceDir: string
  input: ProposeSlideEditInput
  run: SingleTurnRunner
}): Promise<SlideEditProposal | ArtifactEditFailure> {
  const { input } = opts
  if (input.action !== 'slide-title' && input.action !== 'slide-bullets') {
    return fail('不支持的 PPT 动作', 'invalid-scope')
  }
  if (!Number.isInteger(input.index) || input.index < 0) {
    return fail('页码非法', 'invalid-scope')
  }
  const target = await resolveEditTarget(opts.workspaceDir, input.path)
  if (!target) return fail('目标文件不存在或不在工作区内', 'invalid-path')
  if (path.extname(target.rel).toLowerCase() !== '.pptx') {
    return fail('只支持 .pptx 单页文本重写', 'invalid-path')
  }

  const outline = await readSlideOutline(target.abs)
  if (!outline.ok) return fail(outline.error, 'invalid-path')
  const slide = outline.slides[input.index]
  if (!slide) return fail('页码越界', 'invalid-scope')

  const deps = await checkPptxDeps()
  if (!deps.ok || !deps.python) return fail(deps.reason ?? 'PPT 编辑依赖缺失')

  const prompt = [
    '你是 PPT 编辑助手。只修改下面这一页的指定部分，不要改其它页。',
    `第 ${input.index + 1} 页（共 ${outline.slides.length} 页）`,
    `当前标题：${slide.title || '（空）'}`,
    '当前正文：',
    ...(slide.lines.length > 1 ? slide.lines.slice(1).map((line) => `- ${line}`) : ['（空）']),
    '',
    input.action === 'slide-title'
      ? '要求：重写这一页的标题。'
      : '要求：重写这一页的正文要点（1–8 条，每条不超过 200 字，保持要点式）。',
    ...(input.instruction ? [`附加要求：${input.instruction.trim().slice(0, 500)}`] : []),
    '',
    input.action === 'slide-title'
      ? '只输出 JSON：{"title":"新标题"}'
      : '只输出 JSON：{"bullets":["要点1","要点2"]}',
    '不要解释、不要代码围栏、不要输出 HTML。',
  ].join('\n')

  const result = await opts.run.run({
    requestId: input.editId,
    prompt,
    purpose: 'artifact-slide-edit',
    maxTokens: 1500,
  })
  if (!result.ok) {
    return fail(result.error, result.cancelled ? 'cancelled' : 'unavailable')
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(stripJsonFence(result.text)) as Record<string, unknown>
  } catch {
    return fail('模型没有返回合法 JSON', 'invalid-scope')
  }

  let spec: SlideEditSpec
  if (input.action === 'slide-title') {
    const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
    if (!title) return fail('模型没有给出标题', 'invalid-scope')
    if (title.length > 500) return fail('标题过长', 'invalid-scope')
    if (normalizeCompare(title) === normalizeCompare(slide.title)) {
      return fail('模型建议与原标题相同', 'invalid-scope')
    }
    spec = { title: title.slice(0, 500) }
  } else {
    const rawBullets = Array.isArray(parsed.bullets) ? parsed.bullets : []
    const bullets = rawBullets
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim().slice(0, 500))
      .slice(0, 8)
    if (bullets.length === 0) return fail('模型没有给出要点', 'invalid-scope')
    const before = slide.lines.slice(1).map(normalizeCompare).filter(Boolean)
    if (
      before.length === bullets.length &&
      before.every((line, index) => line === normalizeCompare(bullets[index]!))
    ) {
      return fail('模型建议与原要点相同', 'invalid-scope')
    }
    spec = { bullets }
  }

  const proposal = await proposeFileEdit({
    workspaceDir: opts.workspaceDir,
    input: {
      path: target.rel,
      action: input.action,
      scope: { type: 'slide', index: input.index },
      editId: input.editId,
      ...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}),
      ...(input.instruction ? { instruction: input.instruction } : {}),
    },
    writeCandidate: async (candidateAbs) => {
      await runPptxPageEdit({
        python: deps.python!,
        inputAbs: target.abs,
        outputAbs: candidateAbs,
        slideIndex: input.index,
        spec,
      })
    },
  })
  if (!proposal.ok) return proposal

  const candidateAbs = path.join(target.root, ...proposal.candidatePath.split('/'))
  const candidateOutline = await readSlideOutline(candidateAbs)
  return {
    ...proposal,
    ...(candidateOutline.ok ? { slides: candidateOutline.slides } : {}),
  }
}
