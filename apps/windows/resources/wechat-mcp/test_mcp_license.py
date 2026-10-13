# -*- coding: utf-8 -*-
"""四件套授权门禁自测。运行：`python test_mcp_license.py`（秒级，不碰真机、不碰真实授权）。

**用临时密钥对与临时目录**（照 `test_licensing.py` 的口径）——不读 `~/.wechat-mcp-keys/private.pem`，
也不会覆盖你机器上的授权文件。

为什么要它：门禁的失败模式全是**静默放行**（scope 没比、路径读错、"没有授权"被当成"ok"），
而这些在开发机上（源码运行、没签名）永远暴露不出来。另外还钉一条**反向**的：
授权**有效**时必须放行——把收费产品误锁死同样是事故。
"""
import base64
import io
import json
import os
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from Crypto.Hash import SHA256  # noqa: E402
from Crypto.PublicKey import RSA  # noqa: E402
from Crypto.Signature import pkcs1_15  # noqa: E402

import licensing  # noqa: E402
import mcp_stdio as M  # noqa: E402

TMP = tempfile.mkdtemp(prefix="toolkit-license-test-")
KEY = RSA.generate(2048)
# 只在本进程里换公钥做测试；**不要**给生产路径加任何"可换公钥"的开关
licensing.PUBLIC_KEY_PEM = KEY.publickey().export_key().decode()
licensing._data_dir = lambda: TMP          # 授权与状态全部落到临时目录
os.environ.pop(licensing.LICENSE_KEY_ENV, None)   # 开发机上配过真密钥也不能串进测试

import mcp_license as L  # noqa: E402  （必须在改完 licensing 之后再导入）
from wechat_core import UnknownTalker  # noqa: E402,F401

PRODUCT = "wechat-file-mcp"
NOW = int(time.time())
FP = licensing.machine_fp()


def sign(payload, key=KEY):
    sig = pkcs1_15.new(key).sign(SHA256.new(licensing.canonical_bytes(payload)))
    return {**payload, "sig": base64.b64encode(sig).decode()}


def write_license(**over):
    payload = {"v": 1, "scope": PRODUCT, "edition": "pro", "fp": FP,
               "iat": NOW - 10, "exp": NOW + 86400 * 365, **over}
    with open(L.license_path(), "w", encoding="utf-8") as f:
        json.dump(sign(payload), f, ensure_ascii=False)


def clear_license():
    for name in ("license.json", ".state.json"):
        p = os.path.join(TMP, name)
        if os.path.exists(p):
            os.remove(p)


def test_unlicensed_is_gated():
    """没有授权文件 ⇒ 拒绝，且把"该做什么"端出来（不能只说"未授权"）。"""
    clear_license()
    st = L.status(PRODUCT)
    assert st["ok"] is False and st["reason"] == "missing", st
    err = L.gate_error(PRODUCT)
    assert err and err["error_code"] == "not_licensed", err
    assert err["stage"] == "license" and err["hint"], err
    assert licensing.LICENSE_KEY_ENV in err["hint"], err["hint"]   # 得告诉用户密钥配在哪
    assert L.license_path() in err["license_path"], err
    print("ok unlicensed_is_gated")


def make_key(scope, **over):
    """签一条不绑机器的授权密钥（`tools/sign-license.py` 同口径）。"""
    payload = {"v": 2, "id": "t0", "scope": scope, "edition": "pro",
               "iat": NOW - 10, "exp": NOW + 86400 * 365, **over}
    sig = pkcs1_15.new(KEY).sign(SHA256.new(licensing.canonical_bytes(payload)))
    return licensing.encode_license_key(payload, sig)


def test_env_key():
    """环境变量密钥：打包 scope 放行四个、别的产品 scope 拒绝、坏密钥给出 bad_key 提示。"""
    clear_license()
    try:
        os.environ[licensing.LICENSE_KEY_ENV] = make_key("wechat-toolkits")
        for p in ("wechat-file-mcp", "wechat-export-mcp", "wechat-recall-mcp", "wechat-crm-mcp"):
            assert L.status(p)["ok"], f"{p} 该被打包密钥覆盖"
        os.environ[licensing.LICENSE_KEY_ENV] = make_key("wechat-crm-mcp")
        assert not L.status(PRODUCT)["ok"]
        os.environ[licensing.LICENSE_KEY_ENV] = "WMK1.broken"
        err = L.gate_error(PRODUCT)
        assert err["error_code"] == "not_licensed" and "不是合法的授权密钥" in err["hint"], err
    finally:
        os.environ.pop(licensing.LICENSE_KEY_ENV, None)
    print("ok env_key")


