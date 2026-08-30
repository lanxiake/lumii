/**
 * 初始化 workspace/wiki/ 目录树。
 */
import type { WikiTopicTree } from "./wiki-topic-tree.js";
import { DEFAULT_TOPIC_TREE } from "./wiki-topic-tree.js";
import {
  WIKI_META_DIR,
  WIKI_NAV_SECTIONS,
  WIKI_PARKING_DIR,
  folderSlugForNavId,
  navIdFromLegacyCategory,
} from "./wiki-nav-map.js";
import { sanitizeFilenameSegment } from "./wiki-exporter.js";

export interface WikiVaultLayoutFs {
  readonly mkdir: (dirPath: string) => void;
  readonly writeFile: (filePath: string, content: string) => void;
  readonly exists: (filePath: string) => boolean;
  readonly joinPath: (...segments: string[]) => string;
}

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

  for (const sec of WIKI_NAV_SECTIONS) {
    const sectionDir = fs.joinPath(vaultRoot, sec.folderSlug);
    ensureDir(sectionDir);
  }

  ensureDir(fs.joinPath(vaultRoot, WIKI_PARKING_DIR));

  for (const cat of topicTree.categories) {
    const navId = navIdFromLegacyCategory(cat.name);
    const sectionDir = fs.joinPath(vaultRoot, folderSlugForNavId(navId));
    ensureDir(sectionDir);
    for (const sub of cat.subtopics) {
      ensureDir(fs.joinPath(sectionDir, sanitizeFilenameSegment(sub)));
    }
  }

  const metaDir = fs.joinPath(vaultRoot, WIKI_META_DIR);
  ensureDir(metaDir);
  const metaPath = fs.joinPath(metaDir, "wiki-meta.json");
  if (!fs.exists(metaPath)) {
    const meta = {
      version: 1,
      layout: "ref-first",
      sections: WIKI_NAV_SECTIONS.map((s) => ({ id: s.id, folderSlug: s.folderSlug, label: s.label })),
      initializedAt: new Date().toISOString(),
    };
    fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  }

  return { vaultRoot, createdDirs, metaPath };
}
