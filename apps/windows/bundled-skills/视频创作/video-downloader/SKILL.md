---
name: video-downloader
description: 用本机 yt-dlp + ffmpeg 把 B站/抖音/TikTok 等视频站点的视频下载到本地硬盘，含 DASH 音视频合并、登录 Cookie 取高清、批量与产物验收。用户给出视频链接并要求「下载/保存/扒下来/存一份到本地」时使用。
compatibility: 本机 yt-dlp（conda Scripts）+ ffmpeg/ffprobe 7.1（E:\mysoft\ffmpeg\bin）；需联网，全程本地执行。
---

# 视频下载

把视频链接落到本地，并证明它真的能播（有画面也有声音）。

## 环境（已核验，2026-10-05）
| 组件 | 位置 | 备注 |
|---|---|---|
| yt-dlp | `E:\mysoft\conda3\Scripts\yt-dlp`（已在 PATH） | 升级：`pip install -U yt-dlp`，阿里云源 ~3MB/s |
| ffmpeg 7.1 | `E:\mysoft\ffmpeg\bin\ffmpeg.exe` | gyan essentials 构建，含 libx264/x265/vpx/aac |
| ffprobe | `E:\mysoft\ffmpeg\bin\ffprobe.exe` | 同上目录 |

**关键坑**：`E:\mysoft\ffmpeg\bin` 是 2026-10-05 新加进用户 PATH 的。**客户端进程是启动时继承 PATH 的，所以重启客户端之前它看不见 ffmpeg**——在同一个会话里跑 yt-dlp，要么用绝对路径注入 PATH，要么显式 `--ffmpeg-location`：

```bash
export PATH="/e/mysoft/ffmpeg/bin:$PATH"      # 本会话临时生效，推荐
# 或：yt-dlp --ffmpeg-location "E:\mysoft\ffmpeg\bin" ...
```

不加这个，B站/抖音这类 DASH 分离流站点会下成「有画面没声音」或直接在合并步失败。

## 下载目录
C 盘已用 90%，**必须落 E 盘**。默认 `E:\testsoft\Lumii-data\outputs\video-downloads/<站点>/`，用户指定路径时以用户为准。

## 流程
1. **识别站点，先列格式再下载**（别一上来就 `-f best`，B站的 `best` 有时是 360p）：
   ```bash
   yt-dlp -F "<URL>"
   ```
   看清楚有哪些分辨率、有没有 audio-only 分轨、有没有提示「需要会员/Cookie」。
2. **报告并确认**：把标题、选定的格式（ID/分辨率/体积）、输出路径讲清楚，等用户点头再下。列表类（合集/UP主空间/播单）先只报数量和总体积，别默默开下几十个 G。
3. **执行**：
   ```bash
   yt-dlp --no-playlist -S "res,ext" \
     -o "%(title).80s [%(id)s].%(ext)s" -P "<输出目录>" "<URL>"
   ```
   - 单 P 视频加 `--no-playlist`；确实要整集/整季就去掉它并用 `--playlist-items 1-12`。
   - 明确挑画质：`-f "bv*[height<=1080]+ba/b"`（B站 DASH 会拉视频流+音轨两条，交给 ffmpeg 合并）。
   - 只要声音/转音频：`-x --audio-format mp3`。
4. **验收**（这一步不能省，是判断"下载成功"的唯一依据）：
   ```bash
   E:\mysoft\ffmpeg\bin\ffprobe.exe -v error -show_entries stream=codec_type,codec_name \
     -of default=nw=1 "<产物>"
   ```
   必须同时看到 `codec_type=video` 和 `codec_type=audio`（音频类资源除外）。只报文件大小不算验收。
   **时长要对照**：把 ffprobe 的 `format=duration` 与提取器报的 duration 比一下，一致即为完整文件。
   时长很短（几十秒）时先分清是「被截断/试看片段」还是「本来就是预告片」——按体积反推时长只是线索，
   别据此断言下载失败，问一句或查官方时长再下结论。
- **中文文件名的编码坑**：标题带中文/全角标点（`“ ”`、`+` 等）时，在 Git Bash 里把路径传给 Windows 版
  ffprobe/ffmpeg 会因 ANSI 代码页对不上而报 `No such file or directory`（而 `ls` 明明看得见）。
  验收改用 Python 传路径，别怀疑文件没下成：
  ```bash
  python -c "import glob,os,subprocess;p=os.path.abspath(glob.glob('*<ID>*.mp4')[0]);\
  print(subprocess.run([r'E:\mysoft\ffmpeg\bin\ffprobe.exe','-v','error','-show_entries',\
  'format=duration:stream=codec_type,codec_name,width,height','-of','default=nw=1',p],\
  capture_output=True,text=True,encoding='utf-8').stdout)"
  ```
  别为了避坑加 `--restrict-filenames`，那会把中文标题全变成下划线。