def test_right_scope_passes():
    """授权有效且 scope 对得上 ⇒ **必须放行**（误锁死收费产品同样是事故）。"""
    clear_license()
    write_license(scope=PRODUCT)
    st = L.status(PRODUCT)
    assert st["ok"] and st["scope_ok"], st
    assert L.gate_error(PRODUCT) is None, L.gate_error(PRODUCT)
    assert L.instruction_block(PRODUCT) == "", "已授权就不该再往引导词里塞警告"
    print("ok right_scope_passes")


def test_bundle_scope_covers_all():
    """打包 scope（一份授权覆盖四个产品）。"""
    clear_license()
    write_license(scope="wechat-toolkits")
    for p in ("wechat-file-mcp", "wechat-export-mcp", "wechat-recall-mcp", "wechat-crm-mcp"):
        assert L.status(p)["ok"], f"{p} 该被打包授权覆盖"
    print("ok bundle_scope_covers_all")


def test_wrong_scope_is_gated():
    """签名有效但 scope 不含本产品 ⇒ 仍然拒绝，且**说清该是什么 scope**。"""
    clear_license()
    write_license(scope="wechat-crm-mcp")
    st = L.status(PRODUCT)
    assert st["ok"] is False and st["scope_ok"] is False, st
    err = L.gate_error(PRODUCT)
    assert err and err["error_code"] == "not_licensed", err
    assert PRODUCT in err["hint"], f"得告诉用户该要哪个 scope：{err['hint']}"
    assert "wechat-crm-mcp" in L.describe(st), L.describe(st)   # 说清这张是哪来的
    print("ok wrong_scope_is_gated")


def test_expired_and_tampered_are_gated():
    """到期 / 改过签名 ⇒ 拒绝（这些由 licensing 判，这里只确认映射到 not_licensed）。"""
    clear_license()
    write_license(exp=NOW - 86400)
    assert L.status(PRODUCT)["reason"] == "expired"
    assert L.gate_error(PRODUCT)["error_code"] == "not_licensed"

    clear_license()
    with open(L.license_path(), "w", encoding="utf-8") as f:
        json.dump(sign({"v": 1, "scope": PRODUCT, "fp": FP,
                        "iat": NOW, "exp": NOW + 86400}), f)
    lic = json.load(open(L.license_path(), encoding="utf-8"))
    lic["scope"] = "wechat-toolkits"            # 改载荷 = 签名对不上
    with open(L.license_path(), "w", encoding="utf-8") as f:
        json.dump(lic, f)
    assert L.status(PRODUCT)["reason"] == "bad_signature"
    assert L.gate_error(PRODUCT)["error_code"] == "not_licensed"
    print("ok expired_and_tampered_are_gated")


TOOLS = [{"name": "list_files", "description": "demo", "inputSchema": {"type": "object"}}]
DISPATCH = {"list_files": lambda a: {"total": 13, "count": 13}}


def _server(scope):
    s = M.StdioServer("wechat-file", "微信文件归档", "9.9.9", TOOLS, "原始说明", DISPATCH,
                      license_scope=scope)
    buf = io.StringIO()
    s._out = buf
    return s, buf


def _call(s, buf, name):
    buf.seek(0)
    buf.truncate(0)
    s.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
              "params": {"name": name, "arguments": {}}})
    body = json.loads(buf.getvalue().strip())["result"]["content"][0]["text"]
    return json.loads(body)


def test_stdio_blocks_tools_when_unlicensed():
    """走**协议层**验一次：未授权时工具调不动，且 `initialize` 的引导词里已经写明。

    引导词那条是关键：Agent 是**先读引导词、后调工具**的。只靠工具报错，它会白调一次，
    甚至把 `not_licensed` 误判成别的问题。
    """
    clear_license()
    s, buf = _server(PRODUCT)
    assert "尚未授权" in s.instructions and "not_licensed" in s.instructions, s.instructions
    got = _call(s, buf, "list_files")
    assert got["error_code"] == "not_licensed", got
    assert "ok" in got and got["ok"] is False

    write_license(scope=PRODUCT)                    # 放好授权后**不重启**也该恢复
    got2 = _call(s, buf, "list_files")
    assert got2 == {"total": 13, "count": 13}, got2
    print("ok stdio_blocks_tools_when_unlicensed")


def test_stdio_without_scope_is_untouched():
    """没给 scope（主产品那条路）就**不做门禁**——别替它的档位机制做主。"""
    clear_license()
    s, buf = _server(None)
    assert "尚未授权" not in s.instructions, s.instructions
    assert _call(s, buf, "list_files") == {"total": 13, "count": 13}
    print("ok stdio_without_scope_is_untouched")


if __name__ == "__main__":
    try:
        test_unlicensed_is_gated()
        test_env_key()
        test_right_scope_passes()
        test_bundle_scope_covers_all()
        test_wrong_scope_is_gated()
        test_expired_and_tampered_are_gated()
        test_stdio_blocks_tools_when_unlicensed()
        test_stdio_without_scope_is_untouched()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    print("ALL PASS")
