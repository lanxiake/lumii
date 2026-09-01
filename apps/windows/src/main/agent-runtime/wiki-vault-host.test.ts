import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WIKI_VAULT_LAYOUT_ID } from '@mtbot/agent-runtime'
import { wikiVaultNeedsRebuild } from './wiki-vault-host'

describe('wikiVaultNeedsRebuild', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  /** 创建隔离临时 wiki 根目录。 */
  function tmpVault(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-vault-'))
    dirs.push(d)
    return d
  }

  it('顶层存在旧序号目录时需要重建', () => {
    const root = tmpVault()
    fs.mkdirSync(path.join(root, '00-收件箱'))
    expect(wikiVaultNeedsRebuild(root)).toBe(true)
  })

  it('meta 已是当前 layoutId 且无序号目录时不重建', () => {
    const root = tmpVault()
    fs.mkdirSync(path.join(root, '.lumii'), { recursive: true })
    fs.mkdirSync(path.join(root, '工作'))
    fs.writeFileSync(
      path.join(root, '.lumii', 'wiki-meta.json'),
      JSON.stringify({ layoutId: WIKI_VAULT_LAYOUT_ID }),
    )
    expect(wikiVaultNeedsRebuild(root)).toBe(false)
  })
})
