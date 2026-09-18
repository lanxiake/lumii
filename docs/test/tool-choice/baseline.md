# 工具选择评测 · 基线记录

> 跑分器：[`run-tool-choice-eval.mjs`](./run-tool-choice-eval.mjs) · 对照集：[`eval-set.json`](./eval-set.json) · 判读须知：[`README.md`](./README.md)

## 2026-09-18 · 首次可用基线：**9/15（60.0%）**

### 为什么是"首次可用"

此前三次跑**都不算数**，两次失败原因不同、且都不是模型的选法：

| 次序 | 结果 | 作废原因 |
| --- | --- | --- |
| #1 | 6/15 | t12~t15 全线 `connection_failed`，被计成模型失败（把 ~73% 拉到 40%） |
| #2 | 6/15 | 同上，叠加三条**评测集自身的缺陷**（正则误匹配文件名、跨分号误判、引用了已删的探针文件） |
| #3 | 0/15 | 应用被 VCS 快照冻死（见下），全程 `connection_failed` |

本轮的 15 条**全部执行完毕，零 ENV-ERROR、零 MODEL-BUSY** —— 这是它可用的唯一理由。

### 前置：这次跑之前修掉的东西

基线本身没意义，除非宿主是健康的。本轮之前修的（都不是评测集的问题）：

- **工作区 VCS 快照冻死主线程**：isomorphic-git 按内容全量重算 blob hash，2.7GB/12866 文件实测中位 19.9 秒、最长 53.5 秒，且全程在主进程主线程 —— 由此触发 Windows 事件 1002「Application Hang」。改走真 git 子进程后 2.5 秒。
- **cloud-sync 拖死共享队列**：`sync()` 的防抖只有 60 秒而一次同步要 5~10 分钟，于是每个 tick 都往队列里再塞一次全量同步，**排队者出队后不是被丢弃、是真跑一遍**（实测队列深度 8、`vcs:snapshot` 排队 610 秒）。
- **真 git 自动 gc 打出 iso 读不了的大包**：1.38GB 单包让 log/diff/readBlob 全废。已加 `-c gc.auto=0` 并写进仓库自身 config。

**跑这类评测前必须确认宿主健康**，否则测的是环境不是模型 —— 这个坑本项目踩了三次。

### 结果

| 用例 | 类别 | 结果 | 模型实际行为 |
| --- | --- | --- | --- |
| t01 find-vs-glob | 专用工具优先 | ❌ | `find . -name "*.md" -type f \| wc -l` |
| t02 grep-command-vs-tool | 专用工具优先 | ❌ | **全程没调 `grep`**，序列 `[glob, list_dir, list_dir, file_read, file_read, bash, glob, glob, list_dir, list_dir, bash]` |
| t03 ls-vs-list-dir | 专用工具优先 | ✅ | `list_dir > task_complete` |
| t04 cat-vs-file-read | 专用工具优先 | ✅ | `file_read > bash > bash` |
| t05 sed-vs-file-edit | 专用工具优先 | ✅ | `file_read > channel_send > file_edit > file_read` |
| t06 echo-redirect-vs-file-write | 专用工具优先 | ✅ | `file_write > file_read > task_complete` |
| t07 mkdir-vs-file-mkdir | 专用工具优先 | ✅ | `file_mkdir` |
| t08 mv-vs-file-move | 专用工具优先 | ❌ | 用 bash，序列 `[bash, glob, bash]` |
| t09 cp-vs-file-copy | 专用工具优先 | ❌ | 用 bash，序列 `[bash, list_dir, file_read, file_read]` |
| t10 memory-vs-wiki | 语义邻近工具 | ✅ | `bash > memory_search > ...` |
| t11 skill-search-vs-invoke | 语义邻近工具 | ❌ | 越级调 `skill_invoke` + `execute_skill` |
| t12 file-read-vs-wiki-read | 语义邻近工具 | ✅ | `wiki_overview > wiki_search > ...` |
| t13 no-phantom-tools | 不存在的工具 | ✅ | `file_read > file_read` |
| t14 batch-vs-serial | 批量与多步 | ✅ | `glob > glob` |
| t15 guide-before-use | 引导先行 | ❌ | **只调了 `cron_guide`，没建任务** |

| 类别 | 通过 |
| --- | --- |
| 专用工具优先 | 5/9 |
| 语义邻近工具 | 2/3 |
| 不存在的工具 | 1/1 |
| 批量与多步 | 1/1 |
| 引导先行 | 0/1 |

### 判读

**① 失败集中在"shell 先验"这一类。** t01/t08/t09 都是同一件事：`find`/`mv`/`cp` 在 shell 里是本能，而工具描述里明明写着「用专用工具（NOT `find`/`mv`/`cp`）」。**模型读了规则但没照做** —— 这正是工具面设计要解决的问题，不是评测集判错了。

**② t02 比 t01 更严重。** 它**从头到尾没调 `grep`** —— 不是"用了 shell 的 grep"，是连专用工具都没想起来，改用 glob + file_read 硬找。工具名 `grep` 同时是 shell 命令，这层歧义可能是原因之一。

**③ t15 是"引导有用但不够"。** 模型**确实先查了引导**（`cron_guide`）—— "引导先行"的意图生效了；但查完没有执行。当前断言只认 `cron_create`，所以判红。**这是个正向信号强度的问题，不是纯粹的失败**，值得后续单独看。

**④ t11 是典型的越级。** search → invoke → execute 三件套的语义分层没被模型区分开，直接去 invoke 一个猜的名字。

**⑤ 单次跑不能当结论。** 模型是随机的（见 README 特性一）：同一份代码、同一条提示词，t01 在不同轮次里 FAIL/PASS 都出现过。**本表是趋势的起点，不是分数**。至少要两次以上都失败的用例才值得动手改工具面 —— 按这个标准，t08/t09/t11 在两轮里都失败了。

### 复现

```bash
node scripts/verify-tool-choice-eval.mjs          # 前置校验，必做
node docs/test/tool-choice/run-tool-choice-eval.mjs
```

宿主需先确认健康：应用空闲、无后台重活、模型端点没有别的会话在压。
