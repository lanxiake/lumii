# Wiki 多级路径分类实施进度

## 📋 实施计划

### Phase 1: 数据库迁移 ✅ (100%)
- [x] 添加 V39 迁移版本
- [x] 添加 `user_path`、`tags`、`description` 字段
- [x] 重建索引（移除 topic_project）
- [x] 保留 `topic_project` 字段（向后兼容）

### Phase 2: 后端修改 ✅ (100%)
- [x] 修改 WikiSource 类型定义
- [x] 修改 WikiRepo.addSource 方法
- [x] 修改 WikiRepo.updateSourceTopic 方法
- [x] 修改 WikiRepo.clearSourceTopic 方法
- [x] 修改 WikiRepo.archiveInboxItem 方法
- [x] 修改 IPC 命令处理器 (handleWikiInboxOrganize)
- [x] 修改 IPC 命令处理器 (handleWikiSourceUpdateTopic)
- [x] 修改命令类型定义 (WikiInboxOrganizeCommand)
- [x] 修改命令类型定义 (WikiSourceUpdateTopicCommand)
- [x] 修改命令返回值类型定义
- [x] 创建批量分类工具模块 (wiki-batch-classifier.ts)
- [x] 修复所有编译错误

### Phase 3: 前端修改 🔜 (待完成)
- [ ] 修改 UI 组件展示 user_path
- [ ] 添加标签显示和筛选
- [ ] 更新导航树（两级分类 + 用户路径）
- [ ] 移除或隐藏项目相关 UI 组件

### Phase 4: 测试验证 🔜 (待完成)
- [ ] 更新测试用例
- [ ] 运行完整测试
- [ ] 验证实际导入效果
- [ ] 验证数据库迁移

---

## 🎯 当前状态

### ✅ 已完成的工作

#### 1. 数据库层 (100%)
- Schema 迁移脚本已创建 (V39)
- 新增三个 JSON 字段：`user_path`、`tags`、`description`
- 索引已重建，移除了对 `topic_project` 的依赖
- 向后兼容：保留 `topic_project` 字段

#### 2. 类型定义 (100%)
- WikiSource 接口已更新，包含新字段
- IPC 命令类型已更新
- 命令返回值类型已更新

#### 3. WikiRepo (100%)
- `addSource` - 支持新字段（当前设为 NULL）
- `updateSourceTopic` - 接受 options 参数传递新字段
- `clearSourceTopic` - 同时清除新字段
- `archiveInboxItem` - 接受 options 参数传递新字段

#### 4. IPC 层 (100%)
- `handleWikiInboxOrganize` - 传递并解析新字段
- `handleWikiSourceUpdateTopic` - 传递并解析新字段
- JSON 字段的序列化/反序列化处理

#### 5. 批量分类工具 (100%)
- `wiki-batch-classifier.ts` 模块已创建
- 提供目录分组功能
- 提供路径提取和标签提取功能
- 提供 AI 提示词生成功能

#### 6. 编译检查 (100%)
- ✅ 所有 TypeScript 编译错误已修复
- ✅ 类型检查通过

---

## 📊 数据结构设计

### 新的分类结构
```typescript
// 两级固定分类（保持不变）
topic_category: "工作" | "学习" | "生活" | "收藏"
topic_subtopic: "开发" | "文档" | "在学" | ...

// 用户多级路径（新增）- JSON 数组
user_path: ["outputs", "Lumii使用指南", "assets"]

// 标签（新增）- JSON 数组
tags: ["文档", "教程", "Lumii"]

// 描述（新增）- 文本
description: "Lumii 使用指南和界面截图"

// 向后兼容（废弃但保留）
topic_project: null  // 标记为 @deprecated
```

### 示例场景

**场景 1：导入技术文档**
```
原始路径: C:/outputs/Lumii使用指南/界面介绍/截图/main-window.png

分类结果:
- category: "工作"
- subtopic: "文档"
- user_path: ["outputs", "Lumii使用指南", "界面介绍", "截图"]
- tags: ["截图", "UI", "界面"]
- description: "Lumii主窗口界面截图"
```

**场景 2：导入学习笔记**
```
原始路径: D:/学习笔记/编程/TypeScript/类型系统.md

分类结果:
- category: "学习"
- subtopic: "在学"
- user_path: ["学习笔记", "编程", "TypeScript"]
- tags: ["编程", "TypeScript", "类型系统"]
- description: "TypeScript类型系统学习笔记"
```

---

