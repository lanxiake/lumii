#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""MediaCrawler 采集 wrapper

自检 / 安装 / 登录 / 采集 / 查看产物。
只用标准库，用系统 python 就能跑（它内部再去调仓库自己的 venv）。

用法:
    python wrapper.py preflight [--platform xhs] [--json]
    python wrapper.py install   [--repo PATH] [--index-url URL]
    python wrapper.py login     [--platform xhs] [--cdp auto|on|off]
    python wrapper.py run       --platform xhs --keywords "美食" [--max 20] [--cdp auto|on|off]
    python wrapper.py last      [--platform xhs] [--limit 10]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

try:  # 让 Windows 控制台也能打中文和 emoji
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO_URL = "https://github.com/NanmiCoder/MediaCrawler"
ZIP_URL = "https://codeload.github.com/NanmiCoder/MediaCrawler/zip/refs/heads/main"
DEFAULT_INDEX = "https://mirrors.aliyun.com/pypi/simple/"
CDP_PORT = 9222
PLATFORMS = {
    "xhs": "小红书", "dy": "抖音", "ks": "快手",
    "bili": "B站", "wb": "微博", "tieba": "贴吧", "zhihu": "知乎",
}
CFG_KEYS = [
    "PLATFORM", "HEADLESS", "ENABLE_CDP_MODE", "SAVE_DATA_OPTION",
    "CRAWLER_MAX_NOTES_COUNT", "ENABLE_GET_COMMENTS", "SAVE_LOGIN_STATE",
    "CDP_DEBUG_PORT", "ENABLE_GET_MEDIA",
]


# ---------------------------------------------------------------- 基础工具

def workspace_root() -> Path:
    """<ws>/skills/<分类>/mediacrawler/scripts/wrapper.py → <ws>"""
    return Path(__file__).resolve().parents[4]


def looks_like_repo(p: Path) -> bool:
    return (p / "main.py").is_file() and (p / "media_platform").is_dir()


