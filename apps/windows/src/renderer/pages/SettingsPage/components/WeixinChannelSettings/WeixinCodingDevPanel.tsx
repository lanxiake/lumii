import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Card } from '../../../../components/ui/Card/Card'
import {
  useCodingDevProjects,
  useCodingDevProjectModals,
} from '../../../../hooks/business/useCodingDevProjects'

export type CodingDevEnvInfo = {
  resolvedWorkspace: string
  usesDedicatedWorkspace: boolean
  powershellGatewayEnvBlock: string
  weixinSlashHint: string
}

/**
 * 微信渠道关联的「开发类 AI 工具」说明：ACP 项目管理、网关 PowerShell 环境变量、微信内斜杠命令。
 */
export const WeixinCodingDevPanel: React.FC = () => {
  const [info, setInfo] = useState<CodingDevEnvInfo | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const projectsApi = useCodingDevProjects()
  const {
    projects,
    activeProject,
    error: opErr,
    setActive,
  } = projectsApi

  /**
   * 刷新 ACP 环境变量说明（活动项目变更后路径会变）。
   */
  const reloadEnv = useCallback(async () => {
    try {
      const envInfo = await window.electronAPI.app.getCodingDevEnvInfo()
      setInfo(envInfo)
      setLoadErr(null)
    } catch (e: unknown) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void reloadEnv()
  }, [reloadEnv, activeProject])

  const handleCopyEnv = useCallback(async () => {
    if (!info) return
    await window.electronAPI.clipboard.writeText(info.powershellGatewayEnvBlock)
  }, [info])

  const { beginCreate, beginOpen, beginRemove, modals } = useCodingDevProjectModals({
    api: projectsApi,
    onProjectReady: async () => {
      await reloadEnv()
    },
    onRemoved: async () => {
      await reloadEnv()
    },
  })

  /**
   * 切换活动项目后同步刷新 env 说明。
   */
  const handleActivate = useCallback(async (name: string) => {
    await setActive(name)
    await reloadEnv()
  }, [setActive, reloadEnv])

  return (
    <Card>
      <div style={{ padding: '8px 4px' }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>开发类 AI 工具（Codex / Claude / …）</div>
        <p style={{ fontSize: 12, color: '#8c8c8c', margin: '0 0 10px', lineHeight: 1.5 }}>
          微信消息由 Gateway 上的 ACP 子进程处理。请在<strong>运行 MtBot Gateway 的机器</strong>安装对应 CLI，并设置工作目录环境变量。
          本机客户端可将工作区同步到下方路径，便于与「设置 → 工作空间」一致。
        </p>
        {loadErr && (
          <div style={{ color: '#cf1322', fontSize: 12, marginBottom: 8 }}>加载失败：{loadErr}</div>
        )}
        {info && (
          <>
            <div style={{ fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: '#8c8c8c' }}>当前 ACP 工作目录：</span>
              <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{info.resolvedWorkspace}</code>
              {info.usesDedicatedWorkspace ? (
                <span style={{ marginLeft: 8, color: '#52c41a', fontSize: 11 }}>（活动项目）</span>
              ) : (
                <span style={{ marginLeft: 8, color: '#8c8c8c', fontSize: 11 }}>（与主工作区相同）</span>
              )}
            </div>

            <div style={{ marginBottom: 10 }}>
              {projects.length === 0 && (
                <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 6 }}>
                  暂无项目。新建或打开已有项目后，其将出现在工作空间 projects 目录下，并可设为 ACP 活动目录。
                </div>
              )}
              {projects.map((p) => {
                const isActive = p.name === activeProject
                return (
                  <div
                    key={p.name}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 8px', marginBottom: 4, borderRadius: 6,
                      background: isActive ? 'rgba(82,196,26,0.10)' : 'rgba(0,0,0,0.03)',
                      border: isActive ? '1px solid rgba(82,196,26,0.4)' : '1px solid transparent',
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                    {p.isExternal && (
                      <span style={{ fontSize: 10, color: '#1890ff' }}>链接</span>
                    )}
                    {isActive && (
                      <span style={{ fontSize: 10, color: '#52c41a' }}>● 活动</span>
                    )}
                    <code style={{ fontSize: 10, color: '#8c8c8c', wordBreak: 'break-all', flex: 1 }}>
                      {p.realPath}
                    </code>
                    {!isActive && (
                      <button
                        type="button"
                        onClick={() => void handleActivate(p.name)}
                        style={{ fontSize: 11, cursor: 'pointer', border: 'none', background: 'transparent', color: '#1890ff' }}
                      >
                        设为活动
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => beginRemove(p.name)}
                      style={{ fontSize: 11, cursor: 'pointer', border: 'none', background: 'transparent', color: '#cf1322' }}
                    >
                      移除
                    </button>
                  </div>
                )
              })}
            </div>

            {opErr && (
              <div style={{ color: '#cf1322', fontSize: 12, marginBottom: 8 }}>操作失败：{opErr}</div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <Button variant="secondary" onClick={beginCreate}>
                新建项目…
              </Button>
              <Button variant="secondary" onClick={() => void beginOpen()}>
                打开已有项目…
              </Button>
              <Button variant="secondary" onClick={() => void handleCopyEnv()}>
                复制 PowerShell 环境变量
              </Button>
            </div>
            <div
              style={{
                fontSize: 11,
                color: '#595959',
                background: 'rgba(0,0,0,0.04)',
                padding: 10,
                borderRadius: 6,
                whiteSpace: 'pre-wrap',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                maxHeight: 160,
                overflow: 'auto',
                marginBottom: 10,
              }}
            >
              {info.powershellGatewayEnvBlock}
            </div>
            <div style={{ fontSize: 12, color: '#595959', lineHeight: 1.5 }}>
              <strong>微信内切换：</strong>
              {info.weixinSlashHint}
            </div>
          </>
        )}
        {modals}
      </div>
    </Card>
  )
}
