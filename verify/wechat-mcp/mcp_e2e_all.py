# -*- coding: utf-8 -*-
"""四件套 MCP 端到端：按 stdio JSON-RPC 真实拉起每个 server.py，逐个 tools/call 全部工具。

安全约束：发送类一律 `dry_run=true`；画像读写指到临时目录（`LUMII_WECHAT_DISTILL`）；
归档只预演；导出写临时目录。输出只打印结构、计数与截断后的摘要，不整段回显聊天原文。
运行：python verify/wechat-mcp/mcp_e2e_all.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RES = os.path.join(ROOT, "apps", "windows", "resources")
TMP = tempfile.mkdtemp(prefix="mcp_e2e_")
FH = "文件传输助手"
RESULTS = []          # (product, tool, label, ok, ms, summary)


class Client:
    """最小 MCP stdio 客户端：一行一个 JSON-RPC 消息。"""

    def __init__(self, product, env=None, cmd=None):
        """拉起 `<product>/server.py`（或给定的 exe 命令）并完成 initialize 握手。"""
        self.product = product
        e = dict(os.environ, PYTHONIOENCODING="utf-8", **(env or {}))
        self.p = subprocess.Popen(cmd or [sys.executable, os.path.join(RES, product, "server.py")],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, env=e, cwd=TMP)
        self.mid = 0
        init = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                       "clientInfo": {"name": "e2e", "version": "1"}})
        self.info = init["result"]["serverInfo"]
        self.notify("notifications/initialized")
        self.tools = [t["name"] for t in self.rpc("tools/list", {})["result"]["tools"]]

    def notify(self, method, params=None):
        """发一条通知（无 id、无回包）。"""
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})

    def _send(self, obj):
        self.p.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        self.p.stdin.flush()

    def rpc(self, method, params):
        """发请求并读到同 id 的回包（中途的进度通知跳过）。"""
        self.mid += 1
        self._send({"jsonrpc": "2.0", "id": self.mid, "method": method, "params": params})
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise RuntimeError(f"{self.product} 进程提前退出")
            msg = json.loads(line)
            if msg.get("id") == self.mid:
                return msg

    def call(self, tool, args=None, label=""):
        """tools/call 一次；返回 (结果 JSON 或 None, 原始 content)。并记一行到 RESULTS。"""
        t0 = time.time()
        msg = self.rpc("tools/call", {"name": tool, "arguments": args or {}})
        ms = int((time.time() - t0) * 1000)
        res = msg.get("result") or {}
        content = res.get("content") or []
        data = None
        for c in content:
            if c.get("type") == "text":
                try:
                    data = json.loads(c["text"])
                except ValueError:
                    data = {"_text": c["text"]}
                break
        is_err = bool(res.get("isError")) or "error" in msg
        biz_fail = isinstance(data, dict) and (data.get("ok") is False or "error" in data)
        RESULTS.append((self.product, tool, label, not (is_err or biz_fail), ms,
                        summarize(data, content), is_err))
        return data, content

    def close(self):
        """关 stdin 让 server 正常退出。"""
        try:
            self.p.stdin.close()
            self.p.wait(timeout=10)
        except Exception:                                           # noqa: BLE001
            self.p.kill()


def summarize(data, content):
    """把一次结果压成一行：顶层键 + 关键计数 + 失败码。"""
    kinds = [c.get("type") for c in content]
    if "image" in kinds:
        img = next(c for c in content if c.get("type") == "image")
        return f"image {img.get('mimeType')} {len(img.get('data', '')) * 3 // 4} B; " + \
            summarize(data, [c for c in content if c.get("type") != "image"])
    if isinstance(data, list):
        return f"list[{len(data)}]"
    if not isinstance(data, dict):
        return str(data)[:120]
    if data.get("ok") is False:
        return f"FAIL {data.get('error_code')}: {str(data.get('detail'))[:90]}"
    if "error" in data:
        return f"ERROR: {str(data['error'])[:100]}"
    parts = []
    for k in ("total", "count", "messages", "archived", "alive", "files_written", "csv_path",
              "pdf_error", "truncated", "planned", "copied", "bytes", "status", "dry_run", "sent"):
        if k in data:
            v = data[k]
            parts.append(f"{k}={v if not isinstance(v, (list, dict)) else len(v)}")
    keys = ",".join(list(data)[:9])
    return (" ".join(parts) + f"  [{keys}]").strip()


def find(obj, pred):
    """在嵌套结果里找第一个满足 pred 的 dict。"""
    if isinstance(obj, dict):
        if pred(obj):
            return obj
        obj = list(obj.values())
    if isinstance(obj, list):
        for x in obj:
            r = find(x, pred)
            if r is not None:
                return r
    return None


def test_wechat_mcp():
    """主产品：读、媒体、环境、发送预演、检索、未读、蒸馏、画像。"""
    distill = os.path.join(TMP, "distill")
    os.makedirs(distill, exist_ok=True)
    real_key = os.path.join(os.path.expanduser("~"), ".lumii", "wechat-distill", "image_key.json")
    if os.path.isfile(real_key):              # 图片 key 与画像同目录：隔离画像时把 key 带过去，读图才测得到
        import shutil
        shutil.copy(real_key, distill)
    c = Client("wechat-mcp", env={"LUMII_WECHAT_DISTILL": distill})
    try:
        c.call("check_env")
        c.call("locate_db")
        c.call("repair_env")
        s, _ = c.call("list_sessions", {"query": ""})
        c.call("list_sessions", {"query": "文件"}, "按关键词")
        c.call("read_history", {"talker": FH, "limit": 20})
        c.call("read_history", {"talker": "绝对不存在的会话xyz"}, "错误路径")
        # 找图片/语音的 local_id：扫最近若干会话的历史
        talkers = [x.get("talker") or x.get("username") for x in
                   (s.get("sessions") if isinstance(s, dict) else s or [])][:25]
        img = voice = None
        for tk in [FH] + [t for t in talkers if t]:
            h, _ = c.call("read_history", {"talker": tk, "limit": 200}, "_probe")
            RESULTS.pop()
            img = img or (tk, find(h, lambda d: d.get("type") == 3 and "local_id" in d))
            img = img if img and img[1] else None
            voice = voice or (tk, find(h, lambda d: d.get("type") == 34 and "local_id" in d))
            voice = voice if voice and voice[1] else None
            if img and voice:
                break
        if img:
            c.call("read_image", {"talker": img[0], "local_id": img[1]["local_id"]})
        else:
            RESULTS.append(("wechat-mcp", "read_image", "未找到图片消息", False, 0, "skip", False))
        if voice:
            c.call("transcribe_voice", {"talker": voice[0], "local_id": voice[1]["local_id"]})
        else:
            RESULTS.append(("wechat-mcp", "transcribe_voice", "未找到语音消息", False, 0, "skip", False))
        c.call("read_image", {"talker": FH, "local_id": 999999999}, "错误路径")
        c.call("poll_new", {"since_ts": int(time.time()) - 86400})
        c.call("search_messages", {"keyword": "图片", "limit": 10})
        c.call("search_messages", {"keyword": "的", "talker": FH, "limit": 5}, "限定会话")
        c.call("list_unread")
        c.call("wechat_digest", {"talker": FH, "limit": 50})
        c.call("wechat_digest", {"limit": 50}, "本人")
        c.call("send_text", {"talker": FH, "text": "e2e 预演，不会发出", "dry_run": True})
        c.call("send_text", {"talker": FH, "text": ""}, "错误路径：空文本")
        f = os.path.join(TMP, "e2e.txt")
        open(f, "w", encoding="utf-8").write("e2e")
        c.call("send_file", {"talker": FH, "path": f, "dry_run": True})
        c.call("send_batch", {"messages": [{"talker": FH, "text": "e2e 一"},
                                           {"talker": "绝对不存在的会话xyz", "text": "e2e 二"}],
                              "dry_run": True})
        c.call("reply_to", {"talker": FH, "quote": "e2e", "text": "e2e 引用预演", "dry_run": True})
        c.call("wechat_distill_state", {"action": "set", "scope": "self", "ts": 1791900000}, "set")
        c.call("wechat_distill_state", {"action": "get", "scope": "self"}, "get")
        c.call("wechat_profile_save", {"content": "# e2e 测试画像\n- 只是测试"}, "本人")
        c.call("wechat_profile_save", {"scope": FH, "content": "# 文件传输助手\n- e2e"}, "会话")
        c.call("wechat_profile_get", {"scope": "self"}, "本人")
        c.call("wechat_profile_get", {}, "列清单")
        c.call("wechat_distill_clear", {}, "错误路径：不给 scope")
        c.call("wechat_distill_clear", {"scope": FH}, "删会话画像")
        c.call("wechat_distill_clear", {"everything": True}, "清空(临时目录)")
        return c.product, c.info, c.tools
    finally:
        c.close()


def test_export():
    """导出：会话、五种格式、关键词/全库、文件清单、归档预演、空间。"""
    c = Client("wechat-export-mcp")
    out = os.path.join(TMP, "export")
    try:
        c.call("list_sessions", {"query": "文件"})
        for fmt in ("md", "html", "json", "csv", "pdf"):
            media = "images" if fmt in ("html", "pdf") else "none"
            c.call("export_chat", {"talker": FH, "out_dir": out, "format": fmt, "media": media}, fmt)
        c.call("export_chat", {"talker": FH, "out_dir": out, "format": "md", "split": "month"}, "按月拆分")
        c.call("export_chat", {"talker": FH, "out_dir": out, "format": "json", "keyword": "图片"}, "关键词")
        c.call("export_chat", {"out_dir": out, "format": "md", "keyword": "图片", "max_sessions": 3}, "全库搜")
        c.call("export_chat", {"talker": FH, "out_dir": out, "format": "xlsx"}, "错误路径：xlsx")
        c.call("export_chat", {"talker": "绝对不存在的会话xyz", "out_dir": out}, "错误路径：会话")
        c.call("list_files", {"talker": FH, "limit": 20})
        c.call("list_files", {"only_missing": True, "limit": 20}, "只看过期")
        c.call("archive_files", {"out_dir": os.path.join(TMP, "archive"), "talker": FH, "dry_run": True}, "预演")
        c.call("disk_usage", {"session_limit": 5})
        return c.product, c.info, c.tools
    finally:
        c.close()


def test_crm():
    """客户分析：通讯录/群成员/标签/CSV、统计、分层、排行、正文三件。"""
    c = Client("wechat-crm-mcp")
    out = os.path.join(TMP, "crm")
    try:
        c.call("list_contacts", {}, "好友默认页")
        g, _ = c.call("list_contacts", {"scope": "group", "limit": 5}, "群")
        c.call("list_contacts", {"scope": "official", "limit": 3}, "公众号")
        room = (g.get("contacts") or [{}])[0].get("username") if isinstance(g, dict) else None
        if room:
            c.call("list_contacts", {"room": room}, "群成员")
            c.call("list_contacts", {"room": room, "out_dir": out}, "群成员导 CSV")
        ls, _ = c.call("list_labels")
        top = max((ls or {}).get("labels") or [{}], key=lambda x: x.get("count", 0)).get("name")
        if top:
            c.call("list_contacts", {"label": top}, "按标签")
            c.call("list_contacts", {"label": top, "out_dir": out}, "按标签导 CSV")
        c.call("list_contacts", {"label": "不存在的标签xyz"}, "错误路径：标签")
        c.call("list_contacts", {"scope": "friend", "limit": 0, "out_dir": out}, "全部好友导 CSV")
        r, _ = c.call("interaction_rank", {"top": 5})
        c.call("interaction_rank", {"top": 3, "sort": "recent"}, "recent")
        who = ((r or {}).get("ranking") or [{}])[0].get("talker") or FH
        c.call("contact_stats", {"talker": who})
        c.call("contact_stats", {"talker": "绝对不存在的会话xyz"}, "错误路径")
        c.call("silence_ladder", {"top": 3})
        c.call("silence_ladder", {"days": [0, -1]}, "错误路径：days")
        c.call("read_messages", {"talker": who, "limit": 20})
        c.call("search_messages", {"keyword": "图片", "limit": 10})
        c.call("customer_brief", {"talker": who})
        return c.product, c.info, c.tools
    finally:
        c.close()


def test_recall():
    """撤回防护：守护状态、撤回列表、读一条、缺口。"""
    c = Client("wechat-recall-mcp")
    try:
        c.call("daemon_status")
        lr, _ = c.call("list_recalls", {"limit": 10})
        hit = find(lr, lambda d: "local_id" in d and "talker" in d)
        if hit:
            c.call("read_recall", {"talker": hit["talker"], "local_id": hit["local_id"]})
        c.call("read_recall", {"talker": FH, "local_id": 999999999}, "错误路径")
        c.call("archive_gap")
        return c.product, c.info, c.tools
    finally:
        c.close()


def main():
    """跑四个产品并打印汇总表与工具覆盖率。"""
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    covered = {}
    for fn in (test_wechat_mcp, test_export, test_crm, test_recall):
        t0 = time.time()
        try:
            prod, info, tools = fn()
            covered[prod] = tools
            print(f"== {info['name']} {info.get('version')}  {len(tools)} 工具  {time.time() - t0:.1f}s")
        except Exception as e:                                      # noqa: BLE001
            print(f"!! {fn.__name__} 崩了：{e!r}")
    print()
    for prod, tool, label, ok, ms, summ, is_err in RESULTS:
        mark = "OK " if ok else ("ERR" if is_err else "-- ")
        print(f"{mark} {prod:18} {tool:22} {label:16} {ms:>6}ms  {summ[:150]}")
    print()
    by = {}
    for prod, tool, *_ in RESULTS:
        by.setdefault(prod, set()).add(tool)
    for prod, tools in covered.items():
        miss = [t for t in tools if t not in by.get(prod, set())]
        print(f"覆盖 {prod}: {len(tools) - len(miss)}/{len(tools)}" + (f"  未调用: {miss}" if miss else ""))
    print("isError(内部异常) 次数:", sum(1 for r in RESULTS if r[6]))
    print("临时目录:", TMP)


if __name__ == "__main__":
    main()
