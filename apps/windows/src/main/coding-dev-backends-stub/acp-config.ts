/**
 * ACP 后端统一超时配置。
 *
 * 长程编程任务（读文件、改代码、跑命令）单次 prompt 常超过数分钟，
 * 固定的短超时（如 120s）会误杀正常任务。此处提供全局默认与环境变量覆盖。
 */

/** 默认 ACP 超时：60 分钟 */
export const DEFAULT_ACP_TIMEOUT_MS = 3_600_000;

/** 控制 ACP 超时的环境变量名；`0` 表示不限制 */
export const ACP_TIMEOUT_ENV_VAR = "MTBOT_ACP_TIMEOUT_MS";

/**
 * 解析 ACP 超时毫秒数。
 *
 * - 未设置 / 空串：返回 {@link DEFAULT_ACP_TIMEOUT_MS}
 * - `MTBOT_ACP_TIMEOUT_MS=0`：返回 `undefined`，调用方按「不限制」处理
 * - 合法非负整数：返回该值
 * - 非法值（负数、浮点、非数字）：回退 {@link DEFAULT_ACP_TIMEOUT_MS}
 */
export function resolveAcpTimeoutMs(): number | undefined {
  const raw = process.env[ACP_TIMEOUT_ENV_VAR]?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_ACP_TIMEOUT_MS;
  }
  if (raw === "0") {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    console.warn(
      `[acp-config] ${ACP_TIMEOUT_ENV_VAR}="${raw}" is invalid, fallback to ${DEFAULT_ACP_TIMEOUT_MS}ms`,
    );
    return DEFAULT_ACP_TIMEOUT_MS;
  }
  return parsed;
}
