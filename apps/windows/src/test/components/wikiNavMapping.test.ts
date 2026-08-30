/**
 * nav section 映射单测：旧 6 分类 → 新 5 区，未知分类降级 unfiled。
 */
import { describe, expect, it } from 'vitest'
import {
  legacyCategoriesForSection,
  navSectionFromLegacyCategory,
  navSectionLabel,
  type WikiNavSection,
} from '../../renderer/pages/MemoriesPage/components/wikiNavMapping'

describe('navSectionFromLegacyCategory', () => {
  it('六个旧分类各自落到预期区', () => {
    expect(navSectionFromLegacyCategory('做事记录')).toBe('work')
    expect(navSectionFromLegacyCategory('学习资料')).toBe('study')
    expect(navSectionFromLegacyCategory('计划与复盘')).toBe('life')
    expect(navSectionFromLegacyCategory('证件凭据')).toBe('life')
    expect(navSectionFromLegacyCategory('模板参考')).toBe('collection')
    expect(navSectionFromLegacyCategory('随笔创作')).toBe('collection')
  })

  it('临时存放归到待整理——不让搁置的资料从视图里消失', () => {
    expect(navSectionFromLegacyCategory('临时存放')).toBe('inbox')
  })

  it('用户自建的分类降级为未分类，而不是抛错', () => {
    expect(navSectionFromLegacyCategory('我自己加的大类')).toBe('unfiled')
    expect(navSectionFromLegacyCategory('')).toBe('unfiled')
  })
})

describe('legacyCategoriesForSection', () => {
  it('往返一致：section 声明的每个旧分类都映射回该 section', () => {
    const sections: readonly WikiNavSection[] = ['work', 'study', 'life', 'collection']
    for (const section of sections) {
      for (const category of legacyCategoriesForSection(section)) {
        expect(navSectionFromLegacyCategory(category), `${category} 应属于 ${section}`).toBe(section)
      }
    }
  })

  it('life 与 collection 各合并两个旧分类', () => {
    expect(legacyCategoriesForSection('life')).toEqual(['计划与复盘', '证件凭据'])
    expect(legacyCategoriesForSection('collection')).toEqual(['模板参考', '随笔创作'])
  })

  it('inbox / archived / unfiled 不走分类过滤，返回空表', () => {
    expect(legacyCategoriesForSection('inbox')).toEqual([])
    expect(legacyCategoriesForSection('archived')).toEqual([])
    expect(legacyCategoriesForSection('unfiled')).toEqual([])
  })
})

describe('navSectionLabel', () => {
  it('每个 section 都有中文名，无空串', () => {
    const sections: readonly WikiNavSection[] = [
      'work',
      'study',
      'life',
      'collection',
      'inbox',
      'archived',
      'unfiled',
    ]
    for (const section of sections) {
      expect(navSectionLabel(section).length, section).toBeGreaterThan(0)
    }
  })
})
