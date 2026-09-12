# 云同步 v3 CLI 测试报告

**测试时间**: 2026-09-09T08:28:55.396Z

## 测试结果汇总

- 总计: 10
- ✅ 通过: 8
- ❌ 失败: 1
- ⏭️ 跳过: 1

## 详细结果

### ❌ Schema V38: 版本检查

**状态**: FAIL

- **expected**: ">=38"
- **actual**: null

---

### ✅ Merge 规则: 创建测试记忆

**状态**: PASS

- **id**: "test-memory-1788942529301"

---

### ✅ Merge 规则: 查询测试记忆

**状态**: PASS



---

### ✅ Merge 规则: 清理测试数据

**状态**: PASS



---

### ✅ 软删除: 创建测试实体

**状态**: PASS

- **id**: "test-entity-1788942531940"

---

### ✅ 软删除: 标记删除

**状态**: PASS



---

### ✅ 软删除: deleted_at 字段验证

**状态**: PASS

- **deleted_at**: "[Security] 安全工具初始化完成\n[Main] 灵栖 Lumii 启动中...\n[Main] 应用即将退出，等待清理完成...\n[Main] 开始清理资源...\n[Main] 资源清理完成\n[Main] 清理完成，调用 app.exit(0) 强制退出所有进程"

---

### ✅ 软删除: 清理测试数据

**状态**: PASS



---

### ⏭️ 同步工具: 配置文件存在

**状态**: SKIP

**原因**: 配置文件不存在（用户未配置云同步）



---

### ✅ 同步工具: 目录结构检查

**状态**: PASS

- **dirs**: ["profile","wiki","memory","autonomous","workspace"]


## 测试环境

- 操作系统: win32
- Node 版本: v24.19.0
- Lumii 客户端: C:\Users\75791\AppData\Local\Programs\lumii\lumii.exe

## 结论

❌ 有 1 个测试失败，需要修复。

---

**生成时间**: 2026-09-09T08:28:55.397Z
