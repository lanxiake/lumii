# 客户端解耦（agent-runtime × 前端）· 立项

> 创建：2026-09-12
> 状态：**已立项，暂缓启动** —— 按决策 D11，先完成 Linux / 无头移植，再启动本议题
> 范围：`packages/agent-runtime`（内核不动）× `apps/windows/src/main`（宿主边界重构）
> 关联：[Linux 与无头部署调查分析](../../design/Linux客户端移植/Linux与无头部署调查分析.md) §7 —— 本立项的现状依据（含全部 file:line 证据）
> 关联：`docs/plans/客户端优化/`（renderer 侧切片计划，与本议题边界相邻但目标不同）

---

## 一、为什么立项，但不现在动手

**目标**：让 `packages/agent-runtime` 可被非 Electron 宿主复用，从而支持后续新建客户端（移动端、macOS）。

**为什么暂缓**（D11，详见调查文档 §7.6）：

1. **需求来源**：无头形态本身就是「宿主进程缝」的第一个非桌面宿主。调查中「消息客户端缝已存在、宿主进程缝不存在」这个关键结论，正是靠移植调查才发现的——**提前解耦等于在没有真实需求的情况下设计抽象**。
2. **正交性**：移植的 P0 打包链路与本议题无关；P1 平台抽象层属「宿主实现细节」，将来随宿主搬进 host 包是机械搬运。
3. **风险隔离**：本议题的高风险片（拆 `AgentRuntimeBridge`，2500+ 行）与移植并行会造成改动叠加、回归归因困难。
4. **交付价值**：移植有近期可交付物；移动端无近期时间压力。

---

## 二、目标与非目标

| | 内容 |
|---|---|
| **目标** | 新建一个客户端（含非 Electron 宿主）**不需要修改 `apps/windows`**；宿主缝成立且被真实宿主验证 |
| **非目标** | 不做移动端 UI；不重写 agent-runtime 内核；不引入新传输协议（沿用现有可序列化 JSON 命令 / 事件）；不改 `apps/windows` 的产品行为 |

---

## 三、现状基线

> 全部证据见调查文档 §7，此处只列结论。

**已成立（不需要做，只需守住）**：

| 事实 | 证据 |
|------|------|
| `packages/agent-runtime` 零 Electron 依赖 | src 下 grep `from 'electron'` → 0 命中；依赖表仅 pi-agent-core / pi-ai / typebox / axios / cheerio |
| 宿主注入契约已存在 | `host-kit/types.ts:40-219`：`EventSink` / `PermissionProvider` / `ConfigProvider` / `PromptContextProvider` / `StreamFnFactory` / `assembleAgent()` |
| 契约已被真实使用 | `bridge-instance-factory.ts:380,614,675` |
| 命令 / 事件可序列化 | `shared/agent-runtime-commands.ts:16-46`、`shared/agent-runtime-events.ts:50-521` |
| 非 Electron 客户端可驱动命令总线（已证明） | HTTP 控制面复用同一 `handleCommand`（`app-ui-control/server.ts:12,281`）+ `lumii-ui` CLI |
| 会话 / 记忆 / Wiki 数据模型在 portable 包 | `storage/conversation-repo.ts`、`packages/agent-runtime/src/index.ts:321-577` |
| 客户端已被建模为渠道 | `IChannelAdapter`（`channel/types.ts:103-117`），5 个实现之一即桌面端 |

**缺口（本议题要解决的）**：

| 缺口 | 证据 |
|------|------|
| **宿主进程缝不存在**：adapter 必须与 bridge 同进程同仓 | `channel/types.ts:7` 直接 import `AgentRuntimeBridge` |
| 事件出口有 5 处平行实现 | `bridge-renderer-ipc.ts:41,58`；`agent-runtime-ipc.ts:725,734`；`engine-assembly.ts:59`（另见 §7.3 全表） |
| 宿主组合根绑 Electron | `bridge.ts:10,613-618,704` |
| 数据 / 凭据落盘绑 `app.getPath` + `safeStorage` | `provider-config.ts:11,163,176` 等 |
| 控制面自身也耦合 Electron | `app-ui-control/server.ts:11-12,58`；`controller.ts:3,168` |

**量级**：`apps/windows/src/main` 340 个非测试文件中 64 个 import electron。

---

## 四、切片总表

> 切分原则同 [客户端优化](../客户端优化/README.md)：每片可独立提交、独立验证、可单独回滚。**启动时再为每片写实施计划。**

