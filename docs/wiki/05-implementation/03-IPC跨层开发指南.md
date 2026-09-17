# IPC 跨层开发指南

本文档描述 Lumii 三层 IPC（Electron Main / Preload / Renderer）从 0 到 1 的完整开发步骤、编写规范、错误处理模式与现有代码示例位置。

项目总纲 `AGENTS.md` 第 5 条明确要求：**凡新增 IPC，必须同步更新 main handler、preload `ElectronAPI` 类型与方法、renderer 调用方三方，缺一处即视为开发未完成**。

---

## 一、IPC 三层变更的开发步骤（明确步骤清单）

无论多小的 IPC，严格按以下 7 步走，不允许跳步后补。

### Step 1：定义通道签名与往返类型

**在设计文档或实施计划的 IPC 三处同步表中先填表**，再写任何代码。

**通道命名格式**：`<domain>:<action>`，全部小写 kebab-case。
- ✅ `cloudSync:getConfig` / `vcs:diff` / `channel:send`
- ❌ `getCloudSyncConfig`（无冒号 + 驼峰）
- ❌ `data:get`（domain 过泛，谁也找不到）

**类型定义位置**：
- 共享类型：`packages/pet-core/src/types/<domain>.ts`（纯数据、无 DOM/Electron 依赖）
- Electron 专有类型：`apps/windows/src/main/services/<domain>/types.ts` 或就近
- Preload 端 Window 扩展：下文 Step 4

**示例签名**（以云同步设置页为例）：

```typescript
// 共享：packages/pet-core/src/types/cloud-sync.ts
export interface CloudSyncConfig {
  enabled: boolean;
  provider: 'gitcode' | 'github' | 'custom';
  remoteUrl: string;
  accessToken: string;          // main 侧读取时始终掩码返回
  syncIntervalSec?: number;
  repoPath?: string;
}

export interface SyncStatus {
  status: 'idle' | 'syncing' | 'error';
  lastSyncAt?: number;
  progress?: number;
  errorMessage?: string;
}

// 统一返回包：{ ok, data?, error? }
export interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; };
}
```

### Step 2：写 Main Handler（主进程）

在 `apps/windows/src/main/services/<domain>/` 下写，遵循本章 §二 规范。要点：
- 所有 I/O 包 `try/catch`，永远不把原生异常抛给 renderer。
- 输入参数跑 `typeof` / schema 校验，不信任 renderer 传参。
- 返回统一格式 `{ ok:boolean, data?, error?: {code, message} }`。
- 日志打 INFO（操作）/ WARN（失败）/ ERROR（异常），敏感字段掩码。

### Step 3：写 Preload 桥接

在 `apps/windows/src/preload/index.ts` 的 `contextBridge.exposeInMainWorld('electronAPI', {...})` 中嵌套分组暴露。遵循 §三 规范。要点：
- **绝对不能暴露 `ipcRenderer`**。只暴露「已白名单化」的具体函数。
- 通道名完全对齐 Step 2 的 `ipcMain.handle` 注册名。
- 事件（`cloudSync:status` 之类）用 `ipcRenderer.on/off` 包装成 `onStatus(callback) => offFn` 形式。

### Step 4：写 Preload 类型定义

在 `apps/windows/src/renderer/types/electron.d.ts`（或项目现有的全局 d.ts）扩展 `Window` 上的 `electronAPI`。要点：
- 每一层（`cloudSync`、`channelService`、`vcs`）都单独写 interface。
- 参数 / 返回值类型完全对齐 Step 1 的共享类型，禁止 `any`。

### Step 5：封装 Renderer 服务层调用

在 `apps/windows/src/renderer/services/<domain>-service.ts` 写薄封装层。要点：
- 只在这一层访问 `window.electronAPI.*`，Page/Hook 不直接调。
- 包一层 `try/catch`：把网络异常、ipc 异常统一转换成应用级 `AppError`。
- 提供 `async` / `Promise` API，UI 侧配合 `useQuery` / `useMutation`。
- `onStatus` 类事件订阅返回一个 `unsubscribe`，组件卸载时必须清理，防泄漏。

