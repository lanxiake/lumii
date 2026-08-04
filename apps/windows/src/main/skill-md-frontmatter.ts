/**
 * 从 SKILL.md 解析 YAML frontmatter（与 api-server skill-md-frontmatter 及 Claude Code 规范对齐）
 */

import { execSync } from 'node:child_process'

export interface SkillMdFrontmatter {
  name?: string
  description?: string
  /** 与 CCR / MtBot SkillInfo.whenToUse 对齐（frontmatter `when_to_use`） */
  whenToUse?: string
  /**
   * 技能激活范围（frontmatter `activation_scope`）：
   * - always：始终激活，每轮对话强制注入
   * - contextual：按上下文自动匹配（默认）
   * - on_demand：仅用户显式 /skill 或 @skill 时激活
   */
  activationScope?: "always" | "contextual" | "on_demand"
  version?: string
  metadata?: string  // 原始 JSON/JSON5 字符串，如 { "mtbot": { "requires": { "anyBins": [...] } } }
}

function stripYamlQuotes(value: string): string {
  const t = value.trim()
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * 解析 SKILL.md 顶部的 --- ... --- frontmatter
 */
export function parseSkillMdFrontmatter(content: string): SkillMdFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.startsWith('---')) {
    return {}
  }
  const closeIdx = normalized.indexOf('\n---', 3)
  if (closeIdx === -1) {
    return {}
  }
  const block = normalized.slice(4, closeIdx)
  const result: SkillMdFrontmatter = {}

  const lines = block.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const colon = line.indexOf(':')
    if (colon <= 0) {
      i++
      continue
    }
    const key = line.slice(0, colon).trim()
    let rest = line.slice(colon + 1).trim()

    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const body: string[] = []
      let j = i + 1
      while (j < lines.length) {
        const ln = lines[j]
        if (ln.length > 0 && !ln.startsWith(' ') && !ln.startsWith('\t')) {
          break
        }
        body.push(ln)
        j++
      }
      const combined = body.join('\n').trim()
      if (key === 'name') {
        result.name = combined
      } else if (key === 'description') {
        result.description = combined
      } else if (key === 'when_to_use' || key === 'whenToUse') {
        result.whenToUse = combined
      } else if (key === 'version') {
        result.version = combined
      }
      i = j
      continue
    }

    if (key === 'metadata') {
      if (rest === '' || rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
        // 多行块：收集缩进行合并为单行
        const body: string[] = []
        let j = i + 1
        while (j < lines.length) {
          const ln = lines[j]
          if (ln.length > 0 && !ln.startsWith(' ') && !ln.startsWith('\t')) break
          body.push(ln.trim())
          j++
        }
        result.metadata = body.join(' ').trim()
        i = j
        continue
      } else {
        result.metadata = rest
      }
      i++
      continue
    }

    const value = stripYamlQuotes(rest)
    if (key === 'name') {
      result.name = value
    } else if (key === 'description') {
      result.description = value
    } else if (key === 'when_to_use' || key === 'whenToUse') {
      result.whenToUse = value
    } else if (key === 'activation_scope' || key === 'activationScope') {
      if (value === 'always' || value === 'contextual' || value === 'on_demand') {
        result.activationScope = value
      }
    } else if (key === 'version') {
      result.version = value
    }
    i++
  }

  return result
}

// ---------------------------------------------------------------------------
// Skill requires parsing & binary detection
// ---------------------------------------------------------------------------

export interface SkillRequires {
  bins?: string[]
  anyBins?: string[]
  env?: string[]
  config?: string[]
}

/**
 * 从 frontmatter 的 metadata 字段解析 mtbot.requires。
 *
 * metadata 格式示例：
 *   { "mtbot": { "emoji": "🧩", "requires": { "anyBins": ["claude", "codex"] } } }
 *
 * 兼容 JSON5 松散格式（移除尾逗号）。
 */
export function parseSkillRequires(metadataStr: string | undefined): SkillRequires | undefined {
  if (!metadataStr) return undefined
  try {
    // 移除 JSON5 尾逗号以兼容不严格的 JSON 格式
    const jsonStr = metadataStr.replace(/,\s*([}\]])/g, '$1')
    const obj = JSON.parse(jsonStr)
    const requires = obj?.mtbot?.requires
    if (!requires || typeof requires !== 'object') return undefined
    const toStringArray = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined
      return v.filter((x): x is string => typeof x === 'string')
    }
    return {
      bins: toStringArray(requires.bins),
      anyBins: toStringArray(requires.anyBins),
      env: toStringArray(requires.env),
      config: toStringArray(requires.config),
    }
  } catch {
    return undefined
  }
}

/**
 * 检查二进制文件是否存在于 PATH。
 * Windows 使用 `where`，Unix 使用 `which`。
 */
export function hasBinary(bin: string): boolean {
  const cmd = process.platform === 'win32' ? `where "${bin}"` : `which "${bin}"`
  try {
    execSync(cmd, { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}
