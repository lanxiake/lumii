/**
 * 流水线提示词（`buildPipelineSection`）。
 *
 * 这一节是**模型唯一知道流水线存在的地方**——没有它，现成的流水线形同不存在
 * （2026-10-31 真机：用户要录教程，Agent 手工调了一路 `screen_record_*`）。
 *
 * 2026-11-03 真机（自然语言「做一篇小红书笔记，要配图和封面」）：模型走了旧的
 * `xiaohongshu-content-pipeline` **技能**，而不是 `content-to-assets` 流水线。
 * 原因不是没看到流水线，是提示词只说「命中时优先用 pipeline_run」，
 * 没说清**流水线与技能同时覆盖同一件事时该选谁**。补了那段判据后重测走对了。
 */
import { describe, expect, it } from 'vitest'
import { buildPipelineSection } from '../misc-sections'

const HINTS = [
  { id: 'content-to-assets', name: '内容生产到成片素材', description: '调研 → 写稿 → 生图', stepCount: 9 },
  { id: 'settings-tour', name: '设置页巡览', description: '录制设置分区并导出 MP4', stepCount: 8 },
]

const text = (lines: string[]) => lines.join('\n')

describe('buildPipelineSection', () => {
  it('没有流水线时不注入空章节（别让提示词里出现「## Pipelines」下面啥也没有）', () => {
    expect(buildPipelineSection([])).toEqual([])
    expect(buildPipelineSection(undefined)).toEqual([])
  })

  it('每条都带 id、名字与描述——只有 id 的话模型判断不出哪条适配', () => {
    const out = text(buildPipelineSection(HINTS))
    expect(out).toContain('content-to-assets')
    expect(out).toContain('内容生产到成片素材')
    expect(out).toContain('调研 → 写稿 → 生图')
  })

  it('**说清流水线优先于技能**（2026-11-03：模型选了技能没选流水线）', () => {
    const out = text(buildPipelineSection(HINTS))
    expect(out).toContain('流水线优先于技能')
    expect(out).toContain('可复现')
  })

  it('lean 档同样带优先级说明（lean 也不能只列 id）', () => {
    const out = text(buildPipelineSection(HINTS, 'lean'))
    expect(out).toContain('precedence over skills')
    expect(out).toContain('content-to-assets')
  })

  it('lean 档截断过长的描述，但仍给出一句用途', () => {
    // 截断阈值是 60 个**字符**，所以要造一个明显超过它的描述
    const longDesc = '这是一段明显超过六十个字符的描述'.repeat(6)
    const long = [{ ...HINTS[0]!, description: longDesc }]
    const out = text(buildPipelineSection(long, 'lean'))
    expect(out).toContain('…')
    expect(out).toContain('这是一段明显超过六十个字符的描述')
    expect(out).not.toContain(longDesc)
  })
})
