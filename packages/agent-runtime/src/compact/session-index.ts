/**
 * session-index —— 会话级文件/技能使用索引（确定性追踪）
 *
 * 压缩时的 LLM 摘要依赖模型自己回忆"读过哪些文件、用过哪些技能"，历史越长越容易遗漏。
 * 本模块在 `tool_execution_start` 事件上做确定性记录，压缩后由 `buildActivityIndexAttachment`
 * 格式化为附加消息，通过 `PostCompactRebuild.buildAttachments` 注入到摘要之后，
 * 兜底 LLM 摘要遗漏的文件路径与技能使用记录。
 *
 * 设计依据: .qoder/design/agent-context-compact/03-压缩后文件与技能索引重建设计.md
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  EXECUTE_SKILL_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
} from "../tools/built-in/tool-names.js";

/** 文件操作类型 */
export type FileOp = "read" | "write" | "edit";

/** 文件索引条目 */
export interface FileIndexEntry {
  path: string;
  /** 最近一次操作类型（同一文件多次操作时只保留最后一次） */
  lastOp: FileOp;
  /** 操作次数（体现高频接触） */
  opCount: number;
}

/** 技能索引条目 */
export interface SkillIndexEntry {
  name: string;
  /** SKILL.md 位置（约定路径拼接，非精确来源） */
  location: string;
  useCount: number;
}

const FILE_OP_BY_TOOL: Readonly<Record<string, FileOp>> = {
  [FILE_READ_TOOL_NAME]: "read",
  [FILE_WRITE_TOOL_NAME]: "write",
  [FILE_EDIT_TOOL_NAME]: "edit",
};

function readStringField(args: unknown, field: string): string | null {
  if (typeof args !== "object" || args === null) {
    return null;
  }
  const value = (args as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * 会话活跃度索引：追踪本次会话中实际发生过的文件操作与技能使用。
 *
 * 单调增长，不随压缩清空——它本身就是"跨压缩仍应记得"的信息源。
 */
export class SessionActivityIndex {
  private readonly files = new Map<string, FileIndexEntry>();
  private readonly skills = new Map<string, SkillIndexEntry>();

  /**
   * 记录一次工具调用。畸形/缺字段的参数静默忽略，不影响主流程。
   */
  record(toolName: string, args: unknown): void {
    try {
      const fileOp = FILE_OP_BY_TOOL[toolName];
      if (fileOp) {
        this.recordFile(fileOp, args);
        return;
      }
      if (toolName === EXECUTE_SKILL_TOOL_NAME) {
        this.recordSkill(args);
      }
    } catch {
      // 追踪失败不应影响压缩主流程，静默忽略。
    }
  }

  private recordFile(op: FileOp, args: unknown): void {
    const filePath = readStringField(args, "filePath");
    if (!filePath) {
      return;
    }
    const existing = this.files.get(filePath);
    this.files.set(filePath, {
      path: filePath,
      lastOp: op,
      opCount: (existing?.opCount ?? 0) + 1,
    });
  }

  private recordSkill(args: unknown): void {
    const id = readStringField(args, "id");
    if (!id) {
      return;
    }
    const existing = this.skills.get(id);
    this.skills.set(id, {
      name: id,
      location: `skills/${id}/SKILL.md`,
      useCount: (existing?.useCount ?? 0) + 1,
    });
  }

  /** 返回当前快照（不清空、不重置）。 */
  snapshot(): { files: FileIndexEntry[]; skills: SkillIndexEntry[] } {
    return {
      files: [...this.files.values()],
      skills: [...this.skills.values()],
    };
  }
}

/**
 * 将索引快照格式化为压缩后附加消息。
 *
 * 双空时返回 `[]`（无噪音注入，与未注入 postCompactRebuild 行为一致）。
 */
export function buildActivityIndexAttachment(snapshot: {
  files: FileIndexEntry[];
  skills: SkillIndexEntry[];
}): AgentMessage[] {
  const { files, skills } = snapshot;
  if (files.length === 0 && skills.length === 0) {
    return [];
  }

  const sortedFiles = [...files].sort((a, b) => b.opCount - a.opCount);
  const sortedSkills = [...skills].sort((a, b) => b.useCount - a.useCount);

  const lines: string[] = ["<session_activity_index>"];
  lines.push(
    "以下是本会话中实际发生过的文件操作与技能使用记录（确定性追踪，不依赖上文摘要）。",
    "",
  );

  if (sortedFiles.length > 0) {
    lines.push("Files touched:");
    for (const f of sortedFiles) {
      lines.push(`  - [${f.lastOp}] ${f.path} (${f.opCount} 次)`);
    }
    lines.push("");
  }

  if (sortedSkills.length > 0) {
    lines.push("Skills used:");
    for (const s of sortedSkills) {
      lines.push(`  - ${s.name} (${s.location}) — 使用 ${s.useCount} 次`);
    }
    lines.push("");
  }

  lines.push(
    "IMPORTANT: 上方摘要可能未完整保留这些文件的具体内容或技能的详细规则。",
    "- 若需要引用某个文件的具体内容，先重新用 file_read 读取该路径，不要凭摘要印象假设内容仍然如此。",
    "- 若后续任务需要用到上方列出的某个技能，且该技能的详细规则（参数格式、执行步骤、约束）已不在当前上下文中，必须先重新读取对应 location 的 SKILL.md，再执行，不要凭记忆执行技能规则。",
    "</session_activity_index>",
  );

  return [{ role: "user", content: lines.join("\n"), timestamp: Date.now() }];
}
