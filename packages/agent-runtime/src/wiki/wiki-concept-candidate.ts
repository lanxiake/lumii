/**
 * 概念/实体候选——复现门槛扫描 + 候选确认/拒绝流程
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p1-implementation.md` Task 6 §8
 * 不自动建页：跨资料合并语义出错代价高。候选存储在 wiki_index_meta
 * （key 前缀 concept_candidate:），是临时态，用户处理完即清除，不建新表。
 * 落点约束在 concepts/ 或 entities/——AI_WRITABLE_CATEGORIES 不含这两类，
 * 建页只走这条确认流程，防止 organizer 越权直接写入。
 */

import { extractJsonPayload } from "./wiki-classifier.js";
import type { WikiRepo } from "./wiki-repo.js";
import type { WikiPage, WikiSource } from "./types.js";

const CANDIDATE_KEY_PREFIX = "concept_candidate:";
const THRESHOLD_META_KEY = "concept_candidate_threshold_n";
const DEFAULT_THRESHOLD_N = 3;

export type WikiConceptType = "concept" | "entity";

export interface WikiConceptCandidate {
  readonly name: string;
  readonly type: WikiConceptType;
  /** 复现证据：命中的资料 id 列表（已按资料 id 去重） */
  readonly evidenceSourceIds: readonly string[];
  readonly suggestedContentMd: string;
}

function candidateKey(name: string, type: WikiConceptType): string {
  return `${CANDIDATE_KEY_PREFIX}${type}:${name}`;
}

/** 落点分类：concept → concepts/，entity → entities/ */
function categoryPathFor(type: WikiConceptType): "concepts" | "entities" {
  return type === "concept" ? "concepts" : "entities";
}

