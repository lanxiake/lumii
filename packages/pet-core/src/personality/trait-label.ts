/**
 * 气质标签：把 Big Five 数值翻译成一句人话（设计 §3.6）。
 *
 * 取偏离中性（0.5）最远的两维合成一句话；五维都不够偏离时给中性文案。
 * 与「mood 数值不展示给用户」同一个道理——用户看到的是标签，不是数字。
 */

export type TraitKey =
  | "openness"
  | "conscientiousness"
  | "extraversion"
  | "agreeableness"
  | "neuroticism";

/** 结构上兼容 PersonalityState，避免 pet-core 反向依赖 agent-runtime */
export type TraitValues = Record<TraitKey, number>;

/** 偏离 0.5 的门槛：不到它视为「没这个脾气」，不写进标签 */
export const TRAIT_LABEL_THRESHOLD = 0.15;

/** 五维都不够偏离时的文案（约 15% 的宠物落在这里，得是句正经描述而不是错误态） */
export const NEUTRAL_TRAIT_LABEL = "性格平和，不偏不倚";

/** 语感倾向：同向用「，」顺接，反向用「，但」转折 */
type Tone = "active" | "reserved";

interface TraitWord {
  text: string;
  tone: Tone;
}

const TRAIT_WORDS: Record<TraitKey, { high: TraitWord; low: TraitWord }> = {
  openness: {
    high: { text: "好奇心重", tone: "active" },
    low: { text: "不太爱新鲜", tone: "reserved" },
  },
  conscientiousness: {
    high: { text: "做事靠谱", tone: "reserved" },
    low: { text: "比较随性", tone: "active" },
  },
  extraversion: {
    high: { text: "很黏人", tone: "active" },
    low: { text: "有点怕生", tone: "reserved" },
  },
  agreeableness: {
    high: { text: "好说话", tone: "active" },
    low: { text: "有点小脾气", tone: "reserved" },
  },
  neuroticism: {
    high: { text: "心思敏感", tone: "reserved" },
    low: { text: "不太会慌", tone: "active" },
  },
};

const TRAIT_KEYS = Object.keys(TRAIT_WORDS) as TraitKey[];

/**
 * 生成气质标签。偏离不足 `threshold` 的维度一律不写进标签，
 * 因此「好奇心重，但有点怕生」说的是**最突出的两维**，不是五维的罗列。
 */
export function traitLabel(traits: TraitValues, threshold = TRAIT_LABEL_THRESHOLD): string {
  const salient = TRAIT_KEYS.map((key) => {
    const deviation = traits[key] - 0.5;
    return { key, abs: Math.abs(deviation), high: deviation > 0 };
  })
    .filter((t) => Number.isFinite(t.abs) && t.abs >= threshold)
    .sort((a, b) => b.abs - a.abs)
    .slice(0, 2);

  if (salient.length === 0) {
    return NEUTRAL_TRAIT_LABEL;
  }

  const words = salient.map((t) => TRAIT_WORDS[t.key][t.high ? "high" : "low"]);
  if (words.length === 1) {
    return words[0]!.text;
  }
  const conjunction = words[0]!.tone === words[1]!.tone ? "，" : "，但";
  return `${words[0]!.text}${conjunction}${words[1]!.text}`;
}
