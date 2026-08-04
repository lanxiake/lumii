/**
 * A2UI VideoPlayer 组件 — HTML5 视频播放器
 */

import React from 'react'
import styles from './A2UIRenderer.module.css'
import type { A2UIVideoPlayer } from './types'

export const VideoPlayerComponent: React.FC<A2UIVideoPlayer> = ({ src, poster, title }) => (
  <div className={styles['video-player']}>
    {title && <div className={styles['video-title']}>{title}</div>}
    <video
      className={styles['video-element']}
      src={src}
      poster={poster}
      controls
      preload="metadata"
    />
  </div>
)
