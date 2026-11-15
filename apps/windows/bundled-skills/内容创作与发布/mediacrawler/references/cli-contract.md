# MediaCrawler CLI 契约

来源：2026-11-15 在 commit `306ab4ca26c0e44fb87ede0e40e98748752815a6` 上实测的 `python main.py --help` 输出，以及逐个跑过的命令。

## 平台与类型

| 代号 | 平台 | 代号 | 平台 |
|---|---|---|---|
| `xhs` | 小红书 | `wb` | 微博 |
| `dy` | 抖音 | `tieba` | 百度贴吧 |
| `ks` | 快手 | `zhihu` | 知乎 |
| `bili` | B站 | | |

采集类型 `--type`：`search` 关键词搜索 ｜ `detail` 指定帖子 ID ｜ `creator` 指定创作者主页。

## 命令行列全表

实测 `main.py --help` 共 23 个选项，按用途分组：

**基础**
| 参数 | 说明 | 默认 |
|---|---|---|
| `--platform` | 平台代号 | `xhs` |
| `--type` | `search` / `detail` / `creator` | `search` |
| `--start` | 起始页码 | `1` |
| `--keywords` | 关键词，英文逗号分隔 | `编程副业,编程兼职` |
| `--specified_id` | `detail` 模式下的帖子 ID/URL，逗号分隔 | — |
| `--creator_id` | `creator` 模式下的创作者 ID/URL，逗号分隔 | — |
| `--crawler_max_notes_count` | 目标条数上限 | `15` |

**账号**
| 参数 | 说明 |
|---|---|
| `--lt` | 登录方式：`qrcode` / `phone` / `cookie`（默认 `qrcode`） |
| `--cookies` | `cookie` 方式下直接传 cookie 串 |

**评论**
| 参数 | 说明 | 默认 |
|---|---|---|
| `--get_comment` | 抓一级评论，`yes/true/t/y/1` 或 `no/false/f/n/0` | `True` |
| `--get_sub_comment` | 抓二级评论 | `False` |
| `--max_comments_count_singlenotes` | 单帖一级评论上限 | `10` |

**存储**
| 参数 | 说明 | 默认 |
|---|---|---|
| `--get_media` | 是否下载封面/视频/图片 | `False` |
| `--save_data_option` | `csv` / `db`(MySQL) / `json` / `jsonl` / `sqlite` / `mongodb` / `excel` / `postgres` | `jsonl` |
| `--init_db` | 初始化表结构：`sqlite` / `mysql` / `postgres` | — |
| `--save_data_path` | 数据落盘根目录，空则用 `data/` | — |

**运行**
| 参数 | 说明 | 默认 |
|---|---|---|
| `--headless` | 无头模式，`yes/true/t/y/1` 或 `no/false/f/n/0`。**扫码登录必须为 false** | `False` |
| `--max_concurrency_num` | 并发爬取数 | `1` |

**代理**
| 参数 | 说明 | 默认 |
|---|---|---|
| `--enable_ip_proxy` | 是否启用 IP 代理 | `False` |
| `--ip_proxy_pool_count` | 代理池数量 | `2` |
| `--ip_proxy_provider_name` | `kuaidaili` / `wandouhttp` / `static` | `kuaidaili` |
| `--static_proxy_url` | 静态代理地址 | — |

### 命令行盖不住的开关

`config/base_config.py` 里这些**没有对应命令行参数**，只能改文件：

| 配置项 | 说明 | 备注 |
|---|---|---|
| `ENABLE_CDP_MODE` | CDP 模式开关 | 默认 `True`。开关都在这里，`.env` 覆盖不了 |
| `CDP_DEBUG_PORT` | CDP 调试端口 | `9222` |
| `CUSTOM_BROWSER_PATH` | 指定 Chrome/Edge 路径 | 空则自动探测 |
| `SAVE_LOGIN_STATE` | 登录态持久化 | `True`，存到 `browser_data/` |
| `XHS_INTERNATIONAL` | 小红书海外版（rednote.com） | `False` |
| `DOWNLOAD_LIVE_PHOTO` | 实况照片随附视频 | 需先开 `ENABLE_GET_MEDIA` |

`.env` 只覆盖数据库账号和代理 key（MySQL/Redis/Mongo/Postgres/WandouHTTP/Kuaidaili/JiSu），**且全仓库没有 `load_dotenv` 调用**——别指望用它改爬虫行为。

## 数据落盘

```
<repo>/data/<平台>/<格式>/search_contents_<YYYY-MM-DD>.jsonl   # 笔记/帖子正文
<repo>/data/<平台>/<格式>/search_comments_<YYYY-MM-DD>.jsonl   # 评论
<repo>/data/<平台>/media/<帖子ID>/cover.jpg | video.mp4 | 001.jpg   # 开 --get_media 才有
```

**按日期命名且是追加写**：同一天跑两次，第二个文件会接在第一个后面。计算"这次采到多少"必须做差，不能直接数行数——wrapper 已经处理了这点。

笔记字段（jsonl 每行一条，实测 19 个）：

| 字段 | 示例 |
|---|---|
| `note_id` | `6a7c2dff0000000026035565` |
| `type` | `video` / `normal` |
| `title` / `desc` | 标题与正文（话题带 `#xxx[话题]#`） |
| `video_url` | 真实 mp4 签名地址，逗号分隔多个清晰度 |
| `image_list` | 封面/图片地址 |
| `nickname` / `creator_hash` | 昵称（已脱敏成 `吴***饱`）与作者哈希 |
| `liked_count` / `collected_count` / `comment_count` / `share_count` | 互动数（显示值，如 `10万+`） |
| `tag_list` | 话题标签，逗号分隔 |
| `note_url` | 带 `xsec_token` 的完整地址 |
| `source_keyword` | 命中的关键词 |
| `time` / `last_update_time` | 毫秒时间戳 |

## WebUI 与 API

- API：`uvicorn api.main:app --port 8080`，13 个端点（`/api/crawler/{start,stop,status,logs}`、`/api/data/{files,files/{p},download/{p},stats}`、`/api/config/{platforms,options}`、`/api/health`、`/api/env/check`、`/`）
- WebUI：`cd webui && npm install && npm run build`，产物输出到 `api/webui/`，之后 API 根路径直接托管
- **API 自己就是进程管理器**：`api/services/crawler_manager.py` 用 `subprocess.Popen` 起/停 `main.py`，带日志环形缓冲。要做集成就调它，别自己再写一套
- CORS 白名单只有 4 个源：`localhost:5173`、`localhost:3000`、`127.0.0.1:5173`、`127.0.0.1:3000`。跨源调用（比如别的前端外壳）要先解决这个

## 登录态

- 存在 `browser_data/<平台>_user_data_dir`——Playwright 持久化浏览器 profile（cookies + localStorage），**不是** cookie 字符串
- 判定在日志里：`[XiaoHongShuClient.pong] Login state result: True/False`
- `login.py` 的 `check_login_state()` 有三重判定：UI 上"我"入口可见 → 出现"请通过验证"（风控）→ `web_session` cookie 发生变化。**第三条偏宽松**：只要该 cookie 出现且与登录前不同就判成功。实测出现过"没人扫码却报登录成功"的情况，原因未能查实
