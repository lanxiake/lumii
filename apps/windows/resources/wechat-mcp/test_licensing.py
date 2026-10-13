# -*- coding: utf-8 -*-
"""离线授权自测：验签 / 指纹命中 / 到期 / 回拨 / 内置豁免 / 降级。

跑法：`python test_licensing.py`（秒级，不碰微信、不碰真实授权文件）。
**用临时密钥对与临时目录**——不读 `~/.wechat-mcp-keys/private.pem`，也不会覆盖你机器上的授权。

为什么要它：授权逻辑的失败模式全是**静默放行**（签名没验、指纹没比、到期没判），
而这些在开发机上（`sys.frozen=False`，压根不走校验）永远暴露不出来。
"""
import base64
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from Crypto.Hash import SHA256  # noqa: E402
from Crypto.PublicKey import RSA  # noqa: E402
from Crypto.Signature import pkcs1_15  # noqa: E402

import licensing  # noqa: E402

fails = []
TMP = tempfile.mkdtemp(prefix="wm-license-test-")
KEY = RSA.generate(2048)
# 只在本进程内换公钥做测试；**不要**给生产路径加任何"可换公钥"的开关——那等于把授权体系送人
licensing.PUBLIC_KEY_PEM = KEY.publickey().export_key().decode()
licensing._data_dir = lambda: TMP          # 授权/状态全部落到临时目录
os.environ.pop(licensing.LICENSE_KEY_ENV, None)   # 开发机上配过真密钥也不能串进测试


def check(label, cond, extra=""):
    print(("  OK  " if cond else "  FAIL") + f"  {label}" + (f"  [{extra}]" if extra else ""))
    if not cond:
        fails.append(label)


def sign(payload, key=KEY):
    """按签发工具的口径签一份授权。"""
    sig = pkcs1_15.new(key).sign(SHA256.new(licensing.canonical_bytes(payload)))
    return {**payload, "sig": base64.b64encode(sig).decode()}


