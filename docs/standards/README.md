# Business Hooks - 业务 Hooks 重构

基于原代码 `apps/windows/src/renderer/hooks/` 目录重构的业务 Hooks。

## 重构原则

1. **使用通用 Hooks**：所有业务 Hooks 基于 `useAsync`、`useQuery`、`useMutation`、`useLocalStorage`、`usePagination` 等通用 Hooks 构建
2. **提取类型定义**：每个 Hook 都有独立的 `*.types.ts` 文件
3. **简化重复逻辑**：利用通用 Hooks 消除重复的状态管理代码
4. **完整的 TypeScript 类型**：所有接口和函数都有完整的类型定义
5. **统一导出结构**：每个 Hook 包含 `types.ts`、`hook.ts` 和 `index.ts`

## 文件对应关系

| 新 Hook | 原代码文件 | 说明 |
|---------|-----------|------|
| `useAuth` | `useAuth.ts` | 认证管理（登录/注册/登出/Token刷新） |
| `useCredits` | `useCredits.ts` | 积分管理（余额/流水/邀请统计） |
| `useSkills` | `useSkills.ts` | 技能管理（已安装技能/启用禁用） |
| `useFiles` | `useFileManager.ts` | 文件管理（目录导航/文件操作） |
| `useChat` | `useChatStream.ts` + `useChatHistory.ts` | 对话管理（会话/消息/流式响应） |
| `useGateway` | `useConnectionStatus.ts` | 网关连接（连接状态/自动重连） |
| `useSystem` | `useSystemMonitor.ts` | 系统监控（CPU/内存/磁盘/进程） |
| `useDashboard` | `useDashboard.ts` | 仪表盘数据（订阅/统计/设备） |
| `useSettings` | `useSettings.ts` | 设置管理（工作空间/配置） |
| `useMemories` | `useMemories.ts` | 记忆管理（记忆列表/类型过滤） |
| `useSubscription` | `useSubscription.ts` + `usePayment.ts` | 订阅管理（计划/支付） |
| `useAuditLog` | `useAuditLog.ts` | 审计日志（查询/过滤/导出） |

## 目录结构

```
hooks/business/
├── index.ts                    # 统一导出
├── README.md                   # 本文档
├── useAuth/
│   ├── useAuth.types.ts       # 类型定义
│   ├── useAuth.ts             # Hook 实现
│   └── index.ts               # 统一导出
├── useCredits/
│   ├── useCredits.types.ts
│   ├── useCredits.ts
│   └── index.ts
├── useSkills/
│   ├── useSkills.types.ts
│   ├── useSkills.ts
│   └── index.ts
├── useFiles/
│   ├── useFiles.types.ts
│   ├── useFiles.ts
│   └── index.ts
├── useChat/
│   ├── useChat.types.ts
│   ├── useChat.ts
│   └── index.ts
├── useGateway/
│   ├── useGateway.types.ts
│   ├── useGateway.ts
│   └── index.ts
├── useSystem/
│   ├── useSystem.types.ts
│   ├── useSystem.ts
│   └── index.ts
├── useDashboard/
│   ├── useDashboard.types.ts
│   ├── useDashboard.ts
│   └── index.ts
├── useSettings/
│   ├── useSettings.types.ts
│   ├── useSettings.ts
│   └── index.ts
├── useMemories/
│   ├── useMemories.types.ts
│   ├── useMemories.ts
│   └── index.ts
├── useSubscription/
│   ├── useSubscription.types.ts
│   ├── useSubscription.ts
│   └── index.ts
└── useAuditLog/
    ├── useAuditLog.types.ts
    ├── useAuditLog.ts
    └── index.ts
```

## 使用方法

```typescript
// 方式1：从 business 总入口导入
import { useAuth, useCredits, useChat } from './business'

// 方式2：从具体模块导入
import { useAuth, User, LoginParams } from './business/useAuth'
import { useCredits, CreditBalance } from './business/useCredits'
```

## 主要改进

### 1. 状态管理简化
- 使用 `useQuery` 替代手动 useState + useEffect + useCallback 组合
- 使用 `useMutation` 处理数据修改操作
- 使用 `useLocalStorage` 处理持久化状态

### 2. 类型安全增强
- 所有 API 响应都有专门的类型定义
- 使用 TypeScript 严格模式检查

### 3. 错误处理统一
- 统一的错误状态和错误处理逻辑
- 通过通用 Hooks 提供错误重试机制

### 4. 加载状态管理
- 统一的 isLoading 状态
- 支持细粒度的加载状态控制

### 5. 代码复用提高
- 通过通用 Hooks 消除重复代码
- 统一的缓存和刷新策略