### Step 6：写单元测试（三层都测）

| 层 | 测什么 | 文件放置 |
|----|-------|---------|
| Main | 参数校验、异常包装、返回 `{ok:false,error}` 的所有分支 | `main/services/<domain>/__tests__/<domain>-ipc.test.ts`，mock `ipcMain.handle` 实际走 handler 函数 |
| Preload | 桥接函数存在、参数个数对、事件订阅能 on 能 off | `preload/__tests__/electron-api.test.ts`，mock `contextBridge` + `ipcRenderer` |
| Renderer | service 层调用 window.electronAPI、错误转为 AppError、unsubscribe 生效 | `renderer/services/__tests__/<domain>-service.test.ts`，mock `window.electronAPI` |

### Step 7：端到端手工验证并打勾

在测试手测清单上逐项打勾（至少 6 项）：
- [ ] 调成功：UI 拿到 `data`，loading 消失
- [ ] 调失败：UI 看到 ErrorBanner，toast 正确文案
- [ ] 参数错误：main 侧打 WARN，renderer 拿 `{ok:false,error.code='PARAM_ERROR'}`
- [ ] 权限错误（如涉及）：弹权限确认 / 系统设置引导
- [ ] 深主题 / 浅主题切换不破坏 UI 布局
- [ ] 快捷键 Esc 关闭、弹窗 Ctrl+S 保存、Enter 提交都生效
- [ ] 刷新页面、重启应用后，订阅无泄漏（无重复回调触发）

---

## 二、主进程 Handler 编写规范

### 2.1 代码位置与注册方式

**文件**：`apps/windows/src/main/services/<domain>/<domain>-ipc.ts`（或与 service 同目录）
**注册入口**：`apps/windows/src/main/index.ts` 的 `registerIpcHandlers()` 内，按 domain 分组 `import`。

```typescript
// apps/windows/src/main/index.ts
import { registerCloudSyncIpc } from './services/cloud-sync/cloud-sync-ipc';
import { registerChannelIpc } from './services/channel/channel-ipc';

function registerIpcHandlers() {
  registerCloudSyncIpc();
  registerChannelIpc();
  // ...
}
```

### 2.2 Handler 函数签名与统一返回格式

```typescript
import { ipcMain } from 'electron';
import type { CloudSyncConfig, SyncStatus, IpcResult } from '@lumii/pet-core/types/cloud-sync';
import { validate } from './validators';  // 本地校验 helper
import { AppError } from '../../errors';   // 统一错误基类

export function registerCloudSyncIpc() {

  ipcMain.handle('cloudSync:getConfig',
    async (_event): Promise<IpcResult<CloudSyncConfig>> => {
      try {
        // 2.3 业务逻辑，内部所有 I/O 都 try/catch
        const cfg = await cloudSyncManager.getConfig();
        // 2.4 敏感字段永远掩码返回：ghp_****abcd
        cfg.accessToken = maskToken(cfg.accessToken);
        return { ok: true, data: cfg };
      } catch (err) {
        const appErr = AppError.wrap(err, 'CLOUD_SYNC_GET_CONFIG_FAILED');
        log.warn('[cloudSync:getConfig]', appErr.code, appErr.safeMessage);
        return { ok: false, error: { code: appErr.code, message: appErr.safeMessage } };
      }
    });

  ipcMain.handle('cloudSync:setConfig',
    async (_event, raw: unknown): Promise<IpcResult<void>> => {
      try {
        // 2.3 参数校验：不信任 renderer，typeof 或 schema 双保险
        const parsed = validateCloudSyncConfig(raw);  // 抛 AppError(PARAM_ERROR)
        await cloudSyncManager.setConfig(parsed);
        return { ok: true };
      } catch (err) {
        const appErr = AppError.wrap(err, 'CLOUD_SYNC_SET_CONFIG_FAILED');
        log.warn('[cloudSync:setConfig]', appErr.code);
        return { ok: false, error: { code: appErr.code, message: appErr.safeMessage } };
      }
    });

  // 事件：main → renderer（renderer 侧 on 订阅）
  cloudSyncManager.on('status-change', (state: SyncStatus) => {
    BrowserWindow.getAllWindows().forEach(w => {
      w.webContents.send('cloudSync:status', state);
    });
  });
}
```

