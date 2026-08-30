/**
 * Wiki 左栏分区与磁盘目录映射。
 * 供 vault 落盘与分类建议共用，避免 UI 与 agent-runtime 各维护一份。
 */
import { PARKING_CATEGORY } from "./wiki-topic-tree.js";

/** 左栏分区 id（与 renderer wikiNavMapping 对齐） */
export type WikiNavId = "inbox" | "work" | "study" | "life" | "collection" | "archived";

export interface WikiNavSectionDef {
  readonly id: WikiNavId;
  readonly label: string;
  /** 归入本分区的旧大类；inbox / archived 为空 */
  readonly legacyCategories: readonly string[];
  /** workspace/wiki/ 下的目录名 */
  readonly folderSlug: string;
  readonly hint: string;
}

/** 左栏顺序 */
export const WIKI_NAV_SECTIONS: readonly WikiNavSectionDef[] = [
  {
    id: "inbox",
    label: "收件箱",
    legacyCategories: [],
    folderSlug: "00-收件箱",
    hint: "还没想好放哪的新资料",
  },
  {
    id: "work",
    label: "工作",
    legacyCategories: ["做事记录"],
    folderSlug: "01-工作",
    hint: "跟上班、项目、赚钱有关",
  },
  {
    id: "study",
    label: "学习",
    legacyCategories: ["学习资料"],
    folderSlug: "02-学习",
    hint: "主动在学、在读、在备考",
  },
  {
    id: "life",
    label: "生活",
    legacyCategories: ["计划与复盘", "证件凭据"],
    folderSlug: "03-生活",
    hint: "私人、家庭、证件、日记",
  },
  {
    id: "collection",
    label: "收藏",
    legacyCategories: ["模板参考", "随笔创作"],
    folderSlug: "04-收藏",
    hint: "链接、模板、长期参考",
  },
  {
    id: "archived",
    label: "归档",
    legacyCategories: [],
    folderSlug: "05-归档",
    hint: "暂时不用但还要留着",
  },
] as const;

export const WIKI_PARKING_DIR = "_parking";
export const WIKI_META_DIR = ".lumii";

/**
 * 旧大类 → 分区 id；NULL / 临时存放 → inbox；未知大类兜底 work。
 */
export function navIdFromLegacyCategory(category: string | null): WikiNavId {
  if (!category || category === PARKING_CATEGORY) return "inbox";
  for (const sec of WIKI_NAV_SECTIONS) {
    if (sec.legacyCategories.includes(category)) return sec.id;
  }
  return "work";
}

/**
 * 分区 → 涵盖的旧大类列表。
 */
export function legacyCategoriesForNav(navId: WikiNavId): readonly string[] {
  const sec = WIKI_NAV_SECTIONS.find((s) => s.id === navId);
  return sec?.legacyCategories ?? [];
}

/**
 * 「移到…」落库用的首个旧大类；inbox / archived 无写入目标。
 */
export function primaryLegacyCategoryForNav(navId: WikiNavId): string | null {
  const cats = legacyCategoriesForNav(navId);
  return cats[0] ?? null;
}

/**
 * 分区显示名。
 */
export function navLabel(navId: WikiNavId): string {
  return WIKI_NAV_SECTIONS.find((s) => s.id === navId)?.label ?? navId;
}

/**
 * 按分区 id 取磁盘目录 slug。
 */
export function folderSlugForNavId(navId: WikiNavId): string {
  return WIKI_NAV_SECTIONS.find((s) => s.id === navId)?.folderSlug ?? "00-收件箱";
}

/**
 * 根据资料当前主题/归档状态，解析 vault 内目录段（不含 wiki/ 前缀）。
 */
export function vaultDirSegmentsForSource(params: {
  readonly topicCategory: string | null;
  readonly topicSubtopic: string | null;
  readonly archivedAt: string | null;
}): string[] {
  if (params.archivedAt) {
    return [folderSlugForNavId("archived")];
  }
  if (params.topicCategory === PARKING_CATEGORY) {
    return [WIKI_PARKING_DIR];
  }
  if (!params.topicCategory) {
    return [folderSlugForNavId("inbox")];
  }
  const navId = navIdFromLegacyCategory(params.topicCategory);
  const base = folderSlugForNavId(navId);
  if (params.topicSubtopic) {
    return [base, params.topicSubtopic];
  }
  return [base];
}