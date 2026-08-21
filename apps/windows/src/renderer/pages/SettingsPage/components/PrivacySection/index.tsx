import React from 'react'
import { FileText } from 'lucide-react'
import { Badge } from '../../../../components/ui/Badge/Badge'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { Checkbox } from '../../../../components/ui/Checkbox/Checkbox'
import { useToast } from '../../../../components/ui/Toast/useToast'
import { StorageInfo } from '../StorageInfo'
import { SecurityLogViewer } from '../SecurityLogViewer/SecurityLogViewer'
import type { AppSettings, PrivacyConfig, UseCategorySettingsReturn } from '../../../../hooks/business/useSettings'
import styles from '../../SettingsPage.module.css'

const DEFAULT_SCREEN_RECORD = {
  enabled: true,
  alwaysAllow: false,
  includeMicDefault: true,
  includeSystemAudioDefault: true,
  exportMp4Default: false,
  narrateOriginalAudioGain: 0.35,
  confirmTimeoutSec: 120,
}

interface PrivacySectionProps {
  settings: AppSettings
  updatePrivacy: (config: Partial<PrivacyConfig>) => void
  updateSettings: (partial: Partial<AppSettings>) => void
  save: UseCategorySettingsReturn
}

export function PrivacySection({
  settings,
  updatePrivacy,
  updateSettings,
  save,
}: PrivacySectionProps) {
  const toast = useToast()

  return (
    <div className={styles['settings-panel']}>
      <header className={styles['panel-header']}>
        <h3 data-app-ui-section-title className={styles['panel-title']}>
          隐私与数据
          {save.hasChanges && <Badge dot />}
        </h3>
        <p className={styles['panel-desc']}>
          对话与记忆默认只保存在本机。可按需调整本地留存与数据导出。
        </p>
      </header>

      <section className={styles['panel-card']}>
        <h4 className={styles['panel-card-title']} data-app-ui-heading>Agent 界面控制</h4>
        <div className={styles['panel-rows']}>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>允许 Agent 操作本软件界面</span>
              <span className={styles['panel-row-hint']}>
                关闭后 Agent 无法截图、导航或点击本客户端界面
              </span>
            </div>
            <Checkbox
              checked={settings.privacy.allowAgentAppUiControl !== false}
              onChange={(checked) => updatePrivacy({ allowAgentAppUiControl: checked })}
            />
          </div>
        </div>
      </section>

      <section className={styles['panel-card']}>
        <h4 className={styles['panel-card-title']} data-app-ui-heading>录屏</h4>
        <div className={styles['panel-rows']}>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>启用录屏功能</span>
              <span className={styles['panel-row-hint']}>
                关闭后 AI 录屏工具与顶栏入口均不可用
              </span>
            </div>
            <Checkbox
              checked={settings.screenRecord?.enabled !== false}
              onChange={(checked) =>
                updateSettings({
                  screenRecord: {
                    ...(settings.screenRecord ?? DEFAULT_SCREEN_RECORD),
                    enabled: checked,
                  },
                })
              }
            />
          </div>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>始终允许录屏</span>
              <span className={`${styles['panel-row-hint']} ${styles['panel-row-hint-warn']}`}>
                开启后 Agent 可不经确认录制除本软件外的任意屏幕与窗口，请谨慎
              </span>
            </div>
            <Checkbox
              checked={settings.screenRecord?.alwaysAllow === true}
              onChange={(checked) =>
                updateSettings({
                  screenRecord: {
                    ...(settings.screenRecord ?? DEFAULT_SCREEN_RECORD),
                    alwaysAllow: checked,
                  },
                })
              }
            />
          </div>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>默认包含麦克风</span>
              <span className={styles['panel-row-hint']}>新录制时「包含麦克风」开关的默认值</span>
            </div>
            <Checkbox
              checked={settings.screenRecord?.includeMicDefault !== false}
              onChange={(checked) =>
                updateSettings({
                  screenRecord: {
                    ...(settings.screenRecord ?? DEFAULT_SCREEN_RECORD),
                    includeMicDefault: checked,
                  },
                })
              }
            />
          </div>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>默认包含系统声音</span>
              <span className={styles['panel-row-hint']}>
                整屏录制时较可靠；单窗口可能无系统声（会自动降级）
              </span>
            </div>
            <Checkbox
              checked={settings.screenRecord?.includeSystemAudioDefault !== false}
              onChange={(checked) =>
                updateSettings({
                  screenRecord: {
                    ...(settings.screenRecord ?? DEFAULT_SCREEN_RECORD),
                    includeSystemAudioDefault: checked,
                  },
                })
              }
            />
          </div>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>停止时默认导出 MP4</span>
              <span className={styles['panel-row-hint']}>
                转码成功后删除源 WebM；失败则保留 WebM
              </span>
            </div>
            <Checkbox
              checked={settings.screenRecord?.exportMp4Default === true}
              onChange={(checked) =>
                updateSettings({
                  screenRecord: {
                    ...(settings.screenRecord ?? DEFAULT_SCREEN_RECORD),
                    exportMp4Default: checked,
                  },
                })
              }
            />
          </div>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>旁白原声增益</span>
              <span className={styles['panel-row-hint']}>配音混流时原片音量（0–1，默认 0.35）</span>
            </div>
            <div className={styles['setting-input-with-unit']}>
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={settings.screenRecord?.narrateOriginalAudioGain ?? 0.35}
                onChange={(e) =>
                  updateSettings({
                    screenRecord: {
                      ...(settings.screenRecord ?? DEFAULT_SCREEN_RECORD),
                      narrateOriginalAudioGain: Math.min(
                        1,
                        Math.max(0, Number(e.target.value)),
                      ),
                    },
                  })
                }
              />
            </div>
          </div>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>AI 确认超时（秒）</span>
              <span className={styles['panel-row-hint']}>超时未操作将自动拒绝</span>
            </div>
            <div className={styles['setting-input-with-unit']}>
              <Input
                type="number"
                min={10}
                max={600}
                step={5}
                value={settings.screenRecord?.confirmTimeoutSec ?? 120}
                onChange={(e) =>
                  updateSettings({
                    screenRecord: {
                      ...(settings.screenRecord ?? DEFAULT_SCREEN_RECORD),
                      confirmTimeoutSec: Number(e.target.value),
                    },
                  })
                }
              />
              <span className={styles['setting-unit']}>秒</span>
            </div>
          </div>
        </div>
      </section>

      <section className={styles['panel-card']}>
        <h4 className={styles['panel-card-title']} data-app-ui-heading>本地留存</h4>
        <div className={styles['panel-rows']}>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>保存聊天历史</span>
              <span className={styles['panel-row-hint']}>关闭后不再把新对话写入本机</span>
            </div>
            <Checkbox
              checked={settings.privacy.saveChatHistory}
              onChange={(checked) => updatePrivacy({ saveChatHistory: checked })}
            />
          </div>

          {settings.privacy.saveChatHistory && (
            <div className={styles['panel-row']}>
              <div className={styles['panel-row-text']}>
                <span className={styles['panel-row-label']}>历史保留天数</span>
                <span className={styles['panel-row-hint']}>超过天数的记录将被清理</span>
              </div>
              <div className={styles['setting-input-with-unit']}>
                <Input
                  type="number"
                  value={settings.privacy.historyRetentionDays}
                  onChange={(e) => updatePrivacy({ historyRetentionDays: Number(e.target.value) })}
                  min={1}
                  max={365}
                />
                <span className={styles['setting-unit']}>天</span>
              </div>
            </div>
          )}

          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>匿名使用统计</span>
              <span className={styles['panel-row-hint']}>仅用于改进产品，不含对话内容</span>
            </div>
            <Checkbox
              checked={settings.privacy.sendUsageStats}
              onChange={(checked) => updatePrivacy({ sendUsageStats: checked })}
            />
          </div>
        </div>
      </section>

      <section className={styles['panel-card']}>
        <h4 className={styles['panel-card-title']} data-app-ui-heading>安全日志</h4>
        <p className={styles['panel-card-desc']}>
          查看本机 AI 工具与权限相关操作摘要（最近 20 条）
        </p>
        <SecurityLogViewer />
      </section>

      <section className={styles['panel-card']}>
        <h4 className={styles['panel-card-title']} data-app-ui-heading>系统日志</h4>
        <p className={styles['panel-card-desc']}>
          打开应用运行日志文件，便于排查连接、对话与启动问题
        </p>
        <div className={styles['panel-actions']}>
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                const res = await window.electronAPI.app.openLogFile()
                if (!res.success) {
                  toast.error(res.error || '打开日志失败')
                }
              } catch (err) {
                toast.error(err instanceof Error ? err.message : '打开日志失败')
              }
            }}
          >
            <FileText size={16} style={{ marginRight: 6 }} />
            打开系统日志
          </Button>
        </div>
      </section>

      <section className={styles['panel-card']}>
        <h4 className={styles['panel-card-title']} data-app-ui-heading>备份与恢复</h4>
        <p className={styles['panel-card-desc']}>查看本地存储占用，管理数据库备份并按需恢复</p>
        <div className={styles['panel-storage']}>
          <StorageInfo toast={toast} />
        </div>
      </section>

      {save.hasChanges && (
        <div className={styles['category-save-actions']}>
          <Button
            onClick={save.save}
            loading={save.isSaving}
            disabled={save.isSaving}
          >
            {save.saveStatus === 'saved'
              ? '✓ 已保存'
              : save.saveStatus === 'error'
                ? '保存失败'
                : '保存更改'}
          </Button>
        </div>
      )}
    </div>
  )
}
