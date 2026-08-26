/**
 * Wiki ERO 抽取器 — 从最近更新页面经 LLM 抽取实体、关系与观察
 *
 * 设计：`docs/superpowers/specs/2026-08-27-wiki-auto-synthesis-and-kg-design.md` §3
 * 单页失败不中断整批；实体名与已有页面标题匹配时绑定 page_id。
 */

import { extractJsonPayload } from "./wiki-classifier.js";
import type { WikiEroRepo, WikiEntityType } from "./wiki-ero.js";
import type { WikiRepo } from "./wiki-repo.js";

/** 默认扫描最近更新页数 */
export const DEFAULT_ERO_EXTRACT_MAX_PAGES = 20;

/** 默认每页送入 LLM 的正文字符上限 */
export const DEFAULT_ERO_EXTRACT_MAX_CHARS = 4000;

/** maxPages 允许上限 */
export const ERO_EXTRACT_MAX_PAGES_CAP = 100;

/** maxCharsPerPage 允许上限 */
export const ERO_EXTRACT_MAX_CHARS_CAP = 20000;

/**
 * 将抽取页数钳制到 [0, ERO_EXTRACT_MAX_PAGES_CAP]。
 */
export function clampEroExtractMaxPages(value: number | undefined): number {
  const n = value ?? DEFAULT_ERO_EXTRACT_MAX_PAGES;
  return Math.min(ERO_EXTRACT_MAX_PAGES_CAP, Math.max(0, n));
}

/**
 * 将每页字符上限钳制到 [0, ERO_EXTRACT_MAX_CHARS_CAP]。
 */
export function clampEroExtractMaxChars(value: number | undefined): number {
  const n = value ?? DEFAULT_ERO_EXTRACT_MAX_CHARS;
  return Math.min(ERO_EXTRACT_MAX_CHARS_CAP, Math.max(0, n));
}

/** 关系强度缺省值（与 spec 一致） */
const DEFAULT_RELATION_STRENGTH = 0.4;

const VALID_ENTITY_TYPES = new Set<WikiEntityType>([
  "person",
  "project",
  "tool",
  "concept",
  "other",
]);

/** 单批抽取汇总 */
export interface WikiEroExtractResult {
  readonly pagesProcessed: number;
  readonly entitiesUpserted: number;
  readonly relationsUpserted: number;
  readonly observationsAdded: number;
  readonly errors: readonly string[];
}

interface ParsedEroEntity {
  readonly name: string;
  readonly type: WikiEntityType;
}

interface ParsedEroRelation {
  readonly source: string;
  readonly target: string;
  readonly type: string;
  readonly strength: number;
}

interface ParsedEroObservation {
  readonly entity: string;
  readonly content: string;
}

interface ParsedEroPayload {
  readonly entities: readonly ParsedEroEntity[];
  readonly relations: readonly ParsedEroRelation[];
  readonly observations: readonly ParsedEroObservation[];
}

/**
 * 构造单页 ERO 抽取提示词，要求模型仅输出 JSON。
 */
export function buildEroExtractPrompt(title: string, contentMd: string): string {
  return [
    "你是知识图谱抽取助手。从下面 Wiki 页面正文中抽取实体、关系与观察。",
    "",
    "## 页面标题",
    title,
    "",
    "## 页面正文",
    contentMd,
    "",
    "## 输出格式",
    "仅输出 JSON，不要包含其他文字：",
    JSON.stringify(
      {
        entities: [{ name: "...", type: "person|project|tool|concept|other" }],
        relations: [{ source: "...", target: "...", type: "...", strength: 0.4 }],
        observations: [{ entity: "...", content: "..." }],
      },
      null,
      2,
    ),
  ].join("\n");
}

/**
 * 将模型输出解析为 ERO 载荷；非法结构返回 null。
 */
