import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseSkillMdFrontmatter, parseSkillRequires } from './skill-md-frontmatter'

const BUNDLED = path.resolve(__dirname, '..', '..', 'bundled-skills')

/**
 * 与运行时 `walkSkillDirs` 同构的扫描：只遍历目录；目录里有 skill.md（大小写不敏感）
 * 即为技能本体、不再下探；否则继续下探。深度上限同 MAX_SKILL_SCAN_DEPTH。
 */
const MAX_DEPTH = 6

/** 返回目录内实际存在的 skill.md 文件名，没有则 null */
function skillMdIn(dir: string): string | null {
  try {
    return fs.readdirSync(dir).find((f) => f.toLowerCase() === 'skill.md') ?? null
  } catch {
    return null
  }
}

function collectSkillDirs(dir: string, rel = '', depth = 0): Array<{ rel: string; abs: string }> {
  if (depth > MAX_DEPTH) return []
  const out: Array<{ rel: string; abs: string }> = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const abs = path.join(dir, entry.name)
    const nextRel = rel ? `${rel}/${entry.name}` : entry.name
    if (skillMdIn(abs)) {
      out.push({ rel: nextRel, abs })
    } else {
      out.push(...collectSkillDirs(abs, nextRel, depth + 1))
    }
  }
  return out
}

const skills = collectSkillDirs(BUNDLED)

describe('内置技能完整性', () => {
  it('能枚举到已注册技能，且 sub-skills 不被当成独立技能', () => {
    expect(skills.length).toBeGreaterThan(20)
    expect(skills.map((s) => s.rel).join('\n')).not.toContain('/sub-skills/')
  })

  it.each(skills)('$rel：frontmatter 合法且可注册', ({ abs, rel }) => {
    const mdName = skillMdIn(abs)
    expect(mdName, `${rel} 找不到 SKILL.md`).toBeTruthy()
    const fm = parseSkillMdFrontmatter(fs.readFileSync(path.join(abs, mdName!), 'utf-8'))

    // description 是唯一的触发机制，缺失等于技能永远不会被调用
    expect(fm.description, `${rel} 缺 description`).toBeTruthy()

    // 前 120 字符是注入技能列表的部分；这段为空等于触发信号为零
    const head = fm.description!.replace(/\n+/g, ' ').trim().slice(0, 120)
    expect(head.length, `${rel} description 前 120 字符为空`).toBeGreaterThan(0)

    // 顶层解析器用尖括号做标记，description 里出现会出问题
    expect(fm.description, `${rel} description 含尖括号`).not.toMatch(/[<>]/)

    // name 省略时回退目录名；显式写了就必须和目录一致，否则 skill_invoke 查不到
    if (fm.name) {
      expect(fm.name, `${rel} 的 name 与目录名不一致`).toBe(path.basename(abs))
    }

    // metadata 写了就必须是能被 JSON5 松散解析的对象
    if (fm.metadata) {
      const obj = JSON.parse(fm.metadata.replace(/,\s*([}\]])/g, '$1'))
      expect(typeof obj, `${rel} metadata 不是对象`).toBe('object')
      // 有 requires 时结构必须可解析，否则技能会被静默过滤掉
      if (obj?.mtbot?.requires) {
        expect(parseSkillRequires(fm.metadata), `${rel} mtbot.requires 无法解析`).toBeTruthy()
      }
    }
  })
})
