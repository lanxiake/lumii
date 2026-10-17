# -*- coding: utf-8 -*-
"""取各版本微信安装包：**先试镜像、再回退官方**，一律用发布方公布的 SHA256 收口。

为什么必须校验：镜像（gh-proxy 等）是第三方转发。实测镜像 ~1.8MB/s、官方走代理只 ~70KB/s，
差 25 倍——但**不校验就等于拿别人的字节当腾讯的字节**，静态扫描的结论会变成对另一个文件说的。
Rodert/wechat-win-versions 每个 release 的正文里都写了官方 `Sha256:`，拿它对。

用法：
  PYTHONIOENCODING=utf-8 python fetch_wx_versions.py 4.1.6 4.1.9 4.1.15.53
  PYTHONIOENCODING=utf-8 python fetch_wx_versions.py --list          # 看有哪些版本
可选环境变量 WX_DL_DIR 指定落点（默认 `%TEMP%\\wxcompat`）。
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time

OUT = os.environ.get("WX_DL_DIR") or os.path.join(
    os.environ.get("TEMP") or os.path.expanduser("~"), "wxcompat")
PROXY = "http://127.0.0.1:10808"
INDEX = os.path.join(OUT, "rel1.json")
MIRROR = "https://gh-proxy.com/"
API = "https://api.github.com/repos/Rodert/wechat-win-versions/releases?per_page=100"


def fetch_index():
    """拉 release 索引（走代理）——里面有每版的官方 URL 与 Sha256。"""
    if os.path.exists(INDEX):
        return json.load(open(INDEX, encoding="utf-8"))
    os.makedirs(OUT, exist_ok=True)
    subprocess.run(["curl", "-sSL", "--proxy", PROXY, "-o", INDEX, API], check=True)
    return json.load(open(INDEX, encoding="utf-8"))


def versions():
    """`{版本号: (url, sha256_or_None, 字节数)}`。"""
    out = {}
    for r in fetch_index():
        for a in r.get("assets", []):
            if not a["name"].endswith(".exe"):
                continue
            m = re.search(r"(\d+\.\d+\.\d+(?:\.\d+)?)", a["name"])
            if not m:
                continue
            s = re.search(r"sha256:\s*([0-9a-f]{64})", r.get("body") or "", re.I)
            out[m.group(1)] = (a["browser_download_url"], s.group(1).lower() if s else None, a["size"])
    return out


def sha_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()


def get(url, dst):
    """下载到 dst（带续传）。成功返回 True。"""
    r = subprocess.run(["curl", "-sSL", "-C", "-", "--retry", "5", "--retry-all-errors",
                        "-o", dst, url])
    return r.returncode == 0


def one(ver, info):
    url, want, size = info
    dst = os.path.join(OUT, "wx-%s.exe" % ver)
    if os.path.exists(dst) and want and sha_of(dst) == want:
        print("%-12s 已有且哈希一致" % ver)
        return True
    for tag, u in (("镜像", MIRROR + url), ("官方(代理)", url)):
        if tag.startswith("官方"):
            # 镜像没成，走代理；删掉半截文件免得续传拼错
            if os.path.exists(dst):
                os.remove(dst)
            print("%-12s 回退官方…" % ver)
            r = subprocess.run(["curl", "-sSL", "-C", "-", "--proxy", PROXY,
                                "--retry", "20", "--retry-all-errors", "-o", dst, u])
            ok = r.returncode == 0
        else:
            ok = get(u, dst)
        if not ok:
            print("%-12s %s 下载失败" % (ver, tag))
            continue
        got = sha_of(dst)
        if want and got != want:
            print("%-12s ★ %s 的字节与官方 SHA256 不符（%s…），丢弃" % (ver, tag, got[:16]))
            os.remove(dst)
            continue
        print("%-12s ✓ %s，%.1f MB，SHA256 %s" % (ver, tag, os.path.getsize(dst) / 1048576,
                                                 (got[:16] + "…") if want else "（该版未公布，未校验）"))
        return True
    return False


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    vs = versions()
    if not sys.argv[1:] or "--list" in sys.argv:
        print("可用版本 %d 个：" % len(vs))
        for v in sorted(vs, key=lambda s: [int(x) for x in s.split(".")]):
            print("  %-12s %6.1f MB  %s" % (v, vs[v][2] / 1048576, "有哈希" if vs[v][1] else "无哈希"))
        return 0
    t0 = time.time()
    bad = [v for v in sys.argv[1:] if v not in vs or not one(v, vs[v])]
    print("耗时 %.0fs；失败：%s" % (time.time() - t0, bad or "无"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
