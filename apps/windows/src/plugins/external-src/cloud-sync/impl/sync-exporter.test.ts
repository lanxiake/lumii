import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneStaleWikiExports, removeLegacyPipelinesRuns } from './sync-exporter'

const tempDirs: string[] = []

function makeDir(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-wiki-'))
  tempDirs.push(dir)
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'x')
  return dir
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('pruneStaleWikiExports', () => {
  it('删掉不在清单里的 wiki_*.jsonl，清单内与其它文件不动', () => {
    const dir = makeDir(['wiki_sources.jsonl', 'wiki_syntheses.jsonl', 'notes.txt', 'data.json'])

    const removed = pruneStaleWikiExports(dir, ['wiki_sources'])

    expect(removed).toEqual(['wiki_syntheses.jsonl'])
    expect(fs.existsSync(path.join(dir, 'wiki_sources.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'data.json'))).toBe(true)
  })

  it('目录不存在时返回空数组（首次同步的正常情形）', () => {
    expect(pruneStaleWikiExports(path.join(os.tmpdir(), 'lumii-no-such-dir-xyz'), ['wiki_sources'])).toEqual([])
  })
})

/**
 * 流水线的 runs/ 不参与同步。
 *
 * 现场（2026-11-04）：`shouldSkipFile` 只做到「不复制」，而 `mirror: true` 的待删集合
 * **不包含被跳过的文件**（排除规则不该导致删除）。所以规则加上之前已复制进 sync 目录的
 * runs/ 永远留在那儿，还进了 git 历史——实测 156 个文件、每个流水线的每次运行一套
 * journal/meta/spec 快照。
 */
describe('removeLegacyPipelinesRuns', () => {
  const makePipelines = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-runs-'))
    tempDirs.push(root)
    // 两条流水线各有 runs/；第三条没有；另有一个「名字里带 runs 但不是 runs 目录」的
    for (const id of ['pipe-a', 'pipe-b', 'pipe-c']) {
      fs.mkdirSync(path.join(root, id), { recursive: true })
      fs.writeFileSync(path.join(root, id, 'spec.json'), '{}')
    }
    fs.mkdirSync(path.join(root, 'pipe-a', 'runs', 'r1'), { recursive: true })
    fs.writeFileSync(path.join(root, 'pipe-a', 'runs', 'r1', 'journal.jsonl'), '{"ok":true}\n')
    fs.mkdirSync(path.join(root, 'pipe-b', 'runs'), { recursive: true })
    fs.writeFileSync(path.join(root, 'pipe-b', 'runs', 'meta.json'), '{}')
    // 不叫 runs 的目录必须留着（避免误伤）
    fs.mkdirSync(path.join(root, 'pipe-c', 'runslater'), { recursive: true })
    fs.writeFileSync(path.join(root, 'pipe-c', 'runslater', 'x.txt'), 'keep me')
    return root
  }

  it('删掉各流水线的 runs/，保留 spec.json 与名字相近的目录', () => {
    const root = makePipelines()
    expect(removeLegacyPipelinesRuns(root)).toBe(2)
    expect(fs.existsSync(path.join(root, 'pipe-a', 'runs'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'pipe-b', 'runs'))).toBe(false)
    // 流水线本体不动
    expect(fs.existsSync(path.join(root, 'pipe-a', 'spec.json'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'pipe-c', 'spec.json'))).toBe(true)
    // 名字相近的目录不被误删
    expect(fs.existsSync(path.join(root, 'pipe-c', 'runslater', 'x.txt'))).toBe(true)
  })

  it('已经干净时返回 0（幂等，每轮导出都会调）', () => {
    const root = makePipelines()
    removeLegacyPipelinesRuns(root)
    expect(removeLegacyPipelinesRuns(root)).toBe(0)
  })

  it('目录不存在时返回 0（首次同步的正常情形）', () => {
    expect(removeLegacyPipelinesRuns(path.join(os.tmpdir(), 'lumii-no-such-pipes-xyz'))).toBe(0)
  })
})