def find_repo(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = os.environ.get("MEDIACRAWLER_HOME")
    if env:
        return Path(env).expanduser().resolve()
    cands = [
        workspace_root() / "temp" / "oss-deep-test" / "mediacrawler",
        Path.home() / "MediaCrawler",
    ]
    for c in cands:
        if looks_like_repo(c):
            return c
    return cands[0]


def venv_python(repo: Path) -> Path | None:
    for rel in ("Scripts/python.exe", "bin/python", "bin/python3"):
        p = repo / ".venv" / rel
        if p.is_file():
            return p
    return None


def resolve_python(repo: Path, explicit: str | None = None) -> Path | None:
    """解释器优先级：--python > repo/.venv > $MEDIACRAWLER_PYTHON。

    顺序有意把 .venv 放在环境变量前面 —— install 造出来的环境应当直接生效，
    环境变量只是给「环境装在别处」（比如共用 venv、uv 管理的环境）留的口子。
    """
    if explicit:
        p = Path(explicit).expanduser()
        return p if p.is_file() else None
    v = venv_python(repo)
    if v:
        return v
    env = os.environ.get("MEDIACRAWLER_PYTHON")
    if env:
        p = Path(env).expanduser()
        return p if p.is_file() else None
    return None


def child_env() -> dict:
    """Windows 上不设 UTF-8 会因中文/emoji 输出炸掉（实测踩过）。"""
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def port_open(port: int, host: str = "127.0.0.1", timeout: float = 0.6) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def read_config(repo: Path) -> dict:
    f = repo / "config" / "base_config.py"
    if not f.is_file():
        return {}
    text = f.read_text(encoding="utf-8", errors="replace")
    out: dict = {}
    for k in CFG_KEYS:
        m = re.search(rf"(?m)^{k}\s*=\s*(\"[^\"]*\"|'[^']*'|True|False|\d+)", text)
        if m:
            v = m.group(1).strip().strip("\"'")
            if v in ("True", "False"):
                out[k] = v == "True"
            elif v.isdigit():
                out[k] = int(v)
            else:
                out[k] = v
    m = re.search(r"CRAWLER_TYPE\s*=\s*\(\s*\"([^\"]+)\"", text)
    if m:
        out["CRAWLER_TYPE"] = m.group(1)
    return out


def set_cdp(repo: Path, value: bool) -> str | None:
    """临时改写 ENABLE_CDP_MODE，返回原文本（用于还原）。"""
    f = repo / "config" / "base_config.py"
    if not f.is_file():
        return None
    orig = f.read_text(encoding="utf-8")
    new = re.sub(r"(?m)^ENABLE_CDP_MODE\s*=\s*(True|False)",
                 f"ENABLE_CDP_MODE = {value}", orig, count=1)
    if new == orig:
        return None
    (repo / "config" / "base_config.py.wrapper-bak").write_text(orig, encoding="utf-8")
    f.write_text(new, encoding="utf-8")
    return orig


def restore_cdp(repo: Path, orig: str | None) -> None:
    if not orig:
        return
    (repo / "config" / "base_config.py").write_text(orig, encoding="utf-8")
    bak = repo / "config" / "base_config.py.wrapper-bak"
    if bak.exists():
        bak.unlink()


def run_cmd(cmd: list, cwd: Path | None = None, log: Path | None = None) -> int:
    """跑子进程，边跑边回显；给了 log 就同时落盘。"""
    print("$ " + " ".join(str(c) for c in cmd), flush=True)
    fh = None
    if log:
        log.parent.mkdir(parents=True, exist_ok=True)
        fh = log.open("w", encoding="utf-8", errors="replace")
    try:
        proc = subprocess.Popen(
            [str(c) for c in cmd], cwd=str(cwd) if cwd else None,
            env=child_env(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
        )
        for line in proc.stdout:
            print(line, end="", flush=True)
            if fh:
                fh.write(line)
        proc.wait()
        return proc.returncode
    except KeyboardInterrupt:
        print("\n[中断] 已收到 Ctrl-C。", flush=True)
        try:
            proc.terminate()
        except Exception:
            pass
        return 130
    finally:
        if fh:
            fh.close()


# ---------------------------------------------------------------- preflight

def gather_state(repo: Path, platform: str, python_path: str | None = None) -> dict:
    st: dict = {"repo": str(repo), "platform": platform, "checks": []}

    def add(name, ok, detail, blocking=True):
        st["checks"].append({"name": name, "ok": ok, "detail": detail, "blocking": blocking})

    add("仓库可识别", looks_like_repo(repo),
        "找到 main.py + media_platform" if looks_like_repo(repo)
        else f"没找到，看看 {repo}；先跑 install")

    py = resolve_python(repo, python_path)
    src = ("--python 指定" if python_path else
           ".venv" if py and ".venv" in str(py) else "$MEDIACRAWLER_PYTHON")
    add("解释器", bool(py), f"{py}（来源：{src}）" if py
        else "找不到：跑 install 建 .venv，或用 --python 指一个装好依赖的环境")

    target_py = py or Path(sys.executable)
    try:
        r = subprocess.run([str(target_py), "-c",
                            "import sys;print('%d.%d.%d'%sys.version_info[:3])"],
                           capture_output=True, text=True, timeout=30)
        ver = r.stdout.strip()
        parts = tuple(int(x) for x in ver.split("."))
        ok = (3, 10) <= parts < (3, 13)
        add("Python 版本", ok, f"{ver}（要求 >=3.10,<3.13）" if ok
            else f"{ver} 不在 3.10~3.12 范围内")
    except Exception as e:
        add("Python 版本", False, f"探测失败: {e}")

    if py:
        try:
            r = subprocess.run([str(py), "-c", "import playwright;print('ok')"],
                               capture_output=True, text=True, timeout=60)
            ok = r.returncode == 0 and "ok" in (r.stdout or "")
            err = [l for l in (r.stderr or "").strip().splitlines() if l.strip()]
            add("playwright 包", ok, "已装" if ok else (err[-1][:120] if err else "import 失败"))
        except Exception as e:
            add("playwright 包", False, str(e))

        try:
            r = subprocess.run([str(py), "-m", "playwright", "install", "--dry-run", "chromium"],
                               capture_output=True, text=True, timeout=120)
            m = re.search(r"Install location:\s*(.+)", r.stdout or "")
            if m:
                loc = Path(m.group(1).strip())
                add("浏览器二进制", loc.exists(), f"{loc}（{'存在' if loc.exists() else '缺失，跑 install'}）")
            else:
                add("浏览器二进制", False, "拿不到安装位置，手工跑 playwright install chromium")
        except Exception as e:
            add("浏览器二进制", False, str(e))

        try:
            r = subprocess.run([str(py), "-c", "import websockets;print('ok')"],
                               capture_output=True, text=True, timeout=60)
            ok = r.returncode == 0
            add("websockets（日志推送）", ok,
                "已装" if ok else "缺，装 uvicorn[standard] 才有实时日志推送", blocking=False)
        except Exception as e:
            add("websockets（日志推送）", False, str(e))

    cdp_on = port_open(CDP_PORT)
    add(f"CDP 端口 {CDP_PORT}", cdp_on,
        "可连（会走 CDP 模式，复用你已登录的 Chrome）" if cdp_on
        else "不通——用 --cdp auto/off 跳过那 60 秒空等，或让用户在 chrome://inspect/#remote-debugging 打开",
        blocking=False)

    prof = repo / "browser_data" / f"{platform}_user_data_dir"
    exists = prof.is_dir()
    mt = time.strftime("%Y-%m-%d %H:%M", time.localtime(prof.stat().st_mtime)) if exists else "-"
    add("登录态 profile", exists,
        f"{prof}（最后改动 {mt}；有效性只有跑起来才知道，看日志的 Login state result）"
        if exists else "还没有——首次要跑 login 让人扫码", blocking=False)

    cfg = read_config(repo)
    st["config"] = cfg
    add("当前配置", True,
        f"平台={cfg.get('PLATFORM')} 类型={cfg.get('CRAWLER_TYPE')} "
        f"CDP={cfg.get('ENABLE_CDP_MODE')} HEADLESS={cfg.get('HEADLESS')} "
        f"存储={cfg.get('SAVE_DATA_OPTION')}", blocking=False)

    st["ok"] = all(c["ok"] for c in st["checks"] if c.get("blocking", True))
    return st


def cmd_preflight(args):
    repo = find_repo(args.repo)
    st = gather_state(repo, args.platform, getattr(args, "python", None))
    if args.json:
        print(json.dumps(st, ensure_ascii=False, indent=2))
        return 0 if st["ok"] else 1
    print(f"仓库: {st['repo']}\n")
    for c in st["checks"]:
        if c["ok"]:
            tag = "ok  "
        else:
            tag = "!!  " if c.get("blocking", True) else "warn"
        print(f"  [{tag}] {c['name']}: {c['detail']}")
    print("\n结论: " + ("环境就绪，可以采集。" if st["ok"] else "有阻塞项，先修 [!!] 的；[warn] 不拦路。"))
    print("提醒: 该仓库许可为 NON-COMMERCIAL LEARNING LICENSE 1.1，禁止商用。")
    return 0 if st["ok"] else 1


# ---------------------------------------------------------------- install

def cmd_install(args):
    repo = find_repo(args.repo)
    repo.parent.mkdir(parents=True, exist_ok=True)

    if not looks_like_repo(repo):
        print(f"克隆到 {repo}")
        rc = run_cmd(["git", "clone", "--depth", "1", REPO_URL, str(repo)])
        if rc != 0 or not looks_like_repo(repo):
            print("git 克隆失败（本机 git 协议可能被拦），改用 zip 包下载。")
            import urllib.request, zipfile, tempfile
            tmp = Path(tempfile.mkdtemp()) / "mc.zip"
            urllib.request.urlretrieve(ZIP_URL, tmp)
            with zipfile.ZipFile(tmp) as z:
                z.extractall(tmp.parent)
            inner = next(p for p in tmp.parent.iterdir() if p.is_dir() and p.name.startswith("MediaCrawler"))
            if repo.exists():
                shutil.rmtree(repo)
            shutil.move(str(inner), str(repo))
    else:
        print(f"仓库已在 {repo}，跳过克隆。")

    py = venv_python(repo)
    if not py:
        print("创建 venv …")
        if run_cmd([sys.executable, "-m", "venv", str(repo / ".venv")]) != 0:
            return 1
        py = venv_python(repo)
        if not py:
            print("venv 建不起来。")
            return 1

    steps = [
        [str(py), "-m", "pip", "install", "-U", "pip", "-i", args.index_url],
        [str(py), "-m", "pip", "install", "-r", "requirements.txt", "-i", args.index_url],
        # 补 websockets：否则 WebUI 的 /api/ws/logs 会 404，日志退化成轮询
        [str(py), "-m", "pip", "install", "uvicorn[standard]", "-i", args.index_url],
        [str(py), "-m", "playwright", "install", "chromium"],
    ]
    for s in steps:
        t0 = time.time()
        rc = run_cmd(s, cwd=repo)
        print(f"  → rc={rc}，用时 {time.time()-t0:.0f}s\n")
        if rc != 0:
            print("这一步失败了，先看上面的报错。")
            return rc

    st = gather_state(repo, args.platform)
    ok = all(c["ok"] for c in st["checks"] if c["name"].startswith(("仓库", "venv", "Python", "浏览器")))
    print("安装完成。" if ok else "装完了但自检仍有问题，跑一下 preflight 看细节。")
    return 0 if ok else 1


# ---------------------------------------------------------------- run / login

COUNTABLE = (".jsonl", ".csv")


def count_lines(f: Path) -> int | None:
    if f.suffix.lower() not in COUNTABLE:
        return None
    try:
        with f.open(encoding="utf-8", errors="replace") as fh:
            return sum(1 for _ in fh)
    except Exception:
        return None


def snapshot(repo: Path, platform: str) -> dict:
    """跑之前先记一份「文件 → 行数」，跑完才能算准本次新增了多少。

    注意：MediaCrawler 的产物按日期命名且是追加写的，同一个文件当天会越写越长，
    所以直接读总行数会把上一次的结果也算进来 —— 那汇报出去就是错的数字。
    """
    out: dict = {}
    base = repo / "data" / platform
    if base.is_dir():
        for f in base.rglob("*"):
            if f.is_file():
                out[str(f)] = count_lines(f)
    return out


def diff_artifacts(repo: Path, platform: str, before: dict) -> list:
    rows = []
    base = repo / "data" / platform
    if not base.is_dir():
        return rows
    for f in base.rglob("*"):
        if not f.is_file():
            continue
        key = str(f)
        now = count_lines(f)
        old = before.get(key, 0 if key not in before else None)
        if key not in before:
            added = now                      # 全新文件
        elif now is None or old is None:
            added = None                     # 非计数类文件
        else:
            added = now - old
        if added == 0:
            continue                         # 这次没动它
        rows.append({"path": key, "added": added, "total": now,
                     "bytes": f.stat().st_size, "is_new": key not in before})
    return rows


def build_argv(py: Path, args) -> list:
    argv = [str(py), "main.py", "--platform", args.platform, "--type", getattr(args, "type", "search")]
    if getattr(args, "keywords", None):
        argv += ["--keywords", args.keywords]
    if getattr(args, "specified_id", None):
        argv += ["--specified_id", args.specified_id]
    if getattr(args, "creator_id", None):
        argv += ["--creator_id", args.creator_id]
    if getattr(args, "max", None):
        argv += ["--crawler_max_notes_count", str(args.max)]
    if getattr(args, "save_data_option", None):
        argv += ["--save_data_option", args.save_data_option]
    if getattr(args, "comments", None) is not None:
        argv += ["--get_comment", "yes" if args.comments else "no"]
    argv += ["--headless", "true" if getattr(args, "headless", False) else "false"]
    return argv


def do_run(args, repo: Path, py: Path) -> int:
    before = snapshot(repo, args.platform)
    logdir = workspace_root() / "outputs" / "mediacrawler" / "logs"
    log = logdir / f"run-{args.platform}-{time.strftime('%Y%m%d-%H%M%S')}.log"

    orig_cfg = None
    cdp_cfg_on = read_config(repo).get("ENABLE_CDP_MODE")
    cdp_live = port_open(CDP_PORT)
    if args.cdp == "on":
        print(f"[cdp] 按 --cdp on 保持 CDP 模式（端口 {CDP_PORT} {'可达' if cdp_live else '当前不通，会先空等 60 秒再降级'}）。")
    elif args.cdp == "off" or not cdp_live:
        if cdp_cfg_on:
            orig_cfg = set_cdp(repo, False)
            print(f"[cdp] {CDP_PORT} 不通，临时把 ENABLE_CDP_MODE 改成 False，跑完还原（省掉 60 秒空等）。")
        else:
            print(f"[cdp] {CDP_PORT} 不通，但配置里 CDP 本来就是关的，无需改动。")
    else:
        print(f"[cdp] {CDP_PORT} 可达，保持 CDP 模式。")

    try:
        rc = run_cmd(build_argv(py, args), cwd=repo, log=log)
    finally:
        restore_cdp(repo, orig_cfg)

    arts = diff_artifacts(repo, args.platform, before)
    total = sum(a["added"] or 0 for a in arts)
    login = None
    if log.is_file():
        for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
            if "Login state result:" in line:
                login = line.split("Login state result:")[-1].strip().rstrip(".")
    result = {"platform": args.platform, "rc": rc, "log": str(log),
              "artifacts": arts, "added_records": total, "login_state": login}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("\n" + "=" * 52)
        print(f"平台/模式: {PLATFORMS.get(args.platform, args.platform)} · {getattr(args, 'type', 'search')}")
        if getattr(args, "keywords", None):
            print(f"关键词: {args.keywords}")
        print(f"退出码: {rc}   登录态: {login or '未在日志中识别到'}")
        print(f"本次新增: {total} 条（涉及 {len(arts)} 个文件）")
        for a in arts:
            tag = "新建" if a["is_new"] else "追加"
            print(f"  - +{a['added']} 条（{tag}，该文件累计 {a['total']}）")
            print(f"    {a['path']}")
        print(f"日志: {log}")
        print("提醒: 该项目许可禁止商用，仅限个人学习研究。")
    return rc


def cmd_run(args):
    repo = find_repo(args.repo)
    py = resolve_python(repo, getattr(args, "python", None))
    if not py:
        print("找不到可用解释器：跑 install 建 .venv，或用 --python 指一个装好依赖的环境。")
        return 1
    return do_run(args, repo, py)


def cmd_login(args):
    args.type = "search"
    args.keywords = args.keywords or "美食"
    args.max = 1
    args.comments = False
    args.save_data_option = None
    args.specified_id = args.creator_id = None
    args.headless = False  # 扫码必须有头
    repo = find_repo(args.repo)
    py = resolve_python(repo, getattr(args, "python", None))
    if not py:
        print("找不到可用解释器：跑 install 建 .venv，或用 --python 指一个装好依赖的环境。")
        return 1
    print("这是一次最小采集（抓 1 条就停），登录态会在过程中按需建立。")
    print("浏览器会弹出二维码 —— 请用户用对应 App 扫码；扫完可以 Ctrl-C 结束。\n")
    return do_run(args, repo, py)


# ---------------------------------------------------------------- last

def cmd_last(args):
    repo = find_repo(args.repo)
    data = repo / "data"
    rows = []
    if args.platform:
        plats = [args.platform]
    elif data.is_dir():
        plats = [d.name for d in data.iterdir() if d.is_dir()]
    else:
        plats = []
    for pl in plats:
        for path, n in snapshot(repo, pl).items():
            rows.append({"platform": pl, "path": path, "records": n,
                         "bytes": os.path.getsize(path)})
    rows.sort(key=lambda r: os.path.getmtime(r["path"]), reverse=True)
    rows = rows[: args.limit]
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    if not rows:
        print("没有找到数据产物。跑一次 run 再说。")
        return 0
    print(f"最近 {len(rows)} 个数据文件：")
    for r in rows:
        ts = time.strftime("%m-%d %H:%M", time.localtime(os.path.getmtime(r["path"])))
        cnt = r["records"] if r["records"] is not None else "?"
        print(f"  {ts}  [{r['platform']}]  {str(cnt):>6} 条  {r['path']}")
    return 0


# ---------------------------------------------------------------- CLI

def main() -> int:
    ap = argparse.ArgumentParser(description="MediaCrawler 采集 wrapper")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p, platform=True):
        p.add_argument("--repo", help="MediaCrawler 仓库路径")
        p.add_argument("--python", help="指定解释器（默认 repo/.venv，其次 $MEDIACRAWLER_PYTHON）")
        p.add_argument("--json", action="store_true")
        if platform:
            p.add_argument("--platform", default="xhs", choices=list(PLATFORMS))

    p = sub.add_parser("preflight", help="环境与登录态自检"); common(p); p.set_defaults(fn=cmd_preflight)
    p = sub.add_parser("install", help="克隆 + 装依赖 + 装浏览器"); common(p)
    p.add_argument("--index-url", default=DEFAULT_INDEX); p.set_defaults(fn=cmd_install)
    p = sub.add_parser("login", help="触发登录（顺带最小采集）"); common(p)
    p.add_argument("--cdp", default="auto", choices=["auto", "on", "off"])
    p.add_argument("--keywords", default="美食"); p.set_defaults(fn=cmd_login)
    p = sub.add_parser("run", help="执行采集"); common(p)
    p.add_argument("--type", default="search", choices=["search", "detail", "creator"])
    p.add_argument("--keywords"); p.add_argument("--specified_id"); p.add_argument("--creator_id")
    p.add_argument("--max", type=int); p.add_argument("--save-data-option", dest="save_data_option")
    p.add_argument("--comments", dest="comments", action="store_true")
    p.add_argument("--no-comments", dest="comments", action="store_false")
    p.set_defaults(comments=None, fn=cmd_run)
    p.add_argument("--cdp", default="auto", choices=["auto", "on", "off"])
    p.add_argument("--headless", action="store_true")
    p = sub.add_parser("last", help="列出已有数据产物"); common(p)
    p.add_argument("--limit", type=int, default=10); p.set_defaults(fn=cmd_last)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
