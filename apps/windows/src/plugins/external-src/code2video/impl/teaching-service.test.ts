/**
 * 服务层边界测试：目录名净化、JSON 抽取、场景 HTML 抽取、提示词 JSON 解析。
 *
 * 这些是「不会抛异常但会静默产出坏东西」的路径——比崩溃更值得测。
 */
import { describe, expect, it } from 'vitest'

import { extractJson, safeDirName } from './teaching-service'

const AT = new Date('2026-11-07T08:00:00Z')

describe('safeDirName', () => {
  it('普通主题保留可读名字', () => {
    expect(safeDirName('勾股定理', AT)).toBe('勾股定理-2026-11-07T08-00-00')
  })

  it('非法路径字符被替换，不会产生子目录', () => {
    const out = safeDirName('a<b>c:d"e/f\\g|h?i*j', AT)
    expect(out).not.toMatch(/[<>:"/\\|?*]/)
    expect(out.startsWith('a-b-c-d-e-f-g-h-i-j-')).toBe(true)
  })

  // 回归：旧实现把「全是非法字符」的主题净成空串，目录变成 `-2026-...`
  it('全是非法字符时兜底成 teaching-video', () => {
    expect(safeDirName('<>:"/\\|?*', AT)).toBe('teaching-video-2026-11-07T08-00-00')
  })

  it('空主题兜底', () => {
    expect(safeDirName('', AT)).toBe('teaching-video-2026-11-07T08-00-00')
    expect(safeDirName('   ', AT)).toBe('teaching-video-2026-11-07T08-00-00')
  })

  it('超长主题截断到 40 字，且不以分隔符结尾', () => {
    const out = safeDirName('长'.repeat(200), AT)
    const base = out.slice(0, out.lastIndexOf('-2026-'))
    expect(base.length).toBeLessThanOrEqual(40)
    expect(base.endsWith('-')).toBe(false)
  })

  // 回归：截断可能正好切在「-」上，产生 `xxx--2026-` 这种双分隔
  it('截断落在分隔符上时不出现双连字符', () => {
    const out = safeDirName('a'.repeat(39) + ' b', AT)
    expect(out).not.toContain('--2026')
  })

  it('换行与制表符不会进目录名', () => {
    const out = safeDirName('第一行\n第二行\t第三列', AT)
    expect(out).not.toMatch(/[\r\n\t]/)
  })

  it('结尾时间戳可用于排序（字典序 = 时间序）', () => {
    const a = safeDirName('x', new Date('2026-11-07T08:00:00Z'))
    const b = safeDirName('x', new Date('2026-11-07T09:00:00Z'))
    expect(a < b).toBe(true)
  })
})

describe('extractJson', () => {
  it('裸 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('```json 围栏', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('无语言标记的围栏', () => {
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('前后带解释文字时抓第一个完整对象', () => {
    expect(extractJson('好的，结果如下：{"a":1} 以上。')).toEqual({ a: 1 })
  })

  it('坏 JSON 返回 null 而不是抛', () => {
    expect(extractJson('不是 json')).toBeNull()
    expect(extractJson('{不完整')).toBeNull()
    expect(extractJson('')).toBeNull()
  })
})
