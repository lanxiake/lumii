/**
 * 初始化 workspace/wiki/ 目录树。
 */
import type { WikiTopicTree } from "./wiki-topic-tree.js";
import { DEFAULT_TOPIC_TREE } from "./wiki-topic-tree.js";
import {
  WIKI_ARCHIVED_DIR,
  WIKI_INBOX_DIR,
  WIKI_META_DIR,
  WIKI_PARKING_DIR,
} from "./wiki-nav-map.js";
import { sanitizeFilenameSegment } from "./wiki-exporter.js";

export interface WikiVaultLayoutFs {
  readonly mkdir: (dirPath: string) => void;
  readonly writeFile: (filePath: string, content: string) => void;
  readonly exists: (filePath: string) => boolean;
  readonly joinPath: (...segments: string[]) => string;
}

export const WIKI_VAULT_LAYOUT_ID = "ref-first-v2-20260901";

export interface WikiVaultLayoutResult {
  readonly vaultRoot: string;
  readonly createdDirs: readonly string[];
  readonly metaPath: string;
}

/**
 * 确保 wiki 根目录及一级/小类子目录存在，并写入 wiki-meta.json。
 */
export function ensureWikiVaultLayout(
  vaultRoot: string,
  fs: WikiVaultLayoutFs,
  topicTree: WikiTopicTree = DEFAULT_TOPIC_TREE,
): WikiVaultLayoutResult {
  const createdDirs: string[] = [];

  const ensureDir = (abs: string): void => {
    if (!fs.exists(abs)) {
      fs.mkdir(abs);
      createdDirs.push(abs);
    }
  };

  ensureDir(vaultRoot);

  // 系统分区：收件箱 / 归档 / 临时存放。都不是树节点，目录名固定。
  ensureDir(fs.joinPath(vaultRoot, WIKI_INBOX_DIR));
  ensureDir(fs.joinPath(vaultRoot, WIKI_ARCHIVED_DIR));
  ensureDir(fs.joinPath(vaultRoot, WIKI_PARKING_DIR));

  // v1.1：直接按树生成「大类/小类」两级目录，不带序号前缀。
  // 用户自建大类同样按名建目录，无需额外映射。
  for (const cat of topicTree.categories) {
    const categoryDir = fs.joinPath(vaultRoot, sanitizeFilenameSegment(cat.name));
    ensureDir(categoryDir);
    for (const sub of cat.subtopics) {
      ensureDir(fs.joinPath(categoryDir, sanitizeFilenameSegment(sub)));
    }
  }

  const metaDir = fs.joinPath(vaultRoot, WIKI_META_DIR);
  ensureDir(metaDir);
  const metaPath = fs.joinPath(metaDir, "wiki-meta.json");
  if (!fs.exists(metaPath)) {
    const meta = {
      version: 2,
      layout: "ref-first",
      layoutId: WIKI_VAULT_LAYOUT_ID,
      // 目录即分类：大类/小类直接对应目录名，不再有 nav 分区与旧大类的映射表
      categories: topicTree.categories.map((c) => ({ name: c.name, subtopics: [...c.subtopics] })),
      systemDirs: {
        inbox: WIKI_INBOX_DIR,
        archived: WIKI_ARCHIVED_DIR,
        parking: WIKI_PARKING_DIR,
      },
      initializedAt: new Date().toISOString(),
    };
    fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }

  return { vaultRoot, createdDirs, metaPath };
}
