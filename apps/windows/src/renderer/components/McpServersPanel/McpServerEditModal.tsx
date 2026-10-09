/**
 * MCP Server 新增/编辑弹窗
 *
 * 两种录入方式：
 *   表单 —— 逐字段填，适合改一两个参数
 *   JSON —— 粘贴官方文档里的配置块，支持一次导入多个
 */

import React, { useEffect, useMemo, useState } from 'react'
import { ExternalLink, KeyRound } from 'lucide-react'
import { Button, Input, Modal } from '../ui'
import { openExternalUrl } from '../../utils/markdown-external-link'
import type { McpServerConfigInput } from '@shared/agent-runtime-commands'
import { findMcpPreset } from '@shared/mcp-presets'
import { parseMcpJson } from './parse-mcp-json'
import styles from './McpServersPanel.module.css'

interface McpServerEditModalProps {
  readonly open: boolean
  /** 传入表示编辑，不传表示新增 */
  readonly editing?: McpServerConfigInput
  readonly onClose: () => void
  readonly onSubmit: (entries: readonly McpServerConfigInput[], originalName?: string) => Promise<{ success: boolean; error?: string }>
}

const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/你的用户名/Documents"]
    }
  }
}`

/** env 对象 ⇄ `KEY=VALUE` 多行文本 */
function envToText(env?: Record<string, string>): string {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')
}

function textToEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return Object.keys(env).length ? env : undefined
}

/** 表单能编的字段（其余靠 `editing` 原样带过去，见 `buildFormEntry`） */
export interface McpFormFields {
  readonly editing?: McpServerConfigInput
  readonly name: string
  readonly command: string
  readonly argsText: string
  readonly envText: string
  readonly cwd: string
  /** 毫秒的文本形态；空 = 不写进配置，让内置预设决定（30s 或预设自带的值） */
  readonly timeoutMsText: string
}

/**
 * 表单字段 → 一条配置。
 *
 * ⚠️ `...editing` 那行不是顺手写的：`mcp:upsert` 是**整条替换**（`McpManager.upsert` →
 * `configs.set`），表单编不了的字段（`timeoutMs` / `backgroundTools` / `bundledExe`）不带上
 * 就会被静默抹掉——2026-10-09 实测过：打开编辑再保存一下，`timeoutMs: 300000` 就没了，
 * 而界面上根本看不出少了什么。
 *
 * 表单占的字段显式写 `undefined` 而不是省略：省略的话 `...editing` 里的旧值还在，
 * 用户清空「参数」「工作目录」会清不掉。
 */
export function buildFormEntry(f: McpFormFields): McpServerConfigInput {
  const ms = Number(f.timeoutMsText.trim())
  return {
    ...f.editing,
    name: f.name.trim(),
    command: f.command.trim(),
    args: f.argsText.trim() ? f.argsText.split('\n').map((a) => a.trim()).filter(Boolean) : undefined,
    env: textToEnv(f.envText),
    cwd: f.cwd.trim() || undefined,
    timeoutMs: Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : undefined,
  }
}

export const McpServerEditModal: React.FC<McpServerEditModalProps> = ({ open, editing, onClose, onSubmit }) => {
  // 新增默认进 JSON（最常见是粘贴官方配置），编辑进表单
  const [mode, setMode] = useState<'form' | 'json'>('json')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [cwd, setCwd] = useState('')
  const [timeoutMsText, setTimeoutMsText] = useState('')
  const [jsonText, setJsonText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 每次打开都从 editing 重置，避免残留上一次的输入
  useEffect(() => {
    if (!open) return
    setMode(editing ? 'form' : 'json')
    setError(null)
    setName(editing?.name ?? '')
    setCommand(editing?.command ?? '')
    setArgsText((editing?.args ?? []).join('\n'))
    setEnvText(envToText(editing?.env))
    setCwd(editing?.cwd ?? '')
    setTimeoutMsText(editing?.timeoutMs ? String(editing.timeoutMs) : '')
    setJsonText('')
  }, [open, editing])

  /** JSON 模式下实时预览将导入哪些 Server */
  const jsonPreview = useMemo(() => (mode === 'json' && jsonText.trim() ? parseMcpJson(jsonText) : null), [mode, jsonText])

  /** 内置项的说明与申请密钥地址：按表单里的名字实时查，改名后也跟着走 */
  const preset = useMemo(() => findMcpPreset(name.trim()), [name])

  const handleSubmit = async () => {
    setError(null)

    let entries: readonly McpServerConfigInput[]
    if (mode === 'json') {
      const parsed = parseMcpJson(jsonText)
      if (!parsed.ok) {
        setError(parsed.error)
        return
      }
      entries = parsed.entries
    } else {
      if (!name.trim()) return setError('请填写名称')
      if (!command.trim()) return setError('请填写启动命令')
      const ms = Number(timeoutMsText.trim())
      if (timeoutMsText.trim() && !(Number.isFinite(ms) && ms > 0)) {
        return setError('超时（毫秒）要填正整数，留空表示用内置默认')
      }
      entries = [buildFormEntry({ editing, name, command, argsText, envText, cwd, timeoutMsText })]
    }

    setSubmitting(true)
    const result = await onSubmit(entries, editing?.name)
    setSubmitting(false)
    if (result.success) onClose()
    else setError(result.error ?? '保存失败')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `编辑 ${editing.name}` : '添加 MCP Server'}
      width={560}
      layer="elevated"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>取消</Button>
          <Button onClick={() => void handleSubmit()} loading={submitting}>
            {mode === 'json' && jsonPreview?.ok && jsonPreview.entries.length > 1
              ? `导入 ${jsonPreview.entries.length} 个`
              : '保存'}
          </Button>
        </>
      }
    >
      <div className={styles['edit-body']}>
        <div className={styles['mode-tabs']} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'form'}
            className={mode === 'form' ? styles['mode-tab-active'] : styles['mode-tab']}
            onClick={() => { setMode('form'); setError(null) }}
          >
            表单填写
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'json'}
            className={mode === 'json' ? styles['mode-tab-active'] : styles['mode-tab']}
            onClick={() => { setMode('json'); setError(null) }}
          >
            粘贴 JSON
          </button>
        </div>

        {mode === 'form' ? (
          <>
            <label className={styles['field']}>
              <span className={styles['field-label']}>名称</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" />
              <span className={styles['field-hint']}>工具名前缀，只能用字母、数字、下划线和短横线</span>
              {preset && (
                <span className={styles['field-hint']}>
                  {preset.title}：{preset.description}
                </span>
              )}
            </label>

            <label className={styles['field']}>
              <span className={styles['field-label']}>启动命令</span>
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            </label>

            <label className={styles['field']}>
              <span className={styles['field-label']}>参数</span>
              <textarea
                className={styles['textarea']}
                rows={3}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:/Users/你的用户名/Documents'}
              />
              <span className={styles['field-hint']}>每行一个参数</span>
            </label>

            <label className={styles['field']}>
              <span className={styles['field-label']}>环境变量</span>
              <textarea
                className={styles['textarea']}
                rows={2}
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder={'GITHUB_TOKEN=${GITHUB_TOKEN}'}
              />
              <span className={styles['field-hint']}>
                每行 KEY=VALUE。写成 {'${VAR}'} 会在启动时从系统环境变量读取，密钥不落盘
              </span>
              {preset?.todo && <span className={styles['field-hint']}>{preset.todo}</span>}
              {preset?.keyUrl && (
                <button
                  type="button"
                  className={styles['field-key-link']}
                  onClick={() => openExternalUrl(preset.keyUrl!)}
                >
                  <KeyRound size={12} />
                  前往 {new URL(preset.keyUrl).host} 获取密钥
                  <ExternalLink size={11} />
                </button>
              )}
            </label>

            <label className={styles['field']}>
              <span className={styles['field-label']}>工作目录</span>
              <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="可选" />
            </label>

            <label className={styles['field']}>
              <span className={styles['field-label']}>单次请求超时（毫秒）</span>
              <Input
                value={timeoutMsText}
                onChange={(e) => setTimeoutMsText(e.target.value)}
                placeholder={String(preset?.timeoutMs ?? 30000)}
                inputMode="numeric"
              />
              <span className={styles['field-hint']}>
                留空表示用内置默认（{Math.round((preset?.timeoutMs ?? 30000) / 1000)} 秒）。长耗时服务要调大，
                否则单次调用会被截断成「失败」——本机微信的发送要走一整串 GUI 安全网，实测有 36 秒的。
              </span>
            </label>
          </>
        ) : (
          <label className={styles['field']}>
            <span className={styles['field-label']}>配置 JSON</span>
            <textarea
              className={styles['textarea-json']}
              rows={12}
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              placeholder={JSON_PLACEHOLDER}
              spellCheck={false}
            />
            <span className={styles['field-hint']}>
              直接粘贴 MCP 文档里的配置块，可一次导入多个。同名会覆盖
            </span>
            {jsonPreview?.ok && (
              <span className={styles['preview-ok']}>
                将导入：{jsonPreview.entries.map((e) => e.name).join('、')}
              </span>
            )}
            {jsonPreview && !jsonPreview.ok && (
              <span className={styles['preview-err']}>{jsonPreview.error}</span>
            )}
          </label>
        )}

        {error && <div className={styles['edit-error']}>{error}</div>}
      </div>
    </Modal>
  )
}
