# 五个微信 MCP exe 实机回归测试报告（2026-10-15）

- 基线提交：`45ceb59c` 之后重打包的 dist exe（仓库 HEAD `4d756ec4`）
- 环境：Windows，微信 4.1.15.13（已真机验证版本），两个账号，当前 `wxid_sngf3b86qbz021`；Python 用内嵌 `~/.lumii/runtimes/python-embed`
- 方式：每个工具单独起一次 exe（或同进程顺序调用以测冷/热耗时），实时看 stderr、进度通知与 `metrics.jsonl` 增量
- 安全：发送类全部 `dry_run=true`；画像指到临时目录；导出/CSV/归档写临时目录、归档只预演；撤回只读；未结束任何非本测试启动的进程；未改业务代码、未提交 git

## 0. 如何复验

```powershell
# 单工具：.\t.ps1 <pro|lite|export|crm|recall> <tool> [JSON 或 @args 下的文件] [-Label 说明]
.\verify\wechat-mcp\regress-20261015\t.ps1 crm list_labels
.\verify\wechat-mcp\regress-20261015\t.ps1 export export_chat '@ex_csv.json' -Label csv
# 握手 + 工具清单 + 到期行
& "$env:USERPROFILE\.lumii\runtimes\python-embed\python.exe" -u verify\wechat-mcp\regress-20261015\regress_one.py --exe pro --list
# 校验导出产物（BOM / 公式注入前缀 / JSON / PDF 魔数）
& "$env:USERPROFILE\.lumii\runtimes\python-embed\python.exe" verify\wechat-mcp\regress-20261015\check_exports.py <目录>
# 由 results.jsonl 重新生成总表与覆盖率
& "$env:USERPROFILE\.lumii\runtimes\python-embed\python.exe" verify\wechat-mcp\regress-20261015\make_table.py
```

| 文件 | 作用 |
|---|---|
| `regress_one.py` | 单工具测试器（五个 exe 别名、`--env`、同进程多步、超时、只结束自己的进程树、屏幕输出脱敏） |
| `t.ps1` | PowerShell 封装（画像目录固定隔离） |
| `check_exports.py` | 导出 / 通讯录产物校验 |
| `make_table.py` / `table.md` | 总表与覆盖率 |
| `results.jsonl` | 每次调用一行（产品/工具/用例/ok/耗时/摘要/metrics 尾行/截图名） |
| `args/` | 本轮全部参数文件（`_` 开头的是由前一步结果生成的） |