export function parseEroExtractResponse(response: string): ParsedEroPayload | null {
  const payload = extractJsonPayload(response);
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  const entities: ParsedEroEntity[] = [];
  if (Array.isArray(record.entities)) {
    for (const raw of record.entities) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const name = typeof item.name === "string" ? item.name.trim() : "";
      if (!name) continue;
      const typeRaw = typeof item.type === "string" ? item.type : "other";
      const type = VALID_ENTITY_TYPES.has(typeRaw as WikiEntityType)
        ? (typeRaw as WikiEntityType)
        : "other";
      entities.push({ name, type });
    }
  }

  const relations: ParsedEroRelation[] = [];
  if (Array.isArray(record.relations)) {
    for (const raw of record.relations) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const source = typeof item.source === "string" ? item.source.trim() : "";
      const target = typeof item.target === "string" ? item.target.trim() : "";
      const type = typeof item.type === "string" ? item.type.trim() : "";
      if (!source || !target || !type) continue;
      const strength =
        typeof item.strength === "number" && Number.isFinite(item.strength)
          ? Math.min(1, Math.max(0, item.strength))
          : DEFAULT_RELATION_STRENGTH;
      relations.push({ source, target, type, strength });
    }
  }

  const observations: ParsedEroObservation[] = [];
  if (Array.isArray(record.observations)) {
    for (const raw of record.observations) {
      if (typeof raw !== "object" || raw === null) continue;
      const item = raw as Record<string, unknown>;
      const entity = typeof item.entity === "string" ? item.entity.trim() : "";
      const content = typeof item.content === "string" ? item.content.trim() : "";
      if (!entity || !content) continue;
      observations.push({ entity, content });
    }
  }

  return { entities, relations, observations };
}

/**
 * 从 Wiki 最近更新页批量抽取 ERO 并 upsert 到仓储。
 */
export class WikiEroExtractor {
  constructor(
    private readonly repo: WikiRepo,
    private readonly ero: WikiEroRepo,
    private readonly callLLM: (prompt: string) => Promise<string>,
  ) {}

  /**
   * 对最近更新页抽取实体关系；默认 maxPages=20、maxCharsPerPage=4000。
   */
  async extractRecent(
    agentId: string,
    userId: string,
    options?: { maxPages?: number; maxCharsPerPage?: number },
  ): Promise<WikiEroExtractResult> {
    const maxPages = clampEroExtractMaxPages(options?.maxPages);
    const maxCharsPerPage = clampEroExtractMaxChars(options?.maxCharsPerPage);

    const allPages = this.repo.listPages(agentId, userId);
    const pages = allPages.slice(0, maxPages);
    const titleToPageId = new Map(allPages.map((p) => [p.title, p.id]));

    /** 跨页累积：已有 ERO 实体 + 本批已 upsert 实体，供关系/观察解析 */
    const entityIdByName = new Map<string, string>(
      this.ero.listEntities(agentId, userId).map((e) => [e.name, e.id]),
    );

    let pagesProcessed = 0;
    let entitiesUpserted = 0;
    let relationsUpserted = 0;
    let observationsAdded = 0;
    const errors: string[] = [];

    for (const page of pages) {
      try {
        const contentMd = page.content_md.slice(0, maxCharsPerPage);
        const response = await this.callLLM(buildEroExtractPrompt(page.title, contentMd));
        const parsed = parseEroExtractResponse(response);
        if (!parsed) {
          errors.push(`${page.title}: JSON 解析失败`);
          continue;
        }

        for (const ent of parsed.entities) {
          const pageId = titleToPageId.get(ent.name) ?? null;
          const saved = this.ero.upsertEntity({
            agentId,
            userId,
            name: ent.name,
            entityType: ent.type,
            pageId: pageId ?? undefined,
          });
          entityIdByName.set(ent.name, saved.id);
          entitiesUpserted += 1;
        }

        for (const rel of parsed.relations) {
          const sourceEntityId = entityIdByName.get(rel.source);
          const targetEntityId = entityIdByName.get(rel.target);
          if (!sourceEntityId || !targetEntityId) continue;
          this.ero.upsertRelation({
            agentId,
            userId,
            sourceEntityId,
            targetEntityId,
            relationType: rel.type,
            strength: rel.strength,
            sourcePageId: page.id,
          });
          relationsUpserted += 1;
        }

        for (const obs of parsed.observations) {
          const entityId = entityIdByName.get(obs.entity);
          if (!entityId) continue;
          this.ero.addObservation({
            agentId,
            userId,
            entityId,
            content: obs.content,
            sourcePageId: page.id,
          });
          observationsAdded += 1;
        }

        pagesProcessed += 1;
      } catch (err) {
        errors.push(`${page.title}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      pagesProcessed,
      entitiesUpserted,
      relationsUpserted,
      observationsAdded,
      errors,
    };
  }
}
