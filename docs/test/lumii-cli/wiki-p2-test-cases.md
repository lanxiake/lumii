# Wiki P2 CLI 测试用例（补强版）

- 日期：2026-08-27
- 计划：`docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md`

## CLI 覆盖

| 子命令 | 用例 |
|---|---|
| `wiki synthesis create/list/get/accept/reject` | P2-Y* |
| `wiki graph` | P2-G* |
| `wiki search hybrid` | P2-H* |
| `wiki vector rebuild` | P2-V01 |
| `wiki ero bootstrap` | P2-R01 |

---

## Y 综述闭环

### P2-Y01 list / status 过滤
- list；`--status accepted|rejected|candidate`

### P2-Y02 create
- 取 2 个 sources id，`synthesis create ... --title wiki-cli-p2-synth`
- 断言：返回 id；模型不可用 → SKIP

### P2-Y03 get（CLI）
- 命令：`wiki synthesis get <id>`
- 断言：含 `candidateMd` 或 `sourcePages`

### P2-Y04 accept 真跑（隔离标题）
- 对 **本套件 create 出的 candidate** 执行 accept
- 断言：返回 pageId/path；`page list --category syntheses` 可见；list 该条 status=accepted
- 清理：`command wiki:page:delete` 删新建综述页（保留 synthesis 审计行）

### P2-Y05 reject 审计
- 另 create 一条 → reject → `--status rejected` 可见

### P2-Y06 accept/reject 幽灵 id
- 失败含「不存在」

---

## G 图谱

### P2-G01 `--center` 子图
- nodes 含中心；edges 数组；truncated 布尔

### P2-G02 `--category` + limit
- nodes≤limit（或含 entity 时允许略超，记录实际）

### P2-G03 缺 center/category
- 仅 `--limit` → exit 2

### P2-G04 与 backlinks 一致
- 已解析反链 ⊆ graph edges

### P2-G05 孤立中心
- 无链探针页 center → nodes≥1 edges 可为 0

---

## H Hybrid / 向量 / ERO

### P2-H01 `--no-vector`
- hits 非空；mode=fts 或 degradeReason 明示

### P2-H02 默认 hybrid
- exit 0；有 hits 或明确 degrade

### P2-H03 空关键词
- usage 失败

### P2-V01 vector rebuild
- 成功或可理解降级 notice（如缺 transformers）

### P2-R01 ero bootstrap
- exit 0 或明确空

### P2-R02 ero list / extract（GAP）
- `command wiki:ero:list`；extract 可选 SKIP

---

## 状态扫描 GAP

### P2-T01 `wiki:status:scan`
- command 返回候选数组

### P2-T02 `wiki:status:confirm`
- 无候选 SKIP

---

## 验收

- CLI 全部 P2 子命令至少 1 条自动化
- accept 真跑且清理探针综述页
- hybrid 降级可观察
- GAP 命令不静默跳过（须有 PASS/FAIL/SKIP 证据）
