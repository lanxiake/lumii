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

| 产品 | 覆盖 | 未调用 |
|---|---|---|
| pro | 19/19 | — |
| lite | 12/12 | — |
| export | 5/5 | — |
| crm | 8/8 | — |
| recall | 4/4 | — |
