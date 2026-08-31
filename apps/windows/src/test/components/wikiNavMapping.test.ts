/**
 * nav section 映射单测：旧 6 分类 → 新 5 区，未知分类降级 unfiled。
 */
import { describe, expect, it } from 'vitest'
import {
  formatTopicDisplay,
  isSubtopicAmbiguousInSection,
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

  it('inbox 对外统一叫收件箱', () => {
    expect(navSectionLabel('inbox')).toBe('收件箱')
  })
})

const SAMPLE_TREE = {
  categories: [
    { name: '做事记录', subtopics: ['项目/任务资料', '整合长文'] },
    { name: '计划与复盘', subtopics: ['目标规划方案', '整合长文'] },
    { name: '证件凭据', subtopics: ['合同协议文件', '整合长文'] },
  ],
}

describe('formatTopicDisplay', () => {
  it('单分区映射为 工作 / 小类', () => {
    expect(formatTopicDisplay('做事记录', '会议聊天记录')).toBe('工作 / 会议聊天记录')
  })

  it('跨旧大类的分区省略中间层（无歧义时）', () => {
    expect(formatTopicDisplay('证件凭据', '合同协议文件')).toBe('生活 / 合同协议文件')
  })

  it('歧义小类保留旧大类名', () => {
    expect(formatTopicDisplay('做事记录', '整合长文', SAMPLE_TREE)).toBe('工作 / 整合长文')
    expect(formatTopicDisplay('证件凭据', '整合长文', SAMPLE_TREE)).toBe('生活 / 证件凭据 / 整合长文')
  })

  it('未分类与临时存放', () => {
    expect(formatTopicDisplay(null, null)).toBe('收件箱')
    expect(formatTopicDisplay('临时存放', null)).toBe('临时存放')
  })
})

describe('isSubtopicAmbiguousInSection', () => {
  it('整合长文在生活分区有歧义', () => {
    expect(isSubtopicAmbiguousInSection(SAMPLE_TREE, 'life', '整合长文')).toBe(true)
    expect(isSubtopicAmbiguousInSection(SAMPLE_TREE, 'work', '整合长文')).toBe(false)
  })
})
