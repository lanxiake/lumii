/**
 * CodingDevAcpPanel - 本机开发类 AI 工具（ACP）设置
 *
 * 仅展示用户关心的内容：工具安装状态、一键安装、官网链接、工作目录。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Card } from '../../../../components/ui/Card/Card'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import { useSettingsHub } from '../../../../components/SettingsHub'
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
  installUrl: string
  installCommand: string
  installHint: string
  currentVersion?: string
  latestVersion?: string
  /** CLI 自带升级命令（查不到 registry 版本号的工具，如 Cursor 的 agent update） */
  selfUpdateCommand?: string
  /** 认证状态：ok=已登录，required=需登录，unknown=未知 */
  authStatus?: 'ok' | 'required' | 'unknown'
  /** 该卡片的探测状态：元数据已渲染但尚未探测时为 pending */
  detectState: 'pending' | 'detecting' | 'done'
}

/** 工具图标色块（品牌色 + 首字母，与 ChannelBrandIcon 同思路，避免引入外部 logo 资源） */
const TOOL_ICON: Record<string, { bg: string; label: string }> = {
  cursor: { bg: '#1a1a1a', label: 'Cu' },
  claude: { bg: '#CC785C', label: 'Cl' },
  codex: { bg: '#10A37F', label: 'Co' },
  opencode: { bg: '#fb923c', label: 'Oc' },
}

/**
 * 工具图标色块，未知工具回落首字母
 */
const ToolIcon: React.FC<{ id: string; label: string }> = ({ id, label }) => {
  const meta = TOOL_ICON[id] ?? { bg: '#4f8ef7', label: label.slice(0, 2) }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 8,
        background: meta.bg,
        color: '#fff',
        fontSize: 12,
        fontWeight: 700,
        flexShrink: 0,
        userSelect: 'none',
      }}
    >
      {meta.label}
    </span>
  )
}

/** 卸载预览（主进程 previewUninstallCodingDevTool 返回） */
type UninstallPreview = {
  toolId: string
  label: string
  installed: boolean
  displayCommand: string
  automatic: boolean
  documented: boolean
  hint: string
}

/**
 * 卸载确认文案：命令 + 风险提示（无官方文档依据时明确告知是推断路径）
 */
function buildUninstallConfirmText(p: UninstallPreview | null): string {
  if (!p) return ''
  if (!p.automatic) {
    return `${p.label} 无法自动卸载。\n\n${p.displayCommand}\n\n${p.hint}`
  }
  const warn = p.documented
    ? ''
    : '\n\n⚠️ 该工具官方未提供卸载命令，上述路径由官方安装脚本推断得出。请确认目录内没有你自己的文件。'
  return `将执行以下命令：\n\n${p.displayCommand}\n\n${p.hint}${warn}`
}

/**
 * 构造「让 AI 安装」的提示词：强调先查最新官方文档，再动手装并配置
 */
