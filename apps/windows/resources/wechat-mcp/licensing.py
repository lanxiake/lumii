# -*- coding: utf-8 -*-
"""离线授权：RSA 签名的**授权密钥**（无服务端、无授权文件）。

唯一载体
--------
**授权密钥**：环境变量 `WECHAT_MCP_LICENSE_KEY`，写在 MCP 客户端配置的 `env` 里。
形如 `WMK1.<base64url(载荷)>.<base64url(签名)>`，载荷 `{v, id, scope, edition, iat, exp}`，
**不绑机器**——发行方用 `tools/sign-license.py --count N` 批量签，用户无需提供任何信息。

> **文件式授权（`license.json`）已移除**（2026-10-13）。它当初是绑机器的（载荷带 `fp`，
> 按主板/磁盘/系统三项指纹 2/3 命中判定），代价是**每台机器一次往返**：用户先跑 `--machine-id`
> 把机器码发回来、发行方再签一份专属文件。换成密钥后交付只要「exe + 一条密钥」，而绑机器本来
> 也只防"换台机器用同一份"，挡不住别的。机器指纹那一整套（`machine_fp`/`match_count`/三个子项
> 采集）随之删除——留着只会让人以为它还生效。

设计要点
--------
- **验签**：RSA-2048 PKCS1v15/SHA256，对**除 sig 外**的规范化 JSON 签名。公钥内嵌本文件，
  私钥离线保管（`tools/sign-license.py`，**绝不入库**）。
- **防时钟回拨**：`~/.lumii/wechat-mcp/.state.json` 记「见过的最大时间」，当前时间早于它就按过期处理。
- **只对 exe 生效**：源码运行（`python server.py`）是开发/测试场景，不做授权校验。

诚实边界（写在这里免得后来者误判强度）
--------------------------------------
PyInstaller/Nuitka 产物都能被逆向；把校验 patch 掉是可行的。本模块能挡的是**伪造与跨机复用**，
挡不住**整机转卖**与**逆向 patch**。真强度要靠打包加固（见改造计划 P2）+ 校验多点埋点。
"""
import base64
import json
import os
import sys
import time

# --- 公钥（对应私钥离线保管，**绝不入库**；换密钥 = 换信任根，所有已发的授权全部作废）-
PUBLIC_KEY_PEM = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq+bDumRFZInzpYL1hCp5
jhv2Wd0oAlMY9P8y5viuzs/qiFnERdrGvmUqaTBGqgkpEHkI4qIqYY7yo5NUhvnc
kXI1zO+jlOTaO9paNV1tM1wGx1vsL5v6IGpeFd2vSbYzc6OUHdyQJ/mJ64kSIP0h
Hjtipds5ZXnzqTXUsm5ybXhgFI+RJXaz5G8+A3g+7sjY635MNolhRgaZmN59rhfD
f3zAime1FTVgj5wxf1wZWYoftk8l9+zzHmwd2sSfYtxLBcLW3GrYQmt0UMFQbrjE
QhITBlTroybI5lnIDzyovbHFAhopaS2G+BvLYN8ZqxAXAFe9EYNn6s4TyPzxrKDZ
7wIDAQAB
-----END PUBLIC KEY-----
"""

# 灵栖内置标记（由灵栖部署 exe 时写在 exe 同目录）——见 §「灵栖内置免授权」
BUNDLED_MARKER = ".lumii-bundled"
# 时钟回拨容差：允许的“倒退”秒数（时区/夏令时/小幅 NTP 校正不该判死）
CLOCK_SKEW_TOLERANCE = 86400
# 授权密钥的环境变量名与前缀（四件套与主产品共用，靠载荷里的 scope 区分产品）
LICENSE_KEY_ENV = "WECHAT_MCP_LICENSE_KEY"
LICENSE_KEY_PREFIX = "WMK1"
# `describe()` 的表该覆盖的全部 reason。**这份清单是给单测对账用的**：表里少了某一档用户会看到
# 裸的 reason 码，多了某一档后来的人会以为那条路还在（删机器指纹时就留下过一条 `machine_mismatch`）。
# 加新档时这里和 `describe()` 的表一起改，`test_licensing.py` 会发现不一致。
REASONS = ("ok", "bundled", "missing", "bad_key", "bad_signature", "expired", "clock_rollback")


def _data_dir():
    """授权与状态的落点（用户级，与 exe 目录分离）。

    可用 `LUMII_WECHAT_LICENSE_DIR` 覆盖——测试与多份授权并存的场景要用。
    """
    override = os.environ.get("LUMII_WECHAT_LICENSE_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".lumii", "wechat-mcp")


def _is_packaged():
    """是否跑在打包产物里。

    **两个打包器的信号不同**（2026-10-11 实测 Nuitka 4.3 onefile）：
    - PyInstaller 设 `sys.frozen`；
    - **Nuitka 不设它**，而是往模块命名空间注入 `__compiled__`。

    只认 `sys.frozen` 的话，Nuitka 产物上整条授权校验会被**静默跳过**——pro 全功能免费送，
    而且不报任何错（踩过：`--license-status` 报 missing，`effective_edition` 却给 pro）。
    """
    return bool(getattr(sys, "frozen", False)) or "__compiled__" in globals()


def _exe_dir():
    """**真实 exe** 所在目录（内置标记就认这里）。

    - PyInstaller：`sys.executable` 就是 exe 本身；
    - Nuitka onefile：`sys.executable` 指向**临时解包目录里的 python.exe**（实测），
      exe 真目录在 `NUITKA_ONEFILE_DIRECTORY`，退路是 `sys.argv[0]` 的目录；
    - 源码：本文件所在目录。
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    if "__compiled__" in globals():
        d = os.environ.get("NUITKA_ONEFILE_DIRECTORY")
        return d or os.path.dirname(os.path.abspath(sys.argv[0]))
    return os.path.dirname(os.path.abspath(__file__))


