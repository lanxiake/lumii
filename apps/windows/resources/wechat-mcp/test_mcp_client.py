#!/usr/bin/env python3
"""Comprehensive MCP stdio test client for wechat-mcp.

Drives the REAL MCP server over stdio JSON-RPC - the same path the Lumii client uses.
Covers: protocol handshake, tool schemas, all read-only tools, and the send tools
against `filehelper` (self-chat, zero risk).

Usage:
    python test_mcp_client.py            # read-only + safe send tests
    python test_mcp_client.py --no-send  # read-only only
"""
import json
import os
import re
import subprocess
import sys
import threading
import time

# 控制台/管道默认走 GBK，失败明细里的 ⇒ 之类字符会直接抛 UnicodeEncodeError 盖住真正的失败
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
# The deployed exe is what the client actually runs; prefer it, fall back to server.py.
DEPLOYED = os.path.join(os.path.expanduser("~"), ".lumii", "mcp", "wechat-mcp", "wechat-mcp.exe")
LOCAL_EXE = os.path.join(HERE, "dist", "pro", "wechat-mcp.exe")
PYTHON = os.path.join(os.path.expanduser("~"), ".lumii", "runtimes", "python-embed", "python.exe")

# 期望版本号：从**唯一版本源** server.py 读，别写死字面量（写死就得每次发版手工同步）
with open(os.path.join(HERE, "server.py"), encoding="utf-8") as _f:
    _m = re.search(r'^SERVER_VERSION\s*=\s*"([^"]+)"', _f.read(), re.M)
EXPECT_VERSION = _m.group(1) if _m else "?"


def pick_command(use_source=False):
    """Pick which server to drive: deployed exe > local dist > source via python."""
    if use_source:
        return [PYTHON, os.path.join(HERE, "server.py")]
    if os.path.exists(DEPLOYED):
        return [DEPLOYED]
    if os.path.exists(LOCAL_EXE):
        return [LOCAL_EXE]
    return [PYTHON, os.path.join(HERE, "server.py")]