原始日志（含完整返回，**有隐私数据，未放进仓库**）：`%TEMP%\lumii-regress-20261015\raw\*.json`；截图副本：`%TEMP%\lumii-regress-20261015\shots\`。

## 1. 环境信息

| 产品 | exe | serverInfo | edition | 工具数 | 到期 |
|---|---|---|---|---|---|
| 本机微信 高级版 | `wechat-mcp/dist/pro/wechat-mcp-0.8.0.exe` | wechat-local 0.8.0 | pro | 19 | 2027-10-15（剩 364 天） |
| 本机微信 精简版 | `wechat-mcp/dist/lite/wechat-mcp-lite-0.8.0.exe` | wechat-local 0.8.0 | lite | 12 | 2027-10-15（剩 364 天） |
| 微信导出 | `wechat-export-mcp/dist/wechat-export-mcp-0.15.0.exe` | wechat-export 0.15.0 | — | 5 | 2027-10-15（剩 364 天） |
| 微信客户分析 | `wechat-crm-mcp/dist/wechat-crm-mcp-0.15.0.exe` | wechat-crm 0.15.0 | — | 8 | 2027-10-15（剩 364 天） |
| 微信撤回防护 | `wechat-recall-mcp/dist/wechat-recall-mcp-0.13.0.exe` | wechat-recall 0.13.0 | — | 4 | 2027-10-15（剩 364 天） |

握手均约 1.6–2.2 s（冷启动 exe 解包）。`check_env`：`can_send=true`、`db_ok`、`asr.ready=true`（paraformer-zh-small）、`image_key.cached=true`、`uia_tree=unknown`。

## 2. 总表

结果口径：**通过** = 正常路径返回 ok；**预期内拒绝** = 错误路径按约定返回失败；**未拒绝** = 错误路径没有被拒（见第 3 节）。耗时为客户端测得的 tools/call 往返。精简版里调用高级版专属工具，返回 JSON-RPC `-32602`：「该工具属于高级版（pro），当前运行的是基础版（lite）」。

| # | 产品 | 工具 | 用例 | 结果 | 耗时 ms | 摘要 |
|---|---|---|---|---|---|---|
| 1 | pro | `(initialize+tools/list)` | 握手 | 通过 | 3203 | wechat-local 0.8.0 edition=pro tools=19 expiry=['[   2.2s] stderr   [wechat-mcp] expiry: 有 |
| 2 | lite | `(initialize+tools/list)` | 握手 | 通过 | 2616 | wechat-local 0.8.0 edition=lite tools=12 expiry=['[   1.6s] stderr   [wechat-mcp] expiry:  |
| 3 | export | `(initialize+tools/list)` | 握手 | 通过 | 2790 | wechat-export 0.15.0 edition=None tools=5 expiry=['[   1.8s] stderr   [wechat-export] expi |
| 4 | crm | `(initialize+tools/list)` | 握手 | 通过 | 2859 | wechat-crm 0.15.0 edition=None tools=8 expiry=['[   1.8s] stderr   [wechat-crm] expiry: 有效 |
| 5 | recall | `(initialize+tools/list)` | 握手 | 通过 | 2612 | wechat-recall 0.13.0 edition=None tools=4 expiry=['[   1.6s] stderr   [wechat-recall] expi |
| 6 | pro | `check_env` | 正常路径 | 通过 | 52 | [weixin_running,pids,hwnd,visible,minimized,foreground,locked,onscreen,rect,size] |
| 7 | pro | `locate_db` | 正常路径 | 通过 | 23 | [found,root,source,accounts,wechat,wxid] |
| 8 | pro | `repair_env` | 正常路径 | 通过 | 979 | [ok,before,after,db,actions] |
| 9 | pro | `list_sessions` | 全部 | 通过 | 2188 | list[75] |
| 10 | pro | `list_sessions` | 按关键词 | 通过 | 1820 | list[3] |
| 11 | pro | `read_history` | 正常路径 | 通过 | 1421 | count=20 messages=20  [talker,name,count,messages,cursor,has_more] |
| 12 | pro | `read_history` | 错误路径 | 预期内拒绝 | 1857 | ERROR: 未找到会话「绝对不存在的会话xyz」。本工具**严格匹配**（需与显示名或 wxid/群号完全一致），歧义或部分匹配一律拒绝以免发错人。可选会话：123(hdg |
| 13 | pro | `search_messages` | 正常路径 | 通过 | 1993 | count=649 messages=10 truncated=False  [keyword,count,scanned_per_talker,truncated,message |
| 14 | pro | `search_messages` | 限定会话 | 通过 | 1389 | count=40 messages=5 truncated=False  [keyword,count,scanned_per_talker,truncated,messages] |
| 15 | pro | `list_unread` | 正常路径 | 通过 | 1378 | count=130 sessions=130  [count,sessions] |
| 16 | pro | `poll_new` | 正常路径 | 通过 | 1740 | count=226 messages=226 truncated=False  [count,messages,since_ts,next_since_ts,truncated,s |
| 17 | pro | `wechat_digest` | 会话 | 通过 | 1422 | contacts=1  [scope,generated_at,shards,scanned_per_talker,capped_talkers,since,stats_scope |
| 18 | pro | `wechat_digest` | 本人 | 通过 | 1718 | contacts=15  [scope,generated_at,shards,scanned_per_talker,capped_talkers,since,stats_scop |
| 19 | pro | `read_image` | 清空前 | 通过 | 2540 | image image/jpeg 4830B; bytes=4829  [talker,local_id,ts,path,bytes,variant] |
| 20 | pro | `read_image` | 错误路径 | 预期内拒绝 | 1952 | ERROR: 这个会话里没有这条 local_id（会话选错了？local_id 要用 read_history/poll_new 返回的那个） |
| 21 | pro | `transcribe_voice` | voice#1 | 通过 | 5767 | elapsed_ms=3870  [ok,talker,name,local_id,time,text,elapsed_ms,model] |
| 22 | pro | `transcribe_voice` | voice#2 | 通过 | 248 | elapsed_ms=135  [ok,talker,name,local_id,time,text,elapsed_ms,model] |
| 23 | pro | `transcribe_voice` | voice#3 | 预期内拒绝 | 85 | FAIL voice_unavailable: 取不到这条语音的音频：不是语音消息 / 找不到该 local_id / VoiceInfo 里没有音频（较老的语音数据会被微信清掉， |
| 24 | pro | `transcribe_voice` | voice#4 | 预期内拒绝 | 76 | FAIL voice_unavailable: 取不到这条语音的音频：不是语音消息 / 找不到该 local_id / VoiceInfo 里没有音频（较老的语音数据会被微信清掉， |
| 25 | pro | `transcribe_voice` | voice#5 | 通过 | 156 | elapsed_ms=63  [ok,talker,name,local_id,time,text,elapsed_ms,model] |
| 26 | pro | `transcribe_voice` | voice#6 | 通过 | 140 | elapsed_ms=58  [ok,talker,name,local_id,time,text,elapsed_ms,model] |
| 27 | pro | `wechat_distill_state` | set | 通过 | 13 | [ok,state_path,scope,since] |
| 28 | pro | `wechat_distill_state` | get | 通过 | 15 | [state_path,scope,since,all] |
| 29 | pro | `wechat_distill_state` | 错误路径：非法 action | **未拒绝** | 14 | [state_path,scope,since,all] |
| 30 | pro | `wechat_profile_save` | 本人 | 通过 | 17 | [ok,scope,path] |
| 31 | pro | `wechat_profile_save` | 会话 | 通过 | 1917 | [ok,scope,path] |
| 32 | pro | `wechat_profile_save` | 错误路径：空内容 | 预期内拒绝 | 18 | FAIL bad_args: content 为空（画像正文） |
| 33 | pro | `wechat_profile_get` | 本人 | 通过 | 32 | [scope,path,exists,content,updated,age_days,stale] |
| 34 | pro | `wechat_profile_get` | 列清单 | 通过 | 17 | [dir,files] |
| 35 | pro | `wechat_distill_clear` | 错误路径：不给 scope | 预期内拒绝 | 15 | FAIL bad_args: None |
| 36 | pro | `wechat_distill_clear` | 删会话画像 | 通过 | 60 | [ok,removed,dir] |
| 37 | pro | `wechat_profile_get` | 删后列清单 | 通过 | 20 | [dir,files] |
| 38 | pro | `wechat_distill_clear` | 清空全部 | 通过 | 28 | [ok,removed,dir] |
| 39 | pro | `read_image` | 清空后 | 通过 | 1874 | image image/jpeg 4830B; bytes=4829  [talker,local_id,ts,path,bytes,variant] |
| 40 | pro | `send_text` | dry-run | 通过 | 8353 | dry_run=True  [ok,detail,talker,name,dry_run,text] |
| 41 | pro | `send_text` | 错误路径：空文本 | 预期内拒绝 | 1607 | FAIL bad_args: text 为空 |
| 42 | pro | `send_file` | dry-run | 通过 | 4257 | dry_run=True  [ok,detail,talker,name,dry_run,path] |
| 43 | pro | `send_file` | 错误路径：文件不存在 | 预期内拒绝 | 1750 | FAIL attachment_missing: 文件不存在：C:\不存在\nofile.txt |
| 44 | pro | `send_batch` | dry-run+不存在会话 | 预期内（部分失败） | 4716 | FAIL None: None |
| 45 | pro | `reply_to` | 可见quote | 通过 | 8211 | dry_run=True  [ok,detail,talker,name,dry_run,quote,text] |
| 46 | pro | `reply_to` | 错误路径：quote不可见 | 预期内拒绝 | 8208 | FAIL quote_not_found: 聊天区未找到要引用的消息（quote=「这段文字绝对不在屏幕上qq」） |
| 47 | lite | `check_env` | 正常路径 | 通过 | 76 | [weixin_running,pids,hwnd,visible,minimized,foreground,locked,onscreen,rect,size] |
| 48 | lite | `locate_db` | 正常路径 | 通过 | 33 | [found,root,source,accounts,wechat,wxid] |
| 49 | lite | `list_sessions` | 按关键词 | 通过 | 2276 | list[3] |
| 50 | lite | `read_history` | 正常路径 | 通过 | 83 | count=20 messages=20  [talker,name,count,messages,cursor,has_more] |
| 51 | lite | `read_history` | 错误路径 | 预期内拒绝 | 662 | ERROR: 未找到会话「绝对不存在的会话xyz」。本工具**严格匹配**（需与显示名或 wxid/群号完全一致），歧义或部分匹配一律拒绝以免发错人。可选会话：123(hdg |
| 52 | lite | `search_messages` | 正常路径 | 通过 | 870 | count=649 messages=10 truncated=False  [keyword,count,scanned_per_talker,truncated,message |
| 53 | lite | `list_unread` | 正常路径 | 通过 | 59 | count=130 sessions=130  [count,sessions] |
| 54 | lite | `transcribe_voice` | 专属工具应拒绝 | 预期内拒绝 | 2 | None |
| 55 | lite | `wechat_profile_get` | 专属工具应拒绝 | 预期内拒绝 | 0 | None |
| 56 | lite | `poll_new` | 正常路径 | 通过 | 3198 | count=226 messages=226 truncated=False  [count,messages,since_ts,next_since_ts,truncated,s |
| 57 | lite | `send_text` | dry-run | 通过 | 4160 | dry_run=True  [ok,detail,talker,name,dry_run,text] |
| 58 | lite | `repair_env` | 正常路径 | 通过 | 390 | [ok,before,after,db,actions] |
| 59 | lite | `send_file` | dry-run | 通过 | 4134 | dry_run=True  [ok,detail,talker,name,dry_run,path] |
| 60 | lite | `send_batch` | dry-run+不存在会话 | 预期内（部分失败） | 4965 | FAIL None: None |
| 61 | lite | `reply_to` | 可见quote | 通过 | 8541 | dry_run=True  [ok,detail,talker,name,dry_run,quote,text] |
| 62 | export | `list_sessions` | 正常路径 | 通过 | 2237 | count=1 sessions=1  [count,sessions] |
| 63 | export | `export_chat` | md | 通过 | 1894 | messages=394 files_written=1 truncated=False bytes=61098  [dir,session,format,split,messag |
| 64 | export | `export_chat` | html | 通过 | 2568 | messages=394 files_written=1 truncated=False bytes=804717  [dir,session,format,split,messa |
| 65 | export | `export_chat` | json | 通过 | 1995 | messages=394 files_written=1 truncated=False bytes=186114  [dir,session,format,split,messa |
| 66 | export | `export_chat` | csv | 通过 | 1863 | messages=394 files_written=1 truncated=False bytes=58350  [dir,session,format,split,messag |
| 67 | export | `export_chat` | pdf | 通过 | 10378 | messages=394 files_written=1 truncated=False bytes=1230530  [dir,session,format,split,mess |
| 68 | export | `export_chat` | pdf打印失败回退 | 通过 | 2640 | messages=394 files_written=1 pdf_error=浏览器没有产出 PDF；已退回为同内容的 chat.html（浏览器打开后可自行打印成 PDF） tr |
| 69 | export | `export_chat` | 按月拆分 | 通过 | 1969 | messages=394 files_written=3 truncated=False bytes=62949  [dir,session,format,split,messag |
| 70 | export | `export_chat` | 关键词 | 通过 | 2007 | messages=14 files_written=1 truncated=False bytes=6821  [dir,session,format,split,messages |
| 71 | export | `export_chat` | 全库搜 | 通过 | 7791 | [out_dir,keyword,format,sessions_scanned,sessions_failed,sessions_matched,sessions_exporte |
| 72 | export | `export_chat` | 错误路径：xlsx | 预期内拒绝 | 0 | FAIL bad_args: 参数不合法：format='xlsx'（可选 ['md', 'html', 'json', 'csv', 'pdf']） |
| 73 | export | `export_chat` | 错误路径：会话 | 预期内拒绝 | 1923 | FAIL target_not_found: 会话「绝对不存在的会话xyz」解析不出唯一目标（需与显示名或 wxid/群号完全一致）。 |
| 74 | export | `list_files` | 正常路径 | 通过 | 1810 | total=20 count=20  [total,count,ok,missing,size_mismatch,files] |
| 75 | export | `list_files` | 只看过期 | 通过 | 1844 | total=9 count=9  [total,count,ok,missing,size_mismatch,files] |
| 76 | export | `archive_files` | 预演 | 通过 | 1827 | total=20 copied=18 dry_run=True  [out_dir,layout,dry_run,total,copied,dedup,exists,missing |
| 77 | export | `disk_usage` | 正常路径 | 通过 | 2822 | sessions=5  [root,total_bytes,total_files,trees,msg_trees,file_bytes,file_files,file_own_b |
| 78 | export | `export_chat` | media=all+语音转写 | 通过 | 2972 | messages=394 files_written=1 truncated=False bytes=326446745  [dir,session,format,split,me |
| 79 | crm | `list_labels` | 正常路径 | 通过 | 1866 | labels=5  [labels] |
| 80 | crm | `list_contacts` | 好友默认页 | 通过 | 1576 | total=2717 count=200 contacts=200  [total,count,offset,contacts] |
| 81 | crm | `list_contacts` | 按标签 | 通过 | 1590 | total=57 count=57 contacts=57  [total,count,offset,contacts] |
| 82 | crm | `list_contacts` | 按标签导CSV | 通过 | 1629 | total=57 csv_path=…\通讯录_*.csv  [total,csv_path] |
| 83 | crm | `list_contacts` | 错误路径：标签 | 预期内拒绝 | 1653 | FAIL target_not_found: 没有叫「不存在的标签xyz」的标签 |
| 84 | crm | `list_contacts` | 群 | 通过 | 1665 | total=37 count=5 contacts=5  [total,count,offset,contacts] |
| 85 | crm | `list_contacts` | 公众号 | 通过 | 1542 | total=229 count=3 contacts=3  [total,count,offset,contacts] |
| 86 | crm | `list_contacts` | 群成员 | 通过 | 1820 | total=9 count=9 contacts=9  [total,count,contacts,name_in_room_with] |
| 87 | crm | `list_contacts` | 群成员导CSV | 通过 | 1647 | total=9 csv_path=…\通讯录_*.csv  [total,csv_path] |
| 88 | crm | `list_contacts` | 错误路径：群 | 预期内拒绝 | 1757 | FAIL target_not_found: 会话「绝对不存在的群xyz」解析不出唯一目标（需与显示名或 wxid/群号完全一致）。 |
| 89 | crm | `list_contacts` | 全部好友导CSV | 通过 | 1601 | total=2717 csv_path=…\通讯录_*.csv  [total,csv_path] |
| 90 | crm | `interaction_rank` | 正常路径 | 通过 | 1819 | count=5  [count,ranking] |
| 91 | crm | `interaction_rank` | recent | 通过 | 1762 | count=3  [count,ranking] |
| 92 | crm | `interaction_rank` | 错误路径：sort | **未拒绝** | 2201 | count=3  [count,ranking] |
| 93 | crm | `silence_ladder` | 正常路径 | 通过 | 2053 | total=2717  [scope,now,days,total,buckets,never,note] |
| 94 | crm | `silence_ladder` | 错误路径：days | 预期内拒绝 | 0 | FAIL bad_args: days 必须是正整数数组，如 [30, 60, 90] |
| 95 | crm | `contact_stats` | 正常路径 | 通过 | 1614 | count=639  [talker,name,count,from_me,from_other,first_ts,first,last_ts,last,span_days] |
| 96 | crm | `contact_stats` | 错误路径 | 预期内拒绝 | 1978 | FAIL target_not_found: 会话「绝对不存在的会话xyz」解析不出唯一目标（需与显示名或 wxid/群号完全一致）。 |
| 97 | crm | `read_messages` | 正常路径 | 通过 | 1865 | count=20 messages=20 truncated=True  [talker,name,count,truncated,messages] |
| 98 | crm | `search_messages` | 正常路径 | 通过 | 2048 | count=649 messages=10 truncated=False  [keyword,count,scanned_per_talker,truncated,message |
| 99 | crm | `customer_brief` | 正常路径 | 通过 | 1517 | count=639 truncated=False  [count,from_me,from_other,first_ts,first,last_ts,last,span_days |
| 100 | recall | `daemon_status` | 正常路径 | 通过 | 20 | archived=4713 alive=False  [archived,talkers,oldest,newest,first_seen,last_tick,watermark, |
| 101 | recall | `list_recalls` | 正常路径 | 通过 | 1631 | total=0 count=0  [total,count,recalls] |
| 102 | recall | `archive_gap` | 正常路径 | 通过 | 1 | count=0  [count,gaps] |
| 103 | recall | `read_recall` | 错误路径：local_id | 预期内拒绝 | 1467 | FAIL not_archived: 归档里没有这条消息（可能守护当时没在跑） |
| 104 | recall | `list_recalls` | 错误路径：会话 | 预期内拒绝 | 1509 | FAIL target_not_found: 会话「绝对不存在的会话xyz」解析不出唯一目标（需与显示名或 wxid/群号完全一致）。 |

### 本轮重点功能结论

| 重点项 | 结论 | 依据 |
|---|---|---|
| 导出 md/html/json/csv/pdf | 通过 | 394 条全部导出；html 内嵌 12 图（786 KB 单文件）；pdf 1.2 MB、魔数 `%PDF-`，耗时 10.4 s |
| CSV：UTF-8 BOM + 公式注入前缀 | 通过 | `chat.csv` BOM=True、394 行；以 `= + - @` 开头的单元格 4 个全部带 `'`，未加前缀 0 个 |
| PDF 打印失败退回 | 通过 | 用 `LUMII_BROWSER_EXECUTABLE=where.exe` 模拟打印失败：返回 `pdf_error`「浏览器没有产出 PDF；已退回为同内容的 chat.html…」，目录只有 `chat.html`，无 0 字节 PDF |
| `xlsx` → `bad_args` | 通过 | `stage=args`，`invalid` 列出非法项 |
| `list_labels` | 通过 | 5 个标签，人数 11 / 1 / 18 / 57 / 2，字段 `label_id,name,count` |
| `list_contacts(label=已有)` | 通过 | total=57，每行带 `labels` 且都含该标签 |
| `list_contacts(label=不存在)` | 通过 | `target_not_found` + `candidates`(5) + suggestion「从 candidates 里挑一个确切的标签名重试，或调 list_labels 看全部标签。」 |
| `list_contacts(out_dir)` | 通过 | 返回 `{total, csv_path}`，写出 `通讯录_<标签>.csv`（57 行）/`通讯录_friend.csv`（2717 行，29 个单元格加了 `'` 前缀），均带 BOM |
| `list_contacts(room=群名, out_dir)` | 通过（表头中文化） | JSON 行有 `name_in_room`/`is_me`；CSV 多出的两列表头是 **「群内称呼」「是我」**（`contactscore.py:199` 有意本地化，单测断言一致） |
| 高级版语音转写 | 通过 | 同进程 6 条：首条 5767 ms（含模型加载，模型内 3870 ms），其后 248 / 156 / 140 ms；2 条 `voice_unavailable`（老语音音频已被微信清除，预期内）；转写文本均非空 |
| `wechat_distill_clear(everything=true)` | 通过 | 临时目录清空后只剩 `image_key.json`(65 B)；随后 `read_image` 仍解出同一张 JPEG（4829 B） |
| 发送类 dry-run（pro / lite） | 通过 | send_text / send_file / reply_to 切到「文件传输助手」并校验后返回 ok；send_batch 第 1 条 ok、不存在会话那条 `target_not_found` |
| reply_to 可见 quote | 通过 | 截图确认聊天区可见「【版本兼容自检】4.1.15.13 真发测试」；quote=「版本兼容自检」命中，不可见文字返回 `quote_not_found` |
| UI 冻结自动恢复 | **本轮未触发** | 见 3.7 |

