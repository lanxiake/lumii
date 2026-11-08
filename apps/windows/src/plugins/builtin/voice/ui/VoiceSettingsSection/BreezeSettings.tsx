/**
 * Breeze TTS 的配置块。
 *
 * 代码和依赖都是内置的，用户唯一要做的是下载模型——所以这里没有路径要填，
 * 只有影响听感的两个参数。模型下载入口在语音设置上方的「下载」面板里。
 */
import { Input } from '../../../../../renderer/components/ui/Input/Input'
import styles from '../../../../../renderer/pages/SettingsPage/SettingsPage.module.css'

export interface BreezeSettingsValue {
  breezeCfgScale?: number
  breezeInstruction?: string
}

export function BreezeSettings({
  value,
  onChange,
}: {
  value: BreezeSettingsValue
  onChange: (next: Partial<BreezeSettingsValue>) => void
}) {
  return (
    <>
      <p className={styles['voice-block-desc']}>
        Breeze 的推理代码与运行环境随应用内置，只需在上方「下载」面板获取模型（约
        7.7GB，支持断点续传）即可使用。首次合成要加载模型，可能需要几分钟。
      </p>

      <div className={styles['setting-item']}>
        <label className={styles['setting-label']} data-app-ui-label>风格指令</label>
        <Input
          value={value.breezeInstruction ?? ''}
          placeholder="例如：一位温柔自信的年轻女性，声音清晰，语气亲切"
          onChange={(e) => onChange({ breezeInstruction: e.target.value })}
        />
        <span className={styles['setting-hint']}>
          用一句话描述想要的音色与语气。留空则使用模型默认音色。
        </span>
      </div>

      <div className={styles['setting-item']}>
        <label className={styles['setting-label']} data-app-ui-label>指令强度</label>
        <Input
          value={String(value.breezeCfgScale ?? 1)}
          onChange={(e) => onChange({ breezeCfgScale: Number(e.target.value) || 1 })}
        />
        <span className={styles['setting-hint']}>
          4 能明显增强对上面指令的遵循；调高会更慢，默认 1 即可。
        </span>
      </div>
    </>
  )
}
