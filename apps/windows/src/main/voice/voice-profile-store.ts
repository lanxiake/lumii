/**
 * Qwen3-TTS 克隆音色档案存储
 * 路径：{clientDataRoot}/voice/profiles/<id>/
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveWindowsClientDataRoot } from '../client-data-root.js'
import type { Qwen3TtsVariant, VoiceCloneProfile } from '../../shared/voice-events.js'

const log = {
  info: (...a: unknown[]) => console.log('[VoiceProfileStore]', ...a),
  warn: (...a: unknown[]) => console.warn('[VoiceProfileStore]', ...a),
  error: (...a: unknown[]) => console.error('[VoiceProfileStore]', ...a),
}

/**
 * 克隆音色档案根目录
 */
export function resolveVoiceProfilesRoot(): string {
  return path.join(resolveWindowsClientDataRoot(), 'voice', 'profiles')
}

/**
 * 管理本地克隆音色档案（meta.json + 参考音频）
 */
export class VoiceProfileStore {
  constructor(private readonly rootOverride?: string) {}

  /**
   * 档案根目录
   */
  get rootDir(): string {
    return this.rootOverride ?? resolveVoiceProfilesRoot()
  }

  /**
   * 列出全部档案（按更新时间倒序）
   */
  list(): VoiceCloneProfile[] {
    const root = this.rootDir
    if (!fs.existsSync(root)) return []
    const out: VoiceCloneProfile[] = []
    for (const name of fs.readdirSync(root)) {
      const metaPath = path.join(root, name, 'meta.json')
      if (!fs.existsSync(metaPath)) continue
      try {
        const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as VoiceCloneProfile
        if (raw?.id) out.push(raw)
      } catch (e) {
        log.warn(`跳过损坏档案 ${name}:`, e)
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * 读取单个档案
   */
  get(profileId: string): VoiceCloneProfile | null {
    const metaPath = path.join(this.rootDir, profileId, 'meta.json')
    if (!fs.existsSync(metaPath)) return null
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as VoiceCloneProfile
    } catch {
      return null
    }
  }

  /**
   * 参考音频绝对路径
   */
  getRefAudioPath(profile: VoiceCloneProfile): string {
    return path.join(this.rootDir, profile.id, profile.refAudioFile)
  }

  /**
   * 创建或更新档案；会把 refAudioPath 拷贝到档案目录
   */
  upsert(input: {
    id?: string
    name: string
    refAudioPath: string
    refText: string
    language?: string
    qwen3Variant?: Qwen3TtsVariant
    xVectorOnly?: boolean
  }): VoiceCloneProfile {
    const id = input.id?.trim() || randomUUID()
    const dir = path.join(this.rootDir, id)
    fs.mkdirSync(dir, { recursive: true })

    if (!fs.existsSync(input.refAudioPath)) {
      throw new Error(`参考音频不存在: ${input.refAudioPath}`)
    }
    const ext = path.extname(input.refAudioPath) || '.wav'
    const refAudioFile = `ref${ext.toLowerCase()}`
    const dest = path.join(dir, refAudioFile)
    fs.copyFileSync(input.refAudioPath, dest)

    const now = Date.now()
    const existing = this.get(id)
    const profile: VoiceCloneProfile = {
      id,
      name: input.name.trim() || '未命名音色',
      refAudioFile,
      refText: input.refText.trim(),
      language: input.language?.trim() || 'Auto',
      qwen3Variant: input.qwen3Variant ?? '0.6b-base',
      xVectorOnly: input.xVectorOnly === true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    if (!profile.xVectorOnly && !profile.refText) {
      throw new Error('ICL 克隆模式需要填写参考音频转写文本（refText）')
    }

    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(profile, null, 2), 'utf8')
    log.info(`已保存档案 ${id} (${profile.name})`)
    return profile
  }

  /**
   * 重命名档案（只改 meta.json 的 name / updatedAt，不重拷参考音频）
   */
  rename(profileId: string, name: string): VoiceCloneProfile | null {
    const existing = this.get(profileId)
    if (!existing) return null
    const nextName = name.trim() || '未命名音色'
    const profile: VoiceCloneProfile = {
      ...existing,
      name: nextName,
      updatedAt: Date.now(),
    }
    fs.writeFileSync(
      path.join(this.rootDir, profileId, 'meta.json'),
      JSON.stringify(profile, null, 2),
      'utf8',
    )
    log.info(`[rename] 已重命名档案 ${profileId} → ${nextName}`)
    return profile
  }

  /**
   * 删除档案目录
   */
  delete(profileId: string): boolean {
    const dir = path.join(this.rootDir, profileId)
    if (!fs.existsSync(dir)) return false
    fs.rmSync(dir, { recursive: true, force: true })
    log.info(`已删除档案 ${profileId}`)
    return true
  }
}
