import { describe, it, expect } from 'vitest'
import { resolveCodingDevAcpWorkspacePath } from './coding-dev-env'
import type { AppConfig } from './config/types'

const fallback = 'D:/data/workspace'

/** 构造最小 AppConfig 片段供路径解析测试 */
function cfg(partial: Partial<AppConfig>): AppConfig {
  return partial as AppConfig
}

describe('resolveCodingDevAcpWorkspacePath', () => {
  it('活动项目 realPath 优先于旧专用目录与主工作区', () => {
    const path = resolveCodingDevAcpWorkspacePath({
      appConfig: cfg({
        codingDevProjects: [{ name: 'p1', realPath: 'D:/repos/p1', isExternal: true }],
        codingDevActiveProject: 'p1',
        codingDevAcpWorkspace: 'D:/old-dedicated',
        workspaceDirectory: 'D:/main-ws',
      }),
      defaultWorkspaceFallback: fallback,
    })
    expect(path).toBe('D:/repos/p1')
  })

  it('无活动项目时回退旧 codingDevAcpWorkspace', () => {
    const path = resolveCodingDevAcpWorkspacePath({
      appConfig: cfg({
        codingDevAcpWorkspace: 'D:/old-dedicated',
        workspaceDirectory: 'D:/main-ws',
      }),
      defaultWorkspaceFallback: fallback,
    })
    expect(path).toBe('D:/old-dedicated')
  })

  it('无专用目录时回退主工作区，再回退 default', () => {
    expect(
      resolveCodingDevAcpWorkspacePath({
        appConfig: cfg({ workspaceDirectory: 'D:/main-ws' }),
        defaultWorkspaceFallback: fallback,
      }),
    ).toBe('D:/main-ws')
    expect(
      resolveCodingDevAcpWorkspacePath({
        appConfig: cfg({}),
        defaultWorkspaceFallback: fallback,
      }),
    ).toBe(fallback)
  })

  it('活动名在列表中不存在时视为无活动项目', () => {
    const path = resolveCodingDevAcpWorkspacePath({
      appConfig: cfg({
        codingDevProjects: [{ name: 'p1', realPath: 'D:/repos/p1', isExternal: false }],
        codingDevActiveProject: 'missing',
        workspaceDirectory: 'D:/main-ws',
      }),
      defaultWorkspaceFallback: fallback,
    })
    expect(path).toBe('D:/main-ws')
  })
})
