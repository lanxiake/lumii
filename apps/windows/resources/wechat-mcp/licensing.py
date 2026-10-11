# -*- coding: utf-8 -*-
"""离线授权：机器指纹 + RSA 签名授权文件（无服务端）。

设计要点
--------
- **机器指纹三个子项各自独立存放，校验时 2/3 命中即通过**——换网卡、加硬盘、单硬件漂移都不误伤，
  换整机必挂。**刻意不用 MAC**：虚拟网卡 / VPN 常变，误伤率最高。
- **授权文件** `license.json`：`{v, scope, edition, fp{board,disk,os}, iat, exp}` + `sig`
  （RSA-2048 PKCS1v15/SHA256，对**除 sig 外**的规范化 JSON 签名）。公钥内嵌本文件，私钥离线保管。
- **存放位置**：`~/.lumii/wechat-mcp/license.json`。**绝不与 exe 同目录**——灵栖按内容哈希同步
  exe 目录、用户也会整目录拷走，放那儿等于授权跟着文件走。
- **防时钟回拨**：`~/.lumii/wechat-mcp/.state.json` 记「见过的最大时间」，当前时间早于它就按过期处理。
- **只对 exe 生效**：源码运行（`python server.py`）是开发/测试场景，不做授权校验。

诚实边界（写在这里免得后来者误判强度）
--------------------------------------
PyInstaller/Nuitka 产物都能被逆向；把校验 patch 掉是可行的。本模块能挡的是**伪造与跨机复用**，
挡不住**整机转卖**与**逆向 patch**。真强度要靠打包加固（见改造计划 P2）+ 校验多点埋点。
"""
import base64
import hashlib
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


def license_path():
    return os.path.join(_data_dir(), "license.json")


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


def _digest(value):
    """子指纹一律截断到 16 位十六进制：够区分机器，又不至于把原始硬件号泄露进授权文件。"""
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# 机器指纹
# ---------------------------------------------------------------------------

def _volume_serial(drive):
    """系统盘卷序列号（换盘会变，重装系统不变）。"""
    import ctypes
    vol = ctypes.create_unicode_buffer(261)
    fs = ctypes.create_unicode_buffer(261)
    serial = ctypes.c_uint()
    maxlen = ctypes.c_uint()
    flags = ctypes.c_uint()
    ok = ctypes.windll.kernel32.GetVolumeInformationW(
        ctypes.c_wchar_p(drive), vol, 261, ctypes.byref(serial),
        ctypes.byref(maxlen), ctypes.byref(flags), fs, 261)
    return f"{serial.value:08X}" if ok else ""


def _machine_guid():
    """`HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid`（重装系统会变）。"""
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"SOFTWARE\Microsoft\Cryptography") as k:
            return str(winreg.QueryValueEx(k, "MachineGuid")[0])
    except OSError:
        return ""


def _smbios_uuid():
    """主板/整机 UUID（唯一性最好，但取它要起一次 PowerShell，故结果缓存进 .state.json）。"""
    cached = (_read_json(_state_path()) or {}).get("board_raw")
    if cached:
        return cached
    import subprocess
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "(Get-CimInstance Win32_ComputerSystemProduct).UUID"],
            capture_output=True, text=True, timeout=20,
            creationflags=0x08000000,  # CREATE_NO_WINDOW：别闪黑框
        )
        value = (out.stdout or "").strip()
    except Exception:
        value = ""
    # 全 F 是固件没写 UUID 的占位值，等于没有
    if not value or set(value.upper()) == {"F", "-"}:
        return ""
    state = _read_json(_state_path()) or {}
    state["board_raw"] = value
    _write_json(_state_path(), state)
    return value


def machine_fp():
    """三个子指纹（各 16 位十六进制）。取不到的项返回空串——**不参与比较**，也不冤枉用户。

    注意每一项都要先判空再摘要：空串的摘要是**固定值**，不判就会让「取不到」变成
    「永远命中」，把 2/3 门槛悄悄降成 1/2。
    """
    board = _smbios_uuid()
    disk = _volume_serial(os.environ.get("SystemDrive", "C:") + "\\")
    guid = _machine_guid()
    return {
        "board": _digest(board) if board else "",
        "disk": _digest(disk) if disk else "",
        "os": _digest(guid) if guid else "",
    }


def match_count(lic_fp, cur_fp):
    """命中数 / 参与比较的项数。**只在两边都非空时才参与比较**——取不到的项不冤枉用户。"""
    compared = [k for k in ("board", "disk", "os") if lic_fp.get(k) and cur_fp.get(k)]
    hit = [k for k in compared if lic_fp[k] == cur_fp[k]]
    return len(hit), len(compared)


# ---------------------------------------------------------------------------
# 签名 / 校验
# ---------------------------------------------------------------------------

def canonical_bytes(payload):
    """规范化序列化：键排序、无空格、保留非 ASCII——签名两侧必须完全一致。"""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


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
    """完整校验，返回 `{ok, reason, edition, exp, days_left, scope}`。reason 用于排障与提示。"""
    now = int(now if now is not None else time.time())
    if bundled_exempt():
        return {"ok": True, "reason": "bundled", "edition": "pro", "scope": "bundled",
                "exp": 0, "days_left": None}

    lic = _read_json(license_path())
    if not isinstance(lic, dict):
        return {"ok": False, "reason": "missing", "edition": "lite", "scope": "", "exp": 0, "days_left": 0}

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

    hits, compared = match_count(lic.get("fp") or {}, machine_fp())
    # 门槛：2/3 命中即通过；某项取不到时按实际可比项折算（floor(n/2)+1 对 n=2 是 2 = 全中）
    need = 2 if compared >= 3 else compared
    if compared == 0 or hits < need:
        return {"ok": False, "reason": "machine_mismatch", "edition": "lite", "scope": lic.get("scope", ""),
                "exp": exp, "days_left": days_left, "matched": f"{hits}/{compared}"}

    return {"ok": True, "reason": "ok", "edition": lic.get("edition") or "pro",
            "scope": lic.get("scope", ""), "exp": exp, "days_left": days_left,
            "matched": f"{hits}/{compared}"}


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
          f"授权文件应为 {license_path()}", file=sys.stderr, flush=True)
    return "lite"


def describe(status):
    """把状态渲染成给用户看的一行。"""
    table = {
        "ok": "已授权", "bundled": "灵栖内置（免授权）", "missing": "没有授权文件",
        "bad_signature": "授权文件签名不合法（被改过？）", "expired": "授权已过期",
        "clock_rollback": "系统时间被回拨，按过期处理", "machine_mismatch": "授权绑定的不是这台机器",
    }
    line = table.get(status["reason"], status["reason"])
    if status.get("exp"):
        line += f"，到期 {time.strftime('%Y-%m-%d', time.localtime(status['exp']))}"
        if status.get("days_left") is not None:
            line += f"（剩 {status['days_left']} 天）"
    if status.get("matched"):
        line += f"，机器指纹命中 {status['matched']}"
    return line


if __name__ == "__main__":
    # 排障入口：`python licensing.py` 打印当前机器指纹与授权状态
    st = check()
    print(json.dumps({"machine_fp": machine_fp(), "status": st, "human": describe(st),
                      "license_path": license_path()}, ensure_ascii=False, indent=2))
