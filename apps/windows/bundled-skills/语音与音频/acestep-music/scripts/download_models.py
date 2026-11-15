#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ACE-Step 1.5 模型下载器 —— 断点续传 / 可重复运行 / sha256 校验

用法：
    python download_models.py                  下载全部缺失或未完成的文件
    python download_models.py --verify         只校验，不下载
    python download_models.py --budget 1200    最多跑 1200 秒后自行退出

为什么用 .partdownload 而不是 .part：
    ACE-Step 的 check_main_model_exists() 只判断 <checkpoints>/<组件>/ 目录是否存在，
    不看权重文件大小。若临时文件叫 model.safetensors.part，某些工具会误以为模型已就绪，
    启动后直接崩在加载阶段。用 .partdownload 后缀可彻底避免这种误判。

中断与续传：
    进度 = xxx.partdownload 在磁盘上的字节数。Ctrl-C / 断网 / 关机都安全，
    重跑本脚本会从该字节数继续请求 Range，不会从头再来。
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request

REPO = "ACE-Step/Ace-Step1.5"
BASE_URL = "https://modelscope.cn/models/{repo}/resolve/master/{path}"
API_URL = (
    "https://modelscope.cn/api/v1/models/{repo}/repo/files"
    "?Revision=master&Recursive=True"
)
ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(ROOT, "checkpoints")
LOG_DIR = os.path.join(ROOT, "downloads")
PART_SUFFIX = ".partdownload"
CHUNK = 8 * 1024 * 1024
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fetch_manifest():
    cache = os.path.join(LOG_DIR, "manifest.json")
    os.makedirs(LOG_DIR, exist_ok=True)
    try:
        req = urllib.request.Request(API_URL.format(repo=REPO), headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode("utf-8"))
        files = [
            {"path": f["Path"], "size": f["Size"], "sha256": (f.get("Sha256") or "").lower()}
            for f in data.get("Data", {}).get("Files", [])
            if f.get("Type") == "blob"
        ]
        with open(cache, "w", encoding="utf-8") as fh:
            json.dump(files, fh, indent=1)
        log(f"清单：{len(files)} 个文件 / {sum(f['size'] for f in files)/1e9:.2f} GB")
        return files
    except Exception as e:
        if os.path.exists(cache):
            log(f"清单 API 失败（{e}），用本地缓存")
            with open(cache, encoding="utf-8") as fh:
                return json.load(fh)
        raise SystemExit(f"无法获取清单且无缓存：{e}")


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for buf in iter(lambda: fh.read(4 * 1024 * 1024), b""):
            h.update(buf)
    return h.hexdigest()


def download_chunk(url, start, end, retries=5):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "Range": f"bytes={start}-{end}",
                    "User-Agent": UA,
                    "Accept-Encoding": "identity",
                },
            )
            with urllib.request.urlopen(req, timeout=90) as r:
                if r.status not in (200, 206):
                    raise IOError(f"HTTP {r.status}")
                return r.read()
        except Exception as e:
            last = e
            time.sleep(min(2 ** i, 20))
    raise IOError(f"{start}-{end} 重试 {retries} 次仍失败: {last}")


def download_one(item, deadline):
    rel, total = item["path"], item["size"]
    dest = os.path.join(MODEL_DIR, rel.replace("/", os.sep))
    part = dest + PART_SUFFIX
    os.makedirs(os.path.dirname(dest), exist_ok=True)

    if os.path.exists(dest) and os.path.getsize(dest) == total:
        if not item["sha256"] or sha256_of(dest) == item["sha256"]:
            return "skip"
        log(f"  校验不符，重下：{rel}")
        os.remove(dest)

    done = os.path.getsize(part) if os.path.exists(part) else 0
    if done > total:
        os.remove(part)
        done = 0

    url = BASE_URL.format(repo=REPO, path=rel)
    t0, base = time.time(), done
    last_report = done

    while done < total:
        if deadline and time.time() > deadline:
            log(f"  到时间上限，停在 {done/1e6:.1f}/{total/1e6:.1f} MB")
            return "paused"
        end = min(done + CHUNK - 1, total - 1)
        try:
            data = download_chunk(url, done, end)
        except IOError as e:
            log(f"  放弃该文件（{e}）：{rel}")
            return "failed"
        if not data:
            log(f"  空响应，放弃：{rel}")
            return "failed"
        with open(part, "ab") as fh:
            fh.write(data)
        done += len(data)
        if done == total or done - last_report >= 64 * 1024 * 1024:
            spd = (done - base) / max(time.time() - t0, 0.001)
            log(f"  {rel}: {done/1e6:8.1f}/{total/1e6:.1f} MB ({done*100//total:3d}%) {spd/1024:.0f} KB/s")
            last_report = done

    if item["sha256"]:
        got = sha256_of(part)
        if got != item["sha256"]:
            log(f"  校验失败 {got[:16]} != {item['sha256'][:16]}，删除重下")
            os.remove(part)
            return "failed"
    os.replace(part, dest)
    log(f"  完成：{rel}")
    return "done"


def path_of(rel):
    return os.path.join(MODEL_DIR, rel.replace("/", os.sep))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--budget", type=int, default=0)
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    files = fetch_manifest()
    if args.only:
        files = [f for f in files if args.only in f["path"]]
    files.sort(key=lambda f: f["size"])  # 先小后大，尽早拿到可用的散件

    if args.verify:
        bad = 0
        for f in files:
            p = path_of(f["path"])
            if not os.path.exists(p):
                print(f"缺失  {f['path']}")
                bad += 1
            elif os.path.getsize(p) != f["size"]:
                print(f"大小不符  {f['path']}  {os.path.getsize(p)} != {f['size']}")
                bad += 1
            elif f["sha256"] and sha256_of(p) != f["sha256"]:
                print(f"哈希不符  {f['path']}")
                bad += 1
        print("全部校验通过" if bad == 0 else f"{bad} 个文件有问题")
        return 0 if bad == 0 else 1

    deadline = time.time() + args.budget if args.budget else 0
    stats = {}
    for f in files:
        p = path_of(f["path"])
        if os.path.exists(p) and os.path.getsize(p) == f["size"]:
            stats["skip"] = stats.get("skip", 0) + 1
            continue
        have = os.path.getsize(p + PART_SUFFIX) if os.path.exists(p + PART_SUFFIX) else 0
        log(f"→ {f['path']}  ({f['size']/1e6:.1f} MB" + (f", 已有 {have/1e6:.0f} MB" if have else "") + ")")
        r = download_one(f, deadline)
        stats[r] = stats.get(r, 0) + 1
        if r == "paused":
            log("进度已存盘，重跑即续传。")
            break

    have = sum(os.path.getsize(path_of(f["path"])) for f in files if os.path.exists(path_of(f["path"])))
    log(f"本轮：{stats}  已完成 {have/1e9:.2f} / {sum(f['size'] for f in files)/1e9:.2f} GB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