### 2.3 输入校验（主进程是信任边界）

**主进程永远不要信任 renderer 传参**。任何参数先跑校验，非法就抛：

```typescript
// validators.ts
import { AppError } from '../errors';

export function validateCloudSyncConfig(raw: unknown): CloudSyncConfig {
  if (!raw || typeof raw !== 'object') {
    throw new AppError('PARAM_ERROR', 'config 必须是对象');
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== 'string' ||
      !['gitcode', 'github', 'custom'].includes(r.provider)) {
    throw new AppError('PARAM_ERROR', 'provider 必须是 gitcode/github/custom');
  }
  if (typeof r.remoteUrl !== 'string' || !isHttpUrl(r.remoteUrl)) {
    throw new AppError('PARAM_ERROR', 'remoteUrl 必须是合法 http(s) URL');
  }
  // accessToken 允许空串（用户尚未填），非空时最小长度 8
  if (typeof r.accessToken !== 'string' ||
      (r.accessToken.length > 0 && r.accessToken.length < 8)) {
    throw new AppError('PARAM_ERROR', 'accessToken 非法');
  }
  return raw as CloudSyncConfig;
}
```

### 2.4 错误包装（AppError + 稳定 errorCode）

```typescript
// apps/windows/src/main/errors.ts
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) { super(message); }

  // 暴露给 renderer 的安全 message（不含堆栈、不含路径、不含 token）
  get safeMessage(): string {
    if (SAFE_CODES.has(this.code)) return this.message;
    return '服务器开小差了，请稍后重试（错误码：' + this.code + '）';
  }

  static wrap(err: unknown, defaultCode: string): AppError {
    if (err instanceof AppError) return err;
    return new AppError(defaultCode,
      err instanceof Error ? err.message : String(err), err);
  }
}

// 允许直接把 message 抛给用户看的白名单码
const SAFE_CODES = new Set([
  'PARAM_ERROR', 'PERMISSION_DENIED', 'NOT_FOUND', 'CONFLICT',
  'INVALID_CREDENTIALS', 'LOW_DISK', 'NETWORK_ERROR',
]);
```

### 2.5 日志要求

- `ok:true` 的普通操作 → `log.verbose('[cloudSync:getConfig] ok')`，不打完整 data
- 参数校验失败 → `log.warn('[cloudSync:setConfig] PARAM_ERROR', { field: 'provider' })`
- 异常捕获 → `log.error('[cloudSync:setConfig]', appErr.code, appErr.stack ?? appErr.message)`
- **永远不 log token/context_token/用户消息原文**，URL 中的 Basic Auth 必须掩码。

---

## 三、Preload 桥接层的类型定义规范

### 3.1 文件位置与暴露方式

- 桥接实现：`apps/windows/src/preload/index.ts`
- 全局类型扩展：`apps/windows/src/renderer/types/electron.d.ts`（或项目现有 d.ts）
- 暴露方式：`contextBridge.exposeInMainWorld('electronAPI', {...})`

### 3.2 安全红线（必须牢记）

1. **永远不暴露 `ipcRenderer` 对象本身**，包括 `.invoke` `.send` `.on` 原始方法。
2. 只暴露白名单中的具体函数：如 `electronAPI.cloudSync.getConfig()`，而不是 `electronAPI.invoke(channel, args)`。
3. 回调函数必须经过 `contextBridge` 「可序列化」检查；不把 Electron `Event` 对象直接传给 renderer。
4. **最小暴露原则**：新增一个 domain 就加一个嵌套对象，不要全塞顶层。

### 3.3 桥接实现（index.ts 示例）

