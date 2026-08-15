# Windows 客户端双连接架构修复方案

## 问题分析

### 当前错误

```
15:43:41 [ws] [认证路径] role=node hasDevice=false hasAuthToken=true
15:43:41 [ws] ⇄ res ✗ sessions.patch 0ms errorCode=INVALID_REQUEST errorMessage=unauthorized role: node
15:43:44 [ws] ⇄ res ✗ node.list 0ms errorCode=INVALID_REQUEST errorMessage=unauthorized role: node
```

### 根本原因

Windows 桌面应用需要**同时作为 UI 客户端和 Node 设备**连接到 Gateway：

1. **UI 连接** (role=user)
   - 用于 UI 交互：sessions.patch, node.list, chat.* 等
   - 需要使用 **UI Token**

2. **Node 连接** (role=node)
   - 用于命令执行：bash 命令、技能运行等
   - 需要使用 **Node Token**

但是当前实现中，主 GatewayClient 使用了 Node Token + role=node，导致无法调用 UI 相关的方法。

## 架构设计

### Token 管理

系统已经正确设计了双 Token 机制（`DevicePairingService`）：

```typescript
interface PairingState {
  tokens?: {
    ui: string    // UI 连接专用 token
    node: string  // Node 连接专用 token
  }
}
```

配对成功后，`device.pairWithCode` 返回两个 token：
- `uiToken` - 用于 UI 连接
- `nodeToken` - 用于 Node 连接

### 连接架构

```
┌─────────────────────────────────────────────────────────┐
│                   Windows 应用                           │
│                                                          │
│  ┌────────────────────┐      ┌────────────────────┐    │
│  │  主 GatewayClient  │      │ NodeModeCoordinator │    │
│  │                    │      │                     │    │
│  │  UI Token          │      │  Node Token         │    │
│  │  role=user         │      │  role=node          │    │
│  │  scopes=user.basic │      │  scopes=node.*      │    │
│  └────────┬───────────┘      └────────┬────────────┘    │
│           │                           │                  │
└───────────┼───────────────────────────┼──────────────────┘
            │                           │
            ▼                           ▼
    ┌───────────────────────────────────────────┐
    │          Gateway (ws://localhost:18789)    │
    │                                            │
    │  ┌──────────────┐    ┌──────────────┐    │
    │  │ UI 会话      │    │ Node 会话    │    │
    │  │ sessions.*   │    │ node.*       │    │
    │  │ chat.*       │    │ 命令执行     │    │
    │  └──────────────┘    └──────────────┘    │
    └───────────────────────────────────────────┘
```

## 当前实现状态

### ✅ 已正确实现

1. **DevicePairingService** (`device-pairing-service.ts`)
   - 正确获取和存储两个 token
   - `getUiToken()` 和 `getNodeToken()` 方法
   - 配对时调用 `device.pairWithCode` 获取双 token

2. **NodeModeCoordinator** (`node-mode-coordinator.ts`)
   - 正确使用 Node Token 连接
   - 第 323 行：`token: devicePairingService?.getNodeToken()`

3. **initDevicePairingService** (`index.ts` 第 581-588 行)
   - 正确设置主 GatewayClient 使用 UI Token
   - `gatewayClient.setToken(uiToken)`

### ❌ 存在问题

1. **Renderer 代码混淆了 Token 类型**

   `DevicesPage.tsx` 第 305 行：
   ```typescript
   localStorage.setItem('device_token', deviceToken)
   ```

   这里保存的 `deviceToken` 是什么类型？从旧的配对流程来看，可能是 Node Token。

2. **SettingsPage 从 localStorage 读取 Token**

   `SettingsPage.tsx` 第 323-328 行：
   ```typescript
   const deviceToken = localStorage.getItem('device_token')
   const deviceId = localStorage.getItem('device_id')
   if (deviceToken && deviceId) {
     options = { token: deviceToken, deviceId, role: 'user', scopes: ['user.basic'] }
   }
   ```

   虽然设置了 `role: 'user'`，但是 token 可能是 Node Token，导致验证失败。

3. **autoRefreshToken 机制的问题**

   `index.ts` 第 873-887 行的 autoRefreshToken 实现调用 `apiClient.getDeviceToken(deviceId)`，但是这个方法返回的是什么类型的 token？需要确认。

## 修复方案

### 方案 1：移除 localStorage 的 Token 管理（推荐）

**原理**：完全依赖 DevicePairingService 管理 token，不使用 localStorage。

**修改点**：

