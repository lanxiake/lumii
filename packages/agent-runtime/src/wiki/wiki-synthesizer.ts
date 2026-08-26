/**
 * WikiSynthesizer — 用户显式触发的综述合成（分块归纳 + 落盘 + 候选审阅）
 *
 * 设计：`docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md` Task 1
 * Agent / organizer 均不自动调用。合成结果先落 candidate，用户接受后才建 syntheses/ 页。
 * 文件系统经 deps 注入，agent-runtime 不直接依赖 node:fs。
 */

import { sanitizeFilenameSegment } from "./wiki-exporter.js";
import type { WikiRepo } from "./wiki-repo.js";
import type { WikiPage } from "./types.js";

/** 单块输入上限（字/字符），给提示词留余量 */
export const SYNTHESIS_CHUNK_SIZE = 4000;

/** 最终综述正文上限 */
export const SYNTHESIS_MAX_OUTPUT_CHARS = 5000;

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

    const dateStr = new Date().toISOString().slice(0, 10);
    const shortId = synthesisId.slice(0, 8);
    const dirRel = this.fs.joinPath(outputRoot, dateStr);
    await this.fs.mkdir(dirRel);

    const existing = new Set(
      this.fs.listDir ? await this.fs.listDir(dirRel) : [],
    );
    const filename = resolveUniqueFilename(buildSynthesisFilename(title, shortId), existing);
    const fileRel = this.fs.joinPath(dirRel, filename).replace(/\\/g, "/");

    const fileBody = [
      `# ${title}`,
      "",
      finalText,
      "",
      "## 来源页面",
      ...pages.map((p) => `- ${p.title} (\`${p.path}\`)`),
    ].join("\n");
    await this.fs.writeFile(fileRel, fileBody);

    this.repo.finishSynthesisCandidate(synthesisId, {
      candidateMd: finalText,
      outputPath: fileRel,
      error: truncated ? "truncated" : null,
    });
  }
}
