/**
 * 把 Wiki `.lumii-ref` 侧车解析成真正要预览的文件路径。
 * 侧车只是指针；预览必须跟到 targetPath，不能把 JSON 当正文。
 */
import fs from 'node:fs'
import path from 'node:path'
import { isVaultRefPath, parseRefDocument } from '@mtbot/agent-runtime'

const PREVIEWABLE_EXT =
  /\.(pdf|docx?|pptx?|xlsx?|odt|md|txt|html?|png|jpe?g|gif|webp|svg|mp4|webm|mp3|wav)$/i

/**
 * 引用指向文件夹时，尽量挑出唯一可预览文件（优先文件名包含资料标题、其次唯一文档）。
 */
function pickFileInDir(dirAbs: string, title: string): string | null {
  const names = fs.readdirSync(dirAbs)
  const files = names.filter((name) => {
    try {
      return fs.statSync(path.join(dirAbs, name)).isFile()
    } catch {
      return false
    }
  })
  if (files.length === 0) return null

  const previewable = files.filter((name) => PREVIEWABLE_EXT.test(name))
  const needle = title.trim()
  const titled = previewable.filter(
    (name) => needle.length > 0 && (name.includes(needle) || needle.includes(path.parse(name).name)),
  )
  if (titled.length === 1) return path.join(dirAbs, titled[0]!)
  if (titled.length > 1) {
    const pdf = titled.find((name) => name.toLowerCase().endsWith('.pdf'))
    return path.join(dirAbs, pdf ?? titled[0]!)
  }
  if (previewable.length === 1) return path.join(dirAbs, previewable[0]!)
  const pdfOnly = previewable.filter((name) => name.toLowerCase().endsWith('.pdf'))
  if (pdfOnly.length === 1) return path.join(dirAbs, pdfOnly[0]!)
  return null
}

/**
 * 把相对/绝对 targetPath 收成绝对路径：优先相对工作区（vault 里常见 wiki/收件箱/…），再相对侧车所在目录。
 */
function resolveRefTargetAbs(targetPath: string, refAbs: string, workspaceCwd?: string): string {
  if (path.isAbsolute(targetPath)) return path.resolve(targetPath)
  if (workspaceCwd) {
    const fromWorkspace = path.resolve(workspaceCwd, targetPath)
    if (fs.existsSync(fromWorkspace)) return fromWorkspace
  }
  return path.resolve(path.dirname(refAbs), targetPath)
}

const MAX_REF_HOPS = 8

/**
 * 若路径是 vault 内 wiki-ref，沿 targetPath 跟到真正的文件（可穿过多层 .lumii-ref）。
 * 否则原样返回。
 */
export function resolveWikiRefPreviewTarget(absPath: string, workspaceCwd?: string): string {
  let current = path.resolve(absPath)
  const seen = new Set<string>()

  while (isVaultRefPath(current)) {
    if (seen.has(current)) throw new Error('Wiki 引用形成循环，无法预览')
    seen.add(current)
    if (seen.size > MAX_REF_HOPS) throw new Error('Wiki 引用层级过深，无法预览')
    if (!fs.existsSync(current)) throw new Error('Wiki 引用文件不存在')

    const doc = parseRefDocument(fs.readFileSync(current, 'utf-8'))
    if (!doc) throw new Error('Wiki 引用文件损坏，无法预览')
    if (doc.refType === 'url') throw new Error('网页引用请使用内置浏览器打开')
    if (!doc.targetPath?.trim()) throw new Error('引用未记录原文件路径')

    const target = resolveRefTargetAbs(doc.targetPath, current, workspaceCwd)
    if (!fs.existsSync(target)) throw new Error('原文件已丢失或被移动')

    const stat = fs.statSync(target)
    if (stat.isDirectory()) {
      const picked = pickFileInDir(target, doc.title)
      if (!picked) throw new Error('该引用指向文件夹，无法确定要预览的文件')
      current = picked
      continue
    }
    if (!stat.isFile()) throw new Error('无法预览该引用目标')
    current = target
  }

  return current
}
