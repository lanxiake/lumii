/**
 * task_tools — 任务管理工具集
 *
 * 统一的 todo_write 工具，合并 create/update/list/delete 操作。
 */

import { Type, type Static } from "@sinclair/typebox";
import type { MtBotToolConfig } from "../../tools/tool-adapter.js";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const TaskCreateAction = Type.Object({
  action: Type.Literal("create"),
  subject: Type.String({ description: "Brief task title" }),
  description: Type.String({ description: "What needs to be done" }),
  activeForm: Type.Optional(
    Type.String({
      description: 'Present continuous form shown in spinner (e.g., "Running tests")',
    }),
  ),
});

const TaskUpdateAction = Type.Object({
  action: Type.Literal("update"),
  taskId: Type.String({ description: "ID of the task to update" }),
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("todo"),
      Type.Literal("in_progress"),
      Type.Literal("review"),
      Type.Literal("done"),
      Type.Literal("blocked"),
      Type.Literal("cancelled"),
    ]),
  ),
  owner: Type.Optional(Type.String({ description: "Agent name claiming this task" })),
});

const TaskListAction = Type.Object({
  action: Type.Literal("list"),
});

const TaskDeleteAction = Type.Object({
  action: Type.Literal("delete"),
  taskId: Type.String({ description: "ID of the task to delete" }),
});

/**
 * 批量创建任务的单条项目结构
 */
const BatchCreateItem = Type.Object({
  subject: Type.String({ description: "Brief task title" }),
  description: Type.Optional(Type.String({ description: "What needs to be done" })),
  owner: Type.Optional(Type.String({ description: "Agent name claiming this task" })),
  parallel: Type.Optional(
    Type.Boolean({
      description:
        "Whether this task can run in parallel with other parallel tasks (default: false = sequential)",
      default: false,
    }),
  ),
  dependsOnIndex: Type.Optional(
    Type.Array(Type.Integer({ minimum: 0 }), {
      description:
        "0-based indices of tasks in this batch that must complete before this task starts. " +
        "E.g. dependsOnIndex=[0,1] means this task depends on the 1st and 2nd tasks in the tasks array.",
    }),
  ),
});

/**
 * 批量更新任务的单条项目结构
 */
const BatchUpdateItem = Type.Object({
  taskId: Type.String({ description: "ID of the task to update" }),
  status: Type.Optional(Type.String({ description: "New status" })),
  owner: Type.Optional(Type.String({ description: "Agent name" })),
});

/**
 * 使用 Union 而非 discriminatedUnion，因为工具系统限制不允许 Union/anyOf。
 * 工具运行时根据 action 字段分派。
 *
 * 状态流转说明：
 *   pending → todo（已分配执行者）
 *   todo → in_progress（执行中）
 *   in_progress → review（验证中）
 *   review → done（验证通过，完成）
 *   任意状态 → blocked / cancelled
 */
const TodoWriteParams = Type.Object({
  action: Type.Union([
    Type.Literal("create"),
    Type.Literal("batch_create"),
    Type.Literal("update"),
    Type.Literal("batch_update"),
    Type.Literal("list"),
    Type.Literal("delete"),
  ]),
  // create 参数
  subject: Type.Optional(Type.String({ description: "Brief task title (action=create)" })),
  description: Type.Optional(Type.String({ description: "What needs to be done (action=create)" })),
  activeForm: Type.Optional(
    Type.String({ description: "Present continuous form (action=create)" }),
  ),
  // batch_create 参数
  tasks: Type.Optional(
    Type.Array(BatchCreateItem, {
      maxItems: 20,
      description:
        "List of tasks to create (action=batch_create). Max 20 tasks; merge related micro-steps into one task.",
    }),
  ),
  // update 参数
  taskId: Type.Optional(Type.String({ description: "Task ID (action=update|delete)" })),
  status: Type.Optional(
    Type.String({
      description:
        "New status: pending|todo|in_progress|review|done|blocked|cancelled (action=update)",
    }),
  ),
  owner: Type.Optional(Type.String({ description: "Agent name (action=update)" })),
  // batch_update 参数
  updates: Type.Optional(
    Type.Array(BatchUpdateItem, { description: "List of task updates (action=batch_update)" }),
  ),
});

type TodoWriteInput = Static<typeof TodoWriteParams>;

/**
 * todo_write 工具配置
 *
 * stub 实现，由平台集成层注入 TaskRepo 后覆盖 execute。
 */
export const todoWriteToolConfig: MtBotToolConfig<typeof TodoWriteParams> = {
  name: "todo_write",
  label: "Task Manager",
  description:
    "Manage shared task list: create, update, list, or delete tasks. " +
    "For complex multi-step tasks, prefer batch_create with parallel/dependsOnIndex fields " +
    "to express the full task graph in a single call.",
  parameters: TodoWriteParams,
  category: "agent",
  isReadOnly: false,
  needsPermission: false,

  async execute(_toolCallId: string, params: TodoWriteInput): Promise<AgentToolResult<unknown>> {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            message:
              `todo_write is a stub. Platform integration layer should override this. ` +
              `Requested: action=${params.action}`,
            supportedActions: [
              "create",
              "batch_create",
              "update",
              "batch_update",
              "list",
              "delete",
            ],
            statusFlow: "pending → todo → in_progress → review → done",
            batchCreateFields:
              "subject(required), description, owner, parallel(bool,default:false), dependsOnIndex(int[])",
          }),
        },
      ],
      details: undefined,
    };
  },
};