class McpClient:
    """Minimal MCP stdio client: newline-delimited JSON-RPC over stdin/stdout."""

    def __init__(self, cmd):
        self.cmd = cmd
        self.proc = None
        self._id = 0
        self._pending = {}
        self._lock = threading.Lock()
        self._reader = None
        # 无 id 的消息 = 通知（notifications/progress 等）；以前直接丢弃，进度就测不了
        self.notifications = []

    def start(self, timeout=60):
        self.proc = subprocess.Popen(
            self.cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # Keep stderr separate: server.py redirects business prints there, and mixing
            # them into stdout would corrupt the JSON-RPC stream.
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        result = self.request("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "lumii-test-harness", "version": "1.0"},
        }, timeout=timeout)
        self.notify("notifications/initialized", {})
        return result

    def _read_loop(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            mid = msg.get("id")
            if mid is not None:
                with self._lock:
                    self._pending[mid] = msg
            else:
                with self._lock:
                    self.notifications.append(msg)

    def request(self, method, params, timeout=300):
        self._id += 1
        mid = self._id
        payload = {"jsonrpc": "2.0", "id": mid, "method": method, "params": params}
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if mid in self._pending:
                    return self._pending.pop(mid)
            time.sleep(0.05)
        raise TimeoutError(f"{method} timed out after {timeout}s")

    def notify(self, method, params):
        payload = {"jsonrpc": "2.0", "method": method, "params": params}
        self.proc.stdin.write(json.dumps(payload) + "\n")
        self.proc.stdin.flush()

    def call_tool(self, name, args, timeout=300):
        """Call a tool, return (payload_dict, raw_result)."""
        resp = self.request("tools/call", {"name": name, "arguments": args}, timeout=timeout)
        result = resp.get("result", {})
        content = result.get("content", [])
        text = content[0].get("text", "") if content else ""
        try:
            payload = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            payload = {"_raw": text}
        return payload, result

    def call_tool_progress(self, name, args, token, timeout=300):
        """带 `_meta.progressToken` 调工具；返回 (payload, 本次期间收到的 notifications/progress)。

        这是客户端侧要求的**规范姿势**：只有带了 token，Server 才会上报进度。
        """
        before = len(self.notifications)
        resp = self.request("tools/call",
                            {"name": name, "arguments": args, "_meta": {"progressToken": token}},
                            timeout=timeout)
        result = resp.get("result", {})
        content = result.get("content", [])
        text = content[0].get("text", "") if content else ""
        try:
            payload = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            payload = {"_raw": text}
        progs = [n for n in self.notifications[before:]
                 if n.get("method") == "notifications/progress"]
        return payload, progs

    def stop(self):
        if self.proc:
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            try:
                self.proc.terminate()
                self.proc.wait(timeout=5)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass


# ---------------------------------------------------------------- test runner

class Runner:
    def __init__(self):
        self.results = []

    def check(self, name, cond, detail=""):
        self.results.append((name, bool(cond), detail))
        mark = "PASS" if cond else "FAIL"
        line = f"  [{mark}] {name}"
        if detail and not cond:
            line += f"\n         -> {detail}"
        print(line)
        return bool(cond)

    def summary(self):
        passed = sum(1 for _, ok, _ in self.results if ok)
        total = len(self.results)
        print("\n" + "=" * 72)
        print(f"  {passed}/{total} passed")
        if passed < total:
            print("  Failures:")
            for name, ok, detail in self.results:
                if not ok:
                    print(f"    - {name}: {detail}")
        return passed == total


def main():
    use_source = "--source" in sys.argv
    no_send = "--no-send" in sys.argv
    cmd = pick_command(use_source)

    print("=" * 72)
    print("  WECHAT-MCP 协议级测试（真实 MCP stdio 链路）")
    print(f"  server: {' '.join(cmd)}")
    print("=" * 72)

    r = Runner()
    client = McpClient(cmd)
    t0 = time.time()
    try:
        init = client.start()
        boot = time.time() - t0
        print(f"\n[1] 握手（{boot:.1f}s）")
        info = init.get("result", {}).get("serverInfo", {})
        r.check("initialize 返回 serverInfo", bool(info), str(init)[:200])
        # 期望值**从源码读**，不写死：本测试优先驱动的是**已部署的 exe**，所以这一条真正查的是
        # 「部署的 exe 有没有落后于源码」——写死字面量的话，改版本时它必然红，还得手工同步一份。
        r.check(f"版本号 = 源码 {EXPECT_VERSION}", info.get("version") == EXPECT_VERSION,
                f"got {info.get('version')}（部署的 exe 可能落后于源码）")
        # instructions 走 result.instructions 才生效（不是 serverInfo 里）
        instr = init.get("result", {}).get("instructions", "")
        r.check("initialize 带 instructions 引导", bool(instr), f"len={len(instr)}")
        if instr:
            r.check("引导含错误处理指引", any(k in instr for k in ("error_code", "status", "错误")),
                    instr[:120])

        print("\n[2] 工具清单")
        tools_resp = client.request("tools/list", {})
        tools = tools_resp.get("result", {}).get("tools", [])
        r.check("工具数量 >= 15", len(tools) >= 15, f"got {len(tools)}")
        names = {t["name"] for t in tools}
        expected = {"send_text", "send_file", "read_history", "read_image", "list_sessions",
                    "search_messages", "poll_new", "check_env"}
        missing = expected - names
        r.check("核心工具齐全", not missing, f"missing={missing}")

        # 每个工具都要有可解析的 inputSchema
        bad_schema = [t["name"] for t in tools if not isinstance(t.get("inputSchema"), dict)]
        r.check("所有工具都有 inputSchema", not bad_schema, f"bad={bad_schema}")

        # 描述不能为空（Agent 靠它决定怎么用）
        empty_desc = [t["name"] for t in tools if not (t.get("description") or "").strip()]
        r.check("所有工具都有 description", not empty_desc, f"empty={empty_desc}")

        print("\n[3] 只读工具（真实数据）")
        env, _ = client.call_tool("check_env", {})
        r.check("check_env 返回 ok", env.get("ok") is not False, str(env)[:200])

        sessions, _ = client.call_tool("list_sessions", {"limit": 5})
        # list_sessions 返回**裸数组**（不是 {sessions:[...]}），read_history 返回 dict。
        # 形状不一致是既有契约，测试照它写，别去改工具迁就测试。
        slist = sessions if isinstance(sessions, list) else (sessions.get("sessions") or [])
        r.check("list_sessions 返回会话", len(slist) > 0, str(sessions)[:200])
        if slist:
            r.check("会话条目含 talker/name",
                    all("talker" in s and "name" in s for s in slist[:3]),
                    f"keys={list(slist[0].keys())}")

        hist, _ = client.call_tool("read_history", {"talker": "filehelper", "limit": 3})
        msgs = hist.get("messages") or [] if isinstance(hist, dict) else []
        r.check("read_history 读到消息", len(msgs) > 0, str(hist)[:200])

        if msgs:
            m = msgs[-1]
            r.check("消息含必要字段",
                    all(k in m for k in ("text",)),
                    f"keys={list(m.keys())}")

        print("\n[4] 错误码覆盖（不存在的会话 / 空文本）")
        bogus, _ = client.call_tool("send_text", {
            "talker": "绝对不存在的会话_ZZZ_测试", "text": "x", "dry_run": True})
        r.check("不存在的会话 -> ok=false", bogus.get("ok") is False, str(bogus)[:200])
        r.check("不存在的会话 -> error_code=target_not_found",
                bogus.get("error_code") == "target_not_found",
                f"got {bogus.get('error_code')}")
        r.check("错误返回带 stage", bool(bogus.get("stage")), str(bogus)[:150])

        empty, _ = client.call_tool("send_text", {"talker": "filehelper", "text": "", "dry_run": True})
        r.check("空文本 -> ok=false", empty.get("ok") is False, str(empty)[:200])
        r.check("空文本 -> error_code=bad_args",
                empty.get("error_code") == "bad_args",
                f"got {empty.get('error_code')}")

        print("\n[5] dry_run 不落地")
        dry, _ = client.call_tool("send_text", {
            "talker": "filehelper", "text": "dry-run-probe", "dry_run": True})
        r.check("dry_run 返回 dry_run=true", dry.get("dry_run") is True, str(dry)[:200])

        if no_send:
            print("\n[6] 真实发送 —— 已按 --no-send 跳过")
        else:
            print("\n[6] 真实发送（filehelper 自聊，零风险）")
            cases = [
                ("中文短句", "自检：中文短句", None),
                ("含换行", "自检：第一行\n第二行", None),
                ("含特殊字符", '自检：引号"与反斜杠\\与制表\t符', None),
                ("长文本", "自检长文本：" + "稳定性验证" * 30, None),
                ("纯数字", "1234567890", None),
                ("英文", "stability check", None),
                # 非 BMP（emoji）：WM_CHAR 投不进去，工具**必须如实上报**而不是静默发错字。
                # 两个方向都实测过：整投会被截成私用区字符（U+1F60A→U+F60A），
                # 拆代理对则整个丢掉。所以断言点在「detail 里说清楚了」。
                ("emoji（应上报略去）", "自检emoji：😊👍🎉", "无法投递"),
            ]
            for label, text, expect_in_detail in cases:
                t1 = time.time()
                res, _ = client.call_tool("send_text", {
                    "talker": "filehelper", "text": text, "dry_run": False}, timeout=300)
                dt = time.time() - t1
                detail = res.get("detail") or ""
                if expect_in_detail:
                    r.check(f"发送 {label}（{dt:.1f}s）", res.get("ok") is True,
                            f"detail={detail} code={res.get('error_code')}")
                    r.check("  └ emoji 被略去时如实上报",
                            expect_in_detail in detail, f"detail={detail!r}")
                else:
                    r.check(f"发送 {label}（{dt:.1f}s）", res.get("ok") is True,
                            f"detail={detail} code={res.get('error_code')}")

        print("\n[7] 诊断字段")
        # 人为触发一次失败，看 diagnostics 有没有带上
        bad2, _ = client.call_tool("send_text", {
            "talker": "绝对不存在的会话_ZZZ_测试", "text": "x", "dry_run": False})
        diag = bad2.get("diagnostics")
        r.check("失败返回带 diagnostics（或至少 stage）",
                isinstance(diag, dict) or bool(bad2.get("stage")),
                str(bad2)[:250])

        print("\n[8] 协议健壮性")
        bad_req = client.request("tools/call", {"name": "no_such_tool", "arguments": {}})
        r.check("未知工具不崩进程", "error" in bad_req or bad_req.get("result") is not None,
                str(bad_req)[:200])
        still_alive, _ = client.call_tool("check_env", {})
        r.check("未知工具调用后进程仍可用", bool(still_alive), str(still_alive)[:150])

        print("\n[9] 进度通知（notifications/progress）")
        # 带 token 调一个真会走发送路径的 dry_run：服务端应在「检查环境/确认会话」各阶段上报。
        # 不带 token 的调用**不该**产生进度通知——规范里无主通知是非法的。
        _, progs = client.call_tool_progress(
            "send_text", {"talker": "filehelper", "text": "进度探针", "dry_run": True}, token="probe-1")
        r.check("带 progressToken ⇒ 服务端上报进度", len(progs) > 0, f"got {len(progs)}")
        if progs:
            ps = [p.get("params", {}) for p in progs]
            r.check("progressToken 原样回传", all(p.get("progressToken") == "probe-1" for p in ps),
                    str(ps[:2]))
            nums = [p.get("progress") for p in ps]
            r.check("progress 单调递增",
                    all(isinstance(n, (int, float)) for n in nums)
                    and nums == sorted(nums) and len(set(nums)) == len(nums), str(nums))
            r.check("进度带人类可读 message", all(p.get("message") for p in ps), str(ps[:2]))
        _, progs2 = client.call_tool_progress(
            "check_env", {}, token="probe-2")
        r.check("只读工具/无阶段 ⇒ 不产生进度（避免噪音）", len(progs2) == 0, f"got {len(progs2)}")

    except Exception as e:
        import traceback
        traceback.print_exc()
        r.check("测试过程无异常", False, str(e))
    finally:
        client.stop()

    ok = r.summary()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
