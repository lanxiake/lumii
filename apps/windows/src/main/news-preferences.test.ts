/**
 * 资讯偏好（结构化章节）测试。
 *
 * 这个模块的全部价值就在「格式稳定」：情报每轮都要读它。所以边界必须钉死——
 * 章节不存在/字段缺失/分隔符混用/章节外有内容，都不能读歪；写的时候更不能
 * 把用户手写的其它章节弄丢。
 */

import { describe, expect, it } from 'vitest'
import {
  NEWS_PREF_FIELDS,
  applyNewsPreference,
  describeNewsPreferences,
  readNewsPreferences,
} from './news-preferences'

const BASE = `# 用户记忆

## 基本信息
- 称呼：老张
- 时区：UTC+8
`

describe('readNewsPreferences', () => {
  it('章节不存在时四类都为空，而不是抛错', () => {
    const prefs = readNewsPreferences(BASE)
    for (const f of NEWS_PREF_FIELDS) expect(prefs[f]).toEqual([])
  })

  it('读回四类字段，分隔符混用也认', () => {
    const md = `${BASE}
## 资讯偏好
- 关注：AI 应用、端侧推理/国产大模型
- 少推：标题党，纯融资通稿
- 来源偏好：36氪 | 机器之心
- 推送时段：早 8 点
`
    const prefs = readNewsPreferences(md)
    expect(prefs.关注).toEqual(['AI 应用', '端侧推理', '国产大模型'])
    expect(prefs.少推).toEqual(['标题党', '纯融资通稿'])
    expect(prefs.来源偏好).toEqual(['36氪', '机器之心'])
    expect(prefs.推送时段).toEqual(['早 8 点'])
  })

  it('只认已知字段：章节里的其它行不参与解析', () => {
    const md = `## 资讯偏好
- 关注：AI
- 备注：这条不该被当成偏好
`
    const prefs = readNewsPreferences(md)
    expect(prefs.关注).toEqual(['AI'])
    expect(Object.keys(prefs)).toEqual([...NEWS_PREF_FIELDS])
  })

  it('章节后面的其它章节不被误读', () => {
    const md = `## 资讯偏好
- 关注：AI

## 基本信息
- 少推：这行属于别的章节
`
    expect(readNewsPreferences(md).少推).toEqual([])
  })

  it('null 输入返回空', () => {
    expect(readNewsPreferences(null).关注).toEqual([])
  })
})

describe('applyNewsPreference', () => {
  it('章节不存在时追加到文末，原有内容一字不动', () => {
    const next = applyNewsPreference(BASE, { field: '关注', op: 'add', value: '端侧推理' })
    expect(next).toContain('## 基本信息')
    expect(next).toContain('- 称呼：老张')
    expect(next).toContain('## 资讯偏好')
    expect(readNewsPreferences(next).关注).toEqual(['端侧推理'])
  })

  it('add 自带去重', () => {
    let md = applyNewsPreference(BASE, { field: '少推', op: 'add', value: '标题党' })
    md = applyNewsPreference(md, { field: '少推', op: 'add', value: '标题党' })
    expect(readNewsPreferences(md).少推).toEqual(['标题党'])
  })

  it('remove 只删指定的一条，其余保留', () => {
    let md = applyNewsPreference(BASE, { field: '关注', op: 'add', value: 'AI' })
    md = applyNewsPreference(md, { field: '关注', op: 'add', value: '芯片' })
    md = applyNewsPreference(md, { field: '关注', op: 'remove', value: 'AI' })
    expect(readNewsPreferences(md).关注).toEqual(['芯片'])
  })

  it('remove 不存在的项是幂等的，不报错也不改动别的字段', () => {
    const md = applyNewsPreference(BASE, { field: '关注', op: 'add', value: 'AI' })
    const next = applyNewsPreference(md, { field: '关注', op: 'remove', value: '不存在的' })
    expect(readNewsPreferences(next).关注).toEqual(['AI'])
  })

  it('改写章节时，章节前后的内容都原样保留', () => {
    const md = `${BASE}
## 资讯偏好
- 关注：AI

## 其它章节
- 这条要活着
`
    const next = applyNewsPreference(md, { field: '少推', op: 'add', value: '标题党' })
    expect(next).toContain('## 基本信息')
    expect(next).toContain('## 其它章节')
    expect(next).toContain('- 这条要活着')
    // 章节标题只出现一次（重写章节时不能把标题写两遍）
    expect(next.match(/## 资讯偏好/g)).toHaveLength(1)
    expect(readNewsPreferences(next)).toMatchObject({ 关注: ['AI'], 少推: ['标题党'] })
  })

  it('空值被拒绝', () => {
    expect(() => applyNewsPreference(BASE, { field: '关注', op: 'add', value: '  ' })).toThrow(/不能为空/)
  })

  it('空 markdown 也能起一个章节', () => {
    const next = applyNewsPreference('', { field: '关注', op: 'add', value: 'AI' })
    expect(next.startsWith('## 资讯偏好')).toBe(true)
    expect(readNewsPreferences(next).关注).toEqual(['AI'])
  })
})

describe('describeNewsPreferences', () => {
  it('拼成可注入的一句话，只列非空字段', () => {
    const prefs = readNewsPreferences(`## 资讯偏好
- 关注：AI
- 少推：标题党
`)
    expect(describeNewsPreferences(prefs)).toBe('关注：AI；少推：标题党')
  })

  it('全空时明确说「尚未记录」，而不是给空串', () => {
    expect(describeNewsPreferences(readNewsPreferences(''))).toContain('尚未记录')
  })
})
