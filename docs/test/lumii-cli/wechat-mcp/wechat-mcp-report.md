# 微信 MCP 集成 · CLI E2E 测试报告

- **生成时间**: 2026-10-11T07:07:43.792Z（开始 2026-10-11T06:58:40.670Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\75791\.lumii\data\agent-runtime.db
- **微信数据**: 微信 4.x 本机库（只读断言走 devcli.py）
- **探针标记**: WM-DRY-1011065840 / WM-REAL-1011065840 / WM-FAIL-1011065840

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 20 |
| 通过 | 17 |
| 失败 | 3 |
| 跳过 | 0 |
| 通过率 | 85.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| WM-01 | ✅ | 19 个 wechat MCP 工具已注册并启用（list_sessions, read_history, read_image, transcribe_voice, poll_new, check_env, locate_db, repair_env, send_text, send_file, send_batch, reply_to, search_messages, list_unread, wechat_digest, wechat_distill_state, wechat_distill_clear, wechat_profile_save, wechat_profile_get） | 0.2s |
| WM-02 | ✅ | 环境正常：进程运行、窗口可见未最小化、尺寸 1280,820（比例 1.561，dpi 96） | 0.2s |
| WM-03 | ✅ | Agent 经 list_sessions 读到会话列表（含「文件传输助手」） | 14.4s |
| WM-04 | ✅ | Agent 经 read_history 读到 filehelper 最近消息（含「先给结论 那篇文章对应的项目是 」） | 15.7s |
| WM-05 | ✅ | dry-run 校验通过、未发送（基线后新增 0 条；扫描 70 张表命中 0） | 29.9s |
| WM-06 | ✅ | 真发送成功并落库：WM-REAL-1011065840 \| WM-REAL-1011065840 收到 | 95.3s |
| WM-07 | ✅ | 目标不存在时中止且未发出（基线后新增 0 条 + 全库扫描命中 0） | 42.2s |
| WM-10 | ❌ | 图片未落库（type=3）：回复=先确认文件在不在，再按要求真发：



文件存在（389 字节的探针 PNG）。调用 send_file 真发：



真发失败，工具返回原样如下：

```json
{"ok": false, "detail": "没找到工具栏的「发送文件」按钮（fail-closed）", "talker": "filehelpe | 92.8s |
| WM-11 | ❌ | 文件未落库（type=49）：回复=按上次同样的流程：先确认文件存在，再按要求真发（这次是 txt，正好可以对比 png 是否同一种死法）：



文件存在（31 字节）。调用 send_file：



txt 也是同样的结果，返回原样：

```json
{"ok": false, "detail": "没找到工具栏的「发送文件」按钮（fail-cl | 90.2s |
| WM-09 | ❌ | 最小化时发送未被拒：{"ok": true, "detail": "dry-run：已验证目标会话，未输入未发送", "dry_run": true, "talker": "filehelper"} | 20.8s |
| WM-12 | ✅ | Agent 经 list_sessions(query) 定位到「测试微信群」(50313322756@chatroom) | 7.9s |
| WM-13 | ✅ | 目标不存在时返回稳定错误码 target_not_found（Agent 可据此决策） | 20.5s |
| WM-14 | ✅ | 并发互斥生效：持锁时第二次返回 busy（None），释放后可重入 | 1.2s |
| WM-15 | ✅ | Agent 经 send_batch 演练通过、未发送（基线后新增 0 条 + 全库扫描命中 0） | 28.6s |
| WM-16 | ✅ | 群/单聊误开被「头部更像其它会话」反证拦下（双向 fail-closed） | 4.9s |
| WM-17 | ✅ | Agent 经 reply_to 演练通过、未发送（全库扫描命中 0） | 58.0s |
| WM-18 | ✅ | 蒸馏 digest 结构正确、跨分片、全局/单会话一致（shards=1 total=2537 from_me=726 contacts=70） | 5.2s |
| WM-19 | ✅ | 画像可落盘/读回/列出（临时目录）＋ 历史带 from_me（确定性） | 5.5s |
| WM-20 | ✅ | 一键清除：单 scope 清画像+水位、无 scope 被拒、everything 清空全部（临时目录） | 0.4s |
| WM-08 | ✅ | 普通聊天正常（微信工具不影响基础对话） | 7.0s |

## 失败与跳过明细

- **WM-10** FAIL: 图片未落库（type=3）：回复=先确认文件在不在，再按要求真发：



文件存在（389 字节的探针 PNG）。调用 send_file 真发：



真发失败，工具返回原样如下：

```json
{"ok": false, "detail": "没找到工具栏的「发送文件」按钮（fail-closed）", "talker": "filehelpe
  ```
  Error: 图片未落库（type=3）：回复=先确认文件在不在，再按要求真发：



文件存在（389 字节的探针 PNG）。调用 send_file 真发：



真发失败，工具返回原样如下：

```json
{"ok": false, "detail": "没找到工具栏的「发送文件」按钮（fail-closed）", "talker": "filehelpe
    at Module.assert (file:///C:/myself/projects/my/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at h.runCase.fails.fails (file:///C:/myself/projects/my/open-source/lumii/docs/test/lumii-cli/wechat-mcp/run-wechat-mcp-e2e.mjs:296:9)
    at Module.runCase (file:///C:/myself/projects/my/open-
  ```
- **WM-11** FAIL: 文件未落库（type=49）：回复=按上次同样的流程：先确认文件存在，再按要求真发（这次是 txt，正好可以对比 png 是否同一种死法）：



文件存在（31 字节）。调用 send_file：



txt 也是同样的结果，返回原样：

```json
{"ok": false, "detail": "没找到工具栏的「发送文件」按钮（fail-cl
  ```
  Error: 文件未落库（type=49）：回复=按上次同样的流程：先确认文件存在，再按要求真发（这次是 txt，正好可以对比 png 是否同一种死法）：



文件存在（31 字节）。调用 send_file：



txt 也是同样的结果，返回原样：

```json
{"ok": false, "detail": "没找到工具栏的「发送文件」按钮（fail-cl
    at Module.assert (file:///C:/myself/projects/my/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at h.runCase.fails.fails (file:///C:/myself/projects/my/open-source/lumii/docs/test/lumii-cli/wechat-mcp/run-wechat-mcp-e2e.mjs:313:9)
    at Module.runCase (file:///C:/myself/projects/my/open
  ```
- **WM-09** FAIL: 最小化时发送未被拒：{"ok": true, "detail": "dry-run：已验证目标会话，未输入未发送", "dry_run": true, "talker": "filehelper"}
  ```
  Error: 最小化时发送未被拒：{"ok": true, "detail": "dry-run：已验证目标会话，未输入未发送", "dry_run": true, "talker": "filehelper"}
    at Module.assert (file:///C:/myself/projects/my/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at h.runCase.fails.fails (file:///C:/myself/projects/my/open-source/lumii/docs/test/lumii-cli/wechat-mcp/run-wechat-mcp-e2e.mjs:337:11)
    at Module.runCase (file:///C:/myself/projects/my/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:526:18)
    at main (fil
  ```


## 证据

逐条原始证据见 [wechat-mcp-evidence.jsonl](./wechat-mcp-evidence.jsonl)。
