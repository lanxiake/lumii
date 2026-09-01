/**
 * Wiki 用途主题树 — 默认树、校验、读写辅助
 *
 * 设计：docs/design/记忆设计/2026-08-27-wiki-topic-hierarchy-redesign.md §1-§2
 * 分类轴是「用途」（做事记录/学习资料/…），不是来源类型（sources/media）。
 * 「临时存放」是代码常量，不写进树 JSON，用户主动搁置用，AI 不可写。
 */

/** 用户主动搁置的资料去处；不是树节点，AI 不可写入 */
export const PARKING_CATEGORY = "临时存放";

/** wiki_index_meta 中存放主题树 JSON 的键 */
export const TOPIC_CATEGORIES_META_KEY = "topic_categories";

export interface WikiTopicTree {
  readonly version: 1 | 2;
  readonly categories: ReadonlyArray<{ readonly name: string; readonly subtopics: readonly string[] }>;
}

/** v1 六大类树，仅供 V26 迁移前的历史数据/迁移代码引用，不再作为默认树 */
export const LEGACY_TOPIC_TREE_V1: WikiTopicTree = {
  version: 1,
  categories: [
    { name: "做事记录", subtopics: ["项目/任务资料", "会议聊天记录", "汇报总结文稿", "规则制度文档", "数据统计报表", "对外沟通材料", "整合长文"] },
    { name: "学习资料", subtopics: ["课堂&课程笔记", "读书摘抄整理", "调研搜集材料", "考试备考资料", "知识思维导图", "行业专题材料", "整合长文"] },
    { name: "计划与复盘", subtopics: ["目标规划方案", "日程待办清单", "风险预案", "收支预算测算", "经历复盘总结", "备选方案记录", "整合长文"] },
    { name: "证件凭据", subtopics: ["合同协议文件", "证件扫描副本", "票据收据凭证", "保险相关资料", "个人履历档案", "申请证明材料", "整合长文"] },
    { name: "模板参考", subtopics: ["各类文档模板", "PPT与表单素材", "范文案例参考", "图片媒体素材", "工具使用参考", "文案脚本素材", "整合长文"] },
    { name: "随笔创作", subtopics: ["原创作品底稿", "灵感随手记录", "爱好相关笔记", "生活感悟随笔", "作品修改草稿", "整合长文"] },
  ],
};

/**
 * v2 默认树：4 大类 × 用途轴小类，小类数量收窄、去掉「整合长文」专属小类
 * （综述功能已移除，见 P2）。小类可选——大类下允许无小类的资料（见 validateTopicAssignment）。
 */
export const DEFAULT_TOPIC_TREE: WikiTopicTree = {
  version: 2,
  categories: [
    { name: "工作", subtopics: ["项目", "例行", "对外"] },
    { name: "学习", subtopics: ["在学", "参考"] },
    { name: "生活", subtopics: ["凭据", "家事", "自留"] },
    { name: "收藏", subtopics: ["待读", "可复用"] },
  ],
};

const LEGACY_V1_CATEGORY_NAMES = new Set(LEGACY_TOPIC_TREE_V1.categories.map((c) => c.name));

/**
 * 树里是否还带着 v1 旧六大类名。打开 Wiki 时只对这种树自动迁 v2；
 * 仅 version 字段为 1、内容已是工作/学习的（旧 mutation 写错版本）不能当旧六大类清掉。
 */
export function topicTreeHasLegacyV1Categories(tree: WikiTopicTree): boolean {
  return tree.categories.some((c) => LEGACY_V1_CATEGORY_NAMES.has(c.name));
}

/** 名称合法：非空、长度在 [min,max]、无控制字符 */
function isValidName(name: unknown, min: number, max: number): name is string {
  if (typeof name !== "string") return false;
  if (name.length < min || name.length > max) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return false;
  return true;
}

export function parseTopicTree(json: string | null): WikiTopicTree | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return validateTopicTree(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 校验树结构：version 为 1 或 2（1 仅供读取 V26 迁移前的历史 meta JSON，写入一律用 2）；
 * ≥1 个大类；大类名唯一、1-20 字、无控制字符、≠临时存放；
 * 小类名在同一大类内不重复、1-32 字、允许 `/` 和 `&`。
 */
export function validateTopicTree(tree: unknown): tree is WikiTopicTree {
  if (typeof tree !== "object" || tree === null) return false;
  const t = tree as { version?: unknown; categories?: unknown };
  if (t.version !== 1 && t.version !== 2) return false;
  if (!Array.isArray(t.categories) || t.categories.length === 0) return false;

  const seenCategoryNames = new Set<string>();
  for (const c of t.categories) {
    if (typeof c !== "object" || c === null) return false;
    const cat = c as { name?: unknown; subtopics?: unknown };
    if (!isValidName(cat.name, 1, 20)) return false;
    if (cat.name === PARKING_CATEGORY) return false;
    if (seenCategoryNames.has(cat.name)) return false;
    seenCategoryNames.add(cat.name);

    if (!Array.isArray(cat.subtopics)) return false;
    const seenSubtopics = new Set<string>();
    for (const sub of cat.subtopics) {
      if (!isValidName(sub, 1, 32)) return false;
      if (seenSubtopics.has(sub)) return false;
      seenSubtopics.add(sub);
    }
  }
  return true;
}

/**
 * 校验一次分类归属是否落在当前树内。
 * 正式节点：category 必须是树中大类，subtopic 必须是该大类下的小类。
 * `opts.allowParking`：允许 category===PARKING_CATEGORY 且 subtopic 必须为 null。
 */
export function validateTopicAssignment(
  tree: WikiTopicTree,
  category: string,
  subtopic: string | null,
  opts?: { readonly allowParking?: boolean },
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (opts?.allowParking && category === PARKING_CATEGORY) {
    if (subtopic !== null) {
      return { ok: false, reason: "临时存放不允许指定小类" };
    }
    return { ok: true };
  }
  const cat = tree.categories.find((c) => c.name === category);
  if (!cat) {
    return { ok: false, reason: `大类不存在：${category}` };
  }
  // 小类可选（v1.1）：subtopic 为 null 表示只归大类，未细分；非空则必须属于该大类。
  if (subtopic !== null && !cat.subtopics.includes(subtopic)) {
    return { ok: false, reason: `小类不存在：${category} / ${subtopic}` };
  }
  return { ok: true };
}

/**
 * 检查 occupied（当前已被资料占用的 category+subtopic 组合）中是否存在树里没有的节点。
 * 用于 setTopicTree：删除仍有文件占用的小类会产生孤儿，应拒绝。
 */
export function treeHasOrphans(
  tree: WikiTopicTree,
  occupied: ReadonlyArray<{ readonly category: string; readonly subtopic: string }>,
): boolean {
  for (const o of occupied) {
    const result = validateTopicAssignment(tree, o.category, o.subtopic);
    if (!result.ok) return true;
  }
  return false;
}
