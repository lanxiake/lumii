/**
 * emotion-tag-parser — 表情/动作标签解析（纯函数，pet-core）
 *
 * 从 apps/windows/src/shared/virtual-human.ts 抽出的**标签解析纯函数子集**：
 * LLM 回复里内嵌 `[emotion]` 表情标签与 `[motion:tag]` / `<vh_action>` 动作标签，
 * 本模块负责提取与剥离，供各端把表情映射到模型 expression 索引、把动作映射到动作组，
 * 并保证标签不进入朗读文本（TTS）与字幕。
 *
 * 纯正则，无 DOM / Electron / RN 依赖。Windows 私有的 localStorage 键、设置 DTO、
 * resolveAgentId 等不属于跨端逻辑，留在各端，不进公共包。
 */

/** 表情标签正则：匹配 [emotion_name]，名仅允许字母/数字/下划线/中文 */
const EMOTION_TAG_REGEX = /\[([a-zA-Z0-9_一-龥]+)\]/g;
/** 动作标签正则：匹配 [motion:tag] */
const MOTION_TAG_REGEX = /\[motion:([a-zA-Z0-9_一-龥]+)\]/g;
/** 动作块正则：匹配 <vh_action>...</vh_action>（含跨行） */
const VH_ACTION_REGEX = /<vh_action>[\s\S]*?<\/vh_action>/g;
/** 未闭合的动作块开头（流式中途，剥离残留） */
const VH_ACTION_OPEN_REGEX = /<vh_action>[\s\S]*$/;

/**
 * 提取表情标签，返回清洁文本与命中表情名列表。
 * 不依赖 emotionMap，调用方负责映射到索引（mapEmotionsToIndices）。
 */
export function extractEmotionTags(text: string): { cleanText: string; emotions: string[] } {
  const emotions: string[] = [];
  EMOTION_TAG_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMOTION_TAG_REGEX.exec(text)) !== null) {
    emotions.push(m[1]!);
  }
  const cleanText = text.replace(EMOTION_TAG_REGEX, "");
  return { cleanText, emotions };
}

/**
 * 提取动作标签 [motion:tag]，返回命中的 tag 列表。
 * 不依赖模型动作表，调用方负责映射到动作组/index 并触发播放。
 */
export function extractMotionTags(text: string): string[] {
  const tags: string[] = [];
  MOTION_TAG_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MOTION_TAG_REGEX.exec(text)) !== null) {
    tags.push(m[1]!);
  }
  return tags;
}

/**
 * 从 TTS 输入中剥离所有标签（表情 [tag] + 动作 [motion:tag] + <vh_action>...）。
 * 在朗读分句前全局调用，保证标签不进入朗读。对流式 delta 也安全：未闭合的
 * <vh_action> 开头会被剥到行尾。
 */
export function stripVirtualHumanTags(text: string): string {
  EMOTION_TAG_REGEX.lastIndex = 0;
  MOTION_TAG_REGEX.lastIndex = 0;
  return text
    .replace(VH_ACTION_REGEX, "")
    .replace(VH_ACTION_OPEN_REGEX, "")
    .replace(MOTION_TAG_REGEX, "")
    .replace(EMOTION_TAG_REGEX, "");
}

/** 将表情名映射为渲染器 expression 索引（过滤未知标签） */
export function mapEmotionsToIndices(
  emotions: string[],
  emotionMap: Record<string, number>,
): number[] {
  const indices: number[] = [];
  for (const name of emotions) {
    const idx = emotionMap[name];
    if (typeof idx === "number") {
      indices.push(idx);
    }
  }
  return indices;
}
