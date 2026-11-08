/**
 * Breeze TTS 的配置块。
 *
 * 这里只有「填路径」这一步 —— 依赖安装与模型下载都在 Breeze 仓库里做，
 * 本插件不代劳（用户拍板：接本地已有部署）。
 */
import { Input } from '../../../../../renderer/components/ui/Input/Input'
import styles from '../../../../../renderer/pages/SettingsPage/SettingsPage.module.css'

export interface BreezeSettingsValue {
  breezeRepoPath?: string
  breezeModelDir?: string
  breezePort?: number
  breezeBaseUrl?: string
  breezePython?: string
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
      <div className={styles['setting-item']}>
        <label className={styles['setting-label']} data-app-ui-label>仓库路径</label>
        <Input
          value={value.breezeRepoPath ?? ''}
          placeholder="例如 E:\\ai\\breeze-tts"
          onChange={(e) => onChange({ breezeRepoPath: e.target.value })}
        />
      </div>
      <div className={styles['setting-item']}>
        <label className={styles['setting-label']} data-app-ui-label>模型目录</label>
        <Input
          value={value.breezeModelDir ?? ''}
          placeholder="留空则用仓库同级的 breeze-tts-2"
          onChange={(e) => onChange({ breezeModelDir: e.target.value })}
        />
      </div>
      <div className={styles['setting-item']}>
        <label className={styles['setting-label']} data-app-ui-label>服务地址（可选）</label>
        <Input
          value={value.breezeBaseUrl ?? ''}
          placeholder="留空则自动拉起；已自行启动可填 http://127.0.0.1:7860"
          onChange={(e) => onChange({ breezeBaseUrl: e.target.value })}
        />
        <span className={styles['setting-hint']}>
          填了地址就只连接、不自动拉起进程。
        </span>
      </div>
      <div className={styles['setting-item']}>
        <label className={styles['setting-label']} data-app-ui-label>端口</label>
        <Input
          value={String(value.breezePort ?? 7860)}
          onChange={(e) => onChange({ breezePort: Number(e.target.value) || 7860 })}
        />
      </div>
      <div className={styles['setting-item']}>
        <label className={styles['setting-label']} data-app-ui-label>Python 解释器（可选）</label>
        <Input
          value={value.breezePython ?? ''}
          placeholder="留空则用 <仓库>/.venv 里的 python"
          onChange={(e) => onChange({ breezePython: e.target.value })}
        />
      </div>
      <div className={styles['setting-item']}>
        <label className={styles['setting-label']} data-app-ui-label>指令强度</label>
        <Input
          value={String(value.breezeCfgScale ?? 1)}
          onChange={(e) => onChange({ breezeCfgScale: Number(e.target.value) || 1 })}
        />
        <span className={styles['setting-hint']}>4 能明显增强指令跟随，代价是更慢。</span>
      </div>
      <div className={styles['setting-item']}>
        <label className={styles['setting-label']} data-app-ui-label>风格指令（可选）</label>
        <Input
          value={value.breezeInstruction ?? ''}
          placeholder="例如：一位温柔自信的年轻女性，语气亲切"
          onChange={(e) => onChange({ breezeInstruction: e.target.value })}
        />
      </div>
    </>
  )
}