## 3. 失败 / 可疑项

按严重度排序。均**未改代码**，只给复现与定位建议。

### 3.1【中】导出 exe 的 `transcribe_voice=true` 永远失败，原因被吞

- 复现：`.\t.ps1 export export_chat '@ex_voice.json'`（`talker=文件传输助手, format=md, media=all, transcribe_voice=true`）
- 现象：`media_report.voice_exported=2, transcribe_failed=2`；同两条语音（local_id 174/178）在 pro exe 里 `transcribe_voice` 成功（本机模型就绪）。stderr 无任何转写相关输出。
- 原因：`apps/windows/scripts/build-wechat-export-mcp.mjs:9` 明确**不打包** `sherpa-onnx`；`exportcore.py:403-408` 用裸 `except Exception` 计数，不留原因。
- 影响：`server.py:64/90` 对外描述是「需本机装了语音识别模型」，用户装了模型也不会成功，容易误判。
- 建议：要么打包 sherpa-onnx（体积代价），要么把描述改为「exe 版不支持，需用高级版转写」，并在 `media_report` 里给出 `transcribe_error`（首个异常的类型与消息）。

### 3.2【中】`archive_gap` 看不到「守护停机至今」这段正在发生的缺口

- 复现：`.\t.ps1 recall daemon_status` → `alive=false, running=false, autostart=false, last_tick≈2026-10-13 10:44`；`.\t.ps1 recall archive_gap` → `count=0`
- 现象：守护已停约 2.5 天，缺口报 0。
- 原因：`daemon.py:239 note_gap` 只在守护**恢复**后的下一拍补记 gap；`server.py:160 _tool_gap` 只读 gap 表。
- 建议：`_tool_gap` 在守护不在跑、且 `now - last_tick > 3*interval` 时追加一条 `{start: last_tick, end: null, ongoing: true}`，或在 `daemon_status` 里给出「未覆盖至今 N 小时」。

