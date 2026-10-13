# -*- coding: utf-8 -*-
"""离线授权自测：验签 / 到期 / 回拨 / 内置豁免 / 降级。

跑法：`python test_licensing.py`（秒级，不碰微信、不碰真实授权密钥）。
**用临时密钥对与临时目录**——不读 `~/.wechat-mcp-keys/private.pem`，也不会覆盖你机器上的授权。

为什么要它：授权逻辑的失败模式全是**静默放行**（签名没验、到期没判、回拨没挡），
而这些在开发机上（`sys.frozen=False`，压根不走校验）永远暴露不出来。
"""
import base64
import json
import os
import re
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

# 把 `check()` 包一层，记下**这次真跑出来的每一种 reason** —— 最后跟 `describe()` 的表对账。
# 包在最外层是为了把 `effective_edition()` 内部那次 `check()` 也收进来（它不走测试里的显式调用）。
OBSERVED = set()
_real_check = licensing.check


def _observed_check(now=None):
    st = _real_check(now)
    OBSERVED.add(st["reason"])
    return st


licensing.check = _observed_check

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


def fresh():
    """清掉上一场景留下的密钥与状态（防回拨水位），别让它们串场。"""
    os.environ.pop(licensing.LICENSE_KEY_ENV, None)
    p = os.path.join(TMP, ".state.json")
    if os.path.exists(p):
        os.remove(p)


NOW = int(time.time())
# 授权密钥载荷：v=2、带 id、不绑机器（文件式授权的 fp 那一整套已删）
KP = {"v": 2, "id": "a1b2c3d4", "scope": "retail", "edition": "pro", "iat": NOW - 10, "exp": NOW + 86400}

print("=== 规范化序列化 ===")
check("键序无关", licensing.canonical_bytes({"a": 1, "b": 2}) == licensing.canonical_bytes({"b": 2, "a": 1}))
check("非 ASCII 原样保留（不转 \\uXXXX，签名两侧才一致）",
      "机器" in licensing.canonical_bytes({"x": "机器"}).decode("utf-8"))

print("=== 验签 ===")
p = {"v": 1, "scope": "retail", "edition": "pro", "exp": NOW + 86400}
good = sign(p)
check("好签名通过", licensing.verify_signature({k: v for k, v in good.items() if k != "sig"}, good["sig"]))
tampered = dict(p, exp=NOW + 86400 * 365)
check("改过载荷 → 拒绝", not licensing.verify_signature(tampered, good["sig"]))
other = RSA.generate(2048)
check("别的私钥签的 → 拒绝", not licensing.verify_signature(p, sign(p, other)["sig"]))
check("垃圾签名 → 拒绝（fail-closed）", not licensing.verify_signature(p, "not-base64!!"))

print("=== 授权状态（环境变量密钥，不绑机器）===")
fresh()
check("没配密钥 → missing", licensing.check()["reason"] == "missing")

k = make_key(KP)
_, body, sig = k.split(".")
check("密钥只含 URL 安全字符（能原样塞进 env/JSON/TOML）",
      all(c.isalnum() or c in "._-" for c in k), k[:40])
check("密钥往返解析一致", {kk: vv for kk, vv in licensing.decode_license_key(k).items() if kk != "sig"} == KP)

st = with_key(k)
check("有效密钥 → ok（无 fp 不比机器）", st["ok"] and st["source"] == "env" and st.get("key_id") == "a1b2c3d4", str(st))
st = with_key("  " + k + "\n")
check("首尾空白/换行容忍", st["ok"], str(st))

fresh()
check("签名缺失 → bad_signature", with_key(f"WMK1.{body}.")["reason"] == "bad_signature")
fresh()
st = with_key(make_key(dict(KP, exp=0)))
check("exp=0 → 永久有效", st["ok"] and st["days_left"] is None, str(st))
fresh()
check("过期密钥 → expired", with_key(make_key(dict(KP, exp=NOW - 86400)))["reason"] == "expired")
fresh()
check("别的私钥签的密钥 → bad_signature", with_key(make_key(KP, RSA.generate(2048)))["reason"] == "bad_signature")
forged_body = licensing._b64url_encode(licensing.canonical_bytes(dict(KP, scope="all")))
check("改载荷（scope 提权）→ bad_signature", with_key(f"WMK1.{forged_body}.{sig}")["reason"] == "bad_signature")
check("格式不对 → bad_key", with_key("hello")["reason"] == "bad_key")
check("前缀不对 → bad_key", with_key(f"XXX1.{body}.{sig}")["reason"] == "bad_key")
check("清掉密钥 → 回到 missing", with_key(None)["reason"] == "missing")

fresh()
os.environ[licensing.LICENSE_KEY_ENV] = make_key(dict(KP, exp=NOW + 900 * 86400))
licensing.check(now=NOW + 100 * 86400)          # 先让水位涨到未来
check("时间回拨 → clock_rollback",
      licensing.check(now=NOW + 86400)["reason"] == "clock_rollback")

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

print("=== describe 表与 reason 对账 ===")
# `describe()` 是一张 reason → 人话的表。表里**少了**某一档，用户就看到裸的 reason 码；
# 表里**多了**已经不可能出现的档（比如删掉机器指纹后还留着的 `machine_mismatch`），
# 后来的人会以为那条路还在。两头都是无声漂移。
#
# 判据用**这次真跑出来的 reason**（`OBSERVED`，见文件头对 `check()` 的包装）而不是从源码正则抽：
# 正则试过一版，把 `source` 的 `else "env"` 也当成 reason 抽了出来——**正则分不清"reason"与
# 恰好在附近的别的字符串"**。真实的返回值不会骗人。
for _r in sorted(OBSERVED):
    # 表里没有就会**原样回落**成 reason 码本身——这正是判据
    check(f"describe() 有 {_r} 的人话", licensing.describe({"reason": _r, "exp": 0}) != _r)
# 反向：这七档语义上**每一种都该被上面的用例跑到**。少跑到一档 = 覆盖悄悄缩水。
check("七档 reason 都真的跑到了", set(OBSERVED) >= set(licensing.REASONS),
      f"跑到 {sorted(OBSERVED)}，应覆盖 {sorted(licensing.REASONS)}")
# 已删的档不许留在表里（这条就是上面那个死条目当初的形态：表里多一条没人会重走的路）
check("已删的 machine_mismatch 不再出现在 describe 里",
      licensing.describe({"reason": "machine_mismatch", "exp": 0}) == "machine_mismatch")

shutil.rmtree(TMP, ignore_errors=True)
print()
print("结果：" + ("全部通过" if not fails else f"{len(fails)} 项失败 -> {fails}"))
sys.exit(1 if fails else 0)