```typescript
// apps/windows/src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';
import type { CloudSyncConfig, SyncStatus, IpcResult } from '@lumii/pet-core/types/cloud-sync';
import type { ChannelPeer, ChannelSendParams, ChannelSendResult } from '@lumii/pet-core/types/channel';

contextBridge.exposeInMainWorld('electronAPI', {

  // ---------- 分组：cloudSync ----------
  cloudSync: {
    getConfig: (): Promise<IpcResult<CloudSyncConfig>> =>
      ipcRenderer.invoke('cloudSync:getConfig'),

    setConfig: (cfg: CloudSyncConfig): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('cloudSync:setConfig', cfg),

    testConnection: (): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('cloudSync:testConnection'),

    getStatus: (): Promise<IpcResult<SyncStatus>> =>
      ipcRenderer.invoke('cloudSync:getStatus'),

    syncNow: (): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('cloudSync:syncNow'),

    // 事件：返回一个 unsubscribe 函数
    onStatus: (cb: (s: SyncStatus) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, s: SyncStatus) => cb(s);
      ipcRenderer.on('cloudSync:status', listener);
      return () => ipcRenderer.off('cloudSync:status', listener);
    },
  },

  // ---------- 分组：channelService ----------
  channelService: {
    list: (onlyActive?: boolean): Promise<IpcResult<ChannelPeer[]>> =>
      ipcRenderer.invoke('channel:list', onlyActive),

    send: (params: ChannelSendParams): Promise<IpcResult<ChannelSendResult>> =>
      ipcRenderer.invoke('channel:send', params),
  },

  // ---------- 其他分组：vcs / voice / workspace / autonomous … ----------
});
```

### 3.4 全局类型扩展（Window.electronAPI）

```typescript
// apps/windows/src/renderer/types/electron.d.ts
import type { CloudSyncConfig, SyncStatus, IpcResult } from '@lumii/pet-core/types/cloud-sync';
import type { ChannelPeer, ChannelSendParams, ChannelSendResult } from '@lumii/pet-core/types/channel';

export interface ElectronCloudSyncApi {
  getConfig(): Promise<IpcResult<CloudSyncConfig>>;
  setConfig(cfg: CloudSyncConfig): Promise<IpcResult<void>>;
  testConnection(): Promise<IpcResult<void>>;
  getStatus(): Promise<IpcResult<SyncStatus>>;
  syncNow(): Promise<IpcResult<void>>;
  onStatus(cb: (s: SyncStatus) => void): () => void;
}

export interface ElectronChannelApi {
  list(onlyActive?: boolean): Promise<IpcResult<ChannelPeer[]>>;
  send(params: ChannelSendParams): Promise<IpcResult<ChannelSendResult>>;
}

declare global {
  interface Window {
    electronAPI: {
      cloudSync: ElectronCloudSyncApi;
      channelService: ElectronChannelApi;
      // vcs / voice / workspace / autonomous / device …
      device: {
        getPairingInfo(): Promise<IpcResult<{ pairId: string; pubKey: string; }>>;
      };
    };
  }
}

export {};
```

---

## 四、渲染进程调用方的使用方式

### 4.1 先建 service 薄封装层

**禁止 Page/Hook 直接调 `window.electronAPI`**。统一走 `apps/windows/src/renderer/services/`：

```typescript
// apps/windows/src/renderer/services/cloud-sync-service.ts
import { AppError } from '../errors';  // renderer 侧同名 AppError
import type { CloudSyncConfig, SyncStatus } from '@lumii/pet-core/types/cloud-sync';

export async function getCloudSyncConfig(): Promise<CloudSyncConfig> {
  const r = await window.electronAPI.cloudSync.getConfig();
  if (!r.ok) throw AppError.fromIpc(r.error);
  return r.data!;
}

export async function setCloudSyncConfig(cfg: CloudSyncConfig): Promise<void> {
  const r = await window.electronAPI.cloudSync.setConfig(cfg);
  if (!r.ok) throw AppError.fromIpc(r.error);
}

export function subscribeCloudSyncStatus(
  cb: (s: SyncStatus) => void,
): () => void {
  // service 层保证：即使 cb 抛，也不会泄漏到桥接层
  const safeCb = (s: SyncStatus) => {
    try { cb(s); } catch (e) { console.error('[cloudSync] status cb error', e); }
  };
  return window.electronAPI.cloudSync.onStatus(safeCb);
}
```