### 3.3【中】新打包的 0.8.0 中，`send_file` dry-run 的 metric 仍记为 `ok:false`

- 复现：`.\t.ps1 pro send_file '@send_file.json'`（lite 同样）
- metrics：`{"op": "send_file", "ms": 2500, "ok": false, "path": "regress_send_file.txt", "dry_run": true}`，而工具返回 `ok:true / dry_run:true`
- 说明：任务中说这是「旧版 exe」的已知现象，但这次是新打包的 0.8.0，现象仍然存在。所以要么这次打包没包含该修复，要么该修复还没合入。请核对打包源码对应的提交。

### 3.4【低】`interaction_rank(sort="bogus")` 不报错，静默按默认排序

- 复现：`.\t.ps1 crm interaction_rank '@rank_bad.json'` → 正常返回 `count=3`
- 对比：导出的 `format='xlsx'` 会返回 `bad_args` + `invalid`。枚举校验口径不统一。

### 3.5【低】`wechat_distill_state(action="bogus")` 静默当作 `get`

- 复现：`_distill_seq.json` 第 3 条 → 返回 `{state_path, scope, since, all}`，无错误。
- 建议：非 `get/set` 返回 `bad_args`。

### 3.6【低】高级版 / 精简版部分错误返回不符合统一失败形状

