/**
 * WikiSynthesizer — 用户显式触发的综述合成（分块归纳 + 落盘 + 候选审阅）
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md` Task 1
 * Agent / organizer 均不自动调用。合成结果先落 candidate，用户接受后才建 syntheses/ 页。
 * 文件系统经 deps 注入，agent-runtime 不直接依赖 node:fs。
 */

import { sanitizeFilenameSegment } from "./wiki-exporter.js";
import { validateTopicAssignment } from "./wiki-topic-tree.js";
import type { WikiRepo } from "./wiki-repo.js";
import type { WikiPage, WikiSource } from "./types.js";

/** 单块输入上限（字/字符），给提示词留余量 */
export const SYNTHESIS_CHUNK_SIZE = 4000;

/** 最终综述正文上限 */
export const SYNTHESIS_MAX_OUTPUT_CHARS = 5000;

/** 整合模式目标篇幅下限（字） */
export const SYNTHESIS_MIN_CONSOLIDATE_CHARS = 1000;

/** 合成模式：综述归纳 vs 短文整合 */
export type WikiSynthesizeMode = "synthesis" | "consolidate";

/** 整合类合成标题前缀，供 UI 识别 */
export const WIKI_CONSOLIDATE_TITLE_PREFIX = "[整合] ";

/** 整合长文统一归档小类名（各大类下共用） */
export const WIKI_CONSOLIDATE_SUBTOPIC = "整合长文";

/** 单次合成块数上限，超出提示分批 */
export const SYNTHESIS_MAX_CHUNKS = 20;

export interface WikiSynthesizerFsDeps {
  readonly mkdir: (dirPath: string) => Promise<void>;
  readonly writeFile: (filePath: string, content: string) => Promise<void>;
  readonly joinPath: (...segments: string[]) => string;
  /** 列出目录文件名（不含路径）；目录不存在时返回空数组 */
  readonly listDir?: (dirPath: string) => Promise<readonly string[]>;
}

export interface WikiSynthesizeOptions {
  /** 综述标题；缺省时用首个源页标题 +「综述」 */
  readonly title?: string;
  /** 落盘相对 workspace 的根段，默认 outputs/wiki-syntheses */
  readonly outputRoot?: string;
  /** consolidate = 合并同主题短文为一篇 1000 字以上长文 */
  readonly mode?: WikiSynthesizeMode;
}

/** 直接成页选项：固定 wiki 路径，跳过用户 accept 手势 */
export interface WikiSynthesizeDirectOptions extends WikiSynthesizeOptions {
  /** 目标 wiki 页面路径，如 syntheses/overview-sources */
  readonly path: string;
}

/**
 * 按段落边界分块：优先在 `\n\n` 处断开；单段超限时再硬切。
 * 空输入返回空数组。
 */
export function chunkByParagraphs(text: string, maxChars = SYNTHESIS_CHUNK_SIZE): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const paragraphs = trimmed.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      flush();
      for (let i = 0; i < para.length; i += maxChars) {
        chunks.push(para.slice(i, i + maxChars));
      }
      continue;
    }
    const next = current ? `${current}\n\n${para}` : para;
    if (next.length > maxChars) {
      flush();
      current = para;
    } else {
      current = next;
    }
  }
  flush();
  return chunks;
}

