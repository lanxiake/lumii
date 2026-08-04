# 免审批功能验证

## 快速验证

运行验证脚本来测试审批配置管理功能：

```bash
# 设置环境变量
export NODE_ID="your-node-id"
export GATEWAY_URL="ws://127.0.0.1:18789"
export GATEWAY_TOKEN="your-token"  # 可选

# 运行验证脚本
node scripts/verify-approval-config.mjs
```

## 验证步骤

脚本会自动执行以下验证：

1. ✅ 连接到 Gateway
2. ✅ 获取节点当前审批配置
3. ✅ 设置为免审批模式
4. ✅ 验证配置是否正确应用
5. ✅ 恢复为平衡模式
6. ✅ 验证配置是否正确恢复

## 预期输出

```
[验证] 开始验证免审批功能...
[验证] 连接到 Gateway: ws://127.0.0.1:18789
✅ Gateway 连接成功
[验证] 获取节点审批配置...
✅ 成功获取配置
[验证] 当前配置: {
  "ask": "on-miss",
  "security": "allowlist"
}
[验证] 当前模式: balanced
[验证] 设置为免审批模式...
✅ 成功设置为免审批模式
[验证] 新配置: {
  "ask": "off",
  "security": "full"
}
[验证] 新模式: trusted
✅ 配置验证通过
[验证] 恢复为平衡模式...
✅ 成功恢复为平衡模式
[验证] 恢复后配置: {
  "ask": "on-miss",
  "security": "allowlist"
}
[验证] 恢复后模式: balanced
✅ 配置验证通过
✅ 所有测试通过！
```

## 手动测试

### 1. 启动 Gateway

```bash
cd ../../
pnpm gateway:dev
```

### 2. 启动 Node 设备

```bash
pnpm mtbot nodes register
```

### 3. 启动 Windows 客户端

```bash
cd apps/windows
pnpm dev
```

### 4. 在 UI 中测试

1. 打开设备管理页面
2. 选择一个节点设备
3. 打开审批设置
4. 选择"信任模式"
5. 点击"应用设置"
6. 验证配置已保存

### 5. 验证命令执行

执行一个命令，验证是否无需审批：

```bash
# 在 Gateway 中执行
pnpm mtbot chat "执行命令: echo test"
```

应该看到命令直接执行，没有触发审批请求。

## 故障排查

### 问题：连接 Gateway 失败

**检查**：
- Gateway 是否正在运行
- Gateway URL 是否正确
- Token 是否有效

### 问题：获取配置失败

**检查**：
- Node ID 是否正确
- 节点设备是否在线
- 节点设备是否支持审批配置

### 问题：设置配置失败

**检查**：
- 是否有权限修改配置
- baseHash 是否匹配（并发修改冲突）
- 配置格式是否正确

## 单元测试

运行单元测试：

```bash
pnpm test src/main/exec-approvals-manager.test.ts
```

## 相关文档

- [免命令审批实施方案](../../../my-docs/架构改造文档-v2/实施文档/07-免命令审批功能/免命令审批实施方案.md)
- [Windows客户端使用指南](../../../my-docs/架构改造文档-v2/实施文档/07-免命令审批功能/Windows客户端使用指南.md)
- [实施总结](../../../my-docs/架构改造文档-v2/实施文档/07-免命令审批功能/实施总结.md)
