# 按症状排查

下面每一条都是 2026-11-14 ~ 15 在 Windows 11 + Python 3.12.7 上真实遇到过的，报错原文照抄。

---

## 1. `Page.goto: Page crashed` / `Page.content: Target crashed`

```
playwright._impl._errors.TargetClosedError: Page.goto: Page crashed
Call log:
  - navigating to "https://www.xiaohongshu.com/", waiting until "load"
```
```
playwright._impl._errors.Error: Page.content: Target crashed
```

**这不是风控，也不是代码 bug。** 实测根因是 **Playwright 的浏览器目录被删或损坏**——渲染进程根本起不来。

排查顺序：

1. 看 `%LOCALAPPDATA%\ms-playwright\` 里对应版本的目录还在不在。用 `python -m playwright install --dry-run chromium` 它会打印 `Install location:`，拿这个路径去核对。
2. 目录不存在或体积明显偏小 → `python -m playwright install chromium` 重装（约 45 秒、450 MB）。
3. 重装后立刻用一个最小脚本验证——**别直接重跑整条爬虫**，那样你分不清是修好了还是又崩了：

```python
import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        pg = await (await b.new_context()).new_page()
        await pg.goto("https://www.xiaohongshu.com/", wait_until="domcontentloaded", timeout=45000)
        print("OK", await pg.title(), len(await pg.content()))
        await b.close()
asyncio.run(main())
```

**注意**：这台机器上出现过"目录被外部进程删掉"的情况（同一时期还有装到一半的 Python 包凭空消失）。所以修好之后如果过一会儿又崩，先怀疑环境而不是代码。

---

## 2. 卡着不动，日志刷 `CDP port 9222 is not accessible`

```
[CDPBrowserManager] CDP port 9222 is not accessible     ← 每 3 秒一条
[CDPBrowserManager] Waiting up to 60s for browser CDP connection...
```

`ENABLE_CDP_MODE = True`（默认）时，程序会先去连本机 Chrome 的调试端口，**连不上会硬等 60 秒**才降级到自己启浏览器——这 60 秒纯属浪费。

两种处理：

- **要用 CDP（推荐）**：让用户开 Chrome，地址栏输入 `chrome://inspect/#remote-debugging`，勾选允许远程调试，看到 `Server running at: 127.0.0.1:9222` 即可。程序会弹出确认框，点"接受"。好处是直接复用他已登录的会话，不用扫码。
- **不用 CDP**：`wrapper.py run --cdp auto`（默认）会探测端口，不通就临时把 `ENABLE_CDP_MODE` 改成 `False`，跑完还原。

---

## 3. `Login state result: False`，然后一直等扫码

这是**正常流程**，不是故障。程序在看登录态、没登录就弹二维码等 120 秒。

要点：

- **必须 `--headless false`**（有头模式）。无头环境里二维码出不来，人没法扫。
- 二维码落地成 PNG，路径会打进日志（`二维码已经准备好啦，已保存到: ...`）。把这张图给用户扫，别只丢一个路径。
- 超时后它会 `sys.exit()`，不是挂住。
- 抖音可能触发短信二次验证：程序会读项目根目录的 `verify_code.txt`，没有就在交互式终端里直接提示输入。

---

## 4. 跑完了，但 0 条数据

按这个顺序看：

1. **日志里有没有 `Search notes response:` 这一行，`items` 是不是空的**。空 `items` = 平台侧没返回，通常是关键词太窄或登录态实际无效。
2. **登录态**：`Login state result:` 是 True 吗？False 就说明流程没真的登录成功。
3. **`CRAWLER_MAX_NOTES_COUNT`**：默认 15，太小会导致第一页采完就停。
4. **平台风控**：连续高频跑同一个平台容易被限。停一会儿再试，或 `--enable_ip_proxy` 配代理。

---

## 5. 7 个平台一个都拿不到数据

**先确认这不是 bug**：7 个平台全部以登录态为硬前提，逐个看过代码确认过——

| 平台 | 登录判定 |
|---|---|
| 小红书 | `web_session` cookie / 页面"我"入口 |
| B站 | `/x/web-interface/nav` 的 `isLogin` |
| 抖音 / 快手 / 微博 / 贴吧 / 知乎 | 各自登录页元素 + cookie |

没有可用的账号，就没有数据。这是它的设计边界。

---

## 6. `UnicodeDecodeError: 'gbk' codec can't decode byte ...`

Windows 控制台默认 GBK，遇到中文/emoji 输出就炸。两个层次：

- **输出侧**：设 `PYTHONUTF8=1` 和 `PYTHONIOENCODING=utf-8`（wrapper 已经替子进程设好）。
- **依赖安装侧**：如果 `requirements.txt` 里有中文注释，pip 读文件也会报同一个错。解法同样是 `PYTHONUTF8=1`，不用改文件。

---

## 7. 装依赖时刷 `SSLCertVerificationError: certificate has expired`

```
Could not fetch URL https://pypi.mirrors.ustc.edu.cn/simple/xxx/: There was a problem confirming the ssl certificate:
... certificate verify failed: certificate has expired
```

某个国内镜像的证书过期了，pip 会重试 5 次然后跳过。换源即可：

```bash
wrapper.py install --index-url https://mirrors.aliyun.com/pypi/simple/
```

---

## 8. WebUI 日志面板一直空，API 日志刷 404

```
WARNING:  No supported WebSocket library detected. Please use "pip install 'uvicorn[standard]'"
INFO:     127.0.0.1:xxxxx - "GET /api/ws/logs HTTP/1.1" 404 Not Found
```

默认依赖里没有 `websockets`，实时日志推送就是坏的，界面会退化成轮询 `/api/crawler/status`（实测一次运行里轮询了 2500 多次、404 了 1000 多次）。

修：`pip install "uvicorn[standard]"`。wrapper 的 `install` 已经带上这一步。

---

## 9. 数据条数对不上 / 越跑越多

`data/<平台>/<格式>/search_contents_<日期>.jsonl` 是**按日期命名且追加写**的。同一天跑第二次，新数据接在旧数据后面，文件总行数会把上一次的也算进去。

要报"这次采了多少"就得跑前跑后各数一次行数做差。`wrapper.py run` 的 `本次新增` 字段就是这么算的；别直接数文件总行数往上汇报。

---

## 10. 想复用已有环境 / 环境不在 repo/.venv

解释器查找顺序：`--python` → `repo/.venv` → `$MEDIACRAWLER_PYTHON`。

```bash
python wrapper.py preflight --python "C:/some/venv/Scripts/python.exe"
```

如果 preflight 报 `.venv` 里没有 playwright，多半是仓库里那个 `.venv` 是半成品（实测遇到过一个 65 MB 的残废环境，真正能跑的在别处）。

---

## 11. git clone 失败

```
fatal: unable to access 'https://github.com/...': OpenSSL SSL_connect: SSL_ERROR_SYSCALL
```

网络对 git 协议不友好时常见。`wrapper.py install` 已内置退路：git 失败就用 `codeload.github.com` 的 zip 包下载再解压，实测这条能通。
