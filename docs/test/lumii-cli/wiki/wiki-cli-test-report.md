# Wiki CLI 测试报告（资料层）

- 日期：2026-10-19T15:00:34.385Z
- 环境：lumii-ui + ~/.lumii/data/agent-runtime.db
- 汇总：**PASS 39** / **FAIL 0** / **SKIP 1** / 合计 40

## 结论

现存的 wiki CLI 子命令与关键命令总线已覆盖；SKIP 为防污染/手工/模型未配合。

## 明细

| ID | 状态 | 说明 |
|---|---|---|
| P0-A01 | PASS | n=100 |
| P0-A02-organized | PASS | n=100 |
| P0-A02-pending | PASS | n=3 |
| P0-A02-discarded | PASS | n=100 |
| P0-A03 | PASS | sources=798 工作=144 |
| P0-A04 | PASS | runs=10 batch=4 |
| P0-S01 | PASS | hits=7 mode=hybrid |
| P0-S02 | PASS | 特殊字符 ok |
| P0-S03 | PASS | 无结果空数组 |
| P0-S04 | PASS | 空查询 usage |
| P0-S05 | PASS | mode=fts |
| P0-I01 | PASS | sourceId=844a3f99 |
| P0-I02 | PASS | rejected: 整理入口不允许归到临时存放，请在文件列表中操作 |
| P0-I03 | PASS | id=b7274f09 |
| P0-I05 | PASS | 非 pending 拒绝 |
| P0-I04 | PASS | attempt/error cleared |
| P0-I06 | PASS | ghost rejected |
| P0-F01 | PASS | imported=2 run=empty cleaned=2 |
| P0-X01 | PASS | rebuiltCount=834 |
| P0-X02 | PASS | idempotent |
| P0-X03 | PASS | q=研究方法 hits=5 |
| P0-G01 | PASS | organized count=950 list=100（list 有上限） |
| P0-G02 | PASS | title=复盘-三agent加算法-五局-2026-10-16.md |
| P1-T01 | PASS | categories=4 |
| P1-L01 | PASS | unfiled=0 parking=0 archived=17 |
| P1-C01 | PASS | n=686 |
| P1-C02 | PASS | n=720 |
| P1-C03 | PASS | archive+restore |
| P1-E01 | PASS | md=815 |
| P1-E02 | PASS | md=815 --include-sources |
| P1-E03 | PASS | md=815 --include-attachments |
| P1-V01 | PASS | {"rebuiltCount":815,"summarized":237,"backend":"transformers","notice":null} |
| P2-M01 | PASS | run=af665f3f mappings=2 |
| P2-M02 | PASS | phase=review |
| P2-M03 | PASS | ignored alpha |
| P2-M04 | PASS | discard 清空 run |
| P2-U01 | PASS | userPath=probe/meta tags=alpha,beta |
| P2-U02 | PASS | ghost rejected |
| P0-M01 | PASS | wiki_* tools present |
| P0-M02 | SKIP | WIKI_CLI_SKIP_AGENT=1 |

## 覆盖说明

- **P0**：inbox list/count/organize/discard/retry、folder scan/import（--no-auto-classify）、organize run、检索（命中/空/特殊字符/空参数/--no-vector）、索引重建、cleanup scan + source get
- **P1**：主题树、source list 过滤（unfiled/parking/archived）、清理扫描与归档恢复、导出三选项、向量/摘要重建
- **P2**：库级迁移 plan→review（导入后必须停在 review，不静默落位）、migrate get/update-mapping/discard、元信息编辑（user_path/tags/description）
- **Agent**：tools 含 wiki_*；可选一轮 wiki_search

已删除用例：历史页面（page/revisions/backlinks/rollback/unresolved/concept/attach）随 P3 移除；
synthesis create/accept/reject 随智能资料库 P2 移除；graph/ero 随知识图谱移除（2026-09-24）。

证据：`wiki-cli-evidence.jsonl`
