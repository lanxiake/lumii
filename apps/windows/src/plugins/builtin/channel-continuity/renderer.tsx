import { ChevronLeft } from '../../../renderer/components/ui/Icon'
import { Switch } from '../../../renderer/components/ui/Switch/Switch'
import styles from '../../../renderer/pages/SettingsPage/components/ExperimentalSection/ExperimentalSection.module.css'
import settingsStyles from '../../../renderer/pages/SettingsPage/SettingsPage.module.css'
import { useChannelFeatures } from './useChannelFeatures'

/**
 * 跨渠道会话接续的渲染层半边：实验功能列表里的摘要 + 开关详情。
 *
 * 开关值在主进程（`channel-features.json`，由本插件持有），四个渠道 adapter
 * 每条消息现读，所以切换后**下一轮渠道消息即生效**，无需重启。
 */

export function ChannelContinuitySummary() {
  const { features, loading } = useChannelFeatures()
  return (
    <span>
      {loading ? '加载中…' : features.crossChannelContinuityEnabled ? '状态：已启用' : '状态：已关闭'}
    </span>
  )
}

export function ChannelContinuityDetail({ onBack }: { onBack: () => void }) {
  const { features, saving, setFeature } = useChannelFeatures()

  return (
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={onBack}
          aria-label="返回实验功能列表"
        >
          <ChevronLeft size={18} aria-hidden />
          <span>返回</span>
        </button>
        <h3 className={styles.detailTitle}>跨渠道会话接续</h3>
      </div>
      <div className={`${settingsStyles['settings-section']} ${styles.detailBody}`}>
        <div className={settingsStyles['setting-row']}>
          <span className={settingsStyles['setting-label']}>启用接续询问</span>
          <Switch
            id="channel-cross-continuity"
            checked={features.crossChannelContinuityEnabled}
            disabled={saving}
            onChange={(v) => void setFeature('crossChannelContinuityEnabled', v)}
          />
        </div>
        <p className={settingsStyles['setting-hint']}>
          在渠道（微信 / QQ / 飞书 / 企微）里发消息时，若你近期在客户端或其它渠道有进行中的对话，
          会提示你是否继续那条对话：回复「接续」继续（本条消息仍在当前会话回答），回复「不接续」忽略；
          不回则什么都不变。同一会话只提示一次，正等审批答复时不会提示。
          关闭后渠道消息一律留在本渠道自己的会话里。切换后下一轮渠道消息即生效，无需重启。
        </p>
      </div>
    </div>
  )
}

export const channelContinuityExperiment = {
  id: 'com.lumii.channel-continuity',
  title: '跨渠道会话接续',
  Summary: ChannelContinuitySummary,
  Detail: ChannelContinuityDetail,
}