1. **移除 DevicesPage 中的 localStorage 操作**
   - 删除 `localStorage.setItem('device_token', ...)`
   - 删除 `localStorage.setItem('device_id', ...)`

2. **修改 SettingsPage 连接逻辑**
   - 不从 localStorage 读取 token
   - 直接使用 DevicePairingService 的 token（通过 IPC 获取）

3. **添加 IPC 方法获取配对状态**
   ```typescript
   ipcMain.handle('device:getPairingInfo', () => {
     return {
       isPaired: devicePairingService?.isPaired(),
       deviceId: devicePairingService?.getDeviceId(),
       hasUiToken: !!devicePairingService?.getUiToken(),
       hasNodeToken: !!devicePairingService?.getNodeToken(),
     }
   })
   ```

4. **确保 autoRefreshToken 使用正确的 token**
   - `apiClient.getDeviceToken()` 应该返回 UI Token（role=user）
   - 或者添加参数指定 token 类型：`getDeviceToken(deviceId, role: 'user' | 'node')`

### 方案 2：在 localStorage 中区分两种 Token

**原理**：在 localStorage 中分别存储 UI Token 和 Node Token。

**修改点**：

1. **使用不同的 key 存储**
   ```typescript
   localStorage.setItem('ui_token', uiToken)
   localStorage.setItem('node_token', nodeToken)
   localStorage.setItem('device_id', deviceId)
   ```

2. **SettingsPage 读取 UI Token**
   ```typescript
   const uiToken = localStorage.getItem('ui_token')
   const deviceId = localStorage.getItem('device_id')
   if (uiToken && deviceId) {
     options = { token: uiToken, deviceId, role: 'user', scopes: ['user.basic'] }
   }
   ```

3. **确保配对时保存两个 token**

## 推荐实施步骤

采用**方案 1**（移除 localStorage 的 Token 管理）：

### Step 1: 修改 API Client

确保 `getDeviceToken()` 返回 UI Token：

```typescript
// apps/windows/src/main/api-client.ts
async getDeviceToken(deviceId: string, role: 'user' | 'node' = 'user'): Promise<ApiResponse<DeviceTokenResponse>> {
  return this.request<DeviceTokenResponse>('GET', `/devices/${deviceId}/token?role=${role}`)
}
```

### Step 2: 移除 Renderer 的 localStorage 操作

```typescript
// apps/windows/src/renderer/pages/DevicesPage/DevicesPage.tsx
// 删除第 305-306 行
// localStorage.setItem('device_token', deviceToken)
// localStorage.setItem('device_id', deviceInfo.deviceId)

// 删除第 429 行
// localStorage.setItem('device_token', result.token)
```

### Step 3: 修改 SettingsPage 连接逻辑

```typescript
// apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx
// 不从 localStorage 读取，直接连接
// Main process 会自动使用 DevicePairingService 的 UI Token
await connect(settings.gateway.url)
```

### Step 4: 确保 autoRefreshToken 使用 UI Token

```typescript
// apps/windows/src/main/index.ts
if (options?.autoRefreshToken && options?.deviceId && apiClient) {
  const tokenResp = await apiClient.getDeviceToken(options.deviceId, 'user')  // 明确指定 role=user
  // ...
}
```

### Step 5: 测试验证

1. 删除旧的配对数据：`device-pairing.json`
2. 重新配对设备
3. 验证主 GatewayClient 使用 UI Token 连接
4. 验证 NodeModeCoordinator 使用 Node Token 连接
5. 测试 UI 操作（sessions.patch, node.list）
6. 测试命令执行（bash 命令）

## 验证清单

- [ ] 主 GatewayClient 使用 UI Token + role=user
- [ ] NodeModeCoordinator 使用 Node Token + role=node
- [ ] UI 操作正常（sessions.patch, node.list, chat.*）
- [ ] 命令执行正常（bash 命令、技能运行）
- [ ] autoRefreshToken 获取正确的 UI Token
- [ ] 重启应用后自动连接正常
- [ ] Token 轮换功能正常

## 相关文件

- `apps/windows/src/main/device-pairing-service.ts` - Token 管理
- `apps/windows/src/main/index.ts` - 主进程、连接管理
- `apps/windows/src/main/api-client.ts` - API 客户端
- `apps/windows/src/main/gateway-client.ts` - Gateway 客户端
- `apps/windows/src/main/node-mode-coordinator.ts` - Node 连接
- `apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx` - 设置页面
- `apps/windows/src/renderer/pages/DevicesPage/DevicesPage.tsx` - 设备页面