- **番剧/国创**（`/bangumi/play/epXXXX`）走 `BiliBiliBangumi` 提取器：未登录通常只给 360P/480P，
  720P/1080P 一律被会员锁挡（报 `Format(s) ... are missing`）。预告片常常本身就是几十秒，属正常。
  对照：普通投稿（`/video/BV...`）走 `BiliBili` 提取器，未登录一般能给到 **1080P**，只锁「1080P 高码率」——
  所以画质能不能拿，先看是番剧还是投稿，别无脑喊要 Cookie。
5. 交付时给出**产物绝对路径 + 分辨率 + 体积**，不要只说"下好了"。

## 高清与登录
- B站 **1080P 高码率 / 大会员 / 付费课程**：必须带 Cookie，否则会看到 `Format(s) 1080P 高码率 are missing`。
  ```bash
  yt-dlp --cookies-from-browser edge -F "<URL>"    # chrome / edge / firefox
  ```
  读浏览器 Cookie 属于访问用户凭据，**用之前先问一句用哪个浏览器**，并且只在确实需要高清时加。
- 下过 Cookie 后建议 `--cookies cookies.txt` 存成文件复用，少碰浏览器。

## 抖音 / TikTok
`yt-dlp` 自带 `Douyin` 与 `TikTok` 提取器，但**抖音反爬改动频繁，经常整段时间失效**，别向用户承诺稳定。按此顺序处理：
1. 先 `pip install -U yt-dlp`（提取器失效九成是版本旧）。
2. 短链（`v.douyin.com/xxx`）可以粘原始分享文本，yt-dlp 会自己提 URL；若失败，先 `curl -sIL "<短链>"` 拿到真实 `www.douyin.com/video/<id>` 再喂给它。
3. 报 `Fresh cookies / 需要登录`：加 `--cookies-from-browser edge`。
4. 仍然失败就如实说"提取器挂了"，给出两个出路：等 yt-dlp 更新，或者由用户从 App 里"保存本地"。**不要绕到第三方解析网站**（不可信、常夹带东西）。

## 小红书（2026-11-01 实测补录）
yt-dlp 2026.08.19 自带 `XiaoHongShu` 提取器（`--list-extractors | grep -i xiaohongshu` 可确认），
覆盖 `www.xiaohongshu.com/explore/<noteId>`、`/video/<noteId>` 与 `xhslink.com` 短链。

**限制，先跟用户讲清楚再动手**：
- **只给「视频笔记」**，图文笔记没有视频流，会直接报 `No video formats found`——这不是版本问题，别反复升级重试。
- 大概率要登录态：`--cookies-from-browser edge`（先问用哪个浏览器）。
- **代理坑**：本机 Windows 系统代理指向 `http://127.0.0.1:10808`（yt-dlp `-v` 的 `Proxy map` 能看到），
  访问国内站点可能被拦或极慢。
  国内平台优先 `--no-check-certificates` 不用管，但要 `--proxy ""` 显式关掉代理再试一次：
  ```bash
  yt-dlp --proxy "" --cookies-from-browser edge -F "<链接>"
  ```
- 短链 `xhslink.com/xxx` 若解析失败，先 `curl -sIL "<短链>"` 拿真实 `explore/<noteId>` 再喂给它。

## 手机端网页版（2026-11-01）
需要「在手机上框选去水印 / 裁剪后存到手机」时，别临时手搓，直接用现成的：
`E:\testsoft\Lumii-data\outputs\video-downloader-web\` —— `python server.py` 起服务（默认 8848），
手机同 WiFi 扫终端二维码访问。后端复用本技能这套 yt-dlp + ffmpeg，前端是触控框选 + 实时预览。
启动横幅会打印局域网地址和防火墙放行命令；端口占用、HEVC/AV1 转码、iOS HEAD 探测这几个坑都已在代码里处理。

## 其它站点
yt-dlp 覆盖 1800+ 站点，`yt-dlp --list-extractors | grep -i <关键词>` 先查支持情况；不支持的站点直接说不支持，别用通用抓取硬凑。

## 网络源事实（省得重新踩坑）
装/修 ffmpeg 时**别从这几个源拉，会耗死**：gyan.dev ≈6KB/s、GitHub Release ≈112KB/s、TUNA conda 对 curl 返回 403。可用的：

- **阿里云 PyPI**（已配在 pip.conf，~3MB/s）：`pip download imageio-ffmpeg`，wheel 内含 `ffmpeg-win-x86_64-v7.1.exe`（gyan essentials 完整版）。
- **npmmirror**（~2-4MB/s）：`https://registry.npmmirror.com/@ffprobe-installer/win32-x64/-/win32-x64-5.1.0.tgz` → `package/ffprobe.exe`。

ffmpeg 缺失时的修复：下载上面两个包，把 `ffmpeg.exe` / `ffprobe.exe` 放进 `E:\mysoft\ffmpeg\bin\`，用 `-version` 与 `-encoders | grep libx264` 验证。

## 红线
- 下载前必须展示链接、格式、体积、落盘路径并取得确认；批量任务先报总量。
- 不覆盖同名文件：用 `%(title).80s [%(id)s]` 命名，`yt-dlp` 默认还会断点续传。
- 仅限个人备份/离线观看。付费内容、他人原创作品的二次分发不做。
- 下载中途要停就停，别为了"跑完"换源硬试；失败原因如实报告。
