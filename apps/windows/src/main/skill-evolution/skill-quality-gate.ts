/**
 * 技能质量门控 — 纯规则检查，不调用 LLM
 */

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/

export function check(skillMd: string): { pass: boolean; score: number } {
  let score = 100

  // 缺少 frontmatter
  if (!FRONTMATTER_RE.test(skillMd)) {
    return { pass: false, score: 0 }
  }

  const fmMatch = skillMd.match(FRONTMATTER_RE)
  const fm = fmMatch ? fmMatch[1] : ''

  if (!fm.includes('name:')) score -= 20
  if (!fm.includes('description:')) score -= 20
  if (!fm.includes('when_to_use:')) score -= 10

  // 正文有效行 < 5
  const body = skillMd.replace(FRONTMATTER_RE, '').trim()
  const validLines = body.split('\n').filter(l => l.trim().length > 0)
  if (validLines.length < 5) score -= 20

  // name 不符合 kebab-case
  const nameMatch = fm.match(/name:\s*["']?([^\n"']+)["']?/)
  if (nameMatch) {
    const name = nameMatch[1].trim()
    if (!/^[a-z][a-z0-9-]*$/.test(name)) score -= 10
  }

  return { pass: score >= 60, score: Math.max(0, score) }
}