- `read_history` / `read_image` 的错误路径返回 `{"error": "..."}`（只有一个键，无 `ok:false / error_code / suggestion`）。`read_history` 的这条 error 长 2256 字，内含**全部会话名**（与已知的 send_batch detail 偏长同源）。
- `wechat_distill_clear({})` 返回 `{"ok": false, "error_code": "bad_args", "error": "需给 scope…"}`：用 `error` 而不是 `detail`，按统一形状读 `detail` 时会拿到 `None`。
- `send_batch` 整体 `ok:false` 时顶层没有 `error_code/detail`（只有 `total/sent/results`），失败项也没有 `candidates`。

### 3.7【观察】UI 冻结自动恢复：本轮没有触发

- 本轮 pro 有 4 次、lite 有 3 次切会话发送预演（`send_text`、`send_file`、`send_batch`、`reply_to`），**全部首次确认成功**。进度最多到「目标不在当前会话，正在切换」后就正常返回（例如 pro 的 `send_text` 起点是另一个群聊，切换后返回 ok，耗时 8.4 s），没有出现 `target_unconfirmed` 或超时。
- 本轮测试窗口内的 metrics 共 15 行：`uia_blank` 6 次（已知）、`send_text ok` 4 次、`send_file ok:false` 2 次（即 3.3）、`reply_text` 3 次（2 次 ok、1 次 `quote_not_found`），**没有 `ui_alive` 和 `unfreeze_ui`**。
- 旁证（测试开始前的历史 metrics，exe 版本无法确认，不算本轮结论）：今天 20:52–20:54 有 `ui_alive ok=false` 5 次、`unfreeze_ui ok=true` 5 次（detail 为「托盘图标恢复微信 UI」，约 1.5 s）。还有两处同一秒内连续出现 `ui_alive false → true`。
- 没有人为制造冻结：制造冻结需要挂起微信的 UI 线程，或者切到有未读消息的其他会话（会把消息标为已读，改变用户状态），两种都超出约束范围。如需验证，建议你在场时用手动方式复现。

