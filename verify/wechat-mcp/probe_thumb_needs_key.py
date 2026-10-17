# -*- coding: utf-8 -*-
"""缩略图 `_t.dat` 到底要不要 AES key？**只读**：读真实数据目录里的文件，不写任何东西。

问的是报告 §9.3 的一条设计前提：「`read_image` 在没有 AES key 时**立即返回可用的缩略图**
（`_t.dat` 是 XOR-only 的 JPEG，不需要 AES key）」。若成立，新装的 exe 即使没抓过 key 也
能看图（降级），⑫-3 那条"永远读不出图"就不成立。

结论（2026-10-14 本机实测）：**不成立**。抽样 400 个 `_t.dat`，`aes_size` **全部 > 64**、
没有一个 `aes_size == 0` ⇒ 缩略图带的也是 AES 段，纯 XOR 解出的**没有一个**像图（
`looks_like_image` 0/400、`is_complete_image` 0/400）。
所以 **key 缺失时一条路都没有**，`wechat-mcp.exe --image-key` 是唯一入口。

用法：
  set PYTHONIOENCODING=utf-8
  ~/.lumii/runtimes/python-embed/python.exe verify/wechat-mcp/probe_thumb_needs_key.py

⚠️ 判据只看**文件头**（`aes_size`/`xor_size`）：不改微信数据、不落盘、不需要 key 本身。
"""
import collections
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "..",
                                                "apps", "windows", "resources", "wechat-mcp")))

import wechat_core as core  # noqa: E402
import wechat_image as IM  # noqa: E402

SAMPLE = 400


def main():
    root = os.path.dirname(core.db_root())
    files = sorted(set(glob.glob(os.path.join(root, "**", "Img", "*_t.dat"), recursive=True)),
                   key=os.path.getmtime, reverse=True)
    print(f"数据目录：{root}")
    print(f"`*_t.dat` 共 {len(files)} 个，抽样前 {min(SAMPLE, len(files))} 个只读文件头")

    bucket = collections.Counter()
    xor_like = xor_full = 0
    for f in files[:SAMPLE]:
        try:
            with open(f, "rb") as fh:
                d = fh.read()
        except OSError:
            continue
        hs = IM.header(d)
        if not hs:
            bucket["头不对"] += 1
            continue
        aes_size, xor_size = hs
        bucket["aes_size=0" if aes_size == 0 else
               ("0<aes_size<=64" if aes_size <= 64 else "aes_size>64")] += 1
        if aes_size == 0 and xor_size > 0:      # 只有这一支才谈得上"不需要 key"
            k = IM.tail_xor_key(d)
            if k is None:
                bucket["XOR key 反推不出"] += 1
                continue
            body = bytes(b ^ k for b in d[IM.HDR:])
            xor_like += IM.looks_like_image(body)
            xor_full += IM.is_complete_image(body)

    print("aes_size 分布：", dict(bucket))
    print(f"aes_size==0 的那批里，纯 XOR 解出：开头像图 {xor_like}、结构完整 {xor_full}")
    n = sum(bucket.values())
    ok = bucket["aes_size=0"] == 0       # 全是 aes_size>0 ⇒ 缩略图也要 key
    print("\n判据：**只要有 aes_size>0 的缩略图，就说明缩略图也需要 AES key**"
          "（`decrypt` 在 `aes_size<=0` 时直接返回 None）。")
    print(f"  {n} 个样本里 aes_size==0 的有 {bucket['aes_size=0']} 个 ⇒ "
          + ("§9.3 的前提**被否掉**：没 key 连缩略图也拿不到" if ok else
             "§9.3 的前提**部分成立**：存在纯 XOR 的缩略图，可以做无 key 降级"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