def _state_path():
    return os.path.join(_data_dir(), ".state.json")


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write_json(path, data):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError:
        pass

# ---------------------------------------------------------------------------
# 签名 / 校验
# ---------------------------------------------------------------------------

def canonical_bytes(payload):
    """规范化序列化：键排序、无空格、保留非 ASCII——签名两侧必须完全一致。"""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _b64url_encode(data):
    """base64url 去掉填充：密钥要能原样塞进 env / JSON / TOML，不能带 `+/=`。"""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(text):
    """`_b64url_encode` 的逆运算（补回填充）。"""
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def encode_license_key(payload, sig_bytes):
    """把载荷与签名拼成授权密钥 `WMK1.<载荷>.<签名>`（签发侧用）。"""
    return ".".join((LICENSE_KEY_PREFIX, _b64url_encode(canonical_bytes(payload)), _b64url_encode(sig_bytes)))


def decode_license_key(key):
    """解析授权密钥 → 与 `license.json` 同形的 dict（`sig` 为标准 base64）；格式不对返回 None。

    只解析不验签——验签统一走 `verify_signature`，两种载体共用同一条判定路径。
    """
    try:
        prefix, body, sig = key.strip().split(".")
        if prefix != LICENSE_KEY_PREFIX:
            return None
        payload = json.loads(_b64url_decode(body).decode("utf-8"))
        if not isinstance(payload, dict):
            return None
        return {**payload, "sig": base64.b64encode(_b64url_decode(sig)).decode("ascii")}
    except (ValueError, UnicodeDecodeError):
        return None


def license_key():
    """环境变量里的授权密钥（去空白；没配返回空串）。"""
    return (os.environ.get(LICENSE_KEY_ENV) or "").strip()


def _load_license():
    """取授权内容 → `(lic | None, 失败原因)`。**只有环境变量密钥这一条路**。

    文件式授权（`license.json`）已移除：它绑机器、每台一次往返，而换成密钥后交付只要
    「exe + 一条密钥」。**不再回落到任何文件**（回落会让"密钥写错"被旧文件悄悄兜住）。

    失败原因分两种，别混：**没配**（`missing`，用户还没拿到密钥）vs **配了但解不出来**
    （`bad_key`，多半是复制不全）——提示语完全不同。
    """
    key = license_key()
    if not key:
        return None, "missing"
    lic = decode_license_key(key)
    return lic, ("ok" if isinstance(lic, dict) else "bad_key")


def verify_signature(payload, sig_b64):
    """RSA-2048 PKCS1v15/SHA256 验签。缺 pycryptodome 或签名不合法一律 False（**fail-closed**）。"""
    try:
        from Crypto.Hash import SHA256
        from Crypto.PublicKey import RSA
        from Crypto.Signature import pkcs1_15
        key = RSA.import_key(PUBLIC_KEY_PEM)
        pkcs1_15.new(key).verify(SHA256.new(canonical_bytes(payload)), base64.b64decode(sig_b64))
        return True
    except Exception:
        return False