### 4.2 组件层用 useQuery/useMutation + ErrorBoundary

```tsx
// apps/windows/src/renderer/settings/CloudSyncSection.tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import {
  getCloudSyncConfig, setCloudSyncConfig, testConnection,
  syncNow, subscribeCloudSyncStatus,
} from '../services/cloud-sync-service';
import { ErrorBanner } from '../components/ErrorBanner';

export function CloudSyncSection() {
  const qc = useQueryClient();
  const [banner, setBanner] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const { data: cfg, isLoading, error: cfgError } = useQuery({
    queryKey: ['cloudSync', 'config'],
    queryFn: getCloudSyncConfig,
  });

  const setCfg = useMutation({
    mutationFn: setCloudSyncConfig,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cloudSync'] });
      setBanner({ type: 'ok', msg: '已保存' });
    },
    onError: (e) => setBanner({ type: 'err', msg: (e as Error).message }),
  });

  const test = useMutation({
    mutationFn: testConnection,
    onSuccess: () => setBanner({ type: 'ok', msg: '连接成功' }),
    onError: (e) => setBanner({ type: 'err', msg: (e as Error).message }),
  });

  const doSync = useMutation({
    mutationFn: syncNow,
    onSuccess: () => setBanner({ type: 'ok', msg: '同步完成' }),
    onError: (e) => setBanner({ type: 'err', msg: (e as Error).message }),
  });

  const [status, setStatus] = useState<{ lastSyncAt?: number; status?: string }>({});
  useEffect(() => {
    const off = subscribeCloudSyncStatus((s) => setStatus(s));
    return off;   // 4.3 订阅必须卸载，防内存泄漏 + 重复回调
  }, []);

  if (isLoading) return <div>加载中…</div>;
  if (cfgError) return <ErrorBanner msg={(cfgError as Error).message} />;

  return (
    <section>
      {banner && <ErrorBanner msg={banner.msg} type={banner.type} />}
      {/* 表单：provider / remoteUrl / accessToken / syncIntervalSec … */}
      <button onClick={() => test.mutate()} disabled={test.isPending}>
        测试连接
      </button>
      <button onClick={() => doSync.mutate()} disabled={doSync.isPending}>
        立即同步
      </button>
      <div>状态：{status.status}；上次：{status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : '未同步'}</div>
    </section>
  );
}
```

### 4.3 订阅清理原则

任何 `onXXX(callback)` 返回的 `unsubscribe` 必须：
- `useEffect(() => { const off = subscribe(...); return off; }, [])` —— React 组件用
- 普通类：`componentWillUnmount() { this.off?.(); }` / `dispose()` 模式
- 禁止写 `useEffect(() => { subscribe(cb); /* 没 return */ })` → 100% 泄漏

---

## 五、现有代码中的示例参考位置

### 5.1 Feature Standards 中的 IPC 三层标准模板

最完整、最权威的 IPC 规范原文：

| 章节 | 内容 | 文件 |
|------|------|------|
| §6.1 架构与命名 | 三层结构 + domain:action 命名 | `docs/standards/feature-development-standards.md` §6.1 |
| §6.2 Preload 代码示例 | `contextBridge.exposeInMainWorld('electronAPI', { gateway: { connect, … } })` | 同上 §6.2 |
| §6.3 Main Handler 代码示例 | `ipcMain.handle('gateway:connect', async (e, token, mode) => {…})` | 同上 §6.3 |
| §6.4 类型定义与 Renderer 调用 | `interface ElectronAPI { gateway: { connect(…) } }` + 组件调用 | 同上 §6.4 |
| §7 错误处理 | 五层（Domain/Service/Repository/DB/Main）+ 错误包装降级 + 显示 | 同上 §7 |
| 附录检查清单 | 开发前 / 中 / 后三张 checkbox | 同上 附录 |