/** 超限截断到 maxChars，并标记 truncated */
export function truncateSynthesis(
  text: string,
  maxChars = SYNTHESIS_MAX_OUTPUT_CHARS,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/**
 * 生成落盘文件名：短 id 前缀 + 清洗标题，扩展名 .md。
 * 冲突时由 resolveUniqueFilename 追加序号。
 */
export function buildSynthesisFilename(title: string, shortId: string): string {
  const cleaned = sanitizeFilenameSegment(title).slice(0, 80);
  return `${shortId}-${cleaned || "synthesis"}.md`;
}

/** 文件名冲突时追加 -2、-3…，不覆盖 */
export function resolveUniqueFilename(baseName: string, existing: ReadonlySet<string>): string {
  if (!existing.has(baseName)) return baseName;
  const match = /^(.*)(\.[^.]+)$/.exec(baseName);
  const stem = match?.[1] ?? baseName;
  const ext = match?.[2] ?? "";
  let i = 2;
  while (existing.has(`${stem}-${i}${ext}`)) i += 1;
  return `${stem}-${i}${ext}`;
}

/** 接受后写入 syntheses/ 页面的正文：标题 → 归纳 + 源文件链接 → 来源双链 */
export function buildAcceptedSynthesisPageMd(params: {
  readonly title: string;
  readonly sourceCount: number;
  readonly outputRelPath: string;
  readonly bodyMd: string;
  readonly sourcePages: readonly { readonly title: string }[];
}): string {
  const sourceLinks = params.sourcePages.map((p) => `- [[${p.title}]]`).join("\n");
  return [
    `# ${params.title}`,
    `> 本文由 AI 依据 ${params.sourceCount} 份资料合成，源文件：[查看完整文档](${params.outputRelPath})`,
    "",
    params.bodyMd.trim(),
    "",
    "## 来源",
    sourceLinks || "- （无）",
    "",
    "> 引用保真依赖来源清单与人工抽查；P2 不做自动引用校验。",
  ].join("\n");
}

/** 解析进行中进度标记 `progress:i/n` */
export function parseSynthesisProgress(
  error: string | null,
): { readonly chunk: number; readonly total: number } | null {
  if (!error) return null;
  const m = /^progress:(\d+)\/(\d+)$/.exec(error);
  if (!m) return null;
  return { chunk: Number(m[1]), total: Number(m[2]) };
}

function buildChunkSummaryPrompt(chunkIndex: number, total: number, chunk: string): string {
  return [
    "你是知识综述助手。请归纳下面这段资料，保留关键事实、数字、日期与专有名词，不要编造来源中没有的信息。",
    `这是第 ${chunkIndex}/${total} 块。`,
    "",
    "## 资料片段",
    chunk,
    "",
    "输出简洁中文归纳，不要标题以外的客套话。",
  ].join("\n");
}

function buildFinalSynthesisPrompt(title: string, summaries: readonly string[]): string {
  return [
    "你是知识综述助手。请将下列分块归纳合并为一篇连贯的中文综述。",
    `标题意向：${title}`,
    "",
    "要求：",
    `- 全文不超过 ${SYNTHESIS_MAX_OUTPUT_CHARS} 字`,
    "- 数字、日期、引述必须来自下方归纳，不得编造",
    "- 使用 Markdown；可含小标题，不要输出「作为 AI」类元叙述",
    "",
    "## 分块归纳",
    ...summaries.map((s, i) => `### 块 ${i + 1}\n${s}`),
  ].join("\n");
}

/**
 * 整合模式：合并多篇短资料为一篇结构清晰的长文，减少目录碎片化。
 */
function buildConsolidateChunkPrompt(chunkIndex: number, total: number, chunk: string): string {
  return [
    "你是资料整理助手。下面是一组同主题、偏短的网页摘录或笔记片段。",
    "请提取关键信息（定义、用法、例句、出处要点），去掉重复表述，保留可核对的事实。",
    `这是第 ${chunkIndex}/${total} 块。`,
    "",
    "## 资料片段",
    chunk,
    "",
    "输出简洁中文要点，不要客套话。",
  ].join("\n");
}

/** 整合模式终稿：要求合并为不少于 SYNTHESIS_MIN_CONSOLIDATE_CHARS 字的长文 */
function buildConsolidateFinalPrompt(title: string, summaries: readonly string[]): string {
  return [
    "你是资料整理助手。请将下列要点合并为一篇连贯的中文长文，用于替代多篇碎片化短资料。",
    `标题：${title}`,
    "",
    "要求：",
    `- 正文不少于 ${SYNTHESIS_MIN_CONSOLIDATE_CHARS} 汉字，不超过 ${SYNTHESIS_MAX_OUTPUT_CHARS} 字`,
    "- 按主题组织（如：读音、释义、用法、例句、辨析），去除重复",
    "- 只使用下方要点中的信息，不得编造",
    "- 使用 Markdown 与小标题；文末加「## 参考来源」列出合并了哪些原始标题",
    "- 不要输出「作为 AI」类元叙述",
    "",
    "## 分块要点",
    ...summaries.map((s, i) => `### 块 ${i + 1}\n${s}`),
  ].join("\n");
}

/** 根据模式选择分块/终稿提示词 */
function buildChunkPrompt(
  mode: WikiSynthesizeMode,
  chunkIndex: number,
  total: number,
  chunk: string,
): string {
  return mode === "consolidate"
    ? buildConsolidateChunkPrompt(chunkIndex, total, chunk)
    : buildChunkSummaryPrompt(chunkIndex, total, chunk);
}

function buildFinalPrompt(
  mode: WikiSynthesizeMode,
  title: string,
  summaries: readonly string[],
): string {
  return mode === "consolidate"
    ? buildConsolidateFinalPrompt(title, summaries)
    : buildFinalSynthesisPrompt(title, summaries);
}

/** 整合模式标题加前缀，便于 UI 与接受后归档原短文 */
function withConsolidateTitlePrefix(title: string): string {
  return title.startsWith(WIKI_CONSOLIDATE_TITLE_PREFIX)
    ? title
    : `${WIKI_CONSOLIDATE_TITLE_PREFIX}${title}`;
}

export class WikiSynthesizer {
  constructor(
    private readonly repo: WikiRepo,
    private readonly callLLM: (prompt: string) => Promise<string>,
    private readonly fs: WikiSynthesizerFsDeps,
  ) {}

  /**
   * 发起合成：读入 → 分块 → 串行归纳 → 生成终稿 → 落盘 → 写入 candidate。
   * 返回 synthesisId。空输入或超块数上限抛错，不写半成品页面。
   */
  async synthesize(
    agentId: string,
    userId: string,
    pageIds: readonly string[],
    options: WikiSynthesizeOptions = {},
  ): Promise<string> {
    if (pageIds.length === 0) {
      throw new Error("合成至少需要一个页面 id");
    }

    const pages: WikiPage[] = [];
    for (const id of pageIds) {
      const page = this.repo.findPageById(id);
      if (!page || page.agent_id !== agentId || page.user_id !== userId) {
        throw new Error(`页面不存在或无权访问: ${id}`);
      }
      pages.push(page);
    }

    const title = options.title?.trim() || `${pages[0]!.title} 综述`;
    const sourceIds = this.collectSourceIds(agentId, userId, pages);
    const synthesisId = this.repo.insertSynthesis({
      agentId,
      userId,
      sourcePageIds: pageIds,
      sourceIds,
      title,
      candidateMd: "（生成中…）",
      error: "progress:0/0",
    });

    try {
      await this.runPipeline(synthesisId, pages, title, options.outputRoot ?? "outputs/wiki-syntheses");
      return synthesisId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.repo.finishSynthesisCandidate(synthesisId, {
        candidateMd: "",
        outputPath: null,
        error: message,
      });
      throw err;
    }
  }

  /**
   * 二期主路径：以**资料**为输入合成。语料取 extracted_text，无正文的媒体退化为
   * 标题 + media_meta（不做转录，见设计 §19）。落盘后写 candidate，
   * 由 acceptAsSource 接受成目录里的普通文件。
   */
  async synthesizeSources(
    agentId: string,
    userId: string,
    sourceIds: readonly string[],
    options: WikiSynthesizeOptions = {},
  ): Promise<string> {
    if (sourceIds.length === 0) {
      throw new Error("合成至少需要一个资料 id");
    }

    const sources: WikiSource[] = [];
    for (const id of sourceIds) {
      const source = this.repo.findSourceById(id);
      if (!source || source.agent_id !== agentId || source.user_id !== userId) {
        throw new Error(`资料不存在或无权访问: ${id}`);
      }
      sources.push(source);
    }

    const mode = options.mode ?? "synthesis";
    const baseTitle = options.title?.trim() || `${sources[0]!.title} 综述`;
    const title =
      mode === "consolidate" ? withConsolidateTitlePrefix(baseTitle) : baseTitle;
    const synthesisId = this.repo.insertSynthesis({
      agentId,
      userId,
      sourcePageIds: [],
      sourceIds: [...sourceIds],
      title,
      candidateMd: "（生成中…）",
      error: "progress:0/0",
    });

    try {
      await this.runSourcePipeline(
        synthesisId,
        sources,
        title,
        options.outputRoot ?? "outputs/wiki-syntheses",
        mode,
      );
      return synthesisId;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.repo.finishSynthesisCandidate(synthesisId, {
        candidateMd: "",
        outputPath: null,
        error: message,
      });
      throw err;
    }
  }

  /**
   * 二期语义的接受：产物成为目录里的一份普通资料，不写 wiki_pages。
   * 落盘已在 synthesizeSources 完成，这里只入库 + 写主题两列。
   */
  acceptAsSource(
    agentId: string,
    userId: string,
    synthesisId: string,
    topic: { readonly category: string; readonly subtopic: string },
    options: { readonly archiveSources?: boolean } = {},
  ): WikiSource {
    const row = this.repo.findSynthesisById(synthesisId);
    if (!row || row.agent_id !== agentId || row.user_id !== userId) {
      throw new Error(`合成记录不存在: ${synthesisId}`);
    }
    if (row.status !== "candidate") {
      throw new Error(`只能接受 candidate 状态的合成，当前为 ${row.status}`);
    }
    if (!row.candidate_md.trim() || row.candidate_md === "（生成中…）") {
      throw new Error("合成尚未完成，无法接受");
    }
    if (!row.output_path) {
      throw new Error("缺少落盘路径，无法接受");
    }
    // 综述是 AI 产物，必须落正式目录：不开 allowParking
    const check = validateTopicAssignment(
      this.repo.getOrCreateTopicTree(),
      topic.category,
      topic.subtopic,
    );
    if (!check.ok) throw new Error(check.reason);

    this.ensureSubtopicExists(topic.category, topic.subtopic);

    const source = this.repo.acceptSynthesisAsSource({
      synthesisId,
      agentId,
      userId,
      title: row.title.replace(WIKI_CONSOLIDATE_TITLE_PREFIX, ""),
      outputPath: row.output_path,
      contentMd: row.candidate_md,
      category: topic.category,
      subtopic: topic.subtopic,
    });

    if (options.archiveSources && row.source_ids.length > 0) {
      this.repo.archiveSources(agentId, userId, row.source_ids);
    }
    return source;
  }

  /** 接受候选：同一事务建 syntheses/ 页并更新 status=accepted */
  accept(agentId: string, userId: string, synthesisId: string): WikiPage {
    const row = this.repo.findSynthesisById(synthesisId);
    if (!row || row.agent_id !== agentId || row.user_id !== userId) {
      throw new Error(`合成记录不存在: ${synthesisId}`);
    }
    if (row.status !== "candidate") {
      throw new Error(`只能接受 candidate 状态的合成，当前为 ${row.status}`);
    }
    if (!row.candidate_md.trim() || row.candidate_md === "（生成中…）") {
      throw new Error("合成尚未完成，无法接受");
    }
    if (!row.output_path) {
      throw new Error("缺少落盘路径，无法接受");
    }

    const sourcePages = row.source_page_ids
      .map((id) => this.repo.findPageById(id))
      .filter((p): p is WikiPage => p !== null);

    const path = `syntheses/${sanitizeFilenameSegment(row.title)}`;
    const contentMd = buildAcceptedSynthesisPageMd({
      title: row.title,
      sourceCount: row.source_page_ids.length,
      outputRelPath: row.output_path,
      bodyMd: row.candidate_md,
      sourcePages,
    });

    return this.repo.acceptSynthesis({
      synthesisId,
      agentId,
      userId,
      path,
      title: row.title,
      contentMd,
    });
  }

  /**
   * 自动成页：合成后直接写入指定 path（不经 accept 手势）。
   * 仍写 wiki_syntheses 记录便于审计，完成后 status=accepted。
   */
  async synthesizeDirectToPath(
    agentId: string,
    userId: string,
    pageIds: readonly string[],
    options: WikiSynthesizeDirectOptions,
  ): Promise<WikiPage> {
    if (pageIds.length === 0) {
      throw new Error("合成至少需要一个页面 id");
    }

    const pages: WikiPage[] = [];
    for (const id of pageIds) {
      const page = this.repo.findPageById(id);
      if (!page || page.agent_id !== agentId || page.user_id !== userId) {
        throw new Error(`页面不存在或无权访问: ${id}`);
      }
      pages.push(page);
    }

    const title = options.title?.trim() || `${pages[0]!.title} 综述`;
    const sourceIds = this.collectSourceIds(agentId, userId, pages);
    const synthesisId = this.repo.insertSynthesis({
      agentId,
      userId,
      sourcePageIds: pageIds,
      sourceIds,
      title,
      candidateMd: "（生成中…）",
      error: "progress:0/0",
    });

    try {
      await this.runPipeline(synthesisId, pages, title, options.outputRoot ?? "outputs/wiki-syntheses");
      const row = this.repo.findSynthesisById(synthesisId);
      if (!row || !row.output_path) {
        throw new Error("合成未完成，缺少落盘路径");
      }
      const sourcePages = row.source_page_ids
        .map((id) => this.repo.findPageById(id))
        .filter((p): p is WikiPage => p !== null);
      const contentMd = buildAcceptedSynthesisPageMd({
        title: row.title,
        sourceCount: row.source_page_ids.length,
        outputRelPath: row.output_path,
        bodyMd: row.candidate_md,
        sourcePages,
      });
      return this.repo.acceptSynthesis({
        synthesisId,
        agentId,
        userId,
        path: options.path,
        title: row.title,
        contentMd,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.repo.finishSynthesisCandidate(synthesisId, {
        candidateMd: "",
        outputPath: null,
        error: message,
      });
      throw err;
    }
  }

  /** 拒绝候选：保留记录，不建页 */
  reject(agentId: string, userId: string, synthesisId: string): void {
    const row = this.repo.findSynthesisById(synthesisId);
    if (!row || row.agent_id !== agentId || row.user_id !== userId) {
      throw new Error(`合成记录不存在: ${synthesisId}`);
    }
    if (row.status !== "candidate") {
      throw new Error(`只能拒绝 candidate 状态的合成，当前为 ${row.status}`);
    }
    this.repo.rejectSynthesis(synthesisId);
  }

  /** 接受时若小类尚未在主题树中，自动追加（整合长文等统一目录） */
  private ensureSubtopicExists(category: string, subtopic: string): void {
    const tree = this.repo.getOrCreateTopicTree();
    const cat = tree.categories.find((c) => c.name === category);
    if (!cat) {
      throw new Error(`大类不存在：${category}`);
    }
    if (cat.subtopics.includes(subtopic)) return;
    this.repo.applyTopicMutation({ op: "addSubtopic", category, name: subtopic });
  }

  /** 收集页面修订 source_ref 指向的资料 id（去重） */
  private collectSourceIds(agentId: string, userId: string, pages: readonly WikiPage[]): string[] {
    const ids = new Set<string>();
    for (const page of pages) {
      const revs = this.repo.listRevisions(page.id);
      for (const rev of revs) {
        if (rev.source_ref && !rev.source_ref.startsWith("rollback:")) {
          ids.add(rev.source_ref);
        }
      }
      // 回退：用 path 找对应资料页的 source（若有 findPageBySourceRef 反向，此处用修订足够）
      void agentId;
      void userId;
    }
    return [...ids];
  }

  /**
   * 资料版流水线：与页面版同构，只把「读 pages → content_md」换成
   * 「读 sources → extracted_text ?? 标题 + media_meta」，来源段列文件名而非双链。
   */
  private async runSourcePipeline(
    synthesisId: string,
    sources: readonly WikiSource[],
    title: string,
    outputRoot: string,
    mode: WikiSynthesizeMode = "synthesis",
  ): Promise<void> {
    const inputs = sources.map((s) => {
      const body = (s.extracted_text ?? "").trim();
      if (body) return `## ${s.title}\n\n${body}`;
      // 无正文的媒体：至少让模型知道这份材料存在，不凭空编内容
      const meta = s.media_meta ? `\n\n元信息：${s.media_meta}` : "";
      return `## ${s.title}\n\n（无可提取正文，类型 ${s.media_type ?? "unknown"}）${meta}`;
    });
    const chunks = chunkByParagraphs(inputs.join("\n\n"), SYNTHESIS_CHUNK_SIZE);
    if (chunks.length === 0) {
      throw new Error("源资料正文为空，无法合成");
    }
    if (chunks.length > SYNTHESIS_MAX_CHUNKS) {
      throw new Error(
        `输入过大（${chunks.length} 块，上限 ${SYNTHESIS_MAX_CHUNKS}），请减少资料或分批合成`,
      );
    }

    const summaries: string[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      this.repo.setSynthesisProgress(synthesisId, i + 1, chunks.length);
      const summary = await this.callLLM(buildChunkPrompt(mode, i + 1, chunks.length, chunks[i]!));
      summaries.push(summary.trim());
    }

    this.repo.setSynthesisProgress(synthesisId, chunks.length, chunks.length);
    const displayTitle = title.replace(WIKI_CONSOLIDATE_TITLE_PREFIX, "");
    const rawFinal = (await this.callLLM(buildFinalPrompt(mode, displayTitle, summaries))).trim();
    const { text: finalText, truncated } = truncateSynthesis(rawFinal);

    const fileRel = await this.writeSynthesisFile(synthesisId, displayTitle, outputRoot, [
      `# ${displayTitle}`,
      "",
      finalText,
      "",
      mode === "consolidate" ? "## 参考来源" : "## 来源文件",
      ...sources.map((s) => `- ${s.title}`),
    ]);

    this.repo.finishSynthesisCandidate(synthesisId, {
      candidateMd: finalText,
      outputPath: fileRel,
      error: truncated ? "truncated" : null,
    });
  }

  /** 落盘到 outputRoot/YYYY-MM-DD/<shortId>-<title>.md，重名追加序号 */
  private async writeSynthesisFile(
    synthesisId: string,
    title: string,
    outputRoot: string,
    bodyLines: readonly string[],
  ): Promise<string> {
    const dirRel = this.fs.joinPath(outputRoot, new Date().toISOString().slice(0, 10));
    await this.fs.mkdir(dirRel);
    const existing = new Set(this.fs.listDir ? await this.fs.listDir(dirRel) : []);
    const filename = resolveUniqueFilename(
      buildSynthesisFilename(title, synthesisId.slice(0, 8)),
      existing,
    );
    const fileRel = this.fs.joinPath(dirRel, filename).replace(/\\/g, "/");
    await this.fs.writeFile(fileRel, bodyLines.join("\n"));
    return fileRel;
  }

  private async runPipeline(
    synthesisId: string,
    pages: readonly WikiPage[],
    title: string,
    outputRoot: string,
  ): Promise<void> {
    const inputs = pages.map((p) => {
      const body = p.content_md.trim();
      return `## ${p.title}\n\n${body || "（空正文）"}`;
    });
    const combined = inputs.join("\n\n");
    const chunks = chunkByParagraphs(combined, SYNTHESIS_CHUNK_SIZE);
    if (chunks.length === 0) {
      throw new Error("源页面正文为空，无法合成");
    }
    if (chunks.length > SYNTHESIS_MAX_CHUNKS) {
      throw new Error(
        `输入过大（${chunks.length} 块，上限 ${SYNTHESIS_MAX_CHUNKS}），请减少页面或分批合成`,
      );
    }

    const summaries: string[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      this.repo.setSynthesisProgress(synthesisId, i + 1, chunks.length);
      const summary = await this.callLLM(buildChunkSummaryPrompt(i + 1, chunks.length, chunks[i]!));
      summaries.push(summary.trim());
    }

    this.repo.setSynthesisProgress(synthesisId, chunks.length, chunks.length);
    const rawFinal = (await this.callLLM(buildFinalSynthesisPrompt(title, summaries))).trim();
    const { text: finalText, truncated } = truncateSynthesis(rawFinal);

    const fileRel = await this.writeSynthesisFile(synthesisId, title, outputRoot, [
      `# ${title}`,
      "",
      finalText,
      "",
      "## 来源页面",
      ...pages.map((p) => `- ${p.title} (\`${p.path}\`)`),
    ]);

    this.repo.finishSynthesisCandidate(synthesisId, {
      candidateMd: finalText,
      outputPath: fileRel,
      error: truncated ? "truncated" : null,
    });
  }
}
