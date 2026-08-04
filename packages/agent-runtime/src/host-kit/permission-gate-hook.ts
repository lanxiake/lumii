/**
 * 权限闸门 Hook（host-kit 版）
 *
 * 把策略校验（checkPermission，内核纯逻辑）与用户确认（PermissionProvider，
 * 宿主注入）合在一个 ToolHook 里。逻辑等价于 apps/windows 的
 * hooks/permission-gate-hook.ts，唯一差别：用户确认改为调用注入的
 * PermissionProvider.requestPermission，不再直连 Electron dialog。
 *
 * 设计依据: .qoder/design/client-agent-runtime/2026-06-26-agent-standalone-v2-design.md §2.2
 */

import { randomUUID } from "node:crypto";
import type { ToolHook } from "../tools/tool-hooks.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { checkPermission } from "../security/permission-checker.js";
import { createPermissionContext } from "../security/permission-context.js";
import { PermissionMemory, DEFAULT_PERMISSION_MEMORY_MS } from "../security/permission-memory.js";
import type { PermissionProvider } from "./types.js";

/** 工具审计行（宿主可选落库） */
export interface ToolAuditRow {
  readonly toolName: string;
  readonly resultSummary: string;
  readonly isError: boolean;
}

/** 权限闸门 hook 依赖（runContext 仅取构造 PermissionRequest 所需字段） */
export interface PermissionGateHookDeps {
  readonly definition: AgentDefinition;
  readonly instanceId: string;
  readonly runContext: {
    readonly runId: string;
    readonly sessionKey: string;
    readonly rootSessionKey: string;
  };
  /** 进程内「允许并记住」缓存（宿主持有，跨实例复用） */
  readonly permissionMemory: PermissionMemory;
  /** 用户确认交互（宿主决定 UI 形态） */
  readonly permission: PermissionProvider;
  /** 可选审计落库 */
  readonly logToolAudit?: (row: ToolAuditRow) => void;
}

/**
 * 创建权限闸门 hook：执行工具前完成策略校验与用户确认。
 *
 * - denied（策略拒绝）：短路返回错误结果
 * - needs_confirmation：调用 PermissionProvider 询问用户
 *   - deny：短路返回错误结果
 *   - allow-always：写入记忆，放行
 *   - allow-once：放行
 * - allowed：直接放行
 */
export function createPermissionGateHook(deps: PermissionGateHookDeps): ToolHook {
  const audit = deps.logToolAudit ?? (() => {});
  return {
    name: "permission-gate",
    critical: true,
    async beforeExecute(ctx) {
      const rawParams = ctx.params as Record<string, unknown>;
      const permCtx = createPermissionContext(deps.definition.permissionMode ?? "default");
      const check = checkPermission(
        permCtx,
        ctx.toolName,
        rawParams,
        undefined,
        deps.permissionMemory,
      );

      if (check.outcome === "denied") {
        const msg =
          check.decision.behavior === "deny" && "message" in check.decision
            ? check.decision.message
            : "Permission denied";
        audit({ toolName: ctx.toolName, resultSummary: `权限拒绝(策略): ${msg}`, isError: true });
        return {
          content: [{ type: "text", text: msg }],
          details: { permissionDenied: true as const },
          isError: true,
        };
      }

      if (check.outcome === "needs_confirmation") {
        const requestId = randomUUID();
        const askMsg =
          check.decision.behavior === "ask" && "message" in check.decision
            ? check.decision.message
            : "需要确认后执行";
        const decision = await deps.permission.requestPermission({
          requestId,
          runId: deps.runContext.runId,
          sessionKey: deps.runContext.sessionKey,
          rootSessionKey: deps.runContext.rootSessionKey,
          instanceId: deps.instanceId,
          toolName: ctx.toolName,
          toolArgs: rawParams,
          description: askMsg,
        });
        if (decision === "deny") {
          audit({ toolName: ctx.toolName, resultSummary: "权限拒绝(用户取消)", isError: true });
          return {
            content: [{ type: "text", text: "用户已拒绝执行该工具。" }],
            details: { permissionDenied: true as const },
            isError: true,
          };
        }
        if (decision === "allow-always") {
          deps.permissionMemory.recordDecision(ctx.toolName, true, DEFAULT_PERMISSION_MEMORY_MS);
          audit({
            toolName: ctx.toolName,
            resultSummary: "允许(同类工具 24h 内自动允许)",
            isError: false,
          });
        } else {
          audit({ toolName: ctx.toolName, resultSummary: "允许(仅本次)", isError: false });
        }
      }
    },
  };
}
