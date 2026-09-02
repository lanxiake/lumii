import React, { useState, useEffect } from 'react'
import { Eye, EyeOff, Search } from 'lucide-react'
import { Card } from '../../../../components/ui/Card/Card'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { useToast } from '../../../../components/ui/Toast/useToast'
import styles from '../../SettingsPage.module.css'

export function SearchToolsSection() {
  const toast = useToast()
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [langSearchApiKey, setLangSearchApiKey] = useState('')
  const [searxngBaseUrl, setSearxngBaseUrl] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  // 加载配置
  useEffect(() => {
    setLoading(true)
    window.electronAPI.api.getSearchConfig()
      .then((res: any) => {
        if (res.success && res.data) {
          setLangSearchApiKey(res.data.langSearchApiKey || '')
          setSearxngBaseUrl(res.data.searxngBaseUrl || '')
        }
      })
      .catch((err: Error) => {
        console.error('[SearchToolsSection] 加载配置失败', err)
        toast.error('加载搜索配置失败')
      })
      .finally(() => setLoading(false))
  }, [toast])

  // 监听变更
  useEffect(() => {
    setHasChanges(true)
  }, [langSearchApiKey, searxngBaseUrl])

  // 保存配置
  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await window.electronAPI.api.setSearchConfig({
        langSearchApiKey: langSearchApiKey || undefined,
        searxngBaseUrl: searxngBaseUrl || undefined,
      })

      if (res.success) {
        toast.success('搜索配置已保存')
        setHasChanges(false)
      } else {
        throw new Error(res.error || '保存失败')
      }
    } catch (err) {
      console.error('[SearchToolsSection] 保存失败', err)
      toast.error(err instanceof Error ? err.message : '保存搜索配置失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Card className={styles.settingCard}>
        <div className={styles.settingCardHeader}>
          <Search size={20} />
          <h3>搜索工具配置</h3>
        </div>
        <div className={styles.settingCardContent}>
          <p>加载中...</p>
        </div>
      </Card>
    )
  }

  return (
    <Card className={styles.settingCard}>
      <div className={styles.settingCardHeader}>
        <Search size={20} />
        <h3>搜索工具配置</h3>
      </div>

      <div className={styles.settingCardContent}>
        <p className={styles.settingDescription}>
          配置搜索工具 API Keys，提高 web_search 工具的搜索可靠性。
          内置 Bing 搜索无需配置，以下为高级选项。
        </p>

        <div className={styles.formGroup}>
          <label htmlFor="langSearchApiKey">LangSearch API Key</label>
          <div style={{ position: 'relative' }}>
            <Input
              id="langSearchApiKey"
              type={showApiKey ? 'text' : 'password'}
              value={langSearchApiKey}
              onChange={(e) => setLangSearchApiKey(e.target.value)}
              placeholder="sk-xxxxxxxxxxxxxxxx"
              className={styles.input}
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              style={{
                position: 'absolute',
                right: '8px',
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className={styles.fieldHint}>
            可选。用于 web_search 工具的 LangSearch API。
            <a
              href="https://langsearch.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: '4px', color: 'var(--primary)' }}
            >
              申请 API Key
            </a>
          </p>
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="searxngBaseUrl">SearXNG Base URL</label>
          <Input
            id="searxngBaseUrl"
            type="url"
            value={searxngBaseUrl}
            onChange={(e) => setSearxngBaseUrl(e.target.value)}
            placeholder="https://www.mtbot.top/searxng"
            className={styles.input}
          />
          <p className={styles.fieldHint}>
            可选。自托管的 SearXNG 实例地址，作为搜索后备。
          </p>
        </div>

        <div className={styles.formActions}>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            loading={saving}
          >
            {saving ? '保存中...' : '保存配置'}
          </Button>
        </div>
      </div>
    </Card>
  )
}
