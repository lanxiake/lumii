/**
 * 产物卡：数据全部来自 pipeline_run 的返回；缺静态导出时如实降级。
 */
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { PipelineArtifactCard, parseRemainingDifferences } from './pipeline-artifact'
import type { TimelineCardContext, ToolPart } from './registry'

const LOCAL = 'E:\\ws\\projects\\demo\\out\\index.html'

function part(payload: unknown): ToolPart {
  return {
    id: 't1',
    name: 'pipeline_run',
    args: { id: 'web-clone', mode: 'rehearsal' },
    result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
  } as unknown as ToolPart
}

function ctx(p: ToolPart): TimelineCardContext {
  return { part: p, messageStreaming: false, runs: [] }
}

const okPayload = {
  status: 'ok',
  runId: '20261102-000000-abcd',
  steps: [
    { id: 'open', ok: true, ms: 1000 },
    {
      id: 'report',
      ok: true,
      ms: 200,
      observed: { output: '文件都在。\n剩余差异：10 条' },
    },
  ],
  provenanceTarget: 'https://example.com/',
  previewPath: LOCAL,
}

describe('PipelineArtifactCard', () => {
  it('有静态导出 → 出现「对照预览」，点开是双栏 webview', () => {
    render(<PipelineArtifactCard {...ctx(part(okPayload))} />)
    const btn = screen.getByRole('button', { name: '对照预览' })
    fireEvent.click(btn)
    const webviews = Array.from(document.querySelectorAll('webview'))
    expect(webviews.map((el) => el.getAttribute('src'))).toEqual([
      'https://example.com/',
      'file:///E:/ws/projects/demo/out/index.html',
    ])
  })

  it('剩余差异从 report 步 output 解析；解析不到显示「见 README」', () => {
    expect(parseRemainingDifferences(okPayload)).toBe(10)
    expect(parseRemainingDifferences({ steps: [{ id: 'report', ok: true, ms: 1, observed: { output: '完成' } }] })).toBeNull()
  })

  it('没有静态导出 → 不出现对照按钮，给出降级说明', () => {
    render(<PipelineArtifactCard {...ctx(part({ ...okPayload, previewPath: undefined }))} />)
    expect(screen.queryByRole('button', { name: '对照预览' })).toBeNull()
    expect(screen.getByText(/未生成静态导出/)).toBeInTheDocument()
  })

  it('失败结果：显示失败原因与步号', () => {
    render(
      <PipelineArtifactCard
        {...ctx(part({ status: 'error', message: '构建失败', failedAt: { i: 9, id: 'check' } }))}
      />,
    )
    expect(screen.getByText(/构建失败/)).toBeInTheDocument()
    expect(screen.getByText(/第 10 步 check/)).toBeInTheDocument()
  })

  it('还在跑（result 尚未回填）→ 说「执行中」，不报「无法解析」', () => {
    const running = {
      id: 't1',
      name: 'pipeline_run',
      args: { id: 'web-clone', mode: 'record' },
      status: 'running',
    } as unknown as ToolPart
    render(<PipelineArtifactCard {...ctx(running)} />)
    expect(screen.getByText(/流水线执行中/)).toBeInTheDocument()
    expect(screen.queryByText(/无法解析/)).toBeNull()
  })
})
