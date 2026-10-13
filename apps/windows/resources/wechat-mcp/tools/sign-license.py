# -*- coding: utf-8 -*-
"""批量签发授权密钥（**这个脚本不随 exe 分发，也绝不要把私钥放进仓库**）。

不绑机器、无需用户配合：这边一次签一批，交付时给用户 **exe + 一条密钥** 即可。

用法
----
    # 四件套打包授权，签 50 条，一年有效
    python tools/sign-license.py --scope wechat-toolkits --count 50 --days 365

    # wechat-mcp 主产品，签 1 条永久授权，备注客户名
    python tools/sign-license.py --scope retail --days 0 --note 张三

输出 CSV（`id,scope,edition,issued,expires,note,key`），每行一条密钥；`id` 用于登记发给了谁。

用户侧配置：在 MCP 客户端配置里给该服务加环境变量

    "env": { "WECHAT_MCP_LICENSE_KEY": "WMK1.xxxx.yyyy" }

保存后重启该 MCP 服务；`<exe> --license-status` 可核对。

私钥默认读 `~/.wechat-mcp-keys/private.pem`，可用 `--key` 指定。
**私钥丢了 = 以后签不了新的（已发的授权仍然有效）；私钥泄了 = 授权体系失效，须换密钥重签全部。**
诚实边界：密钥不绑机器，能防伪造/篡改（改 scope、改到期都会验签失败），**防不住转手共享**。
"""
import argparse
import csv
import json
import os
import secrets
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from licensing import LICENSE_KEY_ENV, canonical_bytes, encode_license_key  # noqa: E402

SCOPES = ("retail", "bundled", "wechat-toolkits", "all",
          "wechat-file-mcp", "wechat-export-mcp", "wechat-recall-mcp", "wechat-crm-mcp")


def load_private_key(path):
    """读取 RSA 私钥；不存在时给出明确报错而不是堆栈。"""
    from Crypto.PublicKey import RSA
    if not os.path.isfile(path):
        sys.exit(f"找不到私钥：{path}（用 --key 指定）")
    with open(path, "rb") as f:
        return RSA.import_key(f.read())


def sign_key(private_key, scope, edition, days, now):
    """签发一条授权密钥，返回 `(payload, key)`。`days=0` 表示永久（exp=0，校验侧不判到期）。"""
    from Crypto.Hash import SHA256
    from Crypto.Signature import pkcs1_15
    payload = {
        "v": 2,
        "id": secrets.token_hex(4),
        "scope": scope,
        "edition": edition,
        "iat": now,
        "exp": now + days * 86400 if days > 0 else 0,
    }
    sig = pkcs1_15.new(private_key).sign(SHA256.new(canonical_bytes(payload)))
    return payload, encode_license_key(payload, sig)


def fmt_date(ts):
    """时间戳 → `YYYY-MM-DD`；0 显示为「永久」。"""
    return time.strftime("%Y-%m-%d", time.localtime(ts)) if ts else "永久"


def main():
    """解析参数、批量签发并写出 CSV。"""
    ap = argparse.ArgumentParser(description="批量签发 wechat-mcp / 四件套授权密钥")
    ap.add_argument("--scope", default="retail", choices=SCOPES,
                    help="签发范围：retail（wechat-mcp 零售）/ bundled（灵栖内置）/ "
                         "wechat-toolkits（四件套打包，一条覆盖四个）/ "
                         "wechat-*-mcp（四件套单卖）/ all")
    ap.add_argument("--edition", default="pro", choices=["pro"], help="档位（目前只有 pro 需要授权）")
    ap.add_argument("--count", type=int, default=1, help="签发条数，默认 1")
    ap.add_argument("--days", type=int, default=365, help="有效期天数，默认 365；0 = 永久")
    ap.add_argument("--note", default="", help="备注（客户名/订单号），写进 CSV，不进密钥")
    ap.add_argument("--key", default=os.path.join(os.path.expanduser("~"), ".wechat-mcp-keys", "private.pem"),
                    help="私钥路径")
    ap.add_argument("--out", help="输出 CSV，默认 licenses-<scope>-<时间>.csv；已存在则追加")
    args = ap.parse_args()
    if args.count < 1:
        ap.error("--count 至少为 1")
    if args.days < 0:
        ap.error("--days 不能为负（0 表示永久）")
    private_key = load_private_key(args.key)
    now = int(time.time())
    out = args.out or f"licenses-{args.scope}-{time.strftime('%Y%m%d-%H%M%S', time.localtime(now))}.csv"

    rows = []
    for _ in range(args.count):
        payload, key = sign_key(private_key, args.scope, args.edition, args.days, now)
        rows.append([payload["id"], payload["scope"], payload["edition"],
                     fmt_date(payload["iat"]), fmt_date(payload["exp"]), args.note, key])

    is_new = not os.path.exists(out)
    # utf-8-sig：Excel 直接打开不乱码
    with open(out, "a", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        if is_new:
            writer.writerow(["id", "scope", "edition", "issued", "expires", "note", "key"])
        writer.writerows(rows)

    print(f"已签发 {len(rows)} 条 → {os.path.abspath(out)}")
    print(f"  范围 {args.scope} / 档位 {args.edition} / 到期 {rows[0][4]}")
    print("  交付：exe + 一条密钥；用户在 MCP 配置里加：")
    print("  " + json.dumps({"env": {LICENSE_KEY_ENV: rows[0][6]}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
