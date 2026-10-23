/**
 * 录屏设置分区（设置 › 录屏）。
 *
 * 整块由录屏插件注册到 `settings.category.screenRecord`；开关与默认参数写的是
 * 渲染层的 settings（localStorage），由宿主把当前值与保存句柄通过槽位上下文传进来
 * ——多一份 `useSettings()` 实例会与设置页的草稿态分叉。
 */
import type { ScreenRecordConfig } from '../../../../renderer/hooks/business/useSettings'
import type { UseCategorySettingsReturn } from '../../../../renderer/hooks/business/useSettings'
import { Badge } from '../../../../renderer/components/ui/Badge/Badge'
import { Button } from '../../../../renderer/components/ui/Button/Button'
import { Checkbox } from '../../../../renderer/components/ui/Checkbox/Checkbox'
import { Input } from '../../../../renderer/components/ui/Input/Input'
import styles from '../../../../renderer/pages/SettingsPage/SettingsPage.module.css'

export interface ScreenRecordSettingsProps {
  /** 合并缺省值后的当前配置 */
  screenRecord: ScreenRecordConfig
  /** 改一个字段（尚未保存） */
  update: (partial: Partial<ScreenRecordConfig>) => void
  /** 保存句柄（草稿态 / 保存中 / 结果） */
  save: UseCategorySettingsReturn
}

export function ScreenRecordSettings({ screenRecord, update, save }: ScreenRecordSettingsProps) {
  return (
    <div className={styles['settings-panel']}>
      <header className={styles['panel-header']}>
        <h3 data-app-ui-section-title className={styles['panel-title']}>
          录屏
          {save.hasChanges && <Badge dot />}
        </h3>
        <p className={styles['panel-desc']}>
          管理 AI 录屏 / 截屏工具与本机录制的默认参数。
        </p>
      </header>

      <section className={styles['panel-card']}>
        <h4 className={styles['panel-card-title']} data-app-ui-heading>录制选项</h4>
        <div className={styles['panel-rows']}>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>启用录屏功能</span>
              <span className={styles['panel-row-hint']}>
                关闭后 AI 录屏/截屏工具与顶栏入口均不可用
              </span>
            </div>
            <Checkbox
              checked={screenRecord.enabled}
              onChange={(checked) => update({ enabled: checked })}
            />
          </div>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>始终允许录屏 / 截屏</span>
              <span className={`${styles['panel-row-hint']} ${styles['panel-row-hint-warn']}`}>
                开启后 Agent 可不经确认录制或截取除本软件外的任意屏幕与窗口，请谨慎
              </span>
            </div>
            <Checkbox
              checked={screenRecord.alwaysAllow}
              onChange={(checked) => update({ alwaysAllow: checked })}
            />
          </div>
          <div className={styles['panel-row']}>
            <div className={styles['panel-row-text']}>
              <span className={styles['panel-row-label']}>默认包含麦克风</span>
              <span className={styles['panel-row-hint']}>新录制时「包含麦克风」开关的默认值</span>
            </div>
            <Checkbox
              checked={screenRecord.includeMicDefault}
              onChange={(checked) => update({ includeMicDefault: checked })}
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
              checked={screenRecord.includeSystemAudioDefault}
              onChange={(checked) => update({ includeSystemAudioDefault: checked })}
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
              checked={screenRecord.exportMp4Default}
              onChange={(checked) => update({ exportMp4Default: checked })}
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
                value={screenRecord.narrateOriginalAudioGain}
                onChange={(e) =>
                  update({
                    narrateOriginalAudioGain: Math.min(1, Math.max(0, Number(e.target.value))),
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
                value={screenRecord.confirmTimeoutSec}
                onChange={(e) => update({ confirmTimeoutSec: Number(e.target.value) })}
              />
              <span className={styles['setting-unit']}>秒</span>
            </div>
          </div>
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
