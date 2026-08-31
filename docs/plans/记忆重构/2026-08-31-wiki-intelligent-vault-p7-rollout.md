# Wiki 智能资料库 实施总览与分期顺序（P7）

> 规格：`docs/design/记忆设计/2026-08-31-wiki-intelligent-vault-design.md`（v1.1 已确认）
> 本文档不含实现任务，只定顺序、依赖与验收口径；具体任务见各分期文档。

## 分期文档索引

| 分期 | 文档 | 内容 | 依赖 |
|---|---|---|---|
| P1 | `2026-08-31-wiki-intelligent-vault-p1-taxonomy.md` | V26 迁移、树 v2、`wiki-taxonomy-prompt.ts` 单一真源、拆两份 nav-map | — |
| P2 | `2026-08-31-wiki-intelligent-vault-p2-remove-synthesis.md` | 移除综述合成全链路（表随 P3 的 V27 合并 DROP） | 可与 P1 并行；表删除步骤与 P3 协调版本号 |
| P3 | `2026-08-31-wiki-intelligent-vault-p3-remove-pages.md` | 移除历史页面全链路（V27：6 张页面表 + `wiki_syntheses`） | 可与 P1/P2 并行 |
| P4 | `2026-08-31-wiki-intelligent-vault-p4-summary-vector.md` | 摘要分层提取、向量语料收窄 | 依赖 P1（新树落地后摘要才落对目录） |
| P5 | `2026-08-31-wiki-intelligent-vault-p5-cataloging.md` | 全库编目 v2（两轮制+锚点样例）、增量自动落位 | 依赖 P1 + P4 |
| P6 | `2026-08-31-wiki-intelligent-vault-p6-rename.md` | AI 文件名重命名（默认关） | 依赖 P1 + P4；可晚于 P5 |
| P7 | 本文档 | 总览、回归清单、发布顺序 | — |

## 执行顺序（非全部并行，标注可并行的组）

```
第 1 组（可并行）：P1、P2、P3
第 2 组：P4（等 P1 的树落地）
第 3 组：P5（等 P4 摘要列可用）
第 4 组：P6（等 P4；可与 P5 尾部重叠）
```

理由：P1 是分类体系地基，P2/P3 是纯删除、彼此和 P1 无强耦合，三者应尽早并行完成以缩短「代码里同时存在新旧两套分类逻辑」的窗口。P4 摘要是 P5/P6 的共同前置，必须先落。

## 跨分期共享约束（各分期任务不重复列出，此处兜底）

1. **白名单默认拒绝**：任何新增 IPC handler，先加 `command-allowlist.ts` 条目再接线，否则请求在网关层直接被拒绝，容易误判为「handler 写错了」。
2. **迁移单事务 + 备份提示**：V26/V27 执行前 UI 必须调用既有 `storage:listBackups` 提示用户当前备份状态（不新增备份机制，只是提示）。
3. **`packages/agent-runtime` 不依赖 Electron**：涉及文件系统根路径的新逻辑必须接受调用方注入的 `vaultRoot`，不得在 agent-runtime 内直接引用 Electron API。
4. **测试先红后绿**：每个任务先写失败测试、确认失败原因符合预期，再实现。