### 5.2 现有实际功能的完整 IPC 表

**示例 1：云同步设置页 5 个 IPC + 1 个事件**（完整对比例）

| IPC / 事件 | Main handle 名 | Preload electronAPI.* | 渲染调用（service/Page） | 参考 |
|-----------|---------------|-----------------------|------------------------|------|
| getConfig | `cloudSync:getConfig` | `cloudSync.getConfig()` | `getCloudSyncConfig()` | `docs/design/数据同步功能/2026-09-05-工作空间云同步设计.md` §9 设置页 IPC 表格 |
| setConfig | `cloudSync:setConfig` | `cloudSync.setConfig(cfg)` | `setCloudSyncConfig(cfg)` | 同上 |
| testConnection | `cloudSync:testConnection` | `cloudSync.testConnection()` | `testConnection()` | 同上 |
| getStatus | `cloudSync:getStatus` | `cloudSync.getStatus()` | 轮询 + 订阅 | 同上 |
| syncNow | `cloudSync:syncNow` | `cloudSync.syncNow()` | `syncNow()` | 同上 |
| 事件 status | `w.webContents.send('cloudSync:status')` | `cloudSync.onStatus(cb)→off` | `subscribeCloudSyncStatus(cb)` | 同上 |

**示例 2：渠道外联 Hub 2 个 IPC + 1 组 UI 确认**

| IPC | 说明 | 参考 |
|-----|------|------|
| `channel:list` | 列所有 ChannelPeer，可选只列 active | `docs/design/渠道与在场/2026-08-14-渠道出站Hub设计.md` §8.4 IPC + §7.4 工具契约 |
| `channel:send` | 发送，需权限确认（非 self:// 弹确认） | 同上 |
| `channelService.*` | renderer 侧分组命名（不是 channel:*） | 同上 |

**示例 3：双连接架构修复中的配对信息查询**

| IPC | 说明 | 参考 |
|-----|------|------|
| `device:getPairingInfo` | 返回 `{ pairId, pubKey }`，敏感字段掩码 | `docs/standards/dual-connection-architecture.md` §修复方案 + 相关文件列表（7 个） |

### 5.3 代码落地位置搜索锚点

实际代码里找 IPC 实现时，按以下锚点 `Grep`：
- 主进程 handle 注册：`ipcMain.handle(` / `register.*Ipc`
- Preload 暴露：`contextBridge.exposeInMainWorld('electronAPI'`
- Preload 类型：`interface Window { electronAPI:`
- 渲染调用：`window.electronAPI.` / `services/*-service.ts`

---

## 六、错误处理和类型安全

### 6.1 统一错误处理四层分工

| 层 | 谁负责 | 做什么 |
|----|-------|-------|
| **1. Main Handler** | Handler 代码 | try/catch 所有 I/O；AppError.wrap；永远返回 `{ok, data?, error?}`，绝不抛原生异常出进程边界 |
| **2. Preload 桥接** | 桥接代码 | 只做 invoke/on/off 中转；**不对错误做任何格式化**，保证错误原样到 renderer |
| **3. Renderer Service 层** | `*-service.ts` | 收 `{ok:false,error}` 后 → 统一转成 `AppError`（renderer 侧同名类）；把 uncaught Promise 都包掉 |
| **4. Renderer UI 层** | Page / Hook | 用 `useMutation` 的 `onError`、`ErrorBoundary`、`ErrorBanner` 组件显示；禁止 `console.error` 裸写；错误必须带 errorCode |

### 6.2 统一应用错误子类（主 / 渲染两侧各一套，类名保持一致）

