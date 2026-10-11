# -*- coding: utf-8 -*-
"""离线签发授权文件（**这个脚本不随 exe 分发，也绝不要把私钥放进仓库**）。

流程
----
1. 用户在自己机器上跑 `wechat-mcp.exe --machine-id`，把输出的 JSON 发给你；
2. 你在这边签：

       python tools/sign-license.py --fp '<上面那段 JSON>' --days 365 --out license.json

3. 把 license.json 发给用户，让他放到 `%USERPROFILE%\\.lumii\\wechat-mcp\\license.json`。

私钥默认读 `~/.wechat-mcp-keys/private.pem`，可用 `--key` 指定。
**私钥丢了 = 以后签不了新的（已发的授权仍然有效）；私钥泄了 = 授权体系失效，须换密钥重签全部。**
"""
import argparse
import base64
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from licensing import canonical_bytes  # noqa: E402


def load_private_key(path):
    from Crypto.PublicKey import RSA
    with open(path, "rb") as f:
        return RSA.import_key(f.read())


def main():
    ap = argparse.ArgumentParser(description="签发 wechat-mcp 离线授权文件")
    ap.add_argument("--fp", help="用户机器指纹 JSON（`wechat-mcp.exe --machine-id` 的输出）")
    ap.add_argument("--fp-file", help="同上，从文件读")
    ap.add_argument("--edition", default="pro", choices=["pro"], help="档位（目前只有 pro 需要授权）")
    ap.add_argument("--scope", default="retail", help="签发渠道：retail（零售）/ bundled（灵栖内置）")
    ap.add_argument("--days", type=int, default=365, help="有效期天数，默认 365")
    ap.add_argument("--key", default=os.path.join(os.path.expanduser("~"), ".wechat-mcp-keys", "private.pem"),
                    help="私钥路径")
    ap.add_argument("--out", default="license.json", help="输出文件")
    args = ap.parse_args()

    raw = args.fp
    if args.fp_file:
        with open(args.fp_file, "r", encoding="utf-8") as f:
            raw = f.read()
    if not raw:
        ap.error("必须给 --fp 或 --fp-file（用户在目标机器上跑 `wechat-mcp.exe --machine-id` 得到）")
    try:
        fp = json.loads(raw)
    except ValueError as e:
        ap.error(f"--fp 不是合法 JSON：{e}")
    fp = {k: fp.get(k, "") for k in ("board", "disk", "os")}
    if not any(fp.values()):
        ap.error("指纹三项全空——目标机器上一个都取不到，签出来也用不了")

    now = int(time.time())
    payload = {
        "v": 1,
        "scope": args.scope,
        "edition": args.edition,
        "fp": fp,
        "iat": now,
        "exp": now + args.days * 86400,
    }

    from Crypto.Hash import SHA256
    from Crypto.Signature import pkcs1_15
    key = load_private_key(args.key)
    sig = pkcs1_15.new(key).sign(SHA256.new(canonical_bytes(payload)))

    lic = {**payload, "sig": base64.b64encode(sig).decode()}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(lic, f, ensure_ascii=False, indent=2)

    print(f"已签发：{os.path.abspath(args.out)}")
    print(f"  档位 {args.edition} / 渠道 {args.scope}")
    print(f"  有效期 {args.days} 天，到期 {time.strftime('%Y-%m-%d', time.localtime(payload['exp']))}")
    print(f"  指纹 {fp}（命中 {sum(1 for v in fp.values() if v)}/3 项）")
    print("  交给用户放到 %USERPROFILE%\\.lumii\\wechat-mcp\\license.json")


if __name__ == "__main__":
    main()