## 🔧 技术实现细节

### 1. JSON 字段存储
```typescript
// 存储时序列化
const userPathJson = options?.userPath ? JSON.stringify(options.userPath) : null;
const tagsJson = options?.tags ? JSON.stringify(options.tags) : null;

// 读取时反序列化
const userPath = updated.user_path ? JSON.parse(updated.user_path) : null;
const tags = updated.tags ? JSON.parse(updated.tags) : null;
```

### 2. 向后兼容策略
- 保留 `topic_project` 字段，但标记为 `@deprecated`
- 新旧字段可以共存
- 逐步迁移：新导入的文件使用 `user_path`，旧数据保持不变

### 3. 批量分类流程
```
1. 扫描收件箱 → 按目录分组
2. 对每个目录组：
   - 提取目录结构
   - 提取内容预览
   - 生成 AI 提示词
3. 调用 AI 批量判断
4. 根据 confidence 决定：
   - >= 0.8: 自动应用
   - < 0.8: 标记待审查
```

---

## 📝 待完成的工作

### Phase 3: 前端修改

#### 3.1 导航树更新
- 展示两级分类 + 用户路径的树形结构
- 例如：工作 > 文档 > outputs > Lumii使用指南

#### 3.2 资料列表
- 显示 user_path 的面包屑导航
- 显示 tags 标签
- 显示 description 作为副标题

#### 3.3 搜索和筛选
- 支持按 tags 筛选
- 支持按 user_path 层级浏览

#### 3.4 编辑界面
- 允许用户手动修改 user_path
- 允许用户添加/删除 tags
- 允许用户编辑 description

### Phase 4: 测试验证

#### 4.1 单元测试
- 测试批量分类工具函数
- 测试 WikiRepo 的 CRUD 方法
- 测试 JSON 序列化/反序列化

#### 4.2 集成测试
- 测试完整的导入流程
- 测试数据库迁移
- 测试 IPC 命令

#### 4.3 手动验证
- 实际导入一批文件
- 验证分类结果
- 验证 UI 展示

---

## 🚀 如何继续

### 选项 1：完成前端修改
优先级：高
工作量：中等
- 更新导航树组件
- 更新资料列表展示
- 添加标签筛选

### 选项 2：集成批量分类到迁移流程
优先级：高
工作量：中等
- 在 wiki-migrate 中调用批量分类器
- 实现 AI 调用逻辑
- 处理批量应用结果

### 选项 3：先测试当前实现
优先级：高
工作量：较小
- 编译并运行应用
- 手动触发数据库迁移
- 验证基本功能

---

## ⚠️ 注意事项

1. **数据库迁移** - 首次运行会自动执行 V39 迁移
2. **向后兼容** - 旧数据不受影响，新字段默认为 NULL
3. **JSON 字段** - 确保正确处理 NULL 和空数组的区别
4. **前端展示** - 需要优雅处理字段为 NULL 的情况
5. **性能考虑** - JSON 字段不建索引，不适合大量筛选查询

---

## 📚 相关文件清单

### 后端文件
- `packages/agent-runtime/src/storage/migrations.ts` - 数据库迁移
- `packages/agent-runtime/src/wiki/types.ts` - WikiSource 类型
- `packages/agent-runtime/src/wiki/wiki-repo.ts` - WikiRepo 方法
- `packages/agent-runtime/src/wiki/wiki-batch-classifier.ts` - 批量分类工具

### IPC 层
- `apps/windows/src/main/ipc/agent-runtime/wiki-commands.ts` - 命令处理器
- `apps/windows/src/shared/agent-runtime-commands.ts` - 命令类型定义

### 前端文件
- `apps/windows/src/renderer/pages/MemoriesPage/components/WikiTab.tsx` - Wiki 主界面
- `apps/windows/src/renderer/hooks/business/useWikiPage/useWikiPage.ts` - Wiki hooks

---

## ✅ 总结

**当前实施进度：70%**

- ✅ Phase 1 (数据库) - 100%
- ✅ Phase 2 (后端) - 100%
- 🔜 Phase 3 (前端) - 0%
- 🔜 Phase 4 (测试) - 0%

**后端核心功能已完成**，数据结构已就绪，可以开始存储和处理多级路径分类数据。

**下一步建议**：
1. 优先完成前端 UI 修改，让新功能可见可用
2. 或者先进行测试验证，确保后端逻辑正确
3. 然后集成批量分类到实际导入流程

**你希望继续进行哪个部分？**
