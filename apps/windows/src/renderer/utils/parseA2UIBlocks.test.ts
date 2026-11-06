import { describe, expect, it } from 'vitest'

import { parseA2UIBlocks, tryParseA2UISpecFromJson } from './parseA2UIBlocks'

const chartSpec = {
  components: [
    {
      type: 'Chart',
      id: 'c1',
      chartType: 'line',
      data: { labels: ['a', 'b'], datasets: [{ label: 'x', values: [1, 2] }] },
    },
  ],
}

describe('parseA2UIBlocks', () => {
  it('普通文本返回单段 markdown', () => {
    const segs = parseA2UIBlocks('hello world')
    expect(segs).toEqual([{ type: 'markdown', content: 'hello world' }])
  })

  it('识别 ```a2ui 围栏', () => {
    const content = `前文\n\`\`\`a2ui\n${JSON.stringify(chartSpec)}\n\`\`\`\n后文`
    const segs = parseA2UIBlocks(content)
    expect(segs.map((s) => s.type)).toEqual(['markdown', 'a2ui', 'markdown'])
  })

  // 回归：原正则没有 i 标志，```A2UI 不识别
  it('围栏大写 A2UI 也能识别', () => {
    const content = `\`\`\`A2UI\n${JSON.stringify(chartSpec)}\n\`\`\``
    const segs = parseA2UIBlocks(content)
    expect(segs[0]?.type).toBe('a2ui')
  })

  // 回归：收窄失败应降级为 markdown 原文，而不是把坏 spec 交给渲染层
  it('非法 spec 降级为 markdown 原文', () => {
    const bad = '{"components":[{"type":"Chart","chartType":"line","data":{"labels":"a,b"}}]}'
    const segs = parseA2UIBlocks(`\`\`\`a2ui\n${bad}\n\`\`\``)
    expect(segs).toHaveLength(1)
    expect(segs[0]?.type).toBe('markdown')
  })

  it('```json 里是 A2UI spec 时提升为 a2ui 段', () => {
    const segs = parseA2UIBlocks(`\`\`\`json\n${JSON.stringify(chartSpec)}\n\`\`\``)
    expect(segs[0]?.type).toBe('a2ui')
  })

  it('```json 里是普通 JSON 时保持 markdown', () => {
    const segs = parseA2UIBlocks('```json\n{"foo":1}\n```')
    expect(segs.every((s) => s.type === 'markdown')).toBe(true)
  })

  it('```html / ```svg 提升为 artifact 段', () => {
    expect(parseA2UIBlocks('```html\n<p>hi</p>\n```')[0]?.type).toBe('artifact')
    expect(parseA2UIBlocks('```svg\n<svg/>\n```')[0]?.type).toBe('artifact')
  })

  it('```artifact:html 前缀识别', () => {
    const segs = parseA2UIBlocks('```artifact:html\n<p>x</p>\n```')
    expect(segs[0]).toMatchObject({ type: 'artifact', language: 'html' })
  })

  it('artifact 语言允许连字符', () => {
    const segs = parseA2UIBlocks('```artifact:vue-sfc\n<template/>\n```')
    expect(segs[0]).toMatchObject({ type: 'artifact', language: 'vue-sfc' })
  })

  // 回归：原先只判"完全被包含"，artifact:html 会被标准 ```html 再收一遍
  it('artifact 前缀块不会被标准围栏重复收一次', () => {
    const segs = parseA2UIBlocks('```artifact:html\n<p>x</p>\n```')
    expect(segs).toHaveLength(1)
  })

  it('多个块按出现顺序分段', () => {
    const content = `A\n\`\`\`html\n<b/>\n\`\`\`\nB\n\`\`\`a2ui\n${JSON.stringify(chartSpec)}\n\`\`\`\nC`
    const segs = parseA2UIBlocks(content)
    expect(segs.map((s) => s.type)).toEqual(['markdown', 'artifact', 'markdown', 'a2ui', 'markdown'])
  })

  it('空内容返回空数组', () => {
    expect(parseA2UIBlocks('')).toEqual([])
    expect(parseA2UIBlocks('   ')).toEqual([])
  })
})

describe('tryParseA2UISpecFromJson', () => {
  it('非 JSON 返回 null', () => {
    expect(tryParseA2UISpecFromJson('not json')).toBeNull()
  })

  it('合法 spec 返回收窄后的对象', () => {
    const spec = tryParseA2UISpecFromJson(JSON.stringify(chartSpec))
    expect(spec?.components[0]?.type).toBe('Chart')
  })
})
