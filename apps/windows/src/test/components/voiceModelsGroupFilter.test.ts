/**
 * `filterVoiceModelsByGroups` 的语义边界。
 *
 * 回归（T4 后续）：原实现用 `groups && groups.length > 0` 判「是否指定分组」，
 * 于是 `groups={[]}`（显式要空集，用于整体屏蔽下载面板）被当成「不传」而放行**全部**——
 * 屏蔽场景下正好显示反了。正确判据是 `Array.isArray(groups)`。
 */
import { describe, expect, it } from 'vitest'
import {
  filterVoiceModelsByGroups,
  resolveCardState,
  resolveVoiceModelGroup,
} from '../../plugins/builtin/voice/ui/VoiceModelsPanel/index'
import type { VoiceModelStatus } from '../../shared/voice-events'

function model(id: string, group?: VoiceModelStatus['group']): VoiceModelStatus {
  return { id, name: id, group } as VoiceModelStatus
}

const MODELS: VoiceModelStatus[] = [
  model('vad', 'asr-core'),
  model('tts-melo-zh-en', 'tts-synth'),
  model('tts-qwen3-0.6b-custom', 'tts-synth'),
  model('tts-qwen3-0.6b-base', 'tts-clone'),
]

describe('filterVoiceModelsByGroups', () => {
  it('不传 groups 时展示全部', () => {
    expect(filterVoiceModelsByGroups(MODELS, undefined)).toHaveLength(4)
  })

  it('传空数组时不展示任何模型（屏蔽该面板的用法）', () => {
    // 这条是回归本体：旧实现这里会返回全部 4 条
    expect(filterVoiceModelsByGroups(MODELS, [])).toHaveLength(0)
  })

  it('只展示指定分组', () => {
    const only = filterVoiceModelsByGroups(MODELS, ['tts-clone'])
    expect(only.map((m) => m.id)).toEqual(['tts-qwen3-0.6b-base'])
  })

  it('分组以显式 group 字段为准', () => {
    expect(resolveVoiceModelGroup(model('whatever', 'tts-clone'))).toBe('tts-clone')
  })

  it('缺 group 字段时按 id 推断（兼容旧状态）', () => {
    expect(resolveVoiceModelGroup(model('vad'))).toBe('asr-core')
    expect(resolveVoiceModelGroup(model('asr-paraformer-zh'))).toBe('asr-core')
    expect(resolveVoiceModelGroup(model('tts-qwen3-0.6b-base'))).toBe('tts-clone')
    expect(resolveVoiceModelGroup(model('tts-qwen3-tokenizer-12hz'))).toBe('tts-synth')
  })
})

describe('resolveCardState', () => {
  const downloading = (): VoiceModelStatus =>
    ({ id: 'tts-breeze-2', name: 'x', downloadState: 'downloading' }) as VoiceModelStatus

  it('本地进度镜像停在 downloading 时，主进程说失败/暂停就听主进程的', () => {
    const failed = { ...downloading(), downloadState: 'error' } as VoiceModelStatus
    expect(resolveCardState(failed, 'downloading')).toBe('error')
  })

  it('已就绪优先于任何旧镜像（下完之后不许再显示进度条）', () => {
    const done = { ...downloading(), downloaded: true, downloadState: 'ready' } as VoiceModelStatus
    expect(resolveCardState(done, 'downloading')).toBe('ready')
  })

  it('主进程还是 idle 时用镜像补位（刚点下载、状态事件还没到）', () => {
    expect(resolveCardState(model('x'), 'downloading')).toBe('downloading')
  })

  it('两边都没有就是 idle', () => {
    expect(resolveCardState(model('x'), undefined)).toBe('idle')
  })
})
