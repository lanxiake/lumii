import { describe, it, expect } from 'vitest'
import {
  computeAgentBackendBindingUpdate,
  resolveAgentDevBinding,
  resolveCodingDevAcpWorkspacePath,
} from './coding-dev-env'
import type { AgentDevBinding, AppConfig } from './config/types'

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

describe('resolveAgentDevBinding Agent 绑定解析', () => {
  const bindings = [
    { agentId: 'assistant', backendId: 'claude', enabled: true },
    { agentId: 'code-dev', backendId: 'codex', workspace: 'D:/p', enabled: true },
    { agentId: 'disabled-agent', backendId: 'claude', enabled: false },
  ] as AgentDevBinding[]

  it("legacy 'default' 参与者命中 assistant 绑定", () => {
    expect(resolveAgentDevBinding({ codingDevAgentBindings: bindings }, 'default')?.backendId).toBe('claude')
  })

  it('未启用的绑定不命中', () => {
    expect(resolveAgentDevBinding({ codingDevAgentBindings: bindings }, 'disabled-agent')).toBeUndefined()
  })

  it('未提供 agentId 时返回 undefined', () => {
    expect(resolveAgentDevBinding({ codingDevAgentBindings: bindings }, undefined)).toBeUndefined()
  })
})

describe('computeAgentBackendBindingUpdate 按 Agent 粘住后端', () => {
  it('无绑定 → upsert 新绑定并启用', () => {
    expect(computeAgentBackendBindingUpdate([], 'code-dev', 'claude')).toEqual([
      { agentId: 'code-dev', backendId: 'claude', enabled: true },
    ])
  })

  it('已启用同后端 → 返回 null（无需写盘）', () => {
    const bindings = [{ agentId: 'code-dev', backendId: 'claude', enabled: true }] as AgentDevBinding[]
    expect(computeAgentBackendBindingUpdate(bindings, 'code-dev', 'claude')).toBeNull()
  })

  it('切换后端时保留 workspace 与 permissionMode', () => {
    const bindings = [
      {
        agentId: 'code-dev',
        backendId: 'claude',
        workspace: 'D:/p',
        permissionMode: 'bypassPermissions',
        enabled: true,
      },
    ] as AgentDevBinding[]
    expect(computeAgentBackendBindingUpdate(bindings, 'code-dev', 'codex')).toEqual([
      {
        agentId: 'code-dev',
        backendId: 'codex',
        workspace: 'D:/p',
        permissionMode: 'bypassPermissions',
        enabled: true,
      },
    ])
  })

  it("'default' 参与者命中 assistant 绑定，写入时归一化为 assistant", () => {
    const bindings = [{ agentId: 'default', backendId: 'claude', enabled: true }] as AgentDevBinding[]
    expect(computeAgentBackendBindingUpdate(bindings, 'default', 'codex')).toEqual([
      { agentId: 'assistant', backendId: 'codex', enabled: true },
    ])
  })

  it('lumii → 停用现有绑定并保留其余字段（设置页可再启用）', () => {
    const bindings = [
      { agentId: 'code-dev', backendId: 'claude', workspace: 'D:/p', enabled: true },
    ] as AgentDevBinding[]
    expect(computeAgentBackendBindingUpdate(bindings, 'code-dev', 'lumii')).toEqual([
      { agentId: 'code-dev', backendId: 'claude', workspace: 'D:/p', enabled: false },
    ])
  })

  it('lumii 且本无绑定 → 返回 null', () => {
    expect(computeAgentBackendBindingUpdate([], 'code-dev', 'lumii')).toBeNull()
  })

  it('不支持的 ACP 后端（gemini）→ 返回 null（仅会话级生效）', () => {
    expect(computeAgentBackendBindingUpdate([], 'code-dev', 'gemini')).toBeNull()
  })
})
