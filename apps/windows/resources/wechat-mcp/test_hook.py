# -*- coding: utf-8 -*-
"""plus 档 hook 发送后端的离线自测（不碰真微信）。

跑法：`python test_hook.py`
起两个假 hook 端点，验证：单实例直发、多实例按 talker 匹配、不支持联系人接口时
**报错而不是广播**、ret!=0 透传、以及请求真的落到了正确的账号上。

为什么要它：多账号路由错了不会报错——它只会「消息发给错的人」，比发送失败严重得多。
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

SRC = os.path.dirname(os.path.abspath(__file__))
if SRC not in sys.path:
    sys.path.insert(0, SRC)

import wechat_hook

# 测试机可能真开着多个微信；默认把它们挡在闸门外（专门测闸门的那段会再覆盖）。
wechat_hook._running_accounts = lambda: set()

fails = []


def check(label, cond, extra=""):
    print(("  OK  " if cond else "  FAIL") + f"  {label}" + (f"  [{extra}]" if extra else ""))
    if not cond:
        fails.append(label)


class FakeHook(BaseHTTPRequestHandler):
    """配置由 make_server 注入到**子类**上（HTTPServer 每个请求新建 handler 实例）。"""

    wxid = ""
    contacts = None
    ret = 0
    sent = None
    status_500 = ()          # 命中这些 path 时回 HTTP 500（模拟已受理后失败）
    no_file_support = False  # True 时 /SendFileMsg 回 404（模拟只会发文本的老 hook）

    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path in self.status_500:
            self.send_response(500)
            self.end_headers()
            return
        if self.path == "/GetSelfProfile":
            out = {"wxid": self.wxid, "nickname": self.wxid}
        elif self.path == "/GetContactList":
            if self.contacts is None:
                self.send_response(404)
                self.end_headers()
                return
            out = {"ret": 0, "contacts": [{"wxid": c} for c in self.contacts]}
        elif self.path in ("/SendTextMsg", "/SendFileMsg"):
            if self.path == "/SendFileMsg" and self.no_file_support:
                self.send_response(404)
                self.end_headers()
                return
            self.sent.append((self.wxid, self.path, body))
            out = {"ret": self.ret, "retmsg": "ok" if self.ret == 0 else "boom"}
        else:
            self.send_response(404)
            self.end_headers()
            return
        raw = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def make_server(wxid, contacts):
    handler = type("H", (FakeHook,), {"wxid": wxid, "contacts": contacts,
                                      "ret": 0, "sent": []})
    srv = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return handler, f"http://127.0.0.1:{srv.server_address[1]}"


def use(urls, similar=8):
    """钉住端点并清缓存；限速归零，免得测试被防封号节流拖慢。"""
    os.environ["WECHAT_HOOK_ENDPOINTS"] = ",".join(urls)
    wechat_hook._cache.update(at=0.0, endpoints=[])
    wechat_hook.MIN_INTERVAL = 0.0
    wechat_hook.SIMILAR_TARGETS = similar
    wechat_hook._state.clear()


print("=== 单实例：直发 ===")
srv, url = make_server("wxid_me", {"wxid_a", "wxid_b"})
use([url])
r = wechat_hook.try_send_text("wxid_a", "hi")
check("发送成功", r and r["ok"] and r["via"] == "hook", str(r))
check("请求落到该实例", srv.sent == [("wxid_me", "/SendTextMsg", {"wxidorgid": "wxid_a", "msg": "hi"})],
      str(srv.sent))

print("=== 多实例：按 talker 匹配 ===")
srv_a, url_a = make_server("wxid_A", {"wxid_a"})
srv_b, url_b = make_server("wxid_B", {"wxid_b"})
use([url_a, url_b])
r = wechat_hook.try_send_text("wxid_b", "yo")
check("路由到 B", r and r["ok"] and r.get("account") == "wxid_B", str(r))
check("A 没收到", srv_a.sent == [], str(srv_a.sent))
check("B 收到了一条", len(srv_b.sent) == 1, str(srv_b.sent))

print("=== 多实例 + 不支持联系人接口：报错，不广播、不回退 UIA ===")
srv_c, url_c = make_server("wxid_C", None)
use([url_a, url_c])
r = wechat_hook.try_send_text("wxid_b", "nope")
check("报 target_not_found（不是回退）",
      r and not r["ok"] and r.get("error_code") == "target_not_found", str(r))
check("两个实例都没收到", srv_a.sent == [] and srv_c.sent == [],
      f"{srv_a.sent} / {srv_c.sent}")

print("=== 一个 hook 都没有：才允许回退 UIA ===")
use(["http://127.0.0.1:1"])          # 必然连不上
r = wechat_hook.try_send_text("wxid_b", "nope")
check("返回回退信号", r and r.get("_fallback"), str(r))

print("=== 防封号：同一段话短时间群发被拦 ===")
srv_e, url_e = make_server("wxid_E", {"wxid_1", "wxid_2", "wxid_3"})
use([url_e], similar=2)
check("第 1 个会话放行", wechat_hook.try_send_text("wxid_1", "same")["ok"])
check("第 2 个会话放行", wechat_hook.try_send_text("wxid_2", "same")["ok"])
r = wechat_hook.try_send_text("wxid_3", "same")
check("第 3 个被 risk_limited 拦下",
      r and not r["ok"] and r.get("error_code") == "risk_limited", str(r))
check("被拦的那条没有发出去", len(srv_e.sent) == 2, str(srv_e.sent))
check("换个内容仍放行", wechat_hook.try_send_text("wxid_3", "other")["ok"])

print("=== 实例返回 ret!=0：透传失败 ===")
srv_d, url_d = make_server("wxid_D", None)
srv_d.ret = 7
use([url_d])
r = wechat_hook.try_send_text("wxid_x", "bad")
check("ok=False", r and not r["ok"], str(r))
check("错误码可读", r and r.get("error_code") == "send_unconfirmed", str(r))

print("=== 端点不支持文件发送：404 = 没受理，可以回退 UIA ===")
srv_h, url_h = make_server("wxid_H", {"wxid_1"})
srv_h.no_file_support = True
use([url_h])
r = wechat_hook.try_send_file("wxid_1", r"C:\tmp\x.txt")
check("返回回退信号", r and r.get("_fallback"), str(r))
check("没有写进 sent", srv_h.sent == [], str(srv_h.sent))

print("=== 端点受理后 500：按未确认处理，不回退（防重复投递） ===")
srv_h.no_file_support = False
srv_h.status_500 = ("/SendFileMsg",)
r = wechat_hook.try_send_file("wxid_1", r"C:\tmp\x.txt")
check("send_not_confirmed", r and not r.get("_fallback")
      and r.get("error_code") == "send_not_confirmed", str(r))

print("=== 多开 + 只有一个 hook：省略 account 必须拒绝（否则会从错误账号发出） ===")
srv_g, url_g = make_server("wxid_G", {"wxid_1"})
use([url_g])
wechat_hook._running_accounts = lambda: {"wxid_G", "wxid_other"}
r = wechat_hook.try_send_text("wxid_1", "gate")
check("拒绝并报 target_not_found",
      r and not r["ok"] and r.get("error_code") == "target_not_found", str(r))
check("没有发出去", srv_g.sent == [], str(srv_g.sent))
r = wechat_hook.try_send_text("wxid_1", "gate", account="wxid_G")
check("显式指定 account 后放行", r and r.get("ok"), str(r))
check("落到 G", len(srv_g.sent) == 1, str(srv_g.sent))

print()
print("结果：" + ("全部通过" if not fails else f"{len(fails)} 项失败 -> {fails}"))
sys.exit(1 if fails else 0)
