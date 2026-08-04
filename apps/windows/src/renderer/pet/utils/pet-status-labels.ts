/**
 * 虚拟人控制坞 — 表情/动作状态中文展示
 *
 * 编排器内部仍用 emotionMap key 与动作组技术名；UI 层统一转中文。
 */

import { PET_MOTION_GROUP_UNNAMED } from '../config/pet-model-types'
import type { PetAvatarStatus } from '../orchestrator/PetOrchestrator'

/** 表情标签（emotionMap key）→ 中文名 */
export const EMOTION_LABEL_ZH: Record<string, string> = {
  neutral: '平静',
  joy: '开心',
  anger: '生气',
  sadness: '悲伤',
  sad: '悲伤',
  fear: '害怕',
  disgust: '厌恶',
  surprise: '惊讶',
  smirk: '坏笑',
  smile: '微笑',
  calm: '平静',
  shy: '害羞',
  blush: '脸红',
  worried: '担心',
  sparkle: '兴奋',
  // Mao PRO 模型 exp 直查 key
  exp_01: '平静',
  exp_02: '微笑',
  exp_03: '闭眼',
  exp_04: '兴奋',
  exp_05: '难过',
  exp_06: '害羞',
  exp_07: '担心',
  exp_08: '生气',
  平静: '平静',
  微笑: '微笑',
  闭眼: '闭眼',
  思考: '思考',
  开心: '开心',
  兴奋: '兴奋',
  难过: '难过',
  害羞: '害羞',
  脸红: '脸红',
  担心: '担心',
  生气: '生气',
  愤怒: '愤怒',
  desk: '伏案',
  mic: '麦克风',
  clever: '得意',
  oao: 'OAO',
  OAO: 'OAO',
  qaq: 'QAQ',
  QAQ: 'QAQ',
  igari: '嫌弃',
  keyboard: '敲键盘',
  punch: '出拳',
  plus: '点赞',
  伏案: '伏案',
  麦克风: '麦克风',
  得意: '得意',
  呆萌: '呆萌',
  委屈: '委屈',
  嫌弃: '嫌弃',
  敲键盘: '敲键盘',
  出拳: '出拳',
  赞同: '赞同',
  点赞: '点赞',
}

/** 动作组技术名 → 中文简称 */
export const MOTION_GROUP_LABEL_ZH: Record<string, string> = {
  Idle: '待机',
  Talk: '说话',
  Tap: '轻触',
  FlickUp: '抬头',
  Flick3: '挥手',
  Rest: '休息',
  [PET_MOTION_GROUP_UNNAMED]: '扩展动作',
}

/** motion3 文件名片段 → 中文（shizuku / mao_pro 常用） */
export const MOTION_FILE_LABEL_ZH: Record<string, string> = {
  '01': '抬头',
  '02': '轻触',
  '03': '挥手',
  '04': '打哈欠',
  mtn_01: '基础待机',
  mtn_02: '摇摆问候',
  mtn_03: '点头赞同',
  mtn_04: '歪头好奇',
  special_01: '活泼雀跃',
  special_02: '得意特效',
  special_03: '卖萌撒娇',
  loop: '循环摇摆',
  shanziguan: '挥扇',
  tixie: '脱鞋',
  IDLING_1: '待机一',
  IDLING_2: '待机二',
  touch_s: '轻触',
  touch_w: '挥手触',
}

/**
 * 将表情 key 格式化为中文；无则返回「无」。
 */
export function formatExpressionLabel(expressionKey?: string): string {
  if (!expressionKey) return '无'
  return EMOTION_LABEL_ZH[expressionKey] ?? expressionKey
}

/**
 * 将动作组名格式化为中文。
 */
export function formatMotionGroupLabel(group?: string): string {
  if (!group) return ''
  return MOTION_GROUP_LABEL_ZH[group] ?? group
}

/**
 * 从 motion3 路径提取并翻译为中文动作名。
 */
export function formatMotionFileLabel(filePath?: string): string | undefined {
  if (!filePath) return undefined
  const base = filePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.motion3\.json$/i, '') ?? ''
  if (!base) return undefined
  return MOTION_FILE_LABEL_ZH[base] ?? base
}

/**
 * 根据编排器结构化状态生成动作中文描述；优先用实际播放文件，无则「无」。
 */
export function formatMotionLabel(
  status?: Pick<PetAvatarStatus, 'phase' | 'motionKind' | 'motionGroup' | 'motionDetail'> | null,
): string {
  // 优先展示实际播放的 motion3 文件（[motion:tag] 触发的动作）
  const fromFile = formatMotionFileLabel(status?.motionDetail)
  if (fromFile) return fromFile

  // 无实际动作文件时用阶段占位
  if (status?.phase === 'text-reply' || status?.phase === 'speaking') {
    return status.phase === 'text-reply' ? '文字回复中' : '语音说话中'
  }

  if (!status?.motionKind || status.motionKind === 'none') return '无'
  const groupZh = formatMotionGroupLabel(status.motionGroup)
  switch (status.motionKind) {
    case 'idle':
      return groupZh ? `基础${groupZh}` : '基础待机'
    case 'idle-random':
      return groupZh ? `随机${groupZh}` : '随机待机'
    case 'talk':
      return groupZh ? `${groupZh}中` : '说话中'
    case 'cooldown':
      return groupZh ? `${groupZh}·冷却中` : '待机冷却中'
    default:
      return '无'
  }
}

/**
 * 根据 expression 索引反查 emotionMap key。
 */
export function resolveEmotionKeyByIndex(
  emotionMap: Record<string, number>,
  index: number,
): string | undefined {
  return Object.entries(emotionMap).find(([, v]) => v === index)?.[0]
}

/**
 * 拼装控制坞第二行完整文案。
 */
export function formatAvatarStatusLine(
  status: PetAvatarStatus | null | undefined,
  opts?: { idleMotionEnabled?: boolean },
): string {
  const parts: string[] = [
    `表情: ${formatExpressionLabel(status?.expressionKey)}`,
    `动作: ${formatMotionLabel(status)}`,
  ]
  if (opts?.idleMotionEnabled === false) parts.push('随动: 关')
  if (status?.postDialogueCooldown) parts.push('对话冷却中')
  return parts.join(' · ')
}