function buildAiInstallPrompt(t: LocalAcpToolStatusView): string {
  return [
    `请帮我在这台 Windows 电脑上安装并配置 ${t.label}（命令行工具）。`,
    '',
    '已知信息（可能已过时，请以最新官方文档为准）：',
    `- 官方文档：${t.installUrl}`,
    `- 官网：${t.homepageUrl}`,
    `- 参考安装命令：${t.installCommand}`,
    t.installHint ? `- 备注：${t.installHint}` : '',
    t.currentVersion ? `- 本机已装版本：${t.currentVersion}` : '- 本机当前未安装',
    '',
    '请按以下步骤执行：',
    '1. 先用联网能力读取上面的官方文档，确认当前最新的安装方式与前置依赖（Node / Python / uv 等版本要求）。',
    '2. 检查本机是否已满足前置依赖，缺失的先安装。',
    '3. 执行安装，并在安装后运行版本命令验证是否成功。',
    '4. 说明后续如何登录 / 配置 API Key 等认证步骤（有官方推荐方式就照官方的来）。',
    '5. 如果安装失败，给出失败原因和可行的替代安装方式。',
    '',
    '注意：这个工具会作为灵栖的本机 ACP 后端使用，安装完成后我要能在对话里用 '
      + `/${t.id} 切换过去，所以请确保可执行文件在 PATH 中。`,
  ]
    .filter(Boolean)
    .join('\n')
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
  const [installingId, setInstallingId] = useState<string | null>(null)
  /** 与 installingId 分开：同一张卡片"安装/升级中"与"卸载中"是互斥的两种状态，
   * 共用一个标记会导致卸载执行时误渲染成升级按钮的 loading 态 */
  const [uninstallingId, setUninstallingId] = useState<string | null>(null)
  const [loggingInId, setLoggingInId] = useState<string | null>(null)
  const [installMsg, setInstallMsg] = useState<string | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<UninstallPreview | null>(null)
  const projectsApi = useCodingDevProjects()
  const { projects, activeProject, error: opErr, setActive } = projectsApi
  const { closeHub } = useSettingsHub()
  /** 逐个探测期间面板被关掉就停下，避免卸载后 setState（StrictMode 会重挂，故挂载时重置为 true） */
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

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
   * 探测单个工具并就地更新卡片
   */
  const detectOne = useCallback(async (toolId: string) => {
    if (!aliveRef.current) return
    setTools((prev) => prev.map((t) => (t.id === toolId ? { ...t, detectState: 'detecting' } : t)))
    try {
      const status = await window.electronAPI.app.detectCodingDevTool(toolId)
      if (!aliveRef.current) return
      setTools((prev) =>
        prev.map((t) => (t.id === toolId ? { ...t, ...status, detectState: 'done' } : t)),
      )
    } catch {
      if (!aliveRef.current) return
      // 单个工具探测失败不影响其他卡片，标记完成即可
      setTools((prev) => prev.map((t) => (t.id === toolId ? { ...t, detectState: 'done' } : t)))
    }
  }, [])

  /**
   * 先渲染元数据卡片，再逐个探测（避免一次性批量探测阻塞面板）
   */
  const reloadTools = useCallback(async () => {
    setDetecting(true)
    try {
      const metas = await window.electronAPI.app.listCodingDevToolsMetadata()
      if (!aliveRef.current) return
      setTools(metas.map((m) => ({ ...m, installed: false, detectState: 'pending' as const })))
      setLoadErr(null)
      for (const m of metas) {
        if (!aliveRef.current) return
        await detectOne(m.id)
      }
    } catch (e: unknown) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setDetecting(false)
    }
  }, [detectOne])

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

  /**
   * 复制官方安装命令到剪贴板
   */
  const copyInstallCommand = useCallback(async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd)
      setInstallMsg(`已复制安装命令：${cmd}`)
    } catch {
      setInstallMsg(`请手动复制：${cmd}`)
    }
  }, [])

  /**
   * 一键执行官方安装命令
   */
  const handleInstall = useCallback(async (toolId: string) => {
    setInstallingId(toolId)
    setInstallMsg('正在执行官方安装脚本，请稍候…')
    try {
      const result = await window.electronAPI.app.installCodingDevTool(toolId)
      setInstallMsg(result.message)
      await detectOne(toolId)
    } catch (e: unknown) {
      setInstallMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setInstallingId(null)
    }
  }, [detectOne])

  /**
   * 打开卸载确认弹窗（先取预览命令，不执行）
   */
  const beginUninstall = useCallback(async (toolId: string) => {
    try {
      const preview = await window.electronAPI.app.previewUninstallCodingDevTool(toolId)
      setUninstallTarget(preview)
    } catch (e: unknown) {
      setInstallMsg(e instanceof Error ? e.message : String(e))
    }
  }, [])

  /**
   * 用户确认后执行卸载
   */
  const confirmUninstall = useCallback(async () => {
    const target = uninstallTarget
    setUninstallTarget(null)
    if (!target) return
    setUninstallingId(target.toolId)
    setInstallMsg(`正在卸载 ${target.label}…`)
    try {
      const result = await window.electronAPI.app.uninstallCodingDevTool(target.toolId)
      setInstallMsg(result.message)
      await detectOne(target.toolId)
    } catch (e: unknown) {
      setInstallMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setUninstallingId(null)
    }
  }, [uninstallTarget, detectOne])

  /**
   * 触发 CLI 登录（如 cursor agent login 打开浏览器 OAuth）
   */
  const handleLogin = useCallback(async (toolId: string) => {
    setLoggingInId(toolId)
    setInstallMsg('正在打开登录窗口，请在浏览器中完成授权…')
    try {
      const result = await window.electronAPI.app.loginCodingDevTool(toolId)
      setInstallMsg(result.message)
      if (result.success) {
        await detectOne(toolId)
      }
    } catch (e: unknown) {
      setInstallMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoggingInId(null)
    }
  }, [detectOne])

  /**
   * 交给 AI 安装：新开会话并预填提示词，让 Agent 查最新文档后动手
   */
  const handleAiInstall = useCallback((t: LocalAcpToolStatusView) => {
    window.dispatchEvent(
      new CustomEvent('mtbot:chat-draft-request', {
        detail: { text: buildAiInstallPrompt(t), newSession: true },
      }),
    )
    closeHub()
    window.dispatchEvent(new CustomEvent('mtbot:navigate-request', { detail: { view: 'chat' } }))
  }, [closeHub])

  return (
    <Card>
      <div className={styles.panel}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>开发类 AI 工具（本机 ACP）</div>
            <p className={styles.desc}>
              仅连接本机已安装的 CLI（Cursor 需单独安装 Agent CLI，不是编辑器自带的 cursor）。
              对话中用 /{'{'}工具名{'}'} 切换到对应后端（如 /claude、/codex、/cursor），/lumii 回到主代理。
            </p>
          </div>
          <Button variant="secondary" size="sm" loading={detecting} onClick={() => { void reloadTools() }}>
            重新检测
          </Button>
        </div>

        {loadErr && <div className={styles.error}>加载失败：{loadErr}</div>}
        {installMsg && <div className={styles.installMsg}>{installMsg}</div>}

        <div className={styles.sectionLabel}>本机工具</div>
        <div className={styles.toolGrid}>
          {tools.map((t) => (
            <div key={t.id} className={styles.toolCard}>
              <div className={styles.toolCardHeader}>
                <ToolIcon id={t.id} label={t.label} />
                <span className={styles.toolName}>{t.label}</span>
                {t.detectState === 'done' ? (
                  <span
                    className={t.installed ? styles.statusDotOk : styles.statusDotOff}
                    title={t.installed ? '已安装' : '未安装'}
                    aria-label={t.installed ? '已安装' : '未安装'}
                  />
                ) : (
                  <span className={styles.detectingTag} aria-live="polite">检测中…</span>
                )}
              </div>

              <div className={styles.toolCardBody}>
                {t.installed ? (
                  <>
                    <div className={styles.versionRow}>
                      <span className={styles.versionLabel}>当前版本</span>
                      <span>{t.currentVersion ?? '未知'}</span>
                    </div>
                    {t.latestVersion && (
                      <div className={styles.versionRow}>
                        <span className={styles.versionLabel}>最新版本</span>
                        <span>{t.latestVersion}</span>
                      </div>
                    )}
                    {t.authStatus && (
                      <div className={styles.versionRow}>
                        <span className={styles.versionLabel}>认证状态</span>
                        <span className={t.authStatus === 'ok' ? styles.badgeOk : styles.badgeOff}>
                          {t.authStatus === 'ok' ? '已登录' : '需登录'}
                        </span>
                      </div>
                    )}
                    {t.resolvedPath && (
                      <code className={styles.path} title={t.resolvedPath}>{t.resolvedPath}</code>
                    )}
                  </>
                ) : (
                  <div className={styles.installBlock}>
                    <code className={styles.installCmd}>{t.installCommand}</code>
                    {t.installHint && <div className={styles.toolDesc}>{t.installHint}</div>}
                  </div>
                )}
              </div>

              <div className={styles.toolCardFooter}>
                {!t.installed ? (
                  <>
                    <button type="button" className={styles.linkBtn} onClick={() => openUrl(t.homepageUrl)}>
                      官网
                    </button>
                    <button
                      type="button"
                      className={styles.linkBtn}
                      onClick={() => handleAiInstall(t)}
                      title="新开会话，让 AI 查最新文档后安装并配置"
                    >
                      让 AI 安装
                    </button>
                    <Button
                      size="sm"
                      loading={installingId === t.id}
                      disabled={
                        t.detectState !== 'done' || (installingId != null && installingId !== t.id)
                      }
                      onClick={() => void handleInstall(t.id)}
                    >
                      一键安装
                    </Button>
                  </>
                ) : (
                  <>
                    {t.latestVersion && t.latestVersion !== t.currentVersion ? (
                      <Button
                        size="sm"
                        loading={installingId === t.id}
                        disabled={
                          (installingId != null && installingId !== t.id) || uninstallingId === t.id || loggingInId === t.id
                        }
                        onClick={() => void handleInstall(t.id)}
                      >
                        升级到 {t.latestVersion}
                      </Button>
                    ) : t.selfUpdateCommand ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={installingId === t.id}
                        disabled={
                          (installingId != null && installingId !== t.id) || uninstallingId === t.id || loggingInId === t.id
                        }
                        onClick={() => void handleInstall(t.id)}
                        title={`执行 ${t.selfUpdateCommand}`}
                      >
                        检查更新
                      </Button>
                    ) : null}
                    {t.authStatus === 'required' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={loggingInId === t.id}
                        disabled={installingId != null || uninstallingId != null || (loggingInId != null && loggingInId !== t.id)}
                        onClick={() => void handleLogin(t.id)}
                        title="打开浏览器完成 OAuth 授权"
                      >
                        {loggingInId === t.id ? '登录中…' : '登录'}
                      </Button>
                    )}
                    <button
                      type="button"
                      className={styles.linkBtn}
                      disabled={installingId != null || uninstallingId != null || loggingInId != null}
                      onClick={() => void beginUninstall(t.id)}
                    >
                      {uninstallingId === t.id ? '卸载中…' : '卸载'}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          {tools.length === 0 && (
            <div className={styles.empty}>
              {detecting ? '正在加载工具列表…' : '点击「重新检测」扫描本机 CLI'}
            </div>
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

        <ConfirmModal
          open={uninstallTarget != null}
          layer="elevated"
          title={`卸载 ${uninstallTarget?.label ?? ''}`}
          content={buildUninstallConfirmText(uninstallTarget)}
          confirmText={uninstallTarget?.automatic ? '确认卸载' : '我知道了'}
          confirmVariant="danger"
          onConfirm={() => {
            if (uninstallTarget?.automatic) void confirmUninstall()
            else setUninstallTarget(null)
          }}
          onCancel={() => setUninstallTarget(null)}
        />
      </div>
    </Card>
  )
}

export default CodingDevAcpPanel
