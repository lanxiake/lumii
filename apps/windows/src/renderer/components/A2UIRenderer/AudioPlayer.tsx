/**
 * A2UI AudioPlayer 组件 — HTML5 音频播放器
 */

import React, { useRef, useState, useEffect, useCallback } from 'react'
import styles from './A2UIRenderer.module.css'
import type { A2UIAudioPlayer } from './types'

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export const AudioPlayerComponent: React.FC<A2UIAudioPlayer> = ({ src, title, waveform: _waveform }) => {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isDragging, setIsDragging] = useState(false)

  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current && !isDragging) {
      setCurrentTime(audioRef.current.currentTime)
    }
  }, [isDragging])

  const handleLoadedMetadata = useCallback(() => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration)
    }
  }, [])

  const handleEnded = useCallback(() => {
    setIsPlaying(false)
    setCurrentTime(0)
  }, [])

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    el.addEventListener('timeupdate', handleTimeUpdate)
    el.addEventListener('loadedmetadata', handleLoadedMetadata)
    el.addEventListener('ended', handleEnded)
    return () => {
      el.removeEventListener('timeupdate', handleTimeUpdate)
      el.removeEventListener('loadedmetadata', handleLoadedMetadata)
      el.removeEventListener('ended', handleEnded)
    }
  }, [handleTimeUpdate, handleLoadedMetadata, handleEnded])

  const togglePlay = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    if (isPlaying) {
      el.pause()
      setIsPlaying(false)
    } else {
      el.play().catch(() => {})
      setIsPlaying(true)
    }
  }, [isPlaying])

  const handleProgressChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value)
    setCurrentTime(value)
    if (audioRef.current) {
      audioRef.current.currentTime = value
    }
  }, [])

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div className={styles['audio-player']}>
      <audio ref={audioRef} src={src} preload="metadata" />
      {title && <div className={styles['audio-title']}>{title}</div>}
      <div className={styles['audio-controls']}>
        <button
          className={styles['audio-play-btn']}
          onClick={togglePlay}
          aria-label={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <polygon points="5,3 19,12 5,21" />
            </svg>
          )}
        </button>
        <div className={styles['audio-progress-wrap']}>
          <input
            type="range"
            className={styles['audio-progress']}
            min={0}
            max={duration || 100}
            step={0.1}
            value={currentTime}
            onChange={handleProgressChange}
            onMouseDown={() => setIsDragging(true)}
            onMouseUp={() => setIsDragging(false)}
            style={{ '--progress': `${progress}%` } as React.CSSProperties}
          />
        </div>
        <span className={styles['audio-time']}>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  )
}
