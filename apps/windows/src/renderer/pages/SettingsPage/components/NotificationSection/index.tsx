import React from 'react'
import { Badge } from '../../../../components/ui/Badge/Badge'
import { Button } from '../../../../components/ui/Button/Button'
import { Checkbox } from '../../../../components/ui/Checkbox/Checkbox'
import type { AppSettings, NotificationConfig, UseCategorySettingsReturn } from '../../../../hooks/business/useSettings'
import styles from '../../SettingsPage.module.css'

interface NotificationSectionProps {
  settings: AppSettings
  updateNotification: (config: Partial<NotificationConfig>) => void
  save: UseCategorySettingsReturn
}

export function NotificationSection({
  settings,
  updateNotification,
  save,
}: NotificationSectionProps) {
  return (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>
        通知设置
        {save.hasChanges && <Badge dot />}
      </h3>

      <div className={styles['setting-group']}>
        <div className={styles['setting-item']}>
          <Checkbox
            checked={settings.notification.enabled}
            onChange={(checked) => updateNotification({ enabled: checked })}
          >
            启用通知
          </Checkbox>
        </div>

        <div className={styles['setting-item']}>
          <Checkbox
            checked={settings.notification.soundEnabled}
            onChange={(checked) => updateNotification({ soundEnabled: checked })}
            disabled={!settings.notification.enabled}
          >
            启用通知声音
          </Checkbox>
        </div>

        <div className={styles['setting-item']}>
          <Checkbox
            checked={settings.notification.showPreview}
            onChange={(checked) => updateNotification({ showPreview: checked })}
            disabled={!settings.notification.enabled}
          >
            显示消息预览
          </Checkbox>
        </div>

        <div className={styles['setting-item']}>
          <Checkbox
            checked={settings.notification.desktopNotification}
            onChange={(checked) => updateNotification({ desktopNotification: checked })}
            disabled={!settings.notification.enabled}
          >
            桌面通知
          </Checkbox>
        </div>
      </div>

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
                : '保存通知设置'}
          </Button>
        </div>
      )}
    </div>
  )
}
