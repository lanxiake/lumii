/**
 * sync-scope 单元测试：glob 匹配语义与排除/强制包含的优先级。
 *
 * 这些规则决定"哪些文件永不参与同步""哪些无视阈值优先传"，
 * 写错的后果是数据静默不同步 —— 边界必须锁死。
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_SCOPE_RULES,
  isExcluded,
  isForceIncluded,
  matchGlob,
  scopeRulesFromConfig,
  type SyncScopeRules,
} from './sync-scope'

describe('sync-scope', () => {
  describe('matchGlob', () => {
    it('字面量精确匹配', () => {
      expect(matchGlob('a/b.png', 'a/b.png')).toBe(true)
      expect(matchGlob('a/b.png', 'a/c.png')).toBe(false)
    })

    it('* 匹配单层内任意字符，不跨目录', () => {
      expect(matchGlob('20260810/*.png', '20260810/a.png')).toBe(true)
      expect(matchGlob('20260810/*.png', '20260810/sub/a.png')).toBe(false)
      expect(matchGlob('*.md', 'a.md')).toBe(true)
      expect(matchGlob('*.md', 'sub/a.md')).toBe(false)
    })

    it('** 跨目录，且能匹配零层（**/ 是最容易写错的一条）', () => {
      expect(matchGlob('**/*.png', 'a.png')).toBe(true) // 零层
      expect(matchGlob('**/*.png', 'a/b/c.png')).toBe(true) // 多层
      expect(matchGlob('**/*.png', 'a/b/c.jpg')).toBe(false)
    })

    it('目录前缀 ** 覆盖其下全部内容', () => {
      expect(matchGlob('小星星绘本/**', '小星星绘本/video/a.mp4')).toBe(true)
      expect(matchGlob('小星星绘本/**', '小星星绘本')).toBe(false) // 目录本身不算
    })

    it('? 匹配单字符（不跨目录分隔符）', () => {
      expect(matchGlob('a?c.md', 'abc.md')).toBe(true)
      expect(matchGlob('a?c.md', 'a/c.md')).toBe(false)
    })

    it('正则特殊字符按字面量处理（. 不匹配任意字符）', () => {
      expect(matchGlob('a.b', 'a.b')).toBe(true)
      expect(matchGlob('a.b', 'axb')).toBe(false)
    })

    it('非法 pattern 不命中（规则写错不误伤）', () => {
      expect(matchGlob('', 'a.md')).toBe(false)
      expect(matchGlob('[', 'a.md')).toBe(false)
    })
  })

  describe('isExcluded / isForceIncluded', () => {
    const rules: SyncScopeRules = {
      exclude: ['temp/**', '*.tmp'],
      forceInclude: ['temp/keep.png', '小星星绘本/**'],
    }

    it('命中任一排除规则即排除', () => {
      expect(isExcluded('temp/a.png', rules)).toBe(true)
      expect(isExcluded('b.tmp', rules)).toBe(true)
      expect(isExcluded('normal/a.png', rules)).toBe(false)
    })

    it('强制包含命中即生效', () => {
      expect(isForceIncluded('小星星绘本/video/a.mp4', rules)).toBe(true)
      expect(isForceIncluded('normal/a.png', rules)).toBe(false)
    })

    it('**排除优先于强制包含** —— 规则冲突时以不传为准', () => {
      // temp/keep.png 同时命中 exclude(temp/**) 与 forceInclude —— 必须判排除
      expect(isExcluded('temp/keep.png', rules)).toBe(true)
      expect(isForceIncluded('temp/keep.png', rules)).toBe(false)
    })

    it('空规则集：既不排除也不强制', () => {
      expect(isExcluded('a/b.png', EMPTY_SCOPE_RULES)).toBe(false)
      expect(isForceIncluded('a/b.png', EMPTY_SCOPE_RULES)).toBe(false)
    })
  })

  describe('scopeRulesFromConfig', () => {
    it('字段缺失视为空', () => {
      expect(scopeRulesFromConfig({})).toEqual({ exclude: [], forceInclude: [] })
    })

    it('透传配置值', () => {
      const r = scopeRulesFromConfig({
        syncExcludePatterns: ['a/**'],
        syncForceIncludePatterns: ['b.mp4'],
      })
      expect(r.exclude).toEqual(['a/**'])
      expect(r.forceInclude).toEqual(['b.mp4'])
    })
  })
})
