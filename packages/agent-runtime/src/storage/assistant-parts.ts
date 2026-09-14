/**
 * 助手消息 parts 时间线纯函数：流式归约、收尾与回合文件快照 diff
 */

/** 助手气泡内单段内容（思考 / 正文 / 工具） */
export type AssistantPart =
  | { type: "thinking"; id: string; text: string; status: "streaming" | "done" }
  | { type: "text"; id: string; text: string; status: "streaming" | "done" }
  | {
      type: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      result?: unknown;
      isError?: boolean;
      /**
       * 工具执行状态。
       * `interrupted` = 回合被中止/进程重启，工具不会再有 tool_end —— 终端态，不是错误。
       */
      status: "running" | "done" | "error" | "interrupted";
      meta?: { sourceAgent?: { instanceId: string; label: string } };
    };

/** 工具类 assistant part */
export type ToolAssistantPart = Extract<AssistantPart, { type: "tool" }>;

/** 回合工作区净文件变更条目 */
export type FileChangeEntry = {
  path: string;
  status: "added" | "modified" | "deleted";
};

/** 助手消息持久化形态（parts 为唯一真相） */
export type AssistantPartsContent = {
  type: "assistant_parts";
  parts: AssistantPart[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  sourceAgent?: { instanceId: string; label: string };
  fileChanges?: FileChangeEntry[];
};

/** 流式事件，用于归约进 parts */
export type AssistantPartEvent =
  | { kind: "thinking_delta"; delta: string }
  | { kind: "thinking_end" }
  | { kind: "text_delta"; delta: string }
  | {
      kind: "tool_start";
      id: string;
      name: string;
      args: Record<string, unknown>;
      meta?: ToolAssistantPart["meta"];
    }
  | {
      kind: "tool_end";
      id: string;
      name: string;
      result: unknown;
      isError: boolean;
    };

/** 回合开始/结束时的路径 → 内容 hash 快照 */
export type TurnFileSnapshot = ReadonlyMap<string, string>;

/** 可选 ID 生成器，便于测试注入确定性 id */
export type ApplyAssistantPartEventOptions = {
  createId?: () => string;
};

let thinkingIdSeq = 0;
let textIdSeq = 0;

/**
 * 生成 thinking/text part 的唯一 id
 */
function nextPartId(kind: "thinking" | "text", createId?: () => string): string {
  if (createId) {
    return createId();
  }
  if (kind === "thinking") {
    thinkingIdSeq += 1;
    return `th-${thinkingIdSeq}`;
  }
  textIdSeq += 1;
  return `tx-${textIdSeq}`;
}

/**
 * 将流式事件归约进 parts；同类连续增量只 patch 末尾同类型 streaming part
 */
export function applyAssistantPartEvent(
  parts: readonly AssistantPart[],
  event: AssistantPartEvent,
  options?: ApplyAssistantPartEventOptions,
): AssistantPart[] {
  const next = [...parts];

  switch (event.kind) {
    case "thinking_delta": {
      const last = next[next.length - 1];
      if (last?.type === "thinking" && last.status === "streaming") {
        next[next.length - 1] = { ...last, text: last.text + event.delta };
        return next;
      }
      next.push({
        type: "thinking",
        id: nextPartId("thinking", options?.createId),
        text: event.delta,
        status: "streaming",
      });
      return next;
    }

    case "thinking_end": {
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const part = next[i];
        if (part?.type === "thinking" && part.status === "streaming") {
          next[i] = { ...part, status: "done" };
          break;
        }
      }
      return next;
    }

    case "text_delta": {
      const last = next[next.length - 1];
      if (last?.type === "text" && last.status === "streaming") {
        next[next.length - 1] = { ...last, text: last.text + event.delta };
        return next;
      }
      next.push({
        type: "text",
        id: nextPartId("text", options?.createId),
        text: event.delta,
        status: "streaming",
      });
      return next;
    }

    case "tool_start": {
      const index = next.findIndex((p) => p.type === "tool" && p.id === event.id);
      if (index >= 0) {
        const existing = next[index] as Extract<AssistantPart, { type: "tool" }>;
        next[index] = {
          ...existing,
          name: event.name,
          args: event.args,
          meta: event.meta ?? existing.meta,
        };
        return next;
      }
      next.push({
        type: "tool",
        id: event.id,
        name: event.name,
        args: event.args,
        status: "running",
        meta: event.meta,
      });
      return next;
    }

    case "tool_end": {
      const status = event.isError ? "error" : "done";
      const index = next.findIndex((p) => p.type === "tool" && p.id === event.id);
      if (index >= 0) {
        const existing = next[index] as Extract<AssistantPart, { type: "tool" }>;
        next[index] = {
          ...existing,
          name: event.name,
          result: event.result,
          isError: event.isError,
          status,
        };
        return next;
      }
      next.push({
        type: "tool",
        id: event.id,
        name: event.name,
        args: {},
        result: event.result,
        isError: event.isError,
        status,
      });
      return next;
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

/**
 * 回合收尾：把 streaming 的 thinking/text 标为 done。
 *
 * `options.interrupted = true` 时，**还把仍停在 `running` 的 tool part 标为 `interrupted`**。
 * 中断/进程重启后工具不会再有 `tool_end`，不收尾就会永久显示「执行中」——
 * 这是「同一个会话里两个执行过程似乎都在跑」的存储侧根因
 * （见 docs/plans/专项Agent/08-委托可见性.md §5）。
 *
 * 刻意**不**给这些 part 补 `result` 占位：渲染层用「无结果 + 消息已结束」判定中断，
 * 补一个假 result 反而会让它被当成正常完成。默认 `false` 保持既有语义不变。
 */
export function finalizeAssistantParts(
  parts: readonly AssistantPart[],
  options?: { interrupted?: boolean },
): AssistantPart[] {
  const interrupted = options?.interrupted === true;
  return parts.map((part) => {
    if (part.type === "thinking" && part.status === "streaming") {
      return { ...part, status: "done" };
    }
    if (part.type === "text" && part.status === "streaming") {
      return { ...part, status: "done" };
    }
    if (interrupted && part.type === "tool" && part.status === "running") {
      return { ...part, status: "interrupted" };
    }
    return part;
  });
}

/**
 * 将路径规范为正斜杠相对路径
 */
function normalizeSnapshotPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * 对比两轮快照。排序：added → modified → deleted，同组 path 字典序。
 * path 统一为正斜杠相对路径。
 */
export function diffTurnSnapshots(
  start: ReadonlyMap<string, string>,
  end: ReadonlyMap<string, string>,
): FileChangeEntry[] {
  const added: FileChangeEntry[] = [];
  const modified: FileChangeEntry[] = [];
  const deleted: FileChangeEntry[] = [];

  const startPaths = new Map<string, string>();
  for (const [rawPath, hash] of start) {
    startPaths.set(normalizeSnapshotPath(rawPath), hash);
  }

  const endPaths = new Map<string, string>();
  for (const [rawPath, hash] of end) {
    endPaths.set(normalizeSnapshotPath(rawPath), hash);
  }

  for (const [path, hash] of endPaths) {
    if (!startPaths.has(path)) {
      added.push({ path, status: "added" });
    } else if (startPaths.get(path) !== hash) {
      modified.push({ path, status: "modified" });
    }
  }

  for (const path of startPaths.keys()) {
    if (!endPaths.has(path)) {
      deleted.push({ path, status: "deleted" });
    }
  }

  const byPath = (a: FileChangeEntry, b: FileChangeEntry) => a.path.localeCompare(b.path);
  added.sort(byPath);
  modified.sort(byPath);
  deleted.sort(byPath);

  return [...added, ...modified, ...deleted];
}
