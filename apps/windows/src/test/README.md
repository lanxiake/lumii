# ChatPage 功能测试

## 测试文件结构

```
src/test/
├── README.md                          # 本文件
├── components/                        # 组件测试
│   ├── ChatPage.test.tsx             # Phase 1: 架构重构
│   ├── MessageActions.test.tsx       # Phase 3: 消息操作
│   ├── ChatInput.test.tsx            # Phase 3: 自动高度输入框
│   ├── ChatSidebar.test.tsx          # Phase 4: 会话管理-搜索/分组
│   ├── SessionItem.test.tsx          # Phase 4: 会话管理-操作/重命名
│   └── ApprovalCard.test.tsx         # Phase 5: 审批卡片
└── hooks/                             # Hook测试
    └── useChat.test.ts               # Phase 2: Bug修复-流式状态
```

## 运行测试

### 运行所有测试

```bash
# 在 apps/windows 目录下
cd C:\Users\Administrator\Desktop\work_space\mtbot\apps\windows

# 运行所有测试
npm test

# 或使用 Vitest
npx vitest run src/test
```

### 运行特定测试文件

```bash
# 测试单个组件
npx vitest run src/test/components/ChatPage.test.tsx

# 测试 Hook
npx vitest run src/test/hooks/useChat.test.ts
```

### 监视模式（开发时使用）

```bash
npx vitest watch src/test
```

### 生成覆盖率报告

```bash
npx vitest run --coverage src/test
```

## 测试清单

### Phase 1: 架构重构 ✅
- [x] ChatPage 组件存在
- [x] ChatSidebar 组件独立
- [x] ChatContainer 组件独立
- [x] ChatInput 组件独立
- [x] 组件集成正常

### Phase 2: Bug修复 ⚠️
- [ ] 流式消息状态管理（需要手动测试）
- [x] 会话切换功能
- [x] 会话级别 isStreaming
- [ ] 多会话同时流式（需要集成测试）

### Phase 3: 消息功能 ✅
- [x] 复制消息
- [x] 编辑消息（user）
- [x] 删除消息
- [x] 重新生成（assistant）
- [x] 自动高度输入框
- [x] Enter发送/Shift+Enter换行
- [x] 代码块复制按钮

### Phase 4: 会话管理 ✅
- [x] 搜索会话（标题/内容）
- [x] 会话分组（置顶/今天/昨天/更早）
- [x] 悬停操作按钮
- [x] 右键菜单
- [x] 置顶/取消置顶
- [x] 重命名功能
- [x] 删除确认

### Phase 5: 审批卡片 ✅
- [x] 倒计时功能
- [x] 紧急状态（<=10秒）
- [x] 决策按钮
- [x] 结果显示
- [x] 复制命令

### Phase 6: 细节优化 🔄
- [ ] 打字指示器动画（需要视觉测试）
- [ ] 空状态显示
- [ ] 消息入场动画（需要视觉测试）
- [ ] Toast通知

## 需要手动测试的功能

以下功能需要在真实环境中手动测试：

### 1. 流式消息Bug修复
**测试步骤**:
1. 启动应用并连接网关
2. 发送一条消息触发AI回复（流式）
3. 在AI回复过程中，立即切换到另一个会话
4. 检查输入框是否可用
5. 切回原会话，检查AI回复是否完整

**预期结果**:
- ✅ 切换后输入框立即可用
- ✅ AI回复在后台继续生成
- ✅ 切回后消息完整显示

### 2. 多会话同时流式
**测试步骤**:
1. 创建两个会话
2. 在会话A发送消息触发流式回复
3. 切换到会话B发送消息触发流式回复
4. 快速在两个会话间切换
5. 检查两个会话的消息是否都完整

**预期结果**:
- ✅ 两个会话独立维护流式状态
- ✅ 消息不会混乱
- ✅ UI响应流畅

### 3. 动画效果测试
**需要测试**:
- 消息入场动画（淡入+上移）
- 打字指示器跳动动画
- 审批卡片脉冲动画
- Toast通知动画
- 悬停操作按钮出现动画

**测试方法**:
在浏览器开发工具中检查动画性能，确保使用GPU加速（transform/opacity）

### 4. 性能测试
**测试场景**:
- 100个会话滚动性能
- 单会话200条消息滚动
- 多个动画同时触发

**测试工具**:
- Chrome DevTools Performance
- React DevTools Profiler

## 已知问题修复验证

### Bug #1: 切换会话后输入框仍禁用 ✅
**状态**: 需要验证
**测试文件**: `useChat.test.ts` - TC-2.1.1

### Bug #2: 切回会话AI回复不完整 ⚠️
**状态**: 需要手动测试
**原因**: 涉及WebSocket流式消息，需要真实环境

## 测试数据

测试使用的Mock数据在各测试文件中定义：

- **Mock会话**: 包含标题、消息、时间戳
- **Mock审批**: 包含命令、主机、目录、过期时间
- **Mock流式消息**: 模拟AI流式响应

## 注意事项

1. **Electron API Mock**:
   - 测试文件中已Mock `window.electronAPI`
   - 如果测试失败，检查Mock配置

2. **LocalStorage Mock**:
   - 使用内存Mock，测试间自动清理
   - 不会影响真实localStorage

3. **定时器测试**:
   - 审批卡片测试使用 `vi.useFakeTimers()`
   - 记得在afterEach中调用 `vi.useRealTimers()`

4. **异步操作**:
   - 使用 `act()` 包装状态更新
   - 使用 `waitFor()` 等待异步完成

## 贡献指南

添加新测试时：

1. 在相应目录创建 `.test.tsx` 或 `.test.ts` 文件
2. 遵循 `TC-X.Y.Z` 命名规范对应测试用例文档
3. 添加清晰的测试描述
4. Mock必要的依赖
5. 更新本README的测试清单

## 参考文档

- [测试用例文档](../../docs/chatpage-test-cases.md)
- [优化实施计划](../../docs/chatpage-optimization-plan.md)
- [Vitest 文档](https://vitest.dev/)
- [Testing Library](https://testing-library.com/)
