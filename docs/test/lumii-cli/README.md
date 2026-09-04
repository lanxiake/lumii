# Lumii CLI 真实环境测试

本目录存放 `lumii-ui` CLI 的 **完整可测路径** 用例、执行器与报告。

## 测试套件

### 通用 CLI 测试

| 文件 | 说明 |
|---|---|
| [lumii-cli-test-cases.md](./lumii-cli-test-cases.md) | 通用 CLI 测试用例：UI、Agent、Cron、Memory 等核心功能 |
| [run-lumii-cli-suite.mjs](./run-lumii-cli-suite.mjs) | 通用 CLI 测试执行器（覆盖所有主要命令） |
| [lumii-cli-test-report.md](./lumii-cli-test-report.md) | 通用测试最新报告 |
| [lumii-cli-evidence.jsonl](./lumii-cli-evidence.jsonl) | 通用测试逐条证据 |

### Wiki 专项测试

| 文件 | 说明 |
|---|---|
| [wiki-p0-test-cases.md](./wiki-p0-test-cases.md) | P0：收件箱闭环、金标检索、页面、索引、GAP |
| [wiki-p1-test-cases.md](./wiki-p1-test-cases.md) | P1：双链、修订回滚、清理导出、GAP |
| [wiki-p2-test-cases.md](./wiki-p2-test-cases.md) | P2：综述 accept/reject、图谱、hybrid、状态 GAP（旧命令，非记忆重构二期） |
| [wiki-p1-implementation-test-cases.md](./wiki-p1-implementation-test-cases.md) | 记忆重构一期：用途两级目录、口诀分类器、归档不写摘要页、切断聊天摄入、资料层检索（含 CLI/后端签名不同步的已知问题） |
| [wiki-p2-implementation-test-cases.md](./wiki-p2-implementation-test-cases.md) | 记忆重构二期：主题树编辑、重新编目、新建笔记、综述改产资料、清理对齐、资料向量检索 |
| [wiki-p3-test-cases.md](./wiki-p3-test-cases.md) | 记忆重构三期：知识图谱新模型、按资料抽取实体、实体反查资料 |
| [run-wiki-cli-suite.mjs](./run-wiki-cli-suite.mjs) | Wiki 专项测试执行器（全部 wiki CLI + `command` GAP） |
| [run-wiki-real-materials-suite.mjs](./run-wiki-real-materials-suite.mjs) | 用「测试材料」真实文档跑摄入→归档→检索→打开→归档保留的端到端脚本 |
| [wiki-cli-test-report.md](./wiki-cli-test-report.md) | Wiki 测试最新报告 |
| [wiki-real-materials-test-report.md](./wiki-real-materials-test-report.md) | 真实材料套件最新报告 |
| [wiki-cli-evidence.jsonl](./wiki-cli-evidence.jsonl) | Wiki 测试逐条证据 |
| [wiki-real-materials-evidence.jsonl](./wiki-real-materials-evidence.jsonl) | 真实材料测试证据 |

### 测试材料

| 文件 | 说明 |
|---|---|
| [测试材料/](./测试材料/) | 真实文档样本（docx/mp4/PDF），供端到端摄入测试使用 |

## 前置条件

### 通用 CLI 测试

1. **启动应用**: Lumii 桌面应用已运行，或执行 `pnpm dev`
2. **控制口可用**: ~/.lumii/runtime/app-ui.json 存在且端口可访问
3. **基础数据**: 至少有 1 个 Agent、1 个 Wiki 资料（可选）

### Wiki 专项测试

1. `pnpm dev` 已启动，控制口可读
2. 可选：`WIKI_CLI_SKIP_AGENT=1` 跳过模型调用
3. 可选：`WIKI_CLI_ALLOW_DELETE=1`（仍默认不删业务 source）

## 执行测试

### 通用 CLI 测试

```bash
# 基础测试
node docs/test/lumii-cli/run-lumii-cli-suite.mjs

# 详细日志
LUMII_CLI_VERBOSE=1 node docs/test/lumii-cli/run-lumii-cli-suite.mjs
```

### Wiki 专项测试

```powershell
# 完整测试
node docs/test/lumii-cli/run-wiki-cli-suite.mjs

# 跳过 Agent：
$env:WIKI_CLI_SKIP_AGENT='1'; node docs/test/lumii-cli/run-wiki-cli-suite.mjs

# 真实材料测试
node docs/test/lumii-cli/run-wiki-real-materials-suite.mjs
```

## 测试内容

### 通用 CLI 测试套件

测试覆盖：
- ✅ 基础 UI 操作（screenshot、goto、click）
- ✅ Help 系统（help、help --json）
- ✅ Wiki 功能（overview、search、read）
- ✅ Agent 管理（list、info）
- ✅ Cron 任务（list）
- ✅ Memory 搜索（search）
- ✅ 错误处理（无效命令、缺少参数）

### Wiki 专项测试套件

套件会：

- 播种 `wiki_inbox` 探针测 organize/discard/retry/路径逃逸
- 真跑 synthesis accept（并删除新建综述页，保留审计）
- 用 `command` 覆盖 CLI 未暴露的 IPC（unresolved / concept / attach / status / ero 等）
- 校验 `wiki inbox count` 与 `wiki inbox list` 计数一致

## 本轮代码修复（2026-08-27 续）

- 白名单补 `wiki:inbox:count`
- CLI 新增 `wiki inbox count`、`wiki synthesis get`
