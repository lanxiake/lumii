/**
 * 用户主动触发：抓取 URL 并落盘为 Markdown。
 */
import { sanitizeFilenameSegment } from "./wiki-exporter.js";
import { DEFAULT_TIMEOUT_SECONDS, validateUrl, withTimeout } from "../tools/built-in/web-shared.js";
import { htmlToMarkdown } from "../tools/built-in/web-fetch-tool.js";

export interface WikiClipSaverDeps {
  readonly fetchImpl?: typeof fetch;
  readonly writeFile: (relPath: string, content: string) => Promise<string> | string;
  readonly timeoutSeconds?: number;
}

export interface WikiClipResult {
  readonly title: string;
  readonly markdown: string;
  readonly savedPath: string;
}

/**
 * 抓取网页并保存为 Markdown 文件。
 */
export class WikiClipSaver {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutSeconds: number;

  constructor(private readonly deps: WikiClipSaverDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutSeconds = deps.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  }

  /**
   * 抓取 URL，转 Markdown 并落盘；失败抛中文错误。
   */
  async save(url: string, fallbackTitle: string): Promise<WikiClipResult> {
    const parsed = validateUrl(url);
    if (!parsed.protocol.startsWith("http")) {
      throw new Error("仅支持 http/https 链接");
    }

    const { signal, cleanup } = withTimeout(this.timeoutSeconds * 1000);
    try {
      const response = await this.fetchImpl(parsed.toString(), {
        signal,
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      if (!response.ok) {
        throw new Error(`抓取失败：HTTP ${response.status}`);
      }
      const html = await response.text();
      const { text: markdown, title } = htmlToMarkdown(html);
      const finalTitle = title?.trim() || fallbackTitle.trim() || parsed.hostname;
      const slug = sanitizeFilenameSegment(finalTitle).slice(0, 80) || "web-clip";
      const relPath = `wiki-clips/${slug}.md`;
      const body = `# ${finalTitle}\n\n> 来源：${url}\n\n${markdown}`;
      const savedPath = await this.deps.writeFile(relPath, body);
      return { title: finalTitle, markdown: body, savedPath };
    } finally {
      cleanup();
    }
  }
}