| 片 | 范围 | 风险 | 前置 | 状态 |
|---|---|---|---|---|
| **0 · 防腐守卫** | CI 增加「`packages/agent-runtime` 零 electron 导入」检查，锁住已成立的边界 | 低 | 移植的 D7 CI 落地 | 未开始 |
| **1 · 事件出口唯一化** | 把 5 处平行 `webContents.send` 收敛为一个传输接口（`EventSink` 从进程内回调升级为传输抽象）；客户端侧保留一个 Electron IPC 实现 | 中 | 移植完成（无头模式已把其中一处改造成接口） | 未开始 |
| **2 · 存储与凭据注入** | `dataRoot` 与 secret store 抽象化（`safeStorage` → 接口 + 各平台实现） | 中 | 片 1 | 未开始 |
| **3 · 宿主组合根拆分** | 拆 `AgentRuntimeBridge`，产出「不依赖 Electron 即可构造」的 host 装配入口 | **高** | 片 1 + 片 2 | 未开始 |
| **4 · 客户端能力协商** | 客户端声明 capabilities（有无 UI / 能否扫码 / 能否发通知 / 能否选文件），运行时据此分流；复用 `desktop-interaction-gate.ts:55-64` 的降级链雏形 | 中 | 片 3 | 未开始 |
| **5 · 渠道与宿主解耦** | `channel/types.ts:7` 对 `AgentRuntimeBridge` 的 import 换成接口 | 中 | 片 3 | 未开始 |
| **6 · 第二宿主验证** | 用纯 Node 宿主（即移植调查中的「路线 B」）验证宿主缝，作为验收 | 高 | 片 3 | 未开始 |

**切片顺序不可颠倒**：片 1/2 是片 3 的前置（拆分前必须先有传输与存储的抽象，否则拆出来仍是 Electron 形状）；片 4/5 依赖片 3 产出的 host 边界。

---

## 五、与移植的接口（不返工约束）

移植期间**必须**遵守以下约束，否则本议题启动时要重做：

1. **无头模式的事件出口必须做成接口**，不是在 `index.ts` 里再加一处 `if (headless)` 分支——这就是片 1 的雏形，做了就不用返工。
2. **`dataRoot` 注入与移植的路径平台化一并做掉**（片 2 的一半），不拆成两份工作。
3. **移植期间不动**片 3 / 片 4 / 片 5 的范围（宿主组合根、能力协商、渠道解耦）。

---

## 六、验收标准（可判定）

| # | 标准 | 判定方式 |
|---|------|---------|
| 1 | `packages/agent-runtime` 零 Electron 依赖 | CI 守卫检查通过（片 0） |
| 2 | 事件出口唯一 | `grep -rn "webContents.send" apps/windows/src/main` 的命中全部落在客户端适配层内（单一模块），无平行实现 |
| 3 | host 可脱离 Electron 构造 | 存在一个纯 Node 环境下可实例化 host 的单元测试（不 import electron） |
| 4 | **新客户端不改 `apps/windows`** | 用一个最小 fake client（纯 Node 脚本）走通「发消息 → 工具调用 → 事件回传 → 权限应答」全链路，且期间 `apps/windows` 无代码改动（片 6） |

> 标准 4 是本议题的真正验收——它同时证明了「移动端可以只写客户端，复用运行时」这一前提。

---

## 七、风险

| 风险 | 说明 | 应对 |
|------|------|------|
| 片 3 是高风险的存量重构 | 拆 2500+ 行 `AgentRuntimeBridge`，无用户可见收益，容易半途而废 | 必须先有片 1/2 的抽象底座；每片独立提交 + 回归门禁 |
| 抽象设计脱离真实需求 | 目前只有「桌面 Electron」和「无头（仍为 Electron 宿主）」两个真实宿主 | 片 6 用第二宿主（纯 Node）做实证；不提前为移动端做假设 |
| 与既有 39 个测试失败混淆归因 | `apps/windows test:all` 存在既有失败（见基线记录） | 每片开工前先跑基线，改动后对比失败集合是否变化 |
| 与 `客户端优化` 计划的边界重叠 | 两者都动 `apps/windows`，但前者动 renderer，本议题动 main 宿主边界 | 明确不同时并行推进；启动本议题时确认 renderer 侧无进行中的切片 |

---

## 八、启动条件

本议题启动前需全部满足：

- [ ] Linux / 无头移植已完成（至少 M1「能出包能启动」与 P1'「无头启动路径」）
- [ ] D7 的 CI 已落地（片 0 依赖它）
- [ ] `docs/plans/客户端优化/` 无进行中的切片
- [ ] 本 README 的「现状基线」重新核对（代码会变，file:line 需复核）
