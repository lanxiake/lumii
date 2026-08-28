/**
 * Wiki ERO 抽取器 — 从最近更新页面经 LLM 抽取实体、关系与观察
 *
 * 设计：`docs/superpowers/specs/2026-08-27-wiki-auto-synthesis-and-kg-design.md` §3
 * 单页失败不中断整批；实体名与已有页面标题匹配时绑定 page_id。
 */

import { extractJsonPayload } from "./wiki-classifier.js";
import type { WikiEroRepo, WikiEntityType } from "./wiki-ero.js";
import type { WikiRepo } from "./wiki-repo.js";
import type { WikiSource } from "./types.js";

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

/** 三期：按资料抽取的范围 */
export interface WikiEroExtractSourceScope {
  readonly category?: string;
  readonly subtopic?: string;
  readonly sourceIds?: readonly string[];
}

/** 三期：按资料抽取的结果（含游标反馈） */
export interface WikiEroExtractSourceResult {
  readonly sourcesScanned: number;
  readonly sourcesSkipped: number;
  readonly sourcesFailed: number;
  readonly entitiesUpserted: number;
  readonly observationsAdded: number;
  readonly relationsUpserted: number;
  readonly errors: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly message: string;
  }[];
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
 * 三期：构造按资料抽取的提示词。
 * 没有正文的资料（音视频）退化为标题 + 元数据 + 来源上下文，
 * 与设计 §3.5 的「不转录，靠 origin_context 兜底」一致。
 */
export function buildSourceEroExtractPrompt(source: {
  readonly title: string;
  readonly extracted_text: string | null;
  readonly media_meta: string | null;
  readonly origin_context: string | null;
  readonly media_type: string;
}, maxChars: number): string {
  const body = source.extracted_text?.trim();
  const lines = [
    "你是知识图谱抽取助手。从下面这份资料中抽取实体、关系与观察。",
    "",
    "## 资料标题",
    source.title,
    "",
    `## 资料类型`,
    source.media_type,
  ];
  if (body) {
    lines.push("", "## 资料正文", body.slice(0, maxChars));
  } else {
    // 无正文：只能靠标题、元数据与来源上下文
    lines.push("", "## 说明", "该资料没有可读正文（如音视频），请只依据下列信息抽取。");
    if (source.media_meta) lines.push("", "## 文件元数据", source.media_meta);
    if (source.origin_context) lines.push("", "## 来源上下文", source.origin_context);
  }
  lines.push(
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
  );
  return lines.join("\n");
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

  /**
   * 三期：按目录或指定 id 从资料层抽取 ERO。
   *
   * 与 extractRecent（按页面）的差别：写 source_id 而非 page_id；
   * 用 graph_extract_cursor 记 content_hash 做增量，正文未变则跳过不调 LLM；
   * 单份资料失败只记错并跳过，已成功的实体不回滚，且失败项不写游标以便下次重试。
   */
  async extractFromSources(
    agentId: string,
    userId: string,
    scope: WikiEroExtractSourceScope,
    onProgress?: (done: number, total: number) => void,
    options?: { maxCharsPerSource?: number },
  ): Promise<WikiEroExtractSourceResult> {
    const maxChars = clampEroExtractMaxChars(options?.maxCharsPerSource);
    const sources = this.resolveScope(agentId, userId, scope);

    const cursor = this.repo.getGraphExtractCursor(agentId, userId);
    const nextCursor: Record<string, string> = { ...cursor };

    /** 跨资料累积：已有实体 + 本批已 upsert，供关系/观察按名解析 */
    const entityIdByName = new Map<string, string>(
      this.ero.listEntities(agentId, userId).map((e) => [e.name, e.id]),
    );

    let sourcesScanned = 0;
    let sourcesSkipped = 0;
    let sourcesFailed = 0;
    let entitiesUpserted = 0;
    let relationsUpserted = 0;
    let observationsAdded = 0;
    const errors: { sourceId: string; title: string; message: string }[] = [];

    for (const [index, source] of sources.entries()) {
      const hash = sourceContentFingerprint(source);
      if (cursor[source.id] === hash) {
        sourcesSkipped += 1;
        onProgress?.(index + 1, sources.length);
        continue;
      }

      try {
        const response = await this.callLLM(buildSourceEroExtractPrompt(source, maxChars));
        const parsed = parseEroExtractResponse(response);
        if (!parsed) throw new Error("模型返回的内容不是合法 JSON");

        for (const ent of parsed.entities) {
          const saved = this.ero.upsertEntity({
            agentId,
            userId,
            name: ent.name,
            entityType: ent.type,
            sourceId: source.id,
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
            sourceId: source.id,
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
            sourceId: source.id,
          });
          observationsAdded += 1;
        }

        // 仅成功才进游标
        nextCursor[source.id] = hash;
        sourcesScanned += 1;
      } catch (err) {
        sourcesFailed += 1;
        errors.push({
          sourceId: source.id,
          title: source.title,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      onProgress?.(index + 1, sources.length);
    }

    this.repo.setGraphExtractCursor(agentId, userId, nextCursor);

    return {
      sourcesScanned,
      sourcesSkipped,
      sourcesFailed,
      entitiesUpserted,
      observationsAdded,
      relationsUpserted,
      errors,
    };
  }

  /** 解析抽取范围：显式 id 优先，其次按目录；两者皆空拒绝 */
  private resolveScope(
    agentId: string,
    userId: string,
    scope: WikiEroExtractSourceScope,
  ): readonly WikiSource[] {
    if (scope.sourceIds && scope.sourceIds.length > 0) {
      const found: WikiSource[] = [];
      for (const id of scope.sourceIds) {
        const source = this.repo.findSourceById(id, agentId, userId);
        if (source) found.push(source);
      }
      return found;
    }
    if (scope.category) {
      return this.repo.listSourcesByTopic(agentId, userId, {
        category: scope.category,
        subtopic: scope.subtopic,
      });
    }
    throw new Error("请先选择要抽取的目录或文件");
  }
}

/**
 * 资料内容指纹：优先用 content_hash，没有则按标题与正文长度合成。
 * 目的只是「正文变了没有」，不需要密码学强度。
 */
function sourceContentFingerprint(source: WikiSource): string {
  if (source.content_hash) return source.content_hash;
  const text = source.extracted_text ?? "";
  return `${source.title}:${text.length}:${source.media_meta ?? ""}`;
}
