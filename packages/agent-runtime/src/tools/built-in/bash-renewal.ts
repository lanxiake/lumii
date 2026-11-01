/**
 * bash 命令超时前续期 — 询问 **Agent（模型）** 是否续期
 *
 * Agent 卡在 bash execute 里无法再调工具，故由 bash 工具嵌套一次短 LLM 调用
 * （`context.callLLM`，purpose=`bash_renewal`）。模型返回 JSON：
 * `{ "renew": false }` 或 `{ "renew": true, "extendMs": 120000 }`。
 */

/** 续期询问提前量（超时终止前多久问 Agent） */
export const BASH_RENEWAL_LEAD_MS = 60_000;

/** 单次续期建议档位（写入 prompt，供模型选用） */
export const BASH_RENEWAL_PRESETS_MS = [120_000, 300_000, 600_000] as const;

/** 单次续期硬上限 */
export const BASH_RENEWAL_MAX_EXTEND_MS = 600_000;

/**
 * 构造给 Agent 的续期决策 prompt（要求只回 JSON）。
 */
export function buildBashRenewalAgentPrompt(args: {
  command: string;
  elapsedMs: number;
  remainingMs: number;
  timeoutMs: number;
}): string {
  const cmdPreview = args.command.length > 400 ? `${args.command.slice(0, 400)}…` : args.command;
  const elapsedSec = Math.max(1, Math.round(args.elapsedMs / 1000));
  const remainSec = Math.max(1, Math.round(args.remainingMs / 1000));
  const timeoutSec = Math.max(1, Math.round(args.timeoutMs / 1000));
  return [
    "You are deciding whether to renew (extend) a still-running shell command before it times out.",
    "The main agent turn is blocked inside this bash tool call, so you must decide now.",
    "",
    `Command has been running ~${elapsedSec}s (configured timeout ${timeoutSec}s).`,
    `About ${remainSec}s remain until the process is killed.`,
    `Command:\n\`\`\`\n${cmdPreview}\n\`\`\``,
    "",
    "Decide:",
    "- If the command likely still needs more time (install/build/download/compile/wait), renew.",
    "- If it looks stuck, interactive, or already should have finished, do NOT renew.",
    `- If renewing, pick extendMs in milliseconds (suggested: ${BASH_RENEWAL_PRESETS_MS.join(", ")}). Max ${BASH_RENEWAL_MAX_EXTEND_MS}.`,
    "",
    'Reply with ONLY one JSON object, no markdown:',
    '{"renew":false}',
    'or',
    '{"renew":true,"extendMs":120000}',
  ].join("\n");
}

/**
 * 从自由文本里解析续期毫秒（容错：模型偶发回 `2m` / `120s`）。
 */
export function parseRenewalExtendMs(raw: string): number {
  const text = raw.trim().toLowerCase();
  if (!text) return 0;
  if (/^(不续期|不延长|否|no|false|deny)/i.test(text)) return 0;

  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n >= 1000 ? Math.floor(n) : Math.floor(n * 1000);
  }

  const m = text.match(
    /^(\d+(?:\.\d+)?)\s*(ms|毫秒|s|sec|secs|seconds?|秒|m|min|mins|minutes?|分钟|分)?$/i,
  );
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit === "ms" || unit === "毫秒") return Math.floor(n);
  if ((unit.startsWith("m") && unit !== "ms" && !unit.startsWith("ms")) || unit.includes("分")) {
    return Math.floor(n * 60_000);
  }
  return Math.floor(n * 1000);
}

/**
 * 从模型输出中抽出 JSON 对象（允许包在 ```json 围栏里）。
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 把 Agent 文本答复收成 extendMs（0 = 不续期）。
 */
export function extendMsFromAgentRenewalReply(text: string): number {
  const obj = extractJsonObject(text);
  if (!obj) {
    // 兜底：整段当自由文本解析
    return Math.min(BASH_RENEWAL_MAX_EXTEND_MS, parseRenewalExtendMs(text));
  }

  const renew = obj.renew;
  if (renew === false || renew === "false" || renew === 0) return 0;
  if (renew !== true && renew !== "true" && renew !== 1) {
    // 无 renew 字段但有 extendMs：视为续期
    if (obj.extendMs == null && obj.extend_ms == null) return 0;
  }

  const raw = obj.extendMs ?? obj.extend_ms ?? obj.ms;
  let extendMs = 0;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    extendMs = Math.floor(raw);
  } else if (typeof raw === "string") {
    extendMs = parseRenewalExtendMs(raw);
  } else if (renew === true || renew === "true" || renew === 1) {
    // 只说 renew:true 未给时长 → 默认续 2 分钟
    extendMs = BASH_RENEWAL_PRESETS_MS[0];
  }

  if (extendMs <= 0) return 0;
  return Math.min(BASH_RENEWAL_MAX_EXTEND_MS, extendMs);
}
