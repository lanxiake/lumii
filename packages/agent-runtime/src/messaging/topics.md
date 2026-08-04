# MessageBus 与编排事件主题约定

进程内 `MessageBus` 使用 **Mailbox + EventEmitter('message')**；以下为逻辑主题命名，便于日志检索与文档对齐（非代码常量，描述性约定）。

## Agent 生命周期

| 主题              | 含义                       |
| ----------------- | -------------------------- |
| `agent:created`   | AgentInstance 已创建并注册 |
| `agent:destroyed` | 实例已销毁，邮箱已注销     |

## 消息传递

| 主题             | 含义                                          |
| ---------------- | --------------------------------------------- |
| `agent:message`  | `MessageBus.send` 投递到某实例邮箱            |
| `user:broadcast` | `to === "*"` 时向除发送方外全部已注册实例广播 |

## 编排

| 主题                 | 含义                                                   |
| -------------------- | ------------------------------------------------------ |
| `orchestrator:spawn` | `AgentOrchestrator.spawnAgent` 创建子实例              |
| `orchestrator:send`  | `AgentOrchestrator.sendMessage` 经 Bus + followUp 投递 |

## IPC（Electron）

渲染进程侧另见 `agent:activity:snapshot`（活动 Agent 列表），与上述命名空间独立。
