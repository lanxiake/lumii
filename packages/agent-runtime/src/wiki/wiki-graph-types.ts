/**
 * 三期知识图谱类型定义
 */

export const GRAPH_EXTRACT_CURSOR_META_KEY = "graph_extract_cursor";

/** sourceId → 上次抽取时的 content_hash（正文未变则跳过） */
export type WikiGraphExtractCursor = Record<string, string>;
