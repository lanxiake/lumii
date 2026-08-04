/**
 * CodingDevAcpPanel - 本机开发类 AI 工具（ACP）设置
 *
 * 仅展示用户关心的内容：工具安装状态、官网链接、工作目录。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Card } from '../../../../components/ui/Card/Card'
import {
  useCodingDevProjects,
  useCodingDevProjectModals,
} from '../../../../hooks/business/useCodingDevProjects'
import styles from './CodingDevAcpPanel.module.css'

export type LocalAcpToolStatusView = {
  id: string
  label: string
  description: string
  installed: boolean
  resolvedPath?: string
  resolvedCommand?: string
  homepageUrl: string
  githubUrl?: string
  installUrl: string
}

export type CodingDevEnvInfo = {
  resolvedWorkspace: string
  usesDedicatedWorkspace: boolean
  powershellGatewayEnvBlock: string
  weixinSlashHint: string
}

/**
 * ACP 设置面板
 */
export const CodingDevAcpPanel: React.FC = () => {
  const [info, setInfo] = useState<CodingDevEnvInfo | null>(null)
  const [tools, setTools] = useState<LocalAcpToolStatusView[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)
  const projectsApi = useCodingDevProjects()
  const { projects, activeProject, error: opErr, setActive } = projectsApi

  /**
   * 刷新工作目录信息
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

  /**
   * 探测本机 CLI 安装状态
   */
  const reloadTools = useCallback(async () => {
    setDetecting(true)
    try {
      const list = await window.electronAPI.app.detectCodingDevTools()
      setTools(list)
    } catch (e: unknown) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    } finally {
      setDetecting(false)
    }
  }, [])

  useEffect(() => {
    void reloadEnv()
    void reloadTools()
  }, [reloadEnv, reloadTools, activeProject])

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
   * 设为活动工作目录
   */
  const handleActivate = useCallback(async (name: string) => {
    await setActive(name)
    await reloadEnv()
  }, [setActive, reloadEnv])

  /**
   * 打开外部链接
   */
  const openUrl = useCallback((url: string) => {
    void window.electronAPI.app.openExternal(url)
  }, [])

  return (
    <Card>
      <div className={styles.panel}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>开发类 AI 工具（本机 ACP）</div>
            <p className={styles.desc}>
              仅连接本机已安装的 CLI。对话中用 /cursor、/claude、/codex、/copilot 切换，/mtbot 回到主代理。
            </p>
          </div>
          <Button variant="secondary" size="sm" loading={detecting} onClick={() => { void reloadTools() }}>
            重新检测
          </Button>
        </div>

        {loadErr && <div className={styles.error}>加载失败：{loadErr}</div>}

        <div className={styles.sectionLabel}>本机工具</div>
        <div className={styles.toolList}>
          {tools.map((t) => (
            <div key={t.id} className={styles.toolRow}>
              <div className={styles.toolMain}>
                <div className={styles.toolNameRow}>
                  <span className={styles.toolName}>{t.label}</span>
                  <span className={t.installed ? styles.badgeOk : styles.badgeOff}>
                    {t.installed ? '已安装' : '未安装'}
                  </span>
                </div>
                <div className={styles.toolDesc}>{t.description}</div>
                {t.installed && t.resolvedPath && (
                  <code className={styles.path}>{t.resolvedPath}</code>
                )}
              </div>
              <div className={styles.toolActions}>
                <button type="button" className={styles.linkBtn} onClick={() => openUrl(t.homepageUrl)}>
                  官网
                </button>
                {t.githubUrl && (
                  <button type="button" className={styles.linkBtn} onClick={() => openUrl(t.githubUrl!)}>
                    GitHub
                  </button>
                )}
                {!t.installed && (
                  <Button size="sm" onClick={() => openUrl(t.installUrl)}>
                    安装
                  </Button>
                )}
              </div>
            </div>
          ))}
          {tools.length === 0 && !detecting && (
            <div className={styles.empty}>点击「重新检测」扫描本机 CLI</div>
          )}
        </div>

        <div className={styles.sectionLabel}>ACP 工作目录</div>
        {info && (
          <div className={styles.cwdBox}>
            <div className={styles.cwdMeta}>
              <span className={styles.cwdLabel}>当前目录</span>
              {info.usesDedicatedWorkspace ? (
                <span className={styles.badgeOk}>活动项目</span>
              ) : (
                <span className={styles.badgeOff}>主工作区</span>
              )}
            </div>
            <code className={styles.path}>{info.resolvedWorkspace}</code>
          </div>
        )}

        <div className={styles.projectList}>
          {projects.length === 0 && (
            <div className={styles.empty}>暂无项目。新建或打开后可设为 ACP 工作目录。</div>
          )}
          {projects.map((p) => {
            const isActive = p.name === activeProject
            return (
              <div key={p.name} className={`${styles.projectRow} ${isActive ? styles.projectActive : ''}`}>
                <div className={styles.projectMain}>
                  <span className={styles.toolName}>{p.name}</span>
                  {p.isExternal && <span className={styles.badgeLink}>链接</span>}
                  {isActive && <span className={styles.badgeOk}>活动</span>}
                  <code className={styles.path}>{p.realPath}</code>
                </div>
                <div className={styles.toolActions}>
                  {!isActive && (
                    <button type="button" className={styles.linkBtn} onClick={() => void handleActivate(p.name)}>
                      设为活动
                    </button>
                  )}
                  <button type="button" className={styles.dangerBtn} onClick={() => beginRemove(p.name)}>
                    移除
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        {opErr && <div className={styles.error}>操作失败：{opErr}</div>}

        <div className={styles.footerActions}>
          <Button variant="secondary" onClick={beginCreate}>新建项目…</Button>
          <Button variant="secondary" onClick={() => { void beginOpen() }}>打开已有项目…</Button>
        </div>

        {info?.weixinSlashHint && (
          <div className={styles.hint}>{info.weixinSlashHint}</div>
        )}
        {modals}
      </div>
    </Card>
  )
}

export default CodingDevAcpPanel
