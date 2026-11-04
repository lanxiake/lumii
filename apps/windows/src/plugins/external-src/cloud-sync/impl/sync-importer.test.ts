/**
 * 导入端用户文件子树。
 *
 * **回归**：导出端一直有 `exportPipelines`，导入端却只处理 files/outputs，
 * 流水线只上云不下云（2026-11-04：另一台机器看不到「开源项目推荐短视频」）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SyncImporter } from './sync-importer'

interface ImporterInternals {
  applyFileChanges: (
    changes: { copy: string[]; delete: string[] } | 'all',
    sub: 'files' | 'outputs' | 'pipelines',
  ) => number
}

describe('SyncImporter 用户文件', () => {
  let root: string
  let syncDir: string
  let workspaceDir: string

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  })

  function makeImporter(): ImporterInternals {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-sync-import-'))
    syncDir = path.join(root, 'sync')
    workspaceDir = path.join(root, 'workspace')
    return new SyncImporter({
      dbPath: path.join(root, 'unused.db'),
      syncDir,
      workspaceDir,
      dataDir: path.join(root, 'data'),
    }) as unknown as ImporterInternals
  }

  function write(rel: string, content: string): void {
    const abs = path.join(syncDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }

  it('pipelines 变更集会复制 spec，但跳过 runs/', () => {
    const importer = makeImporter()
    write('workspace/pipelines/oss-recommend-video/spec.json', '{"name":"开源项目推荐短视频"}')
    write('workspace/pipelines/oss-recommend-video/runs/r1/journal.jsonl', '{}')

    const copied = importer.applyFileChanges(
      {
        copy: [
          'workspace/pipelines/oss-recommend-video/spec.json',
          'workspace/pipelines/oss-recommend-video/runs/r1/journal.jsonl',
        ],
        delete: [],
      },
      'pipelines',
    )

    expect(copied).toBe(1)
    expect(
      fs.readFileSync(
        path.join(workspaceDir, 'pipelines/oss-recommend-video/spec.json'),
        'utf-8',
      ),
    ).toContain('开源项目推荐短视频')
    expect(
      fs.existsSync(path.join(workspaceDir, 'pipelines/oss-recommend-video/runs')),
    ).toBe(false)
  })

  it('pipelines 无基线（all）时同样只复制、不碰 runs', () => {
    const importer = makeImporter()
    write('workspace/pipelines/p1/spec.json', '{}')
    write('workspace/pipelines/p1/runs/r1/meta.json', '{}')

    const copied = importer.applyFileChanges('all', 'pipelines')

    expect(copied).toBe(1)
    expect(fs.existsSync(path.join(workspaceDir, 'pipelines/p1/spec.json'))).toBe(true)
    // 空目录会被建出来，关键是运行记录文件没被复制
    expect(fs.existsSync(path.join(workspaceDir, 'pipelines/p1/runs/r1/meta.json'))).toBe(false)
  })
})
