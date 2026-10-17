# -*- coding: utf-8 -*-
"""微信版本兼容性**静态扫描**：把 `wechat-mcp` 硬绑到微信二进制上的那些字面量，
在一个安装目录里逐个找（ASCII + UTF-16LE 两种编码）。

**为什么先做这个**：这套代码对微信内部结构的假设是硬的——密钥扫描要找
`com.Tencent.WCDB.Config.Cipher` 那几个字节和一段 16 字节机器码，发送层要认
`Qt*QWindowIcon` 形状的窗口类名，UIA 读数要靠 `session_item_` / `chat_input_field`
这些 AutomationId。真机逐个装十几个版本要扫码登录十几遍、且降级会迁移用户的
`db_storage`，所以先用**不装不登录**的方式把候选区间收窄。

⚠️ **静态命中 ≠ 运行时可用**。它只能证伪（找不到 = 这版一定不行），不能证实
（找到了仍可能因偏移/结构变了而失效）。运行时那部分只能真机抽验。

用法：python probe_wx_version_compat.py <微信安装目录> [更多目录...]
只读：只 open/read，不执行任何东西。
"""
import os
import sys

# `(标签, needle, 来源)`——**这份表就是兼容性契约**，加一条要写清它在哪被用。
NEEDLES = [
    ("Config.Cipher 名", b"com.Tencent.WCDB.Config.Cipher", "wxkey4.py:24 挖密钥的入口字符串"),
    ("CONFIG_XOR_MASK", bytes.fromhex("d2c7442458020000004889442450488b"
                                      "450048844c2448488944254048584c24"),
     "wxkey4.py:25 blob 解码掩码（编译器生成的机器码，最可能随版本变）"),
    ("QWindowIcon 类名形状", b"QWindowIcon", "wechat_sender.py:297 认主窗口"),
    ("UIA session_item_", b"session_item_", "wechat_sender.py 会话列表项"),
    ("UIA search_list", b"search_list", "uia_read.ps1:84 搜索浮层"),
    ("UIA chat_input_field", b"chat_input_field", "uia_read.ps1:114 输入框"),
    # ⚠️ 这里**只能放二进制里的字面量**：`image_hardlink_info_v4` / `video_hardlink_info_v4`
    # 是 SQLite 表名，住在 `hardlink.db` 的字节里、不在 exe 里（基线实测两个都找不到）。
    # 真契约是客户端会不会写出 `hardlink/` 这个目录——`wechat_image.hardlink_map` 开的就是它。
    ("hardlink 目录", b"hardlink", "wechat_image.py:232 图片/视频换名的索引目录"),
    ("数据目录名", b"xwechat_files", "wechat_core.py 数据目录探测"),
    # 基线实测这条**只有 utf16**（`db_storage`）——只试 ASCII 的话会得到假阴性。
    ("db_storage 目录", b"db_storage", "wechat_core.py 定位 message_N.db/session.db"),
]

SKIP_DIR = {"__pycache__"}
MIN_SIZE = 64 * 1024          # 小文件不可能放这些字面量（省扫描时间）


def variants(needle):
    """ASCII 与 UTF-16LE 两种编码都试——Qt/C++ 里两种都常见，猜错编码 = 假阴性。"""
    try:
        wide = needle.decode("ascii").encode("utf-16-le")
    except UnicodeDecodeError:
        wide = None
    return [("ascii", needle)] + ([("utf16", wide)] if wide and wide != needle else [])


def scan_file(path, needle):
    """返回命中的编码名列表（去重）。"""
    hits = []
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return hits
    for name, pat in variants(needle):
        if pat in data:
            hits.append(name)
    return hits


def scan_root(root):
    """扫一个微信安装目录 → `{标签: {文件名: [编码]}}`；另外报出最大那个文件的体积。"""
    found = {label: {} for label, _b, _s in NEEDLES}
    files = []
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIR]
        for n in names:
            p = os.path.join(base, n)
            try:
                if os.path.getsize(p) < MIN_SIZE:
                    continue
            except OSError:
                continue
            files.append(p)
    for p in files:
        rel = os.path.relpath(p, root)
        for label, needle, _src in NEEDLES:
            hit = scan_file(p, needle)
            if hit:
                found[label][rel] = hit
    return found


SZ = r"C:\Program Files\7-Zip\7z.exe"


def expand(arg, workdir):
    """参数是目录就直接扫；是**安装包**（NSIS 套 install.7z）就先解到 workdir。

    实测形状（2026-10-15）：腾讯安装包 = NSIS3 → 里面一个**纯存储**的 `install.7z`
    → 里面 `4.1.<小版本>.<补丁>\\` 一整棵载荷。所以解两层。
    返回可扫的目录；解不开返回 `None`。
    """
    if os.path.isdir(arg):
        return arg
    import re
    import subprocess
    out = os.path.join(workdir, os.path.basename(arg) + ".x")
    try:
        subprocess.run([SZ, "x", "-o" + out, "-y", arg], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        inner = os.path.join(out, "install.7z")
        if os.path.exists(inner):
            subprocess.run([SZ, "x", "-o" + out, "-y", inner], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:                              # noqa: BLE001
        print("  （解包失败：%r）" % (e,))
        return None
    return out


def label_of(root, arg):
    """矩阵里的版本号：**认载荷目录名**（安装包文件名 ≠ 真实版本，`4.1.6.exe` 装出来是
    `4.1.6.46`）；没有版本目录才退回文件名。"""
    import re
    for d in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        if os.path.isdir(os.path.join(root, d)) and re.match(r"^\d+\.\d+", d):
            return d
    return os.path.basename(arg)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                   # noqa: BLE001
        pass
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    import tempfile
    workdir = tempfile.mkdtemp(prefix="wxcompat-")
    n_bad = 0
    print("%-14s %-8s %s" % ("版本", "命中", "缺的项"))
    print("-" * 78)
    for arg in args:
        root = expand(arg, workdir)
        ver = label_of(root, arg) if root else "?"
        if not root or not os.path.isdir(root):
            print("%-14s %-8s %s" % (ver, "-", "解不开/不是目录"))
            n_bad += 1
            continue
        found = scan_root(root)
        missing = [lab for lab, _b, _s in NEEDLES if not found[lab]]
        print("%-14s %-8s %s" % (ver, "%d/%d" % (len(NEEDLES) - len(missing), len(NEEDLES)),
                                 "、".join(missing) if missing else "—"))
        for lab in missing:
            src = next(s for l, _b, s in NEEDLES if l == lab)
            print("      ✗ %-20s ← %s" % (lab, src))
        if missing:
            n_bad += 1
    print("-" * 78)
    print("扫描目录：%s" % workdir)
    return 1 if n_bad else 0


if __name__ == "__main__":
    sys.exit(main())