/** 从模型回复中解析候选列表；解析失败返回空数组（扫描失败不影响主流程） */
function parseCandidateResponse(response: string): readonly { name: string; type: string; sourceIds: string[] }[] {
  const payload = extractJsonPayload(response);
  if (!Array.isArray(payload)) return [];
  const results: { name: string; type: string; sourceIds: string[] }[] = [];
  for (const raw of payload) {
    if (typeof raw !== "object" || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const type = record.type === "entity" ? "entity" : record.type === "concept" ? "concept" : "";
    const sourceIds = Array.isArray(record.sourceIds)
      ? record.sourceIds.filter((id): id is string => typeof id === "string")
      : [];
    if (name && type && sourceIds.length > 0) {
      results.push({ name, type, sourceIds });
    }
  }
  return results;
}

/** 构造扫描提示词：近期资料标题 + 摘要前 N 字 */
export function buildConceptScanPrompt(sources: readonly WikiSource[], thresholdN: number): string {
  const list = sources
    .map((s, i) => `${i + 1}. [id=${s.id}] 标题: ${s.title}\n摘要: ${(s.content_md ?? s.extracted_text ?? "").slice(0, 300)}`)
    .join("\n\n");

  return [
    "你是知识提炼助手。分析下面这批资料，找出在多份不同资料中复现的概念或实体。",
    "",
    `## 复现门槛：同一概念/实体必须在至少 ${thresholdN} 份不同资料中出现才算候选`,
    "",
    "## 待分析资料",
    list,
    "",
    "## 输出格式",
    '返回 JSON 数组，每条: {"name": "概念名", "type": "concept"|"entity", "sourceIds": ["资料id1", "资料id2", ...]}',
    "sourceIds 必须是上面列出的 [id=...] 中的原值。达不到复现门槛的不要输出。",
    "仅输出 JSON，不要包含其他文字。",
  ].join("\n");
}

export class WikiConceptCandidateScanner {
  constructor(private readonly repo: WikiRepo) {}

  getThresholdN(agentId: string, userId: string): number {
    const raw = this.repo.getIndexMeta(`${THRESHOLD_META_KEY}:${agentId}:${userId}`);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD_N;
  }

  setThresholdN(agentId: string, userId: string, n: number): void {
    this.repo.setIndexMeta(`${THRESHOLD_META_KEY}:${agentId}:${userId}`, String(n));
  }

  /**
   * 扫描并写入候选（不落正式页）。复现计数按资料 id 去重——同一资料被模型重复列出
   * 只算一次证据。未达复现门槛的候选被丢弃，不写入。
   * 扫描失败（LLM 异常）时不抛错，返回空数组——扫描是辅助功能，不能拖垮整理主流程。
   */
  async scan(
    agentId: string,
    userId: string,
    sources: readonly WikiSource[],
    callLLM: (prompt: string) => Promise<string>,
  ): Promise<readonly WikiConceptCandidate[]> {
    if (sources.length === 0) return [];
    const thresholdN = this.getThresholdN(agentId, userId);

    let response: string;
    try {
      response = await callLLM(buildConceptScanPrompt(sources, thresholdN));
    } catch {
      return [];
    }

    const byId = new Map(sources.map((s) => [s.id, s]));
    const parsed = parseCandidateResponse(response);

    const candidates: WikiConceptCandidate[] = [];
    for (const item of parsed) {
      const uniqueSourceIds = [...new Set(item.sourceIds.filter((id) => byId.has(id)))];
      if (uniqueSourceIds.length < thresholdN) continue;

      const type = item.type as WikiConceptType;
      const evidence = uniqueSourceIds.map((id) => byId.get(id)!);
      const suggestedContentMd = [
        `## ${item.name}`,
        "",
        "复现证据：",
        ...evidence.map((s) => `- ${s.title}`),
      ].join("\n");

      const candidate: WikiConceptCandidate = {
        name: item.name,
        type,
        evidenceSourceIds: uniqueSourceIds,
        suggestedContentMd,
      };
      candidates.push(candidate);
      this.repo.setIndexMeta(candidateKey(item.name, type), JSON.stringify(candidate));
    }
    return candidates;
  }

  /** 列出当前所有未处理的候选 */
  listCandidates(): readonly WikiConceptCandidate[] {
    return this.repo
      .listIndexMetaByPrefix(CANDIDATE_KEY_PREFIX)
      .map((row) => {
        try {
          return JSON.parse(row.value) as WikiConceptCandidate;
        } catch {
          return null;
        }
      })
      .filter((c): c is WikiConceptCandidate => c !== null);
  }

  /**
   * 确认候选：走 WikiRepo.savePage() 建页（editor='ai'，落 concepts/ 或 entities/），
   * 相关资料摘要页自动追加反链（编辑摘要页正文追加 [[概念名]]，走正常保存路径）。
   * 确认后从候选存储中清除。
   */
  confirm(agentId: string, userId: string, name: string, type: WikiConceptType): WikiPage {
    const key = candidateKey(name, type);
    const raw = this.repo.getIndexMeta(key);
    if (!raw) {
      throw new Error(`候选不存在: ${type}:${name}`);
    }
    const candidate = JSON.parse(raw) as WikiConceptCandidate;

    const category = categoryPathFor(type);
    const path = `${category}/${name}`;
    const page = this.repo.savePage({
      agentId,
      userId,
      path,
      title: name,
      contentMd: candidate.suggestedContentMd,
      editor: "ai",
    });

    for (const sourceId of candidate.evidenceSourceIds) {
      this.linkEvidencePageToConcept(agentId, userId, sourceId, name);
    }

    this.repo.deleteIndexMeta(key);
    return page;
  }

  /** 拒绝候选：从候选存储中清除，不产生任何写入 */
  reject(name: string, type: WikiConceptType): void {
    this.repo.deleteIndexMeta(candidateKey(name, type));
  }

  /**
   * 找到该资料对应的摘要页（通过 wiki_page_revisions.source_ref = sourceId），
   * 在其正文追加 [[概念名]] 并重新保存——走正常保存路径触发链接解析。
   * 找不到对应页面时静默跳过（资料没有对应页面是正常情况，不应报错中断整批确认）。
   */
  private linkEvidencePageToConcept(agentId: string, userId: string, sourceId: string, conceptName: string): void {
    const page = this.repo.findPageBySourceRef(agentId, userId, sourceId);
    if (!page) return;
    if (page.content_md.includes(`[[${conceptName}]]`)) return;
    this.repo.savePage({
      agentId,
      userId,
      path: page.path,
      title: page.title,
      contentMd: `${page.content_md}\n\n[[${conceptName}]]`,
      editor: "ai",
    });
  }
}
