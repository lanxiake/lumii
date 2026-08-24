# 上下文压缩测试执行进度

**日期**: 2026-08-24
**测试文档**: `docs/test/2026-08-21-context-compression-test-cases.md`

## 已完成调查

### 缺陷 #7: context messages 命令字段名不一致

**根因**:
- CLI 端: `apps/windows/resources/app-ui-cli/commands.mjs:359`
  ```javascript
  { type: 'conversation:messages', conversationId: sessionKey }
  ```
- 服务端类型: `apps/windows/src/shared/agent-runtime-commands.ts:164-165`
  ```typescript
  readonly type: 'conversation:messages'
  readonly sessionKey: string
  ```
- 服务端 handler: `apps/windows/src/main/ipc/agent-runtime/conversation-commands.ts:267`
  ```typescript
  const { sessionKey, limit, before } = command
  ```

**症状**: 
```
command_failed: Cannot read properties of undefined (reading 'trim')
```

**影响范围**:
- 阻塞 B-01 及所有需要读取消息验证的测试用例
- `context usage` 命令正常（使用了正确的 `sessionKey` 字段）

**修复方案**:
- 最小改动：`commands.mjs:359` 改为 `sessionKey: sessionKey`
- 验证：CLI `context messages --session <key>` 返回消息列表而非报错

**严重级别**: 高（阻塞测试）

---

## 测试套件执行状态

### A 套件 — CLI/控制口冒烟
- [x] A-01 应用未运行时退出码
- [x] A-02 help --json 命令发现
- [x] A-03 未知命令参数错误
- [x] A-04 白名单第一道闸
- [x] A-05 第二道闸：user:send 附件字段
- [x] A-06 认证失败退出码

**状态**: ✅ 全部通过

### B 套件 — 会话构造与真实模型主套件
- [x] B-01 会话构造 (部分完成，阻塞于缺陷 #7)
- [ ] B-02 大文本撑高 token
- [ ] B-03 手动压缩
- [ ] B-04 压缩前后 token 单调下降
- [ ] B-05 无消息可压缩的幂等
- [ ] B-06 会话列表可回读测试会话

**状态**: ⚠️ 阻塞（缺陷 #7）

### C/D/E/F 套件
**状态**: ⏸️ 待执行

---

## 下一步

1. **不修改代码**，将缺陷 #7 记入报告
2. 尝试绕过缺陷继续测试（使用其他验证手段）
3. 继续执行 B 套件剩余用例
4. 推进 C/D/E/F 套件
5. 汇总生成最终测试报告