def write_license(payload):
    with open(licensing.license_path(), "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)


def fresh():
    """清掉上一场景留下的授权与状态。"""
    for name in ("license.json", ".state.json"):
        p = os.path.join(TMP, name)
        if os.path.exists(p):
            os.remove(p)


NOW = int(time.time())
FP = licensing.machine_fp()

print("=== 规范化序列化 ===")
check("键序无关", licensing.canonical_bytes({"a": 1, "b": 2}) == licensing.canonical_bytes({"b": 2, "a": 1}))
check("非 ASCII 原样保留（不转 \\uXXXX，签名两侧才一致）",
      "机器" in licensing.canonical_bytes({"x": "机器"}).decode("utf-8"))

print("=== 验签 ===")
p = {"v": 1, "fp": FP, "exp": NOW + 86400}
good = sign(p)
check("好签名通过", licensing.verify_signature({k: v for k, v in good.items() if k != "sig"}, good["sig"]))
tampered = dict(p, exp=NOW + 86400 * 365)
check("改过载荷 → 拒绝", not licensing.verify_signature(tampered, good["sig"]))
other = RSA.generate(2048)
check("别的私钥签的 → 拒绝", not licensing.verify_signature(p, sign(p, other)["sig"]))
check("垃圾签名 → 拒绝（fail-closed）", not licensing.verify_signature(p, "not-base64!!"))

print("=== 指纹命中 ===")
check("3/3", licensing.match_count({"board": "a", "disk": "b", "os": "c"},
                                   {"board": "a", "disk": "b", "os": "c"}) == (3, 3))
check("2/3", licensing.match_count({"board": "a", "disk": "b", "os": "c"},
                                   {"board": "a", "disk": "X", "os": "c"}) == (2, 3))
check("取不到的项不参与（空串不计入分母）",
      licensing.match_count({"board": "", "disk": "b", "os": "c"},
                            {"board": "a", "disk": "b", "os": "c"}) == (2, 2))
check("全空即不可比", licensing.match_count({"board": "", "disk": "", "os": ""},
                                           {"board": "a", "disk": "b", "os": "c"}) == (0, 0))

print("=== 授权状态 ===")
fresh()
check("没有授权文件 → missing", licensing.check()["reason"] == "missing")

fresh()
write_license({"v": 1, "scope": "retail", "edition": "pro", "fp": FP, "iat": NOW - 10, "exp": NOW + 86400})
check("签名缺失 → bad_signature", licensing.check()["reason"] == "bad_signature")

fresh()
write_license(sign({"v": 1, "scope": "retail", "edition": "pro", "fp": FP, "iat": NOW - 10, "exp": NOW + 86400}))
check("有效授权 → ok", licensing.check()["reason"] == "ok", str(licensing.check()))

fresh()
write_license(sign({"v": 1, "scope": "retail", "edition": "pro", "fp": FP, "iat": NOW - 900000,
                    "exp": NOW - 86400}))
check("过期 → expired", licensing.check()["reason"] == "expired")

fresh()
write_license(sign({"v": 1, "scope": "retail", "edition": "pro",
                    "fp": {"board": "deadbeef", "disk": "deadbeef", "os": "deadbeef"},
                    "iat": NOW - 10, "exp": NOW + 86400}))
check("别的机器 → machine_mismatch", licensing.check()["reason"] == "machine_mismatch")

fresh()
future = sign({"v": 1, "scope": "retail", "edition": "pro", "fp": FP, "iat": NOW, "exp": NOW + 900 * 86400})
write_license(future)
licensing.check(now=NOW + 100 * 86400)          # 先让水位涨到未来
check("时间回拨 → clock_rollback",
      licensing.check(now=NOW + 86400)["reason"] == "clock_rollback")


def make_key(payload, key=KEY):
    """按 `tools/sign-license.py` 的口径签一条授权密钥。"""
    sig = pkcs1_15.new(key).sign(SHA256.new(licensing.canonical_bytes(payload)))
    return licensing.encode_license_key(payload, sig)


def with_key(value):
    """设置/清除授权密钥环境变量，返回当前 `check()` 结果。"""
    if value is None:
        os.environ.pop(licensing.LICENSE_KEY_ENV, None)
    else:
        os.environ[licensing.LICENSE_KEY_ENV] = value
    return licensing.check()


print("=== 授权密钥（环境变量，不绑机器）===")
KP = {"v": 2, "id": "a1b2c3d4", "scope": "retail", "edition": "pro", "iat": NOW - 10, "exp": NOW + 86400}
fresh()
k = make_key(KP)
check("密钥只含 URL 安全字符（能原样塞进 env/JSON/TOML）",
      all(c.isalnum() or c in "._-" for c in k), k[:40])
check("密钥往返解析一致", {kk: vv for kk, vv in licensing.decode_license_key(k).items() if kk != "sig"} == KP)
st = with_key(k)
check("有效密钥 → ok（无 fp 不比机器）", st["ok"] and st["source"] == "env" and st.get("key_id") == "a1b2c3d4", str(st))
st = with_key("  " + k + "\n")
check("首尾空白/换行容忍", st["ok"], str(st))
fresh()
st = with_key(make_key(dict(KP, exp=0)))
check("exp=0 → 永久有效", st["ok"] and st["days_left"] is None, str(st))
fresh()
check("过期密钥 → expired", with_key(make_key(dict(KP, exp=NOW - 86400)))["reason"] == "expired")
fresh()
check("别的私钥签的密钥 → bad_signature", with_key(make_key(KP, RSA.generate(2048)))["reason"] == "bad_signature")
_, body, sig = k.split(".")
forged_body = licensing._b64url_encode(licensing.canonical_bytes(dict(KP, scope="all")))
check("改载荷（scope 提权）→ bad_signature", with_key(f"WMK1.{forged_body}.{sig}")["reason"] == "bad_signature")
check("格式不对 → bad_key", with_key("hello")["reason"] == "bad_key")
check("前缀不对 → bad_key", with_key(f"XXX1.{body}.{sig}")["reason"] == "bad_key")
write_license(sign({"v": 1, "scope": "retail", "edition": "pro", "fp": FP, "iat": NOW - 10, "exp": NOW + 86400}))
check("配了坏密钥不回落到旧文件（错误要暴露出来）", with_key("hello")["reason"] == "bad_key")
check("清掉密钥 → 回到授权文件", with_key(None)["reason"] == "ok" and licensing.check()["source"] == "file")
fresh()

print("=== 灵栖内置豁免 ===")
fresh()
marker_dir = tempfile.mkdtemp(prefix="wm-bundled-", dir=TMP)
open(os.path.join(marker_dir, licensing.BUNDLED_MARKER), "w").close()
licensing._exe_dir = lambda: marker_dir
st = licensing.check()
check("有标记 → bundled 且 ok", st["ok"] and st["reason"] == "bundled", str(st))
os.remove(os.path.join(marker_dir, licensing.BUNDLED_MARKER))
check("标记被删 → 回到 missing", licensing.check()["reason"] == "missing")

print("=== 档位降级 ===")
check("lite 产物永远 lite", licensing.effective_edition("lite") == "lite")
check("源码运行不校验（开发/测试）", licensing.effective_edition("pro") == "pro")
licensing._exe_dir = lambda: tempfile.mkdtemp(prefix="wm-noexe-", dir=TMP)
sys.frozen = True                              # 假装是打包后的 exe
try:
    check("exe + 无授权 → 降级 lite", licensing.effective_edition("pro") == "lite")
    write_license(sign({"v": 1, "scope": "retail", "edition": "pro", "fp": FP,
                        "iat": NOW - 10, "exp": NOW + 86400}))
    check("exe + 有效授权 → pro", licensing.effective_edition("pro") == "pro")
    os.remove(licensing.license_path())
    os.environ[licensing.LICENSE_KEY_ENV] = make_key(KP)
    check("exe + 有效密钥 → pro", licensing.effective_edition("pro") == "pro")
    os.environ.pop(licensing.LICENSE_KEY_ENV)
    lic_dir = tempfile.mkdtemp(prefix="wm-bundled2-", dir=TMP)
    open(os.path.join(lic_dir, licensing.BUNDLED_MARKER), "w").close()
    licensing._exe_dir = lambda: lic_dir
    check("exe + 灵栖内置标记 → pro（免授权）", licensing.effective_edition("pro") == "pro")
finally:
    del sys.frozen

# Nuitka 不设 sys.frozen，只注入 __compiled__（实测 4.3 onefile）。漏认它 = 授权门静默失效。
licensing._exe_dir = lambda: tempfile.mkdtemp(prefix="wm-nuitka-", dir=TMP)
licensing.__dict__["__compiled__"] = True
try:
    check("Nuitka 产物也认作「已打包」", licensing._is_packaged())
    check("Nuitka + 无授权 → 同样降级 lite", licensing.effective_edition("pro") == "lite")
finally:
    del licensing.__dict__["__compiled__"]
check("__compiled__ 清掉后回到「源码不校验」", licensing.effective_edition("pro") == "pro")

shutil.rmtree(TMP, ignore_errors=True)
print()
print("结果：" + ("全部通过" if not fails else f"{len(fails)} 项失败 -> {fails}"))
sys.exit(1 if fails else 0)
