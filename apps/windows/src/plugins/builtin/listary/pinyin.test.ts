/**
 * pinyin 单测 —— 纯逻辑，vitest 可跑。
 *
 * 用例来自用户提的三条需求（2026-11-15）：
 * > 豆包 → doubao、dou → doubao、豆包、豆 → 豆包
 * 这里把「输入 → 应命中」拆成两半验：查询侧产出什么前缀、索引侧产出什么 token。
 * 能否命中由 FTS5 前缀匹配保证（在 `verify/listary-p3` 的探针里端到端验）。
 */

import { describe, expect, it } from 'vitest'

import {
  buildPinyinQuery,
  buildPinyinTokens,
  hasCjk,
  pinyinFull,
  pinyinInitials,
} from './pinyin.js'

describe('pinyinFull / pinyinInitials', () => {
  it('中文全拼与首字母', () => {
    expect(pinyinFull('豆包')).toBe('doubao')
    expect(pinyinInitials('豆包')).toBe('db')
  })

  it('混合中英：拉丁段保留原文，中文段取首字母', () => {
    expect(pinyinFull('Listary逆向')).toBe('listarynixiang')
    // pinyin-pro 的实测行为：拉丁段整段保留、中文段取首字母；本函数统一转小写
    expect(pinyinInitials('Listary逆向')).toBe('listarynx')
    expect(pinyinInitials('Listary逆向笔记')).toBe('listarynxbj')
  })

  it('多音字取默认读音', () => {
    expect(pinyinFull('长江')).toBe('changjiang')
  })

  it('空串不炸', () => {
    expect(pinyinFull('')).toBe('')
    expect(pinyinInitials('')).toBe('')
  })
})

describe('hasCjk', () => {
  it('中文为真', () => {
    expect(hasCjk('豆包')).toBe(true)
    expect(hasCjk('a豆')).toBe(true)
  })

  it('纯英文/数字为假', () => {
    expect(hasCjk('doubao')).toBe(false)
    expect(hasCjk('readme.md')).toBe(false)
  })
})

describe('buildPinyinTokens（索引侧）', () => {
  it('中文文件名写全拼与首字母，空格分隔', () => {
    const t = buildPinyinTokens('豆包.exe')
    expect(t).toContain('doubao')
    expect(t).toContain('db')
  })

  it('纯英文文件名不写拼音（不必给 readme.md 存一遍 readme）', () => {
    expect(buildPinyinTokens('readme.md')).toBe('')
    expect(buildPinyinTokens('package.json')).toBe('')
  })

  it('首字母与全拼相同时不重复存', () => {
    // 单字中文：全拼 == 首字母
    const t = buildPinyinTokens('猫')
    expect(t.split(' ').filter((x) => x === 'mao')).toHaveLength(1)
  })

  it('空串返回空串', () => {
    expect(buildPinyinTokens('')).toBe('')
  })
})

describe('buildPinyinQuery（查询侧）', () => {
  // ── 用户给的四条，逐条验 ──

  it('「豆包」→ 产出 doubao（首字母 db 太短被门槛挡掉，但 bigram 分支仍能命中原词）', () => {
    const words = buildPinyinQuery('豆包')
    expect(words).toContain('doubao')
  })

  it('「豆」→ 产出 dou（前缀匹配命中 doubao）', () => {
    expect(buildPinyinQuery('豆')).toContain('dou')
  })

  it('「dou」→ 原样保留（用户直接输入，不受中文转换门槛限制）', () => {
    expect(buildPinyinQuery('dou')).toEqual(['dou'])
  })

  it('「doubao」→ 原样保留', () => {
    expect(buildPinyinQuery('doubao')).toEqual(['doubao'])
  })

  it('「db」→ 原样保留（首字母查询；这是用户亲手打的，短也得认）', () => {
    expect(buildPinyinQuery('db')).toEqual(['db'])
  })

  it('「d」→ 原样保留（同上，不设下限）', () => {
    expect(buildPinyinQuery('d')).toEqual(['d'])
  })

  // ── 中文转换词的长度门槛（防拼音前缀噪声） ──

  it('「文档」的 2 字首字母 wd 被挡掉，只留全拼 wendang', () => {
    const words = buildPinyinQuery('文档')
    expect(words).toEqual(['wendang'])
    expect(words).not.toContain('wd')
  })

  it('中文转换出的 3 字母以上首字母保留', () => {
    // 项目设计文档 → xmsjwd（6 字）
    expect(buildPinyinQuery('项目设计文档')).toContain('xmsjwd')
  })

  it('中文转换出的短全拼也过门槛（豆 → dou 是 3 字）', () => {
    expect(buildPinyinQuery('豆')).toContain('dou')
  })

  it('大小写不敏感', () => {
    expect(buildPinyinQuery('DouBao')).toEqual(['doubao'])
  })

  it('空串产出空数组（不构造空 MATCH）', () => {
    expect(buildPinyinQuery('')).toEqual([])
    expect(buildPinyinQuery('   ')).toEqual([])
  })

  it('产出已去重', () => {
    const words = buildPinyinQuery('豆包')
    expect(new Set(words).size).toBe(words.length)
  })
})
