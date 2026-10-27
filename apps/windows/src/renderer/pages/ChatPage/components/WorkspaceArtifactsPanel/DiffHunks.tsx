/**
 * 行级 diff 渲染（提议面板 / 版本对照共用）
 *
 * CRLF 文件的 hunk 行尾会带 `\r`：只影响展示，显示时去掉，不回写文件。
 */

import type { TextDiffHunk } from '../../../../../shared/text-diff'
import styles from './DiffHunks.module.css'

export interface DiffHunksProps {
  hunks: readonly TextDiffHunk[]
}

export const DiffHunks: React.FC<DiffHunksProps> = ({ hunks }) => {
  if (hunks.length === 0) return null
  return (
    <div className={styles.diff}>
      {hunks.map((hunk, index) => (
        <div key={`${hunk.oldStart}-${hunk.newStart}-${index}`} className={styles.hunk}>
          <div className={styles.hunkHead}>
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </div>
          {hunk.lines.map((line, lineIndex) => {
            const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx'
            const display = line.endsWith('\r') ? line.slice(0, -1) : line
            return (
              <div key={lineIndex} className={styles[kind]}>
                {display || ' '}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
