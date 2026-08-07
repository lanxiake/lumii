/**
 * Qwen3 克隆音色档案管理面板
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import type { VoiceCloneProfile } from '../../../../../shared/voice-events'
import styles from '../VoiceModelsPanel/VoiceModelsPanel.module.css'

type SaveConfig = (partial: {
  tts?: {
    qwen3ProfileId?: string
    qwen3CloneEnabled?: boolean
    language?: string
  }
}) => Promise<void>

interface Props {
  selectedProfileId?: string
  onSelectProfile: (id: string | undefined) => void
  saveVoiceConfig: SaveConfig
  disabled?: boolean
}

/**
 * 列出 / 新建 / 删除克隆音色，并同步当前选中档案到语音配置
 */
export function VoiceProfilesPanel({
  selectedProfileId,
  onSelectProfile,
  saveVoiceConfig,
  disabled,
}: Props): React.ReactElement {
  const [profiles, setProfiles] = useState<VoiceCloneProfile[]>([])
  const [name, setName] = useState('我的音色')
  const [refText, setRefText] = useState('')
  const [refPath, setRefPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    const list = await api.voice.sendCommand({ type: 'voice:profiles:list' })
    if (Array.isArray(list)) setProfiles(list as VoiceCloneProfile[])
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /**
   * 通过系统对话框选择参考音频
   */
  const pickAudio = async () => {
    const api = (window as any).electronAPI
    if (!api?.dialog?.showOpenDialog) {
      setError('当前环境不支持文件选择')
      return
    }
    try {
      const result = await api.dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }],
      })
      const filePath = result?.filePaths?.[0]
      if (filePath) setRefPath(filePath)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /**
   * 保存新档案
   */
  const handleCreate = async () => {
    setError(null)
    if (!refPath) {
      setError('请先选择参考音频（建议 ≥3 秒）')
      return
    }
    if (!refText.trim()) {
      setError('请填写参考音频对应的转写文本')
      return
    }
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    setBusy(true)
    try {
      const res = await api.voice.sendCommand({
        type: 'voice:profiles:upsert',
        profile: {
          name: name.trim() || '我的音色',
          refAudioPath: refPath,
          refText: refText.trim(),
          language: 'Auto',
          qwen3Variant: '0.6b-base',
        },
      })
      if (res?.error) {
        setError(String(res.error))
        return
      }
      const profile = res?.profile as VoiceCloneProfile | undefined
      await refresh()
      if (profile?.id) {
        onSelectProfile(profile.id)
        await saveVoiceConfig({ tts: { qwen3ProfileId: profile.id } })
      }
      setRefText('')
      setRefPath('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * 删除档案
   */
  const handleDelete = async (id: string) => {
    const api = (window as any).electronAPI
    if (!api?.voice?.sendCommand) return
    setBusy(true)
    try {
      await api.voice.sendCommand({ type: 'voice:profiles:delete', profileId: id })
      if (selectedProfileId === id) {
        onSelectProfile(undefined)
        await saveVoiceConfig({ tts: { qwen3ProfileId: undefined, qwen3CloneEnabled: false } })
      }
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.panel} style={{ marginTop: 12 }}>
      <h4 className={styles.title}>我的音色（声音克隆 · 可选）</h4>
      <p className={styles.hint}>
        默认不开启克隆。先创建并选择音色，再到上方勾选「启用声音克隆出声」后才会用克隆声。
        上传 ≥3 秒清晰人声参考音，并填写对应转写文本。
      </p>

      {profiles.length === 0 ? (
        <p className={styles.hint}>暂无音色档案</p>
      ) : (
        <ul className={styles.list}>
          {profiles.map((p) => (
            <li key={p.id} className={styles.card}>
              <div className={styles.cardHead}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
                  <input
                    type="radio"
                    name="qwen3-profile"
                    checked={selectedProfileId === p.id}
                    disabled={disabled || busy}
                    onChange={() => {
                      onSelectProfile(p.id)
                      void saveVoiceConfig({ tts: { qwen3ProfileId: p.id } })
                    }}
                  />
                  <span className={styles.name}>
                    {p.name}
                    <span className={styles.meta}> · {p.qwen3Variant}</span>
                  </span>
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || disabled}
                  onClick={() => void handleDelete(p.id)}
                >
                  删除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <Input
          placeholder="音色名称"
          value={name}
          disabled={busy || disabled}
          onChange={(e) => setName(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button variant="secondary" size="sm" disabled={busy || disabled} onClick={() => void pickAudio()}>
            选择参考音频
          </Button>
          <span className={styles.meta} style={{ fontSize: 12 }}>
            {refPath ? refPath.split(/[/\\]/).pop() : '未选择'}
          </span>
        </div>
        <Input
          placeholder="参考音频转写文本（必填）"
          value={refText}
          disabled={busy || disabled}
          onChange={(e) => setRefText(e.target.value)}
        />
        <Button variant="primary" size="sm" disabled={busy || disabled} onClick={() => void handleCreate()}>
          {busy ? '保存中...' : '保存音色'}
        </Button>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    </div>
  )
}
