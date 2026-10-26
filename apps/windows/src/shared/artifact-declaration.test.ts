import { describe, expect, it } from 'vitest'
import {
  MAX_DECLARATIONS,
  normalizeArtifactPath,
  parseSidecar,
  readDeclarations,
  sanitizeArtifactMeta,
  sidecarPathFor,
} from './artifact-declaration'

describe('normalizeArtifactPath', () => {
  it('归一化相对路径', () => {
    expect(normalizeArtifactPath('outputs\\a\\b.png')).toBe('outputs/a/b.png')
    expect(normalizeArtifactPath('./outputs//a.png')).toBe('outputs/a.png')
    expect(normalizeArtifactPath('  outputs/a.png  ')).toBe('outputs/a.png')
  })

  it('拒绝绝对路径与越界', () => {
    expect(normalizeArtifactPath('/etc/passwd')).toBeNull()
    expect(normalizeArtifactPath('C:\\Windows\\a.png')).toBeNull()
    expect(normalizeArtifactPath('\\\\server\\share\\a.png')).toBeNull()
    expect(normalizeArtifactPath('outputs/../../a.png')).toBeNull()
    expect(normalizeArtifactPath('')).toBeNull()
    expect(normalizeArtifactPath(42)).toBeNull()
  })
})

describe('readDeclarations', () => {
  const valid = {
    kind: 'image',
    path: 'outputs/20261026/a.png',
    role: 'deliverable',
    meta: { width: 1024, height: 1024, model: 'seedream', prompt: '兔子' },
  }

  it('读 details.artifacts 并清洗字段', () => {
    const [declaration] = readDeclarations({ details: { artifacts: [valid] } })
    expect(declaration).toMatchObject({
      kind: 'image',
      path: 'outputs/20261026/a.png',
      role: 'deliverable',
      meta: { width: 1024, height: 1024, model: 'seedream', prompt: '兔子' },
    })
  })

  it('无 details / 坏形状返回空，不抛', () => {
    expect(readDeclarations(null)).toEqual([])
    expect(readDeclarations({ details: null })).toEqual([])
    expect(readDeclarations({ details: { artifacts: 'x' } })).toEqual([])
    expect(readDeclarations({ details: { artifacts: [{}] } })).toEqual([])
  })

  it('非法 path / 无 path 且无 remoteUrl 被丢弃', () => {
    const declarations = readDeclarations({
      details: {
        artifacts: [
          { kind: 'image', path: '../a.png' },
          { kind: 'video' },
          { kind: 'video', remoteUrl: 'http://x/a.mp4' },
          { kind: 'nope', path: 'a.png' },
        ],
      },
    })
    expect(declarations).toEqual([{ kind: 'video', remoteUrl: 'http://x/a.mp4' }])
  })

  it('MCP structuredContent 是第二通道', () => {
    const [declaration] = readDeclarations({
      details: { mcpServer: 'comfyui', structuredContent: { artifacts: [valid] } },
    })
    expect(declaration?.path).toBe('outputs/20261026/a.png')
  })

  it('最多 50 条', () => {
    const many = Array.from({ length: MAX_DECLARATIONS + 10 }, (_, index) => ({
      kind: 'image',
      path: `outputs/a-${index}.png`,
    }))
    expect(readDeclarations({ details: { artifacts: many } })).toHaveLength(MAX_DECLARATIONS)
  })
})

describe('sanitizeArtifactMeta', () => {
  it('只留已知数值/文本字段', () => {
    expect(
      sanitizeArtifactMeta({
        width: 1024,
        height: '1024',
        pages: 12,
        durationSec: -1,
        model: 'h3',
        junk: 'x',
        params: { seed: 1, ratio: '3:4', bad: null },
      }),
    ).toEqual({
      width: 1024,
      pages: 12,
      model: 'h3',
      params: { seed: 1, ratio: '3:4' },
    })
  })
})

describe('parseSidecar', () => {
  it('读取 kind/title/meta，坏 JSON 静默', () => {
    expect(
      parseSidecar(
        JSON.stringify({
          kind: 'slides',
          title: '月报',
          meta: { pages: 12, model: 'pptx-skill' },
        }),
      ),
    ).toEqual({ kind: 'slides', title: '月报', meta: { pages: 12, model: 'pptx-skill' } })
    expect(parseSidecar('{oops')).toBeNull()
    expect(parseSidecar('null')).toBeNull()
    expect(parseSidecar(JSON.stringify({ unknown: 1 }))).toBeNull()
  })

  it('侧车文件名约定', () => {
    expect(sidecarPathFor('outputs/deck.pptx')).toBe('outputs/deck.pptx.lumii-artifact.json')
  })
})
