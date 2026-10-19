import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneStaleWikiExports } from './sync-exporter'

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