### 3.8【待确认】其他口径差异

- 高级版 `list_sessions` 无论是否带关键词，都最多返回 75 个会话，而 `list_unread` 返回 130 个（每个都有 `unread>0`）。如果 75 是设计上限，返回值里应带 `total` 或 `truncated` 标记。
- 同样 `query="文件"`：高级版 `list_sessions` 返回 3 个，导出版 `list_sessions` 返回 1 个，两边匹配口径不同。
- `archive_files` 预演：返回 `copied=18`，最后一条进度却是「已拷贝 17」，而且 dry-run 下用 `copied` 这个词有歧义（实际写入 0 个文件）。
- 导出 `media=all` 时，语音进度显示为「13/2 导出语音 2/2」：进度值沿用了图片阶段的累计数，超过了总数。
- 导出 `media=all` 时文件附件会整份拷贝（18 个文件，共 326 MB，约 3 s）。功能正常，只提醒注意磁盘占用。

### 已知、未报为 bug

`uia_blank`（6 次，均退回截帧判据）；send_batch 找不到会话时 detail 列出全部会话（2256 字）。

## 4. 覆盖率

| 产品 | 调到 / 总数 | 未调到 |
|---|---|---|
| 高级版 pro | 19 / 19 | — |
| 精简版 lite | 12 / 12 | — |
| 导出 export | 5 / 5 | — |
| 客户分析 crm | 8 / 8 | — |
| 撤回防护 recall | 4 / 4 | — |

