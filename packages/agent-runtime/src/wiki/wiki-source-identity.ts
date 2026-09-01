/**
 * 判断两条 Wiki 记录是否指向同一份文件（收件箱队列 vs 资料层，或重复资料行）。
 * 路径在 vault 同步后会从原文件变成 .lumii-ref，故同时比哈希、URL、路径和标题。
 */

export interface WikiFileIdentity {
  readonly title?: string | null;
  readonly sourcePath?: string | null;
  readonly sourceUrl?: string | null;
  readonly originUrl?: string | null;
  readonly contentHash?: string | null;
}

/**
 * 路径分隔符归一化并去掉末尾斜杠。
 */
function normalizePath(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 取路径最后一段。
 */
function basename(value: string): string {
  const i = value.lastIndexOf("/");
  return i >= 0 ? value.slice(i + 1) : value;
}

/**
 * 去掉侧车后缀与普通文件扩展名，便于标题/文件名比对。
 */
function stripFileExt(name: string): string {
  return name.replace(/(\.url)?\.lumii-ref$/i, "").replace(/\.[a-z0-9]{1,12}$/i, "");
}

/**
 * 两条记录是否同一份文件。
 */
export function wikiRecordsShareFileIdentity(a: WikiFileIdentity, b: WikiFileIdentity): boolean {
  if (a.contentHash && b.contentHash && a.contentHash === b.contentHash) return true;

  const aUrl = (a.sourceUrl ?? a.originUrl ?? "").trim();
  const bUrl = (b.sourceUrl ?? b.originUrl ?? "").trim();
  if (aUrl && bUrl && aUrl === bUrl) return true;

  const aPath = normalizePath(a.sourcePath);
  const bPath = normalizePath(b.sourcePath);
  if (aPath && bPath) {
    if (aPath === bPath) return true;
    const aBase = stripFileExt(basename(aPath));
    const bBase = stripFileExt(basename(bPath));
    if (aBase && aBase === bBase) return true;
  }

  const aTitle = stripFileExt((a.title ?? "").trim().toLowerCase());
  const bTitle = stripFileExt((b.title ?? "").trim().toLowerCase());
  if (aTitle && aTitle === bTitle) return true;

  return false;
}
