# Gateway 遗留代码分析报告

> 生成日期：2026-08-20
> 项目：灵栖 Lumii 开源独立版
> 目的：梳理 Gateway（远程网关/云后端）相关的全部遗留代码，为后续彻底移除提供清单与步骤。

---

## 一、背景

项目原为"客户端 + 云端 Gateway + Agent Host"三段式架构（MtBot 时代），现转型为**本地优先、Direct-Stream 直连模型**的独立版（Lumii）。核心能力已全部本地化运行：

- LLM 请求：`createDirectStreamFn` 直连用户自行配置的 OpenAI 兼容端点（见 [direct-stream.ts](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/src/llm/direct-stream.ts)）
- 生图：`RightAPIClient` + `RightCodesDrawClient` 直连上游（见 [rightapi-image-client.ts](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/main/agent-runtime/rightapi-image-client.ts)、[right-codes-draw-client.ts](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/main/agent-runtime/right-codes-draw-client.ts)）
- Gateway 客户端、Node Mode Coordinator、设备配对服务等实际**从未在独立版启动**（见 [main/index.ts#L3135](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/main/index.ts#L3135) 的注释 `// 不构造 apiClient / gatewayClient / nodeModeCoordinator / devicePairingService`）

但代码中仍残留大量 Gateway 相关的**类型、包、导入、死代码分支、配置、文档**。本报告按"可直接删除 → 需要清理死分支 → 仅文档/注释"三层分类。

---

## 二、第一级：可整个删除的独立包（最高优先级，风险最低）

### 2.1 `packages/protocol` — 整个包可删除

**状态：** 纯协议门面，**运行时零引用**（仅在 `agent-runtime/package.json` 声明依赖，实际代码未 import 其任何具体协议类型）。

| 维度 | 详情 |
|------|------|
| 包名 | `@mtbot/protocol` |
| 位置 | [packages/protocol/](file:///C:/myself/projects/my/open-source/lumii/packages/protocol) |
| package.json 描述 | "Stable facade for MtBot gateway protocol types" |
| 源码文件数 | ~40 个 TS 文件（26 个 schema 子文件 + agent-host + envelope 等） |
| 对外导出 | 全部是 `gateway-protocol/*` 协议类型 + `agent/kernel.ts` |

**删除清单（整个目录）：**
```
packages/protocol/
├── src/
│   ├── agent/kernel.ts
│   ├── gateway-protocol/          (25+ schema & agent-host files)
│   │   ├── schema/
│   │   │   ├── agent.ts
│   │   │   ├── agents-models-skills.ts
│   │   │   ├── channels.ts
│   │   │   ├── config.ts
│   │   │   ├── error-codes.ts
│   │   │   ├── exec-approvals.ts
│   │   │   ├── frames.ts
│   │   │   ├── internal-config.ts
│   │   │   ├── internal-events.ts
│   │   │   ├── logs-chat.ts
│   │   │   ├── pipeline.ts
│   │   │   ├── primitives.ts
│   │   │   ├── protocol-schemas.ts
│   │   │   ├── rfs.ts
│   │   │   ├── sessions.ts
│   │   │   ├── snapshot.ts
│   │   │   ├── types.ts
│   │   │   └── wizard.ts
│   │   ├── agent-host/
│   │   │   ├── events.ts
│   │   │   ├── index.ts
│   │   │   ├── methods.ts
│   │   │   └── params.ts
│   │   ├── client-envelope.ts
│   │   ├── client-info.ts
│   │   ├── index.ts
│   │   ├── schema.ts
│   │   └── skill-execution.ts
│   └── index.ts
├── package.json
└── tsconfig.json
```

**连带清理：**
- [packages/agent-runtime/package.json#L21](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/package.json#L21) — 移除 `"@mtbot/protocol": "workspace:*"` 依赖
- [apps/windows/package.json#L50](file:///C:/myself/projects/my/open-source/lumii/apps/windows/package.json#L50) — 移除 `"@mtbot/protocol": "workspace:*"` 依赖
- [apps/windows/electron.vite.config.ts#L190](file:///C:/myself/projects/my/open-source/lumii/apps/windows/electron.vite.config.ts#L190) — externalize 列表移除 `'@mtbot/protocol'`
- [apps/windows/electron.vite.config.ts#L226](file:///C:/myself/projects/my/open-source/lumii/apps/windows/electron.vite.config.ts#L226) — optimizeDeps.exclude 移除 `'@mtbot/protocol'`
- [apps/windows/electron.vite.config.ts#L238](file:///C:/myself/projects/my/open-source/lumii/apps/windows/electron.vite.config.ts#L238) — resolve.alias 移除 `'@mtbot/protocol'` 映射
- [pnpm-workspace.yaml](file:///C:/myself/projects/my/open-source/lumii) — 如有 packages 枚举需同步移除

---

### 2.2 `packages/client-sdk` — 整个包可删除

**状态：** 纯 WS 客户端原语（请求-响应关联表 + gateway-client 握手），**运行时零引用**。

| 维度 | 详情 |
|------|------|
| 包名 | `@mtbot/client-sdk` |
| 位置 | [packages/client-sdk/](file:///C:/myself/projects/my/open-source/lumii/packages/client-sdk) |
| package.json 描述 | "Shared, transport-agnostic client primitives for the MtBot gateway protocol" |
| 源码文件 | `gateway-client.ts`（WS 握手、重连、心跳）、`request-registry.ts`（请求关联表）、各 1 份测试 |

**删除清单（整个目录）：**
```
packages/client-sdk/
├── src/
│   ├── gateway-client.ts
│   ├── index.ts
│   ├── request-registry.test.ts
│   └── request-registry.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

**连带清理：**
- [apps/windows/package.json#L48](file:///C:/myself/projects/my/open-source/lumii/apps/windows/package.json#L48) — 移除 `"@mtbot/client-sdk": "workspace:*"` 依赖
- [apps/windows/electron.vite.config.ts#L190](file:///C:/myself/projects/my/open-source/lumii/apps/windows/electron.vite.config.ts#L190) — externalize 列表移除 `'@mtbot/client-sdk'`
- [apps/windows/electron.vite.config.ts#L226](file:///C:/myself/projects/my/open-source/lumii/apps/windows/electron.vite.config.ts#L226) — optimizeDeps.exclude 移除 `'@mtbot/client-sdk'`
- [apps/windows/electron.vite.config.ts#L239](file:///C:/myself/projects/my/open-source/lumii/apps/windows/electron.vite.config.ts#L239) — resolve.alias 移除 `'@mtbot/client-sdk'` 映射

---

## 三、第二级：`packages/agent-runtime` 内的 Gateway 死代码分支

### 3.1 LLM 层：Gateway Stream（目前仍被类型导入，实际运行走 Direct）

#### 3.1.1 [llm/gateway-stream.ts](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/src/llm/gateway-stream.ts) — **文件级可删除**

- 632 行，实现 `createGatewayStreamFn`（通过 `POST /v1/llm/stream` 走网关 SSE 代理）
- **运行时**：`bridge-instance-factory.ts` 中 `streamFnFactory` 虽仍传入 gateway 配置，但 `resolveModel` 固定返回 `streamFnKind: 'direct'`（见 [bridge-instance-factory.ts#L447-L460](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-instance-factory.ts#L447-L460)），且 `wrapStreamFn` 外层统一用 `buildLiveDirectStream()` 覆盖（见 [#L337-L364](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-instance-factory.ts#L337-L364)）。故**该函数在独立版从未被真正调用**。
- 但 `bridge-instance-factory`、`bridge-image-services` 中有**类型引用** `ReturnType<typeof createGatewayStreamFn>`，清理时需替换为 `StreamFn` 或 `ReturnType<typeof createDirectStreamFn>`。

#### 3.1.2 [llm/llm-error.ts](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/src/llm/llm-error.ts) — **可移除 Gateway 专属错误码**

包含 `GatewayLlmErrorDetail`、`llmErrorCodeFromHttpStatus`（按 HTTP 状态 401/403/429 推断 gateway 侧错误）、`inferHttpStatusFromMessage`（反向从消息推断 gateway 状态码）。这些仅 gateway-stream 使用，direct 走原生 fetch 错误。**需审查 direct-stream 是否复用了 normalizeLlmError 核心函数，如是则保留核心，删除 Gateway 专属类型。**

#### 3.1.3 [llm/model-router.ts](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/src/llm/model-router.ts) — **注释与 `resolve()` 分支需清理**

- 文件头注释写的是"客户端不再决定模型，由 gateway CapabilityResolver 解析"，与实际 direct 模式相悖。
- `resolve(purpose)` 返回 `{ id: purpose, api: 'openai' }` 占位 Model —— 在独立版中**此路径实际从未命中**（`resolveModel` 当 provider 启用时走 `resolveExplicitModelId`，禁用时抛错）。但为兼容性保留占位逻辑也可，**至少更新注释**。
- `MODEL_API_MAP` 是有用的（用户显式选模型时用），保留。

#### 3.1.4 [llm/index.ts](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/src/llm/index.ts) — 移除 gateway-stream 全部导出

#### 3.1.5 [`__tests__/gateway-error.test.ts`](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/src/__tests__/gateway-error.test.ts) — 整个删除

---

### 3.2 host-kit 装配层：Gateway 工厂分支

文件：[host-kit/stream-fn-factory.ts](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/src/host-kit/stream-fn-factory.ts)

- 暴露 `createGatewayStreamFnFactory` + `GatewayStreamFnFactoryConfig` 接口 + `StreamFnKind = 'gateway' | 'direct'`
- `createStreamFnFactory({ gateway, direct })` 顶层分派
- 建议：**保留 `StreamFnKind` 联合类型（为将来可插拔留扩展点，不占体积）**，但**删除 `GatewayStreamFnFactoryConfig` 与 `createGatewayStreamFnFactory` 具体实现**；或最简化为直接抛错的占位。

---

### 3.3 `packages/agent-runtime/src/index.ts` 顶层导出

当前从 `llm/index.ts` re-export 了 `createGatewayStreamFn`、`DEFAULT_GATEWAY_STREAM_PATH`、`gatewayErrorFromHttpResponse`、`GatewayStreamConfig`、`GatewayStreamDiagnostic`、`StreamMetadata`、`GatewayLlmErrorDetail`、`AssistantMessageWithLlmError`。**删除上述全部 Gateway 专属导出**（见 [index.ts#L123-L137](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/src/index.ts#L123-L137)）。

同文件 host-kit 部分：删除 `createGatewayStreamFnFactory` + `GatewayStreamFnFactoryConfig` 导出（见 [#L462-L469](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/src/index.ts#L462-L469)）。

---

### 3.4 `packages/agent-runtime/dist/` — 旧编译产物

[packages/agent-runtime/dist/llm/](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/dist/llm) 下的 `gateway-stream.d.ts / .js / .map` — **直接删除整个 dist/ 目录**（该包源码直出，不需要 dist；如仍保留则是历史遗留）。

---

## 四、第三级：`apps/windows` 内的 Gateway 配置/类型/死分支（按文件逐个列）

### 4.1 配置类型与默认值

#### 4.1.1 [src/main/config/types.ts](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/main/config/types.ts)

| 条目 | 位置 | 处理建议 |
|------|------|---------|
| `ServerConfig.gatewayUrl` | L12 | **删除该字段**（只保留 `apiUrl`，或整个 `ServerConfig` 视情况再评估，因为 api 也未用） |
| `ServerConfig` 接口 | L8-L13 | 若 `apiUrl` 也死代码，整个接口可删除 |
| `DEFAULT_CONFIG.server.gatewayUrl` | L92 | 删除 `ws://127.0.0.1:18789` 占位 |
| `DEFAULT_CONFIG.server.apiUrl` | L91 | 一并评估是否删除 |

#### 4.1.2 [config/server-config.json](file:///C:/myself/projects/my/open-source/lumii/apps/windows/config/server-config.json)

**整个文件可删除**（或移除 `gatewayUrl` 字段；但从注释 `"Offline placeholders only"` 可看整个文件是无意义占位）。

#### 4.1.3 [.env.example](file:///C:/myself/projects/my/open-source/lumii/apps/windows/.env.example)

开头 L2 已写 "Lumii is offline-first: no gateway / api-server required." — 状态正确，但 `MTBOT_GATEWAY_URL` / `MTBOT_API_URL` 环境变量在 `server-config.ts` 仍读取，**清理 server-config.ts 后文档即自动对齐**。

---

### 4.2 `src/main/server-config.ts`

- 函数 `loadServerConfig()` — **整个评估后可能大幅简化或删除**
- L85 `MTBOT_GATEWAY_URL` / `MTBOT_API_URL` 分支：对应移除
- L113-L119 对 gateway 是否 local 的判断逻辑：删除
- 若 `AppConfig` 中也有对 `ServerConfig` 的引用，按情况清理或降级为仅 workspace 目录等本地配置

---

### 4.3 `src/main/agent-runtime/bridge-types.ts`

[AgentRuntimeBridgeConfig](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-types.ts#L15-L64)：

| 字段 | 行 | 处理 |
|------|----|------|
| `gatewayUrl: string` | L16 | **删除**（改为 optional？或整个删除——实际 direct 路径不需要它，但被 `bridge-image-services` 仍当参数传，需跟下方一并清理） |
| `getAuthToken: () => Promise<string>` | L17 | **删除**（direct 直连不使用；image-service 的 gateway 分支也删） |
| `getDeviceId?: () => string` | L24 | **删除**（仅 gateway token 认证用） |
| `callGateway?: (method, params)` | L62-L64 | **删除**（现已注入为 `async (_method, _params?) => {}` 空实现，见 [main/index.ts#L1006](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/main/index.ts#L1006)） |
| `fetchAgentDefinitionById?` L54-L56 | | 原设计从 gateway API 拉 Agent 定义 → 现走本地 DefinitionStore → **删除** |
| `fetchAgentDefinitionsFromApi?` L58-L60 | | 同上 → **删除** |

---

### 4.4 `src/main/agent-runtime/bridge-instance-factory.ts`

这是引用 Gateway 最重的文件（但运行时全走 direct）。关键清理点：

| 位置 | 代码 | 处理 |
|------|------|------|
| L25 | `import { ... createGatewayStreamFn, DEFAULT_GATEWAY_STREAM_PATH, ... } from '@mtbot/agent-runtime'` | 删除 Gateway 相关导入，保留 `createDirectStreamFn`、`ModelRouter`、`createStreamFnFactory` |
| L77-L80 `CreateSummaryGeneratorFn` 类型 | 签名用了 `ReturnType<typeof createGatewayStreamFn>` | 改为 `StreamFn` 或 `ReturnType<typeof createDirectStreamFn>` |
| L101 `mainInnerStreamRef` 类型 | 同上 | 改签名 |
| L129-L132 `createSummaryGenerator` 参数类型 | 同上 | 改签名 |
| L197 `streamPathOverride = MTBOT_GATEWAY_STREAM_PATH` | 死环境变量 | 删除 |
| L280-L333 `createStreamFnFactory({ gateway: {...}, direct: {...} })` | gateway 对象占 ~50 行死配置 | **删掉 `gateway:` 整个对象**，仅留 `direct:`，并简化 factory 调用 |
| L439-L463 `ConfigProvider.resolveModel` | 其中全部返回 `streamFnKind: 'direct'`，无 gateway 分支 | 保持（行为正确） |
| L673 日志 `gatewayUrl=${this.deps.config.gatewayUrl}` | 打印 127.0.0.1 占位 | 删除该日志字段 |
| L741 `mainInnerStreamRef.value = capturedInnerStream as ReturnType<typeof createGatewayStreamFn>` | as 类型断言 | 改为对应 direct 类型 |
| L748-L751 `InstanceState.stream.innerStream` 类型同上 | | 改 |
| L761-L775 `registerNodeStreamCallback / unregisterNodeStreamCallback` | 纯 Gateway 委派流式回调（"Gateway 委派 Agent 执行时使用"） | **整个删除**（含对应导入 `AgentRuntimeEvent`、bridge.ts 中的 `nodeStreamCallbacks` Map 等） |

---

### 4.5 `src/main/agent-runtime/bridge-image-services.ts` + `gateway-image-client.ts`

#### 4.5.1 [gateway-image-client.ts](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/main/agent-runtime/gateway-image-client.ts) — **整个删除**

129 行，`generateImageViaGateway()` 向 `/v1/image/generate` POST。

#### 4.5.2 [bridge-image-services.ts](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/main/agent-runtime/bridge-image-services.ts)

清理清单：
- L11-L15 `import` 删除 `createGatewayStreamFn`、`DEFAULT_GATEWAY_STREAM_PATH`、`generateImageViaGateway`
- `BridgeImageServicesDeps`（L24-L35）删除 `getGatewayUrl`、`getAuthToken`、`getDeviceId` 三个字段（保留 `getModelRouter`、`getCwd`）
- L44-L66 `getOrCreateRecognitionStream()` —— 当前使用 `createGatewayStreamFn` 创建"图片识别专用 GatewayStream"。但视觉识别在 direct 模式下应走 `createDirectStreamFn`（vision 槽配置）——**替换为 direct 实现（懒创建缓存逻辑保留）**，或在 vision 槽未启用时直接抛错提示用户配置
- `generateImage()` 方法（L225 附近）：删除 Gateway 生图分支与"Gateway 不可用回退直连"的逻辑——现在只有 RightAPI / RightCodesDraw 两条直连路径

---

### 4.6 `src/main/agent-runtime/bridge.ts` 主类

读取了前 200 行，可见：
- L16 `import { createGatewayStreamFn, DEFAULT_GATEWAY_STREAM_PATH, ... } from '@mtbot/agent-runtime'` → 删除 Gateway 导入
- L200 `mainInnerStreamRef: { value: ReturnType<typeof createGatewayStreamFn> | null }` → 改类型
- 类构造中向 `BridgeInstanceFactory`、`BridgeImageServices` 传入的 `gatewayUrl`、`getAuthToken`、`getDeviceId`、`callGateway` 等 deps → **全部停止传入**（对应工厂构造点在 main/index.ts）

---

### 4.7 `src/main/index.ts` 主进程入口（3000+ 行）

通过 grep 定位到以下 Gateway 条目：

| 行 | 内容 | 处理 |
|----|------|------|
| L7 | 注释 "与 Gateway 建立 WebSocket 连接" | 删除该注释段 |
| L324 | 注释 "允许连接到配置的 Gateway 地址" | CSP 需同步移除 gatewayUrl 来源（见下条） |
| L408 | "配置 CSP 允许连接到 Gateway" | 从 CSP connect-src 中移除 `config.gatewayUrl` / 动态占位的网关域名 |
| L759-L762 | `rawGatewayUrl = config.gatewayUrl` → `gatewayUrl = replace ws→http` → 传给 bridge.config | 删除，构造 bridge 时不再传 gatewayUrl |
| L1006 | `callGateway: async (_method, _params?) => { /* empty */ }` | 移除 callGateway 注入（对应 bridge-types 字段已删） |
| L1851 | `ipcMain.handle('app:updateServerConfig', ... gatewayUrl ...)` | 若 ServerConfig 整体简化，此处同步改 |
| L2308 | 注释"手动刷新：重新扫描本地技能目录并上报到 Gateway" | 改注释为"重新扫描本地技能目录"（删除上报 Gateway） |
| L2386 | 注释 "独立版不依赖云端 Gateway" | 保留（正确描述事实） |
| L2453 | 注释"避免继续走创建时快照的 Gateway/旧凭据" | 改或删 |
| L3032-L3034 | `getGatewayUrl()` getter | 删除（仅 bridge-image-services 旧代码用） |
| L3135 | `// 不构造 apiClient / gatewayClient / nodeModeCoordinator / devicePairingService` | **保留这条注释并扩充**——它是独立版的关键文档；但可在末尾注明"相关代码见 §2 删除清单" |

---

### 4.8 Preload (`src/preload/index.ts`)

ElectronAPI 中暴露了 Gateway 相关 RPC：

| 位置 | 条目 | 处理建议 |
|------|------|---------|
| L316 | `getServerConfig: () => Promise<{ apiUrl: string; gatewayUrl: string }>` | 若保留 `apiUrl` 则简化为 `{ apiUrl?: string }`；若全删则移除该 RPC |
| L317 | `updateServerConfig: (config: Partial<{ gatewayUrl: string; apiUrl: string }>)` | 同上 |
| L675-L678 | `listAllSkills()`（"通过 Gateway WS"）+ `listNodes()`（"获取 Gateway 节点列表"） | **两个 RPC 整个删除**（技能列表现走本地 skill-store，节点列表在独立版无意义） |
| L875-L876 | `refresh: () => Promise<{success, count}>` 注释"上报到 Gateway" | 更新注释为"刷新本地技能扫描缓存" |
| L1269-L1270 | 对应上述类型的实现侧签名 | 同步更新 |

---

### 4.9 Renderer 层

#### 4.9.1 `useSettings` hook 与类型

- [useSettings.types.ts#L5-L109](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/renderer/hooks/business/useSettings/useSettings.types.ts) — 定义了 `GatewayConfig { url, autoConnect, wsUrl? ... }` 接口与 `AllSettings.gateway: GatewayConfig` 字段
- [useSettings.ts#L32](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/renderer/hooks/business/useSettings/useSettings.ts#L32) — `DEFAULT_SETTINGS.gateway` 默认值
- [useSettings.ts#L132-L198](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/renderer/hooks/business/useSettings/useSettings.ts#L132-L198) — `load()` 中对 `base.gateway` 做云端 URL → 本地占位的替换 + 强制 `autoConnect:false`
- [useSettings.ts#L248-L252](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/renderer/hooks/business/useSettings/useSettings.ts#L248-L252) — `updateGateway()` 方法
- [useSettings.ts#L362](file:///C:/myself/projects/my/open-source/lumii/apps/windows/src/renderer/hooks/business/useSettings/useSettings.ts#L362) — 导出 `updateGateway`

**处理：** 整个删除 `GatewayConfig` 接口、`AllSettings.gateway` 字段、`DEFAULT_SETTINGS.gateway`、`updateGateway` 方法、load() 中的 gateway 合并逻辑。相应 SettingsPage UI 若有网关连接面板也删（本次分析未查 UI 组件，需后续扫 SettingsPage 子组件）。

#### 4.9.2 业务组件中残留引用

grep 找到 20 个 renderer 文件命中"gateway"关键词：
- ChatPage / ChatMessage / ChatContainer — 可能是显示 `agent:llm:diagnostic` 事件（fallback/http_error 源于 gateway-stream 的 diagnostic 回调；删除 gateway-stream 工厂后此事件源消失）
- TitleBar / SkillsPage / DeviceCard / DualConnectionStatus / DeviceBindWizard — **DualConnectionStatus、DeviceCard、DeviceBindWizard 极可能是旧 Gateway 双连接架构 + 设备配对 UI，整个可删**
- useWorkspace / useCron / usePipelines / SkillStoreView / CodingDevAcpPanel 等 — 多是读取 env 片段或旧注释（如 `powershellGatewayEnvBlock`）

**建议后续阶段对上述 20 个文件做第二轮精细 grep（按行内容而非仅文件名）**，但大方向：
- 删除 DeviceBindWizard、DualConnectionStatus、DeviceCard 组件（Gateway 设备专属 UI）
- 逐一修 comment / dead import

---

## 五、第四级：环境变量残留

在 `apps/windows/src/main/` grep 的 env 变量名与 Gateway 相关：

| 变量名 | 出现位置 | 状态 |
|--------|---------|------|
| `MTBOT_GATEWAY_URL` | server-config.ts, main/index.ts(L1851) | 可删除 |
| `MTBOT_GATEWAY_STREAM_PATH` | bridge-instance-factory, bridge-image-services | 可删除 |
| `MTBOT_IMAGE_DIRECT_ONLY` | provider-config.ts `applyImageSlotToDrawEnv` | 反向变量——"关掉 Gateway 路径"。删掉整条 set 逻辑 |
| `MTBOT_API_URL` | server-config.ts | 同评估 apiUrl 是否死代码 |
| `LANGSEARCH_*` / `SEARXNG_*` | web_search 相关，非 Gateway | 保留（仍是可选功能） |

---

## 六、第五级：文档与注释（不影响编译，最后清理）

### 6.1 顶层 [README.md](file:///C:/myself/projects/my/open-source/lumii/README.md)

- L17："Gateway 是可选的远程扩展通道，非核心路径" → **改文案**，体现"Gateway 时代已结束，当前完全本地运行"
- L101-L102：共享包表格中 `@mtbot/protocol`、`@mtbot/client-sdk` 两行 → **删除**
- L150 后目录树：`protocol/ # Gateway 协议类型门面`、`client-sdk/ # ...客户端原语` 两行 → **删除**

### 6.2 [CLAUDE.md](file:///C:/myself/projects/my/open-source/lumii/CLAUDE.md)

已准确写了"gateway 是可选的远程通道，本地模式不需要"。但 §架构 中：
- 对 `packages/protocol`、`packages/client-sdk` 的描述 → 删除（两包删后）
- §Agent 运行时："renderer 通过 `src/main/ipc/agent-runtime-ipc.ts` 与之通信"前面 gateway 的描述可微调

### 6.3 `docs/standards/` 文档（**整个目录强烈建议整体清理或标记过期**）

| 文件 | 命中内容 | 建议 |
|------|---------|------|
| [dual-connection-architecture.md](file:///C:/myself/projects/my/open-source/lumii/docs/standards/dual-connection-architecture.md) | **整个文件讲 Gateway 双连接（UI Token + Node Token）**，所有架构图、代码清单、验证清单都指向旧时代 | **整个删除或重命名为 `.md.deprecated`** |
| [project-structure.md](file:///C:/myself/projects/my/open-source/lumii/docs/standards/project-structure.md) | 列出 `gateway-client.ts`、`node-connection.ts`、`useGateway/`、`gateway-service.ts`、架构图 `A→C[网关客户端 Gateway Client]` | 更新：删除 Gateway 相关条目，重新映射主进程模块表 |
| [feature-development-standards.md](file:///C:/myself/projects/my/open-source/lumii/docs/standards/feature-development-standards.md) | L47、L143、L178 等同上 | 同步更新 |
| [improvements-summary.md](file:///C:/myself/projects/my/open-source/lumii/docs/standards/improvements-summary.md) | L19 "hooks 列表新增 useGateway" | 更新 hooks 列表 |

### 6.4 `docs/plans/` 与 `docs/design/` 历史计划

| 文件 | 处理 |
|------|------|
| [大文件重构分析处理/code-location-index.md](file:///C:/myself/projects/my/open-source/lumii/docs/plans/%E5%A4%A7%E6%96%87%E4%BB%B6%E9%87%8D%E6%9E%84%E5%88%86%E6%9E%90%E5%A4%84%E7%90%86/code-location-index.md) | 引用 gateway 位置 → 更新或保持（历史文件） |
| [2026-08-05-ui-tech-refresh-client-implementation.md](file:///C:/myself/projects/my/open-source/lumii/docs/plans/2026-08-05-ui-tech-refresh-client-implementation.md) | 历史计划，保留但不强制更新 |
| [2026-08-14-channel-outbound-hub-design.md](file:///C:/myself/projects/my/open-source/lumii/docs/design/2026-08-14-channel-outbound-hub-design.md) | P5 "message 工具与 Gateway 耦合" L90、L236、L417、L454 — 多处注明 Gateway 遗留分支**已移除**（✅ 标注）。该文件本身是设计文档，保持为历史记录即可。 |

**原则：** `docs/plans/` / `docs/design/` 是**历史记录**，非必须同步修改；但 `docs/standards/` 是当前开发标准，必须更新。

---

## 七、第六级：dist/ 与编译产物

- [packages/agent-runtime/dist/llm/gateway-stream.*](file:///C:/myself/projects/my/open-source/lumii/packages/agent-runtime/dist/llm) — 直接删除（源码直出项目不应保留 dist，如有 .gitignore 已忽略则可能无需手动删）
- 同样检查 `packages/protocol/dist`、`packages/client-sdk/dist` 是否存在（若存在随包一起删）

---

## 八、风险评估与删除顺序建议

### 风险分级

| 级别 | 内容 | 破坏性 | 验证方式 |
|------|------|--------|---------|
| 🟢 无风险 | 删 `packages/protocol`、`packages/client-sdk` 整个包 + 对应依赖声明 + alias | 编译期立即暴露遗漏引用 | `pnpm typecheck` + `pnpm build` 不报错即可 |
| 🟢 无风险 | 删 `packages/agent-runtime/src/__tests__/gateway-error.test.ts` | 只影响测试 | 测试跑通 |
| 🟡 低风险 | 删 `llm/gateway-stream.ts` + 对应导出 + `createGatewayStreamFnFactory` | 有类型引用，需同步替换 `ReturnType<typeof createGatewayStreamFn>` 为 `StreamFn` | `pnpm typecheck` + 启动对话图片识别生图全跑一遍 |
| 🟡 低风险 | 删 `gateway-image-client.ts` + `bridge-image-services.ts` 中 Gateway 分支 | 需要验证 vision 槽 direct 路径在启用时可用 | 对图生文 + 文生图各做 1 次手动测试 |
| 🟡 低风险 | `bridge-instance-factory.ts` 中 gateway: {...} 工厂配置移除 | 只删初始化代码，行为不变 | 发送 2-3 轮 Agent 对话（含工具调用） |
| 🟠 中风险 | `bridge-types.ts` 删 `gatewayUrl/getAuthToken/callGateway` 字段 | 多个构造点 deps 传参要同步断 | 需全局搜 `new AgentRuntimeBridge({` 等所有构造点 |
| 🟠 中风险 | `preload/index.ts` 删除 `listAllSkills / listNodes` IPC + Settings gateway 字段 | Renderer 对应调用点需同步删 | Settings 打开 + SkillsPage 打开不报错 |
| 🔴 需谨慎 | 删除 `ServerConfig.gatewayUrl / apiUrl` + `loadServerConfig` 简化 | 可能波及 CSP、工作目录、.env 解析 | 必须先搜 `serverConfig`、`apiUrl` 全部使用点 |
| 🟢 无风险 | 文档更新 | 纯文案 | 人工通读 README / standards 关键段落 |

### 推荐执行顺序（由易到难、每步独立验证）

```
Phase 1 — 删整包（风险最低，编译即验证）
  └─ Step 1: rm -rf packages/protocol  packages/client-sdk
  └─ Step 2: 同步清理 3 处 package.json + electron.vite.config.ts（alias/external/exclude）
  └─ Step 3: pnpm install  # 更新 workspace
  └─ Step 4: pnpm typecheck 全量（暴露遗漏的 @mtbot/protocol / client-sdk import）
  └─ Step 5: pnpm build（验证构建期通过）

Phase 2 — agent-runtime 包内清理
  └─ Step 6: 删 packages/agent-runtime/src/llm/gateway-stream.ts
             删 packages/agent-runtime/src/__tests__/gateway-error.test.ts
             删 packages/agent-runtime/dist/（若存在）
  └─ Step 7: 精简 llm/model-router.ts 注释；保留核心 API
  └─ Step 8: 精简 llm/index.ts、host-kit/stream-fn-factory.ts（删 gateway 工厂 + 类型）
  └─ Step 9: 更新 packages/agent-runtime/src/index.ts 顶层导出
  └─ Step 10: pnpm --filter @mtbot/agent-runtime typecheck + test

Phase 3 — apps/windows 主进程
  └─ Step 11: 删 gateway-image-client.ts；重写 bridge-image-services.ts（走 direct vision + RightAPI/RightCodesDraw）
  └─ Step 12: bridge-types.ts 删 gatewayUrl / getAuthToken / getDeviceId / callGateway / fetchAgentDefinition*
  └─ Step 13: bridge-instance-factory.ts → 移除 gateway: {...} 工厂配置 + NodeStream 回调注册 + 类型断言改
  └─ Step 14: bridge.ts → 导入清理 + deps 断传
  └─ Step 15: main/index.ts → CSP 移除 gateway 域名、构造 bridge 少传 4 个字段、getGatewayUrl getter 删除、callGateway 空实现删除、注释清理
  └─ Step 16: pnpm --filter lumii-windows typecheck

Phase 4 — apps/windows preload + renderer
  └─ Step 17: preload/index.ts → listAllSkills / listNodes / gatewayUrl 类型签名简化
  └─ Step 18: useSettings → 删 GatewayConfig + updateGateway + AllSettings.gateway
  └─ Step 19: 第二轮精细 grep renderer 20 文件 → 删 DeviceBindWizard / DualConnectionStatus / DeviceCard
  └─ Step 20: pnpm --filter lumii-windows test + 手动启动应用冒烟

Phase 5 — 配置 + 文档（最后）
  └─ Step 21: 评估 config/types.ts 中 ServerConfig 是否可整体简化/删除；同步 server-config.ts、server-config.json、.env.example
  └─ Step 22: 更新 README.md（删 protocol/client-sdk 两行 + 文案微调）
  └─ Step 23: 更新 CLAUDE.md §packages 列表
  └─ Step 24: docs/standards/ → project-structure / feature-standards 更新，dual-connection-architecture.md 标记为 deprecated
  └─ Step 25: 运行 pnpm typecheck && pnpm build && pnpm dist:dir 三件套全绿
```

---

## 九、验证清单（全部通过才算完成）

1. ✅ `pnpm typecheck` — workspace 全量无 TS 报错
2. ✅ `pnpm --filter lumii-windows build` — electron-vite 三进程构建成功
3. ✅ `pnpm --filter @mtbot/agent-runtime test` — agent-runtime 单测全绿
4. ✅ `pnpm --filter lumii-windows test` — 现有 vitest 用例全绿
5. ✅ 手动启动：主窗口正常打开，ChatPage / AgentsPage / SkillsPage / SettingsPage 4 个核心页不抛错
6. ✅ 手动对话一轮：主 Agent（本地已配 provider 情况下）回复正常（证明 direct stream 路径不受影响）
7. ✅ 图片识别（新会话首条消息直接传图）：走 vision 槽或给出明确提示"请先配置 vision 模型"（而非走 Gateway 占位失败）
8. ✅ 文生图：image_generate 工具调用走 RightAPI / RightCodesDraw 或明确提示"请先配置 image 槽"（而非 Gateway AUTH_REQUIRED）
9. ✅ 渠道适配器（微信/企微/飞书）：入站消息 → Agent → 回复，链路不触发 gateway 相关未定义

---

## 十、附录：快速 grep 命令备查（每删完一轮自检用）

```bash
# workspace 根目录
grep -rln "@mtbot/protocol\|@mtbot/client-sdk" --include="*.ts" --include="*.tsx" --include="*.json" apps packages

grep -rln "gatewayUrl\|MTBOT_GATEWAY\|createGatewayStreamFn\|GatewayStream\|callGateway\|listAllSkills\|listNodes" \
  --include="*.ts" --include="*.tsx" apps/windows/src packages/agent-runtime/src

# 仅看 renderer 侧
grep -rln "gateway" --include="*.tsx" --include="*.ts" apps/windows/src/renderer
```