说明：`read_recall` 只测了错误路径。原因是守护停机，`list_recalls` 返回 `total=0`，没有可读的撤回记录。精简版额外确认了 `transcribe_voice` 和 `wechat_profile_get` 会被拒绝；它的 `tools/list` 里也没有 `read_image`、`transcribe_voice`、`wechat_digest`、`wechat_distill_*`、`wechat_profile_*` 这 7 个高级版专属工具（19 − 12 = 7）。

## 5. 清理确认

- 进程：测试前已把所有 `wechat*`/`msedge*` 进程的 PID 存为基线（131 个，含用户自己的 Claude Code / Lumii 实例）。测试结束后，基线之外**没有新增进程**，也没有带 `lumii-pdf-` 配置目录的无头 Edge。系统里有 2 个无头 Edge 进程是 20:36 启动的基线进程，不是本次测试产生的。测试器每次结束时只对**自己启动的 PID** 执行 `taskkill /T`。
- `LUMII_BROWSER_EXECUTABLE` 只在 PDF 回退那一次临时设置，用完立即删除，已核实。
- 真实画像目录 `~/.lumii/wechat-distill`：测试前后都是 43 个文件、最新修改时间 2026-10-13T09:52:12，**未被改动**（只读了元数据）。
- 临时目录 `%TEMP%\lumii-regress-20261015\`：
  - `distill\`：隔离的画像目录，现在只剩 `image_key.json`
  - `export\`：导出产物，其中 `voice\` 子目录约 326 MB
  - `crm\`：通讯录 CSV
  - `archive\`：空目录（只做了预演）
  - `raw\`：原始日志，含隐私数据
  - `shots\`：截图副本
  - `tools_*.json`、`baseline_pids.txt`、`real_distill_before.txt`
- 另有临时文件 `%TEMP%\lumii-regress-20261015\regress_send_file.txt`（只用于 send_file 预演）。
- 验证完成后，可以用 `Remove-Item -Recurse "$env:TEMP\lumii-regress-20261015"` 一次清掉。