```typescript
// apps/windows/src/renderer/errors.ts
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) { super(message); Object.setPrototypeOf(this, new.target.prototype); }

  static fromIpc(err?: { code: string; message: string }): AppError {
    return new AppError(err?.code ?? 'UNKNOWN_IPC_ERROR',
      err?.message ?? '未知错误');
  }
}

// 常见子类：供 instanceof 判断
export class ValidationError extends AppError { constructor(m: string) { super('PARAM_ERROR', m); } }
export class PermissionError extends AppError { constructor(m: string) { super('PERMISSION_DENIED', m); } }
export class NotFoundError   extends AppError { constructor(m: string) { super('NOT_FOUND', m); } }
export class ConflictError   extends AppError { constructor(m: string) { super('CONFLICT', m); } }
export class NetworkError    extends AppError { constructor(m: string) { super('NETWORK_ERROR', m); } }
```

### 6.3 稳定 errorCode 约定（例：渠道外联 Hub §13.1）

| errorCode | 含义 | UI / Agent 侧建议处理 |
|-----------|------|----------------------|
| `CHANNEL_NOT_FOUND` | peerId 不存在或已下线 | 提示「该渠道暂不可用」 |
| `PERMISSION_DENIED` | 用户取消确认 | 重试时再次弹确认 |
| `INVALID_CREDENTIALS` | 飞书/企微 webhook 401 | 引导用户去设置页重填 token |
| `PAYLOAD_TOO_LARGE` | 单条消息 > 平台上限 | 自动切为「附件上传 + 链接」 |
| `REPLY_ONLY_VIOLATION` | 企微没 24h 上下文就推 | 提示「请用户先在群里说话，再重试」 |
| `RATE_LIMITED` | 429 被限流 | 指数退避重试 3 次，仍失败再报 |
| `NETWORK_ERROR` | 本地/网关无网 | 展示「请检查网络」 |
| `UNKNOWN_ERROR` | 任何意料之外 | 保留堆栈，引导提 bug（带 code） |

### 6.4 类型安全三条铁律

1. **tsconfig strict=true 必须始终开着**：`noImplicitAny` / `strictNullChecks` 全打开，不要在任何包关。
2. **所有 IPC 函数的入参、出参显式写类型**：
   - main `handle('<channel>', async (_e, a: A, b: B): Promise<R> => {…})`
   - preload `getConfig(): Promise<IpcResult<CloudSyncConfig>>`
   - service `export async function getCloudSyncConfig(): Promise<CloudSyncConfig>`
3. **全局 Window 扩展必须显式 interface**：
   - 禁止 `(window as any).electronAPI.cloudSync.getConfig()` → 一次都不行
   - 所有调用都走 `window.electronAPI.<domain>.<method>()` → 类型自动推导

### 6.5 常见错误与排查

| 症状 | 可能原因 | 排查方法 |
|------|---------|---------|
| Renderer 报 `window.electronAPI.xxx` undefined | Preload 没跑 / exposeInMainWorld 少了分组 / webPreferences.preload 路径错 | 在 DevTools Console 里执行 `Object.keys(window.electronAPI)` 看分组；确认 `main/index.ts` 里 BrowserWindow 的 preload 路径 |
| 调 main handle 永远返回 undefined | main handler 忘记 `return { ok:true, data }` 或者 `await` 没加 | 在 main 侧 handler 里加 log，看是否真的走到 return |
| 事件订阅触发两次/多次 | `useEffect` 忘记 return off，或者 React.StrictMode 双跑没处理 | service 层幂等去重（同 listener 只注册一次）；组件严格写 `return off` |
| 类型通过但运行时参数丢了 | preload 调 `invoke` 的参数个数与 handler 的不匹配（常见只传 1 个，handler 写了 2 个） | 打印 preload 端 `arguments.length` 与 main 端 `(...args) => console.log(args.length)` 对齐 |
| 401/403 反复出现 | main 侧没把 keytar 读到的加密 token 反解密；或 accessToken 字段两边命名不一致（accessToken vs accessTokenEncrypted） | 打掩码日志（仅首尾字符）对比配置保存时的 token 与读取时是否一致 |
