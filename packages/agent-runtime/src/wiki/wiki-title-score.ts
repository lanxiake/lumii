/**
 * titleInfoScore —— 标题信息量打分
 *
 * 给低信息标题（`IMG_1234.jpg`、`扫描_0001.pdf`、`未命名文档.docx`）判分，
 * 供 P6 AI 改名筛出「值得改」的候选：分数低才提案，标题本身已够用就不动。
 *
 * 设计：docs/plans/记忆重构/2026-08-31-wiki-intelligent-vault-p6-rename.md Task 2
 */

/** 低于此分视为低信息标题 */
export const LOW_INFO_THRESHOLD = 0.4;

const STOPWORDS = new Set([
  "的", "了", "和", "与", "及", "在", "是", "有", "或", "对", "为", "而",
  "a", "an", "the", "of", "and", "or", "to", "in", "on", "for",
]);

/** 相机/扫描/微信等自动生成文件名的常见模式（作为一项特征，权重不过半） */
const AUTO_GEN_PATTERNS: readonly RegExp[] = [
  /^img[_-]?\d+$/i,
  /^dsc[_-]?\d+$/i,
  /^screenshot[_\s-]?\d*/i,
  /^微信图片[_-]?\d*/,
  /^微信截图[_-]?\d*/,
  /^扫描[_-]?\d*/,
  /^scan[_-]?\d*$/i,
  /^未命名(文档|表格|演示文稿)?\s*\d*$/,
  /^新建(文本文档|文件夹|文档)\s*\d*$/,
  /^document\s*\d*$/i,
  /^photo[_-]?\d*$/i,
  /^video[_-]?\d*$/i,
  /^\d{8}[_-]?\d*$/, // 20260812
  /^wechat_\d+$/i,
];

/** 去掉扩展名，取纯文件名部分打分 */
function stripExt(title: string): string {
  const idx = title.lastIndexOf(".");
  return idx > 0 ? title.slice(0, idx) : title;
}

/** 粗分词：按非中文/非字母数字的边界切，加上逐字符中文 2-gram，用于词重合度估计 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const cleaned = text.toLowerCase();
  for (const seg of cleaned.split(/[^一-龥a-z0-9]+/).filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(seg)) {
      tokens.push(seg);
    } else {
      // 中文按 2-gram 展开，短于 2 字整段保留
      if (seg.length < 2) tokens.push(seg);
      else for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2));
    }
  }
  return tokens;
}

/** 实义词占比：去停用词后剩余 token 数 / 总 token 数 */
function meaningfulRatio(title: string): number {
  const tokens = tokenize(stripExt(title));
  if (tokens.length === 0) return 0;
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  return meaningful.length / tokens.length;
}

/** 标题与正文的词重合度（Jaccard 近似） */
function overlapWithCorpus(title: string, corpus: string | null): number {
  if (!corpus) return 0;
  const titleTokens = new Set(tokenize(stripExt(title)));
  const corpusTokens = new Set(tokenize(corpus));
  if (titleTokens.size === 0 || corpusTokens.size === 0) return 0;
  let hit = 0;
  for (const t of titleTokens) if (corpusTokens.has(t)) hit++;
  return hit / titleTokens.size;
}

function matchesAutoGenPattern(title: string): boolean {
  const stem = stripExt(title).trim();
  return AUTO_GEN_PATTERNS.some((re) => re.test(stem));
}

function isPureNumericOrAsciiPrefixed(title: string): boolean {
  const stem = stripExt(title).trim();
  return /^\d+$/.test(stem) || /^[a-z]+[_-]?\d+$/i.test(stem);
}

/**
 * 打分 0–1：分数越高标题信息量越大。特征：
 * - 与正文（summary 优先，无则 extracted_text 前 300 字）词重合度
 * - 标题实义词占比
 * - 自动生成命名模式匹配（相机/扫描/微信，权重不过半）
 * - 纯数字/ASCII+数字前缀
 * - 标题长度 ≤2
 *
 * `< LOW_INFO_THRESHOLD` 视为低信息，值得 AI 改名提案。
 */
export function titleInfoScore(title: string, corpus: string | null): number {
  const stem = stripExt(title).trim();
  if (stem.length === 0) return 0;

  let score = 0;

  // 实义词占比：最高贡献 0.35
  score += meaningfulRatio(title) * 0.35;

  // 与正文重合度：最高贡献 0.35
  score += overlapWithCorpus(title, corpus) * 0.35;

  // 长度基础分：越长通常信息量越大，但不是决定性因素，最高贡献 0.3
  const lengthScore = Math.min(stem.length / 12, 1);
  score += lengthScore * 0.3;

  // 惩罚项：自动生成命名模式（权重不过半，避免单靠这一项判死）
  if (matchesAutoGenPattern(title)) score -= 0.4;

  // 惩罚项：纯数字或 ASCII+数字前缀
  if (isPureNumericOrAsciiPrefixed(title)) score -= 0.3;

  // 惩罚项：标题过短
  if (stem.length <= 2) score -= 0.3;

  return Math.max(0, Math.min(1, score));
}

export function isLowInfoTitle(title: string, corpus: string | null): boolean {
  return titleInfoScore(title, corpus) < LOW_INFO_THRESHOLD;
}

/** renameTitle 提案的置信阈值：低于此丢弃（比批量分类阈值更严，改名影响更直观） */
export const RENAME_CONFIDENCE_THRESHOLD = 0.7;

/**
 * 服务端校验改名提案是否可接受（P6 Task 3）：
 * - titleLocked → 强制丢弃，不管 LLM 输出了什么
 * - storageMode === 'ref' 且未显式允许 → 默认丢弃（避免库内显示名与磁盘文件名双名）
 * - 当前标题本身信息量已够（>= LOW_INFO_THRESHOLD）→ 丢弃，不需要改
 * - confidence < RENAME_CONFIDENCE_THRESHOLD → 丢弃
 */
export function shouldAcceptRenameProposal(params: {
  readonly renameTitle: string | undefined;
  readonly currentTitle: string;
  readonly titleLocked: boolean;
  readonly storageMode: "ref" | "materialized" | "native";
  readonly confidence: number;
  readonly allowRenameRef?: boolean;
}): boolean {
  if (!params.renameTitle) return false;
  if (params.titleLocked) return false;
  if (params.storageMode === "ref" && !params.allowRenameRef) return false;
  if (titleInfoScore(params.currentTitle, null) >= LOW_INFO_THRESHOLD) return false;
  if (params.confidence < RENAME_CONFIDENCE_THRESHOLD) return false;
  return true;
}
