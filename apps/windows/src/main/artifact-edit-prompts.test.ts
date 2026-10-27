/**
 * 改写提示词：动作/语气/上下文；输出清洗与「伪整篇」拒绝。
 */
import { describe, expect, it } from 'vitest'
import { buildEditPrompt, checkReplacement, cleanLlmReplacement } from './artifact-edit-prompts'

describe('buildEditPrompt', () => {
  const base = {
    selected: '原来的段落',
    before: '前面'.repeat(200),
    after: '后面'.repeat(200),
    fileName: 'notes.md',
  }

  it('包含动作要求、上下文与文件标题', () => {
    const prompt = buildEditPrompt({ ...base, action: 'rewrite' })
    expect(prompt).toContain('notes.md')
    expect(prompt).toContain('原来的段落')
    expect(prompt).toContain('改写得更通顺')
    expect(prompt).not.toContain('前面'.repeat(200)) // 只保留尾部 200 字
  })

  it('扩写/精简/语气各有对应要求', () => {
    expect(buildEditPrompt({ ...base, action: 'expand' })).toContain('1.5–2 倍')
    expect(buildEditPrompt({ ...base, action: 'shorten' })).toContain('60%')
    expect(buildEditPrompt({ ...base, action: 'tone', tone: 'casual' })).toContain('口语化')
  })

  it('附加要求被截断', () => {
    const prompt = buildEditPrompt({ ...base, action: 'rewrite', instruction: 'x'.repeat(600) })
    expect(prompt).toContain(`附加要求：${'x'.repeat(500)}`)
    expect(prompt).not.toContain('x'.repeat(501))
  })
})

describe('cleanLlmReplacement / checkReplacement', () => {
  it('去掉代码围栏、前缀与包裹引号', () => {
    expect(cleanLlmReplacement('```md\n新段落\n```')).toBe('新段落')
    expect(cleanLlmReplacement('修改后：新段落')).toBe('新段落')
    expect(cleanLlmReplacement('“新段落”')).toBe('新段落')
  })

  it('空输出、原文相同、超长都拒绝', () => {
    expect(checkReplacement('原文', '   ')).toMatchObject({ ok: false })
    expect(checkReplacement('原文', '原文')).toMatchObject({ ok: false })
    expect(checkReplacement('短', 'x'.repeat(5000))).toMatchObject({ ok: false })
  })

  it('正常改写通过', () => {
    expect(checkReplacement('原文', '修改后的这一段')).toEqual({
      ok: true,
      text: '修改后的这一段',
    })
  })
})