def bundled_exempt():
    """灵栖内置免授权：exe 同目录有标记文件即视为已授权。

    ⚠️ **这是礼貌性豁免，不是安全边界**——标记文件可伪造，成本约等于 patch 一次校验。
    真正的防盗边界只对**独立分发版**成立。见改造计划 §4.4。
    """
    return os.path.exists(os.path.join(_exe_dir(), BUNDLED_MARKER))


def check(now=None):
    """完整校验，返回 `{ok, reason, edition, exp, days_left, scope, source}`。reason 用于排障与提示。

    `source`：`env`（授权密钥）/ `bundled`（灵栖内置，免授权）。
    """
    st = _check(now)
    st.setdefault("source", "bundled" if st["reason"] == "bundled" else "env")
    return st


def _check(now=None):
    """`check` 的判定主体（不含 `source` 标注）。"""
    now = int(now if now is not None else time.time())
    if bundled_exempt():
        return {"ok": True, "reason": "bundled", "edition": "pro", "scope": "bundled",
                "exp": 0, "days_left": None}

    lic, fail = _load_license()
    if not isinstance(lic, dict):
        return {"ok": False, "reason": fail, "edition": "lite", "scope": "", "exp": 0, "days_left": 0}

    payload = {k: v for k, v in lic.items() if k != "sig"}
    if not lic.get("sig") or not verify_signature(payload, lic["sig"]):
        return {"ok": False, "reason": "bad_signature", "edition": "lite", "scope": "", "exp": 0, "days_left": 0}

    # 防时钟回拨：记「见过的最大时间」，当前时间明显倒退即判过期
    state = _read_json(_state_path()) or {}
    max_seen = int(state.get("max_seen") or 0)
    if now < max_seen - CLOCK_SKEW_TOLERANCE:
        return {"ok": False, "reason": "clock_rollback", "edition": "lite", "scope": lic.get("scope", ""),
                "exp": int(lic.get("exp") or 0), "days_left": 0}
    if now > max_seen:
        state["max_seen"] = now
        _write_json(_state_path(), state)

    exp = int(lic.get("exp") or 0)
    days_left = int((exp - now) // 86400)
    if exp and now > exp:
        return {"ok": False, "reason": "expired", "edition": "lite", "scope": lic.get("scope", ""),
                "exp": exp, "days_left": days_left}

    days_left = days_left if exp else None
    result = {"ok": True, "reason": "ok", "edition": lic.get("edition") or "pro",
              "scope": lic.get("scope", ""), "exp": exp, "days_left": days_left}
    if lic.get("id"):
        result["key_id"] = lic["id"]
    return result


def effective_edition(built_edition):
    """把「构建出来的档位」与授权状态合起来算出**实际生效的档位**。

    - lite 产物：基础版免费，不校验；
    - pro 产物 + 源码运行：开发/测试场景，不校验（授权只针对分发的 exe）；
    - pro 产物 + exe：校验不过就**降级为 lite**（不是拒绝启动，用户损失最小）。
    """
    if built_edition != "pro":
        return "lite"
    if not _is_packaged():
        return "pro"
    status = check()
    if status["ok"]:
        return "pro"
    print(f"[wechat-mcp] 未获授权（{status['reason']}），本次以基础版运行；"
          f"请在 MCP 配置的 env 里设置 {LICENSE_KEY_ENV}=<授权密钥>", file=sys.stderr, flush=True)
    return "lite"


def describe(status):
    """把状态渲染成给用户看的一行。"""
    table = {
        "ok": "已授权", "bundled": "灵栖内置（免授权）", "missing": f"没有配置授权密钥（{LICENSE_KEY_ENV}）",
        "bad_key": f"授权密钥格式不对（{LICENSE_KEY_ENV}，是否复制不全？）",
        "bad_signature": "授权签名不合法（被改过？）", "expired": "授权已过期",
        "clock_rollback": "系统时间被回拨，按过期处理",
    }
    line = table.get(status["reason"], status["reason"])
    if status.get("exp"):
        line += f"，到期 {time.strftime('%Y-%m-%d', time.localtime(status['exp']))}"
        if status.get("days_left") is not None:
            line += f"（剩 {status['days_left']} 天）"
    return line


if __name__ == "__main__":
    # 排障入口：`python licensing.py` 打印授权状态（不打印密钥本身）
    st = check()
    print(json.dumps({"status": st, "human": describe(st),
                      "license_key_env": LICENSE_KEY_ENV},
                     ensure_ascii=False, indent=2))
