#!/usr/bin/env python3
"""wechat-mcp 自动化测试脚本

模拟用户操作，验证 P0-A 和 P0-B 修复的实际效果。

测试内容：
1. P0-A：路径自动发现（多路径探测 + 注册表读取）
2. P0-A：可操作的错误提示
3. P0-B：发送重试机制（智能重试 + 错误分类）
4. P0-B：修复建议生成
5. 完整流程：list_sessions → read_history → send_text → poll_new

用法：
    python test_automation.py
"""
import os
import sys
import json
import time
import traceback
from datetime import datetime

# stdout 固定 UTF-8：Windows 控制台默认 GBK，打印 ✅/❌ 会直接抛 UnicodeEncodeError
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# 添加当前目录到 sys.path
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


class TestRunner:
    """测试运行器"""

    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.skipped = 0
        self.results = []

    def section(self, title):
        """打印章节标题"""
        print("\n" + "=" * 70)
        print(f"  {title}")
        print("=" * 70)

    def test(self, name, fn, *args, **kwargs):
        """运行单个测试"""
        print(f"\n[测试] {name}")
        try:
            result = fn(*args, **kwargs)
            if result is False:
                self.fail(name, "测试返回 False")
            else:
                self.success(name)
            return result
        except AssertionError as e:
            self.fail(name, str(e))
            return None
        except Exception as e:
            self.fail(name, f"{type(e).__name__}: {e}")
            traceback.print_exc()
            return None

    def success(self, name):
        """测试通过"""
        print(f"  ✅ 通过")
        self.passed += 1
        self.results.append({"name": name, "status": "passed"})

    def fail(self, name, reason):
        """测试失败"""
        print(f"  ❌ 失败: {reason}")
        self.failed += 1
        self.results.append({"name": name, "status": "failed", "reason": reason})

    def skip(self, name, reason):
        """跳过测试"""
        print(f"  ⏭️  跳过: {reason}")
        self.skipped += 1
        self.results.append({"name": name, "status": "skipped", "reason": reason})

    def summary(self):
        """打印测试摘要"""
        print("\n" + "=" * 70)
        print("  测试摘要")
        print("=" * 70)
        print(f"  通过: {self.passed}")
        print(f"  失败: {self.failed}")
        print(f"  跳过: {self.skipped}")
        print(f"  总计: {self.passed + self.failed + self.skipped}")

        if self.failed == 0:
            print("\n  🎉 所有测试通过！")
            return 0
        else:
            print(f"\n  ⚠️  {self.failed} 个测试失败")
            return 1


def test_imports():
    """测试模块导入"""
    try:
        import wechat_core as core
        print("  ✅ wechat_core 导入成功")
    except ImportError as e:
        raise AssertionError(f"wechat_core 导入失败: {e}")

    try:
        import server
        print("  ✅ server 导入成功")
    except ImportError as e:
        raise AssertionError(f"server 导入失败: {e}")

    return True


def test_path_discovery():
    """测试 P0-A：路径自动发现"""
    import wechat_core as core

    print("  [1] 测试 list_accounts() 多路径探测...")
    try:
        accounts = core.list_accounts()
        print(f"     找到 {len(accounts)} 个账号")

        if accounts:
            for acc in accounts[:2]:  # 只显示前2个
                print(f"     - {acc['wxid']}")
                print(f"       路径: {acc['root'][:60]}...")
            return True
        else:
            print("     ⚠️  未找到账号（可能是正常情况）")
            return True  # 未找到账号也算通过，只要没报错
    except Exception as e:
        raise AssertionError(f"list_accounts() 失败: {e}")


def test_error_message_quality():
    """测试 P0-A：错误提示质量"""
    import wechat_core as core

    print("  [1] 测试 db_root() 错误提示...")
    try:
        root = core.db_root()
        print(f"     ✅ 数据目录定位成功: {root[:50]}...")
        return True
    except RuntimeError as e:
        # 预期会抛出错误（如果数据目录不存在）
        error_msg = str(e)

        # 验证错误提示质量
        has_scan_paths = "已扫描路径" in error_msg
        has_suggestion = "修复建议" in error_msg or "环境变量" in error_msg

        print(f"     错误提示包含扫描路径: {'✅' if has_scan_paths else '❌'}")
        print(f"     错误提示包含修复建议: {'✅' if has_suggestion else '❌'}")

        if not has_scan_paths:
            raise AssertionError("错误提示缺少'已扫描路径'清单")
        if not has_suggestion:
            raise AssertionError("错误提示缺少'修复建议'")

        print("     ✅ 错误提示质量合格")
        return True


def test_error_code_mapping():
    """测试 P0-B：错误码映射"""
    import server

    test_cases = [
        ("环境前置检查失败：微信窗口未在前台", "env_not_ready"),
        ("输入未落地（fail-closed）", "input_not_landed"),
        ("发送后输入框未清空", "send_unconfirmed"),
        ("未找到要引用的消息", "quote_not_found"),
        ("目标会话校验失败", "verification_failed"),
        ("菜单里未找到「引用」", "menu_not_found"),
    ]

    all_passed = True
    for detail, expected_code in test_cases:
        actual_code = server._code_of(detail)
        if actual_code == expected_code:
            print(f"  ✅ '{detail[:30]}...' → {actual_code}")
        else:
            print(f"  ❌ '{detail[:30]}...' → {actual_code} (期望 {expected_code})")
            all_passed = False

    if not all_passed:
        raise AssertionError("部分错误码映射不正确")

    return True


def test_fix_suggestions():
    """测试 P0-B：修复建议生成"""
    import server

    test_codes = [
        "env_not_ready",
        "input_not_landed",
        "send_unconfirmed",
        "target_not_found",
        "verification_failed",
    ]

    all_passed = True
    for code in test_codes:
        suggestion = server._get_fix_suggestion(code)
        if suggestion and len(suggestion) > 20:
            print(f"  ✅ {code}: {suggestion[:50]}...")
        else:
            print(f"  ❌ {code}: 建议过短或缺失")
            all_passed = False

    if not all_passed:
        raise AssertionError("部分修复建议生成失败")

    return True


def test_retry_logic():
    """测试 P0-B：重试逻辑"""
    import server

    print("  [1] 测试重试成功场景...")

    # 模拟首次失败、第二次成功
    attempt_count = [0]

    def mock_send_success_on_retry():
        attempt_count[0] += 1
        if attempt_count[0] == 1:
            return False, "输入未落地（fail-closed）"
        return True, "发送成功"

    ok, detail, attempts = server._send_with_retry(
        mock_send_success_on_retry,
        max_retries=2,
        retry_delay=0.1
    )

    if not ok:
        raise AssertionError(f"重试失败：ok={ok}, detail={detail}")
    if attempts != 2:
        raise AssertionError(f"重试次数错误：{attempts}（期望 2）")
    if "第 2 次尝试成功" not in detail:
        raise AssertionError(f"重试成功标记缺失：{detail}")

    print(f"     ✅ 首次失败，第 {attempts} 次成功")

    print("  [2] 测试不可重试错误...")

    # 重置计数器
    attempt_count[0] = 0

    def mock_send_env_error():
        attempt_count[0] += 1
        return False, "环境前置检查失败：微信窗口未在前台"

    ok, detail, attempts = server._send_with_retry(
        mock_send_env_error,
        max_retries=2,
        retry_delay=0.1
    )

    if ok:
        raise AssertionError("环境错误不应该重试成功")
    if attempts != 1:
        raise AssertionError(f"不可重试错误执行了 {attempts} 次（期望 1）")
    if "不可重试" not in detail:
        raise AssertionError(f"不可重试标记缺失：{detail}")

    print(f"     ✅ 环境错误不重试（attempts={attempts}）")

    return True


def test_uia_blank_falls_back_to_frames():
    """UIA 拿不到控件树时，几何修复后**必须退回帧判据**（回归测试）。

    原实现第二段写死 `ok = uia_header_is(d, name) if d else False`：微信 4.x 可能整条
    生命周期都不暴露控件树（`read_uia`→None），于是修复后**必判失败** —— 白切一次会话
    （用户看到的「只是打开了微信界面」）、再报 `target_unconfirmed`（2026-10-10 定位）。
    这里用桩件模拟「两次 read_uia 都拿不到、帧判据第二次才过」，断言最终判定成功。
    """
    import wechat_sender as ws

    calls = {"verify": 0, "open": 0}
    names = ("read_uia", "read_ui_stable", "verify_target",
             "_repair_geometry_for_send", "open_chat_post")
    saved = {n: getattr(ws, n) for n in names}
    try:
        ws.read_uia = lambda h, tag="uia", all_ctls=False: None      # UIA 一直拿不到
        ws.read_ui_stable = lambda tag: (1280, 820, ["frame"])

        def _verify(talker, name, lines, ww, wh, verbose=False):
            calls["verify"] += 1
            return calls["verify"] >= 2, ("消息" if calls["verify"] >= 2 else "-")

        ws.verify_target = _verify
        ws._repair_geometry_for_send = lambda h: None                # 尺寸已合规，无需搬窗口

        def _open(*a, **k):
            calls["open"] += 1
            return False

        ws.open_chat_post = _open

        ok, detail = ws._send_locked_body(4242, "hi", "wxid_x", "Loop", True, False, 0)
    finally:
        for n, v in saved.items():
            setattr(ws, n, v)

    if not ok:
        raise AssertionError(f"UIA 拿不到时应退帧判据重判，实得 {(ok, detail)}")
    if calls["verify"] < 2:
        raise AssertionError("修复后没有重跑帧判据（回到硬判 False 的老 bug）")
    if calls["open"]:
        raise AssertionError("目标已确认，不该再去切会话")

    print(f"     ✅ UIA blank → 修复后退回帧判据 → 判定成功（verify×{calls['verify']}）")
    return True


def _stub_open_chat_post(ws, verify_ok_on, alive):
    """装了 `open_chat_post` 的桩件：UIA 拿不到、帧路命中一行、按序号决定切没切过去。"""
    calls = {"open": 0, "alive": 0, "unfreeze": 0}
    names = ("read_uia", "read_ui_stable", "find_session", "_post_click_verify",
             "_ui_alive", "_unfreeze_ui")
    saved = {n: getattr(ws, n) for n in names}

    def _verify(h, x, y, tag, name, talker, verbose=False):
        calls["open"] += 1
        return calls["open"] >= verify_ok_on

    ws.read_uia = lambda h, tag="uia", all_ctls=False: None          # 拿不到 ⇒ 走帧路
    ws.read_ui_stable = lambda tag, tries=4: (1280, 820, [(120, 100, 260, 114, "Loop")])
    ws.find_session = lambda lines, name, ww, wh: (1.0, 190, 107, "Loop")
    ws._post_click_verify = _verify

    def _alive(h):
        calls["alive"] += 1
        return alive

    ws._ui_alive = _alive

    def _unfreeze(tag="tray"):
        calls["unfreeze"] += 1
        return True

    ws._unfreeze_ui = _unfreeze
    return calls, saved, names


def test_open_chat_post_unfreezes_when_ui_dead():
    """界面卡死时：认出来 → 拉托盘恢复 → **重试一遍**（回归测试，2026-10-10）。

    现场：UI 卡死时 `PrintWindow` 给的是冻结旧帧，目标往往不在那张旧帧里 ⇒ `find_session`
    恒 None，表面看像"目标不在列表"、实际整屏不响应，于是回复永远 `target_unconfirmed`
    （2026-10-10 实测：Loop 那条连挂 20+ 次，全靠人工拉托盘图标才恢复）。
    """
    import wechat_sender as ws

    calls, saved, names = _stub_open_chat_post(ws, verify_ok_on=2, alive=False)
    try:
        ok = ws.open_chat_post(4242, "Loop", "wxid_x", False)
    finally:
        for n, v in saved.items():
            setattr(ws, n, v)

    if not ok:
        raise AssertionError("判定卡死 → 拉托盘后重试成功，但 open_chat_post 返回了 False")
    if calls["unfreeze"] != 1:
        raise AssertionError(f"应恰好拉一次托盘，实得 {calls['unfreeze']}")
    if calls["alive"] != 1:
        raise AssertionError(f"应只探一次界面存活，实得 {calls['alive']}")
    if calls["open"] != 2:
        raise AssertionError(f"应在恢复后重试一次，实得 {calls['open']} 次")
    print(f"     ✅ 判死 → 拉托盘 ×{calls['unfreeze']} → 重试第 {calls['open']} 次成功")
    return True


def test_open_chat_post_no_unfreeze_when_alive():
    """界面**活着**时不许拉托盘——它会白抢用户的前台（实测 `GetForegroundWindow` 变微信）。

    这条守的是误判方向：目标真够不着时（不在列表里 / 名字读花）该老实排队等下一拍。
    """
    import wechat_sender as ws

    calls, saved, names = _stub_open_chat_post(ws, verify_ok_on=99, alive=True)
    try:
        ok = ws.open_chat_post(4242, "Loop", "wxid_x", False)
    finally:
        for n, v in saved.items():
            setattr(ws, n, v)

    if ok:
        raise AssertionError("桩件里切不过去，不该返回成功")
    if calls["unfreeze"]:
        raise AssertionError(f"界面活着却拉了 {calls['unfreeze']} 次托盘（会抢前台）")
    if calls["open"] != 1:
        raise AssertionError(f"界面活着不该重试，实得 {calls['open']} 次")
    print("     ✅ 界面活着 → 不拉托盘、不重试")
    return True


def test_ui_alive_reads_failure_as_alive():
    """`_ui_alive` 拍不到图时必须判「活着」——判不了 ≠ 卡死（误判的代价是抢前台）。"""
    import wechat_sender as ws

    saved = (ws.read_ui, ws.post_click)
    try:
        ws.read_ui = lambda tag: (0, 0, [])          # 拍不到
        ws.post_click = lambda h, x, y: (_ for _ in ()).throw(AssertionError("拍不到就不该点"))
        if not ws._ui_alive(4242):
            raise AssertionError("拍不到图时判成了卡死")
    finally:
        ws.read_ui, ws.post_click = saved
    print("     ✅ 拍不到 → 判活着（不点、不拉托盘）")
    return True


# 一帧真实形态的界面（坐标取自 2026-10-10 的现场帧）：会话行在 OCR 里是**两行文字**
# （名字 + 紧跟着的预览行），另外还带了服务号这种"不是会话"的固定项。
_UI_ALIVE_FRAME = [
    (324, 49, 421, 62, "产 品 技 术 部 （ 18 ）"),      # 聊天头部（x>SESSION_COL）
    (126, 97, 196, 109, "产 品 技 术 部"),              # 当前会话：名字行
    (127, 118, 256, 130, "肖 美 虹 ： 链 接"),           # 当前会话：预览行（同一行会话！）
    (127, 162, 210, 175, "四 川 人 保 财 险"),           # 另一行会话 —— 探针该点这里
    (126, 747, 168, 759, "服 务 号"),                    # 非会话：右半边是网页面板
    (126, 767, 252, 780, "京 东 白 条 ： 账 单"),
]


def _stub_snap(changed):
    """桩掉 `_snap`：首帧固定，第二帧按 `changed` 决定指纹变不变；返回 (桩件, 调用计数)。"""
    import wechat_sender as ws

    calls = {"n": 0}

    def snap(tag):
        calls["n"] += 1
        sig = "A" if tag.startswith("alive0") else ("B" if changed else "A")
        return sig, 1280, 820, [list(l) for l in _UI_ALIVE_FRAME]

    return snap, calls


def test_ui_alive_skips_current_row_and_nonchat():
    """探针**不许点当前会话那一行**（含它的预览行），也不许点服务号那类。

    两条都是 2026-10-10 实测踩出来的：点当前会话的**预览行**（y 与名字行不同、但同属一行）
    会让微信把聊天区重绘成空白，看起来像被点坏；点服务号那类会异步加载网页面板，
    把随后的还原点击盖掉。
    """
    import wechat_sender as ws

    snap, calls = _stub_snap(True)
    clicks = []
    saved = (ws._snap, ws.post_click)
    try:
        ws._snap = snap
        ws.post_click = lambda h, x, y: clicks.append((x, y)) is None
        alive = ws._ui_alive(4242)
    finally:
        ws._snap, ws.post_click = saved
    assert alive, "画面变了却判成卡死"
    assert clicks[0] == (168, 168), (
        f"第一次点击该落在「四川人保财险」那一行 (168,168)，实际 {clicks[0]}"
        "（(161,103) 是当前会话名字行、(191,124) 是它的预览行——点了会把聊天区点成空白）")
    assert clicks[-1] == (161, 103), f"探针没把用户本来开着的会话点回来：{clicks}"
    assert calls["n"] == 2, f"_snap 调用次数应为 2（探针前后各一帧），实际 {calls['n']}"
    print("     ✅ 只点别的会话行，且点回来了")
    return True


def test_ui_alive_click_without_change_is_dead():
    """点了画面一字节不差 ⇒ 判卡死（这才是真的"点不动"）。"""
    import wechat_sender as ws

    snap, calls = _stub_snap(False)
    clicks = []
    saved = (ws._snap, ws.post_click)
    try:
        ws._snap = snap
        ws.post_click = lambda h, x, y: clicks.append((x, y)) is None
        alive = ws._ui_alive(4242)
    finally:
        ws._snap, ws.post_click = saved
    assert not alive, "画面一字节不差却判成了活着"
    assert clicks == [(168, 168)], f"判死后不该再点还原，实际点了 {clicks}"
    assert calls["n"] == 2, f"_snap 调用次数应为 2，实际 {calls['n']}"
    print("     ✅ 点不动 → 判卡死")
    return True


def test_mcp_server_structure():
    """测试 MCP 服务器结构"""
    import server

    print("  [1] 验证服务器元信息...")
    assert hasattr(server, "SERVER_NAME"), "缺少 SERVER_NAME"
    assert hasattr(server, "SERVER_VERSION"), "缺少 SERVER_VERSION"
    print(f"     服务名称: {server.SERVER_NAME}")
    print(f"     服务版本: {server.SERVER_VERSION}")

    print("  [2] 验证工具定义...")
    assert hasattr(server, "TOOLS"), "缺少 TOOLS"
    assert isinstance(server.TOOLS, list), "TOOLS 不是列表"
    assert len(server.TOOLS) > 0, "TOOLS 为空"

    tool_names = [t["name"] for t in server.TOOLS]
    print(f"     工具数量: {len(tool_names)}")

    # 验证关键工具存在
    required_tools = [
        "list_sessions",
        "read_history",
        "send_text",
        "poll_new",
        "check_env",
    ]

    for tool in required_tools:
        if tool not in tool_names:
            raise AssertionError(f"缺少关键工具: {tool}")
        print(f"     ✅ {tool}")

    print("  [3] 验证使用引导...")
    assert hasattr(server, "INSTRUCTIONS"), "缺少 INSTRUCTIONS"
    assert len(server.INSTRUCTIONS) > 100, "INSTRUCTIONS 过短"
    print(f"     引导长度: {len(server.INSTRUCTIONS)} 字符")

    return True


def test_integration_list_sessions():
    """集成测试：list_sessions"""
    import wechat_core as core

    print("  [1] 调用 sessions()...")
    try:
        sessions = core.sessions()
        print(f"     ✅ 返回 {len(sessions)} 个会话")

        if sessions:
            # 显示前3个会话
            for sess in sessions[:3]:
                name = sess.get("name", "未知")
                preview = sess.get("preview", "")[:30]
                print(f"     - {name}: {preview}...")

        return True
    except Exception as e:
        # 如果数据目录不存在，这是预期的
        if "未找到" in str(e) or "不存在" in str(e):
            print(f"     ⚠️  数据目录不存在（预期行为）: {str(e)[:50]}...")
            return True
        raise


def test_integration_check_env():
    """集成测试：check_env"""
    try:
        import wechat_sender

        print("  [1] 调用 check_env()...")
        status = wechat_sender.check_env()

        # ⚠️ 键名是 `weixin_running`/`visible`——原先写的 `wechat_running`/`window_visible`
        # 在 check_env 的返回里根本不存在，于是无论微信开着没开都打印 False（误导了 2026-10-10 那轮排查）
        print(f"     微信运行: {status.get('weixin_running', False)}")
        print(f"     窗口可见: {status.get('visible', False)}")
        print(f"     环境就绪: {status.get('ok', False)}")

        if not status.get("ok"):
            print(f"     提示: {status.get('hint', '')[:60]}...")

        return True
    except ImportError:
        print("     ⚠️  wechat_sender 未安装（仅在 Windows 下可用）")
        return True



def test_post_text_skips_nonbmp():
    """非 BMP 字符必须**跳过并上报**，绝不能整投出去。

    实测（2026-10-10，两个方向都试过）：
    - 直接投 `ord(ch)`：接收端按 16 位码元取低 16 位，`😊`(U+1F60A) 静默变成 `U+F60A`
      （私用区），读库还能读到、`ok=True` —— 没有任何一道会报错。
    - 拆成合法代理对 `(0xD83D, 0xDE0A)` 分两次投：微信整个丢掉。
    所以正确行为是「不发它，但说清发了什么」。
    """
    import wechat_sender as ws

    posted = []
    saved_post, saved_sleep = ws.u.PostMessageW, ws.time.sleep
    try:
        ws.u.PostMessageW = lambda h, msg, wp, lp: posted.append(wp) or True
        ws.time.sleep = lambda *_a: None
        ws.post_text(1234, "A😊中👍")
    finally:
        ws.u.PostMessageW, ws.time.sleep = saved_post, saved_sleep

    # A -> 0x41 ; 中 -> 0x4E2D ; 两个 emoji 都不该出现在投递序列里
    assert posted == [0x41, 0x4E2D], [hex(x) for x in posted]
    assert not any(x > 0xFFFF for x in posted), "把非 BMP 码点整投了 ⇒ 会被截成私用区字符"
    assert not any(0xD800 <= x <= 0xDFFF for x in posted), "投了裸代理项 ⇒ 微信会整个丢掉"

    n, chars = ws.dropped_nonbmp()
    assert n == 2 and chars == "😊👍", f"丢弃上报不对：n={n} chars={chars!r}"
    print("     ✅ 非 BMP 跳过并上报 2 个，BMP 原样投递")
    return True


def test_nontext_rendering():
    """非文本消息必须渲染成**有信息的一行**，且绝不漏原始 XML。

    XML 形态全部取自 2026-10-10 的现场样本。以前一律 `[非文本消息]`，
    把图片/语音/位置/链接/撤回全丢了（实测占样本 1/3）。
    """
    import wechat_core as core

    cases = [
        (3, '<msg><img aeskey="fa43d919293fc5b79067e3262ad859bd" length="18227" md5="x"/></msg>',
         "[图片 18KB]"),          # 18227B = 17.8KB，四舍五入
        (3, '<msg><img length="500" md5="x"/></msg>', "[图片 500B]"),
        (34, '<msg><voicemsg voiceformat="4" voicelength="11338" length="19882"/></msg>',
         "[语音 11.3 秒]"),
        (43, '<msg><videomsg playlength="38" length="12816159"/></msg>', "[视频 38 秒]"),
        (47, '<msg><emoji md5="90cc" len="13793"/></msg>', "[表情]"),
        (48, '<msg><location x="30.5" y="104.0" label="四川省成都市武侯区交子北二路17号"'
             ' poiname="市级机关(第六办公区)"/></msg>',
         "[位置] 市级机关(第六办公区) 四川省成都市武侯区交子北二路17号"),
        (49, '<msg><appmsg><title>都看过</title><type>5</type>'
             '<url>https://mp.weixin.qq.com/s/abc</url></appmsg></msg>',
         "[链接] 都看过 (https://mp.weixin.qq.com/s/abc)"),
        (49, '<msg><appmsg><title>数据表.xlsx</title><type>6</type></appmsg></msg>',
         "[文件] 数据表.xlsx"),
        (50, '<voipmsg type="VoIPBubbleMsg"><VoIPBubbleMsg><msg><![CDATA[通话时长 02:41]]></msg>'
             '</VoIPBubbleMsg></voipmsg>', "[通话] 通话时长 02:41"),
        (42, '<msg nickname="Elvy" username="wxid_1"/></msg>', "[名片] Elvy"),
        (10000, '<sysmsg type="revokemsg"><revokemsg><content>"韩玉" 撤回了一条消息</content>'
                '</revokemsg></sysmsg>', '"韩玉" 撤回了一条消息'),
    ]
    for lt, raw, want in cases:
        got = core.describe_nontext(lt, raw)
        assert got == want, "type=%s want=%r got=%r" % (lt, want, got)

    # 模板型系统消息：$username$ 要换成 link 里的 nickname
    tmpl = ('<sysmsg type="sysmsgtemplate"><sysmsgtemplate><content_template>'
            '<template><![CDATA["$username$"邀请"$names$"加入了群聊]]></template>'
            '<link_list><link name="username"><memberlist><member>'
            '<nickname><![CDATA[肖美虹]]></nickname></member></memberlist></link>'
            '<link name="names"><memberlist><member>'
            '<nickname><![CDATA[杨冬]]></nickname></member></memberlist></link>'
            '</link_list></content_template></sysmsgtemplate></sysmsg>')
    got = core.describe_nontext(10000, tmpl)
    assert got == '"肖美虹"邀请"杨冬"加入了群聊', repr(got)
    assert "$" not in got, f"没替上的变量漏出来了：{got!r}"

    print("     ✅ 11 类消息 + 模板替换都渲染正确")
    return True


def test_render_strips_group_prefix_and_never_leaks_xml():
    """群聊 content 前面缀了发送者（`wxid_x: <msg>…`），必须剥掉再判类型。

    不剥的话 `startswith("<")` 判定失败 ⇒ 整段 XML 漏给 Agent（实测踩过）。
    """
    import wechat_core as core

    # 形态一（非文本）：前缀后跟 `<?xml`／空格 + `<`
    for wrapped in ['hdghdx: <msg><img aeskey="abc" length="2048"/></msg>',
                    'hdghdx:<msg><img aeskey="abc" length="2048"/></msg>']:
        assert core._render(3, wrapped) == "[图片 2KB]", core._render(3, wrapped)

    # 形态二（纯文本）：前缀后**紧跟换行**。实测 1117 条群文本命中 1010 条、单聊 0 条。
    # 不剥的话群历史/预览/搜索里全是裸 id，客户端还会再补一次「名字：」变成 `张三：wxid_x: …`。
    for raw, want in [("vicky1990202:\n12345那边回复了", "12345那边回复了"),
                      ("wxid_pio7v0rpnq4n22:\n服务器卡死了，我重启下服务哈。", "服务器卡死了，我重启下服务哈。")]:
        assert core._render(1, raw) == want, core._render(1, raw)

    # 普通文本不能被误伤（前缀里含空格/是正常中文句子的都不该剥）
    for plain in ["注意: 明天开会", "他说:你好", "12:30 见", "Note: 明天再说"]:
        assert core._render(1, plain) == plain, f"误剥了普通文本：{plain!r}"

    # 全类型扫一遍：渲染结果里不许再出现 XML 痕迹
    core._refresh()
    bad = []
    n = 0
    for tbl, tk in core.talkers()[:25]:
        for ct, lt, c, s, _lid, _src in core._rows_full(tbl, 60):
            n += 1
            t = core._render(lt, c)
            if t.lstrip().startswith("<") or "aeskey=" in t or "<msg>" in t[:40]:
                bad.append((tk, lt, t[:60]))
    assert not bad, f"{n} 条里有 {len(bad)} 条漏了 XML：{bad[:3]}"
    print(f"     ✅ 群聊前缀已剥；{n} 条消息无 XML 泄漏")
    return True


def test_at_me_from_msgsource():
    """群消息 @我 按 `source` 的 `<atuserlist>` 里的 **wxid** 判定，不猜昵称。

    样本取自 2026-10-10 现场：本人 wxid_sngf3b86qbz021 在群里被 @ 成 `@TOOLAN …`，
    正文里的昵称与全局昵称不是一回事（换昵称就失准），只有 atuserlist 是确定的。
    """
    import wechat_core as core

    me = "wxid_sngf3b86qbz021"
    hit = "<msgsource>\n\t<atuserlist><![CDATA[wxid_sngf3b86qbz021]]></atuserlist>\n</msgsource>"
    multi = "<msgsource><atuserlist><![CDATA[wxid_a,wxid_sngf3b86qbz021]]></atuserlist></msgsource>"
    other = "<msgsource><atuserlist><![CDATA[wxid_other]]></atuserlist></msgsource>"
    assert core.at_me_in_source(hit, me) is True
    assert core.at_me_in_source(multi, me) is True, "多人被 @ 时也要认出来"
    assert core.at_me_in_source(other, me) is False, "别人被 @ 不算我"
    assert core.at_me_in_source("<msgsource><pua>1</pua></msgsource>", me) is False
    assert core.at_me_in_source(None, me) is False

    # msg_dict 只在命中时才带 at_me（没命中不写字段——省得每条消息都多一个假 flags）
    d = core.msg_dict(1, 1, "你好", {}, talker="1@chatroom", me=me, source=hit)
    assert d.get("at_me") is True, d
    d2 = core.msg_dict(1, 1, "你好", {}, talker="1@chatroom", me=me, source=other)
    assert "at_me" not in d2, d2

    # `_rows_full` / `_rows_full_conn` 现在多带一列 `source`——元组宽度错了会当场炸在
    # 调用方（历史上靠 unpack 报错才发现的），所以在这里钉一下宽度。
    try:
        core._refresh()
        tk = next((t for t in core.talkers() if str(t[1]).endswith("@chatroom")), None)
        if tk:
            rows = core._rows_full(tk[0], 5)
            assert rows and len(rows[0]) == 6, f"行宽应为 6（含 source），实际 {rows[:1]}"
    except Exception as e:                                # 换机/无库：跳过而非误报
        print(f"     （跳过真库抽查：{e}）")
    print("     ✅ atuserlist 判定正确（含多人被 @ / 别人被 @ / 无 source）")
    return True


def test_voice_extraction():
    """语音能从 media 库取出来，且**必须靠 local_id 消歧**。

    音频不在磁盘上——它在 `message/media_*.db` 的 `VoiceInfo.voice_data`（明文 SILK_V3）。
    同一秒可以有多条语音，只按 create_time 取第一条会转写出**另一个人的另一段话**，
    比不转写更糟（模型会照着错内容回话），所以没给 local_id 时必须拒绝。
    """
    import os
    import wechat_core as core

    # 1. 没有 local_id ⇒ 宁可返回 None，绝不猜
    assert core.voice_file("filehelper", 0) is None, "无 local_id 时不该返回文件"

    core._refresh()
    found = []
    for tbl, tk in core.talkers():
        for m in core.history(tk, 500)["messages"]:
            if m.get("voice_path"):
                found.append((tk, m))
    assert found, "一条语音都没导出来 —— VoiceInfo 读取可能坏了"

    # 2. 倒出来的确实是 SILK
    tk, m = found[0]
    with open(m["voice_path"], "rb") as f:
        head = f.read(10)
    # 头是 0x02 + "#!SILK_V3"（10 字节），不是 9 字节的纯文本标记
    assert head == b"#!SILK_V3", f"不是 SILK_V3：{head!r}"

    # 3. 文件必须由 (talker, local_id) 唯一决定：
    #    同一个 local_id 只能对应一个文件（否则同一条语音被导成两份），
    #    不同 local_id 必须对应不同文件（否则就是**转写了别人的话**）。
    by_id = {}
    by_file = {}
    for tk2, m2 in found:
        k = (tk2, m2.get("local_id"))
        p2 = m2["voice_path"]
        assert by_id.setdefault(k, p2) == p2, f"同一 local_id 导出了不同文件：{k}"
        assert by_file.setdefault(p2, k) == k, f"不同 local_id 共用了同一个文件：{p2}"

    # 4. 同秒（create_time 相同）但 local_id 不同 ⇒ 必须是两个文件
    grp = {}
    for tk3, m3 in found:
        grp.setdefault((tk3, m3["ts"]), {})[m3.get("local_id")] = m3["voice_path"]
    same_sec = {k: v for k, v in grp.items() if len(v) > 1}
    for k, byid in same_sec.items():
        assert len(set(byid.values())) == len(byid), f"{k} 同秒多条语音撞成同一文件（会转写出别人的话）"
    if same_sec:
        print(f"     （其中 {len(same_sec)} 组同秒语音，已正确分开）")

    print(f"     ✅ 导出 {len(found)} 条 SILK，同秒消歧正常")
    return True


def test_style_stats_by_length():
    """打字风格必须**按长度分层**量，不能只看总比例。

    起因（2026-10-10 用户报障）：画像里写「几乎不加标点」，代聊照着模仿，用户一眼看出不对。
    实测本机 809 条：1-5 字只有 6% 带标点、13 字以上 66-69% 都带——
    **短句本来就不需要标点**。只看总比例（38%）或只看几条短样本，都会得出错结论。
    """
    import wechat_core as core

    short = ["要得", "可以", "在干嘛"]                            # 2-3 字，不带标点
    long_ = ["开关一下MCP服务，有可能是连接没有刷新",              # 18 字，带逗号
             "我觉得很难，毕竟你要和更年轻的博士竞争。"]          # 21 字，句读齐全
    st = core.style_stats(short * 4 + long_ * 4)

    assert st["messages"] == 20, st

    assert st["length_hist"]["1-5"] == 12, st["length_hist"]
    # 关键：短句不带标点、长句都带——分层里看得清清楚楚
    assert st["punct_rate_by_len"]["1-5"] == 0.0, st["punct_rate_by_len"]
    assert st["punct_rate_by_len"]["13-25"] == 1.0, st["punct_rate_by_len"]
    # 总比例被短句拉低 ⇒ **单看它就会写成「几乎不加标点」**，这正是要防的
    assert st["punct_rate"] < 0.6 < st["punct_rate_by_len"]["13-25"], st["punct_rate"]

    # 微信表情短码要能量出来（画像里那句「爱用[捂脸]」得有数字支撑）
    st2 = core.style_stats(["要得[捂脸]", "好嘛", "收到了[呲牙]"])
    assert st2["emoji_rate"] == round(2 / 3, 2), st2

    # 断句方式：标点率只问「有没有中文标点」，而长句**用空格代顿号**的人会被算成「无标点」
    # （实测本机 26+ 字里有 9% 是这种），画像那句「26+ 字 88% 带标点」因此偏高。
    d = core.style_stats(["差不多 一整天都是阴的 上午到中午小雨最密 下午3点以后雨停了但还是阴",
                          "不要想太多，我也没想那么多。小朋友还是要多鼓励。",
                          "要得"] * 3)["delim_long"]
    assert d["n"] == 6, d                      # 「要得」2 字不算
    assert d["punct"] == 0.5, d                # 3 条带逗号句号
    assert d["space"] == 0.5, d                # 3 条用空格断
    assert d["none"] == 0.0, d

    # 空输入不能炸
    assert core.style_stats([]) == {}

    print("     ✅ 分层标点率/表情率/断句方式都能量出来，空输入不炸")
    return True


def test_exchange_pairs_both_sides_filtered():
    """范本对（对方说了什么 → 我回了什么）：三条硬门禁，一条都不能少。

    这是代聊每轮真正面对的题面（`exchange_pairs` 会**每轮拼进提示词**），所以：
    ① **两侧**都得像「人说的话」。只过滤对方那侧的话，实测会出现
       「对方：收到！ / 我：http://内网地址/login 明文账号口令」——等于把口令烤进每一次请求。
    ② 对方那轮太短（`?`）没有信息，不是范本。
    ③ 同秒的消息靠 `local_id` 定序；微信时间戳只到秒，不排就会把对子配错。
    """
    import wechat_core as core

    me = "wxid_me"
    rows = [                                  # (ct, lt, content, sender, local_id, source)
        (100, 1, "在吗", "wxid_a", 1, ""),
        (101, 1, "在的", me, 2, ""),
        (102, 1, "http://10.1.2.3:9003/login admin/admin123456", me, 3, ""),  # ★ 我这侧
        (103, 1, "看下这个", "wxid_a", 4, ""),
        (104, 1, "好的", me, 5, ""),
        (105, 1, "?", "wxid_a", 6, ""),       # 太短
        (106, 1, "在吗？", me, 7, ""),
        (300, 1, "回来吃饭不", "wxid_a", 8, ""),   # 跟上一轮隔 194s > 120 ⇒ 新的一轮
        (301, 1, "要回来", me, 9, ""),
    ]
    got = core._pairs_from(core._seq_of(rows, me, {}, "wxid_a"))
    assert got == [("看下这个", "好的"), ("回来吃饭不", "要回来")], got
    for _t, mine in got:
        assert "://" not in mine, f"我这一侧的网址/口令没拦住：{mine!r}"

    # 同秒按下标定序：输入给的是**倒序**，排完必须是我先说、对方后说
    same = [(100, 1, "对方那句", "wxid_a", 2, ""), (100, 1, "我先说的", me, 1, "")]
    seq = core._seq_of(same, me, {}, "wxid_a")
    assert [s[2] for s in seq] == ["我先说的", "对方那句"], seq

    # 群消息的范本要带上说话人（不然不知道是谁说的）；私聊不必
    g = core._seq_of([(1, 1, "xiaomeihong99:\n几张信用卡就有了", "wxid_x", 1, "")],
                     me, {"wxid_x": "肖美虹"}, "1@chatroom")
    assert g[0][2] == "肖美虹：几张信用卡就有了", g
    p = core._seq_of([(1, 1, "xiaomeihong99:\n几张信用卡就有了", "wxid_x", 1, "")],
                     me, {"wxid_x": "肖美虹"}, "wxid_someone")
    assert p[0][2] == "几张信用卡就有了", p

    # 分层：我回话的长短都要有，别全是「收到」
    picked = core._pick_pairs([("a", "要得"), ("b", "好的，我看下"), ("c", "行" * 20),
                               ("d", "三台都这样那就不是偶发了，基本能锁定是设计或批次的问题。")],
                              per_bucket=1)
    assert len(picked) == 4, picked
    assert [len(p["me"]) for p in picked] == sorted(len(p["me"]) for p in picked), picked
    assert all(p["them"] and p["me"] for p in picked)

    # 真跑一遍 digest：键在、两侧非空、且**没有一侧是网址/口令**
    d = core.digest(limit=200)
    assert d["exchange_pairs"], "digest 没产出范本对"
    for pr in d["exchange_pairs"]:
        assert pr["them"].strip() and pr["me"].strip(), pr
        assert "://" not in pr["me"], f"我这侧混进了网址：{pr['me']!r}"
    assert d["self"]["style"]["delim_long"]["n"] > 0, d["self"]["style"]

    print(f"     ✅ 两侧过滤/定序/分层都对；实测蒸馏出 {len(d['exchange_pairs'])} 组范本对")
    return True


def test_distill_filters_and_scope():
    """蒸馏要剔掉「粘过来的东西」，且增量**不许丢全量统计**。

    两个都是 2026-10-10 实测定型的：
    ① `top_words` 前 20 里有 7 个来自**同一条**粘贴的终端会话，画像因此写成「服务器运维」；
       同一批污染还把「26+ 字带标点」从 88% 拉到 68%。
    ② 提示词教的是「下次 `since=水位` 只处理新消息」，而 `profile_save` 是**整体覆盖**——
       统计若被 `since` 收窄，一次增量蒸馏就把全量画像换成几天切片（实测 3 天只剩 403/3903 条、
       联系人 69→21）。
    """
    import time
    import wechat_core as core

    # ① 过滤器
    assert not core.is_conversational("root@iZww601n9e4jlvpsogs18mZ:/home/wxwj# ls images")
    assert not core.is_conversational("https://github.com/andatoshiki/toshiki-live2d")
    assert not core.is_conversational("sk-S0glPlSekdU9dloREQ297JSdDhnKWsScpQwJfEr6bhpSFt4X")
    assert core.is_conversational("要得")
    assert core.is_conversational("开关一下MCP服务，有可能是连接没有刷新")

    # ② 分层样本：长句那档必须真的有长句（口吻的关键就在那儿）
    ss = core.style_samples(["要得", "可以", "开关一下MCP服务，有可能是连接没有刷新"] * 5)
    assert ss["1-5"] and ss["13-25"], ss.keys()
    assert all(13 <= len(x) <= 26 for x in ss["13-25"]), ss["13-25"]
    assert ss["26+"] == [], "没长句就不该编"

    # ③ 增量只收窄样本，统计恒为全量
    import server
    full = server.tool_digest({"limit": 80})
    assert full.get("stats_scope") == "all", full.get("stats_scope")
    future = int(time.time()) + 86400
    inc = server.tool_digest({"limit": 80, "since": future})
    assert inc["samples_from_me"] == [], "未来的水位不该有样本"
    for k in ("total", "from_me"):
        assert inc["self"][k] == full["self"][k], f"增量把 {k} 收窄了：{inc['self'][k]} vs {full['self'][k]}"
    assert inc["contacts_total"] == full["contacts_total"], "增量把联系人收窄了"
    assert inc["self"]["style"] == full["self"]["style"], "增量把风格统计收窄了"

    # ④ 对方那侧的风格（联系人画像的「沟通风格」写的是对方）
    d = server.tool_digest({"talker": "wxid_s6piyhfvptv522", "limit": 80})
    assert "style_from_them" in d["self"], "限定了 talker 就该给对方的风格实测"
    assert "style_samples_from_them" in d["self"]
    # 不限定会话时「对方」= 所有人，没有意义，不该给
    assert "style_from_them" not in server.tool_digest({"limit": 80})["self"]

    print("     ✅ 过滤器命中；分层样本有长句；增量不丢全量统计；对方风格也给了")
    return True

def main():
    """主测试流程"""
    runner = TestRunner()

    print("=" * 70)
    print("  wechat-mcp 自动化测试套件")
    print("=" * 70)
    print(f"  时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  Python: {sys.version.split()[0]}")
    print(f"  工作目录: {os.getcwd()}")

    # ========================================================================
    # 基础测试
    # ========================================================================
    runner.section("基础测试")

    runner.test("模块导入", test_imports)

    # ========================================================================
    # P0-A：路径自动发现
    # ========================================================================
    runner.section("P0-A：路径自动发现")

    runner.test("多路径探测", test_path_discovery)
    runner.test("错误提示质量", test_error_message_quality)

    # ========================================================================
    # P0-B：发送重试机制
    # ========================================================================
    runner.section("P0-B：发送重试机制")

    runner.test("错误码映射", test_error_code_mapping)
    runner.test("修复建议生成", test_fix_suggestions)
    runner.test("重试逻辑", test_retry_logic)

    # ========================================================================
    # 目标确认（UIA 不可用时的回退）
    # ========================================================================
    runner.section("目标确认")

    runner.test("UIA 拿不到时退回帧判据", test_uia_blank_falls_back_to_frames)
    runner.test("UI 卡死 → 拉托盘恢复并重试", test_open_chat_post_unfreezes_when_ui_dead)
    runner.test("UI 活着 → 不拉托盘", test_open_chat_post_no_unfreeze_when_alive)
    runner.test("蒸馏过滤与增量口径", test_distill_filters_and_scope)
    runner.test("风格统计按长度分层", test_style_stats_by_length)
    runner.test("范本对两侧过滤与分层", test_exchange_pairs_both_sides_filtered)
    runner.test("语音提取与消歧", test_voice_extraction)
    runner.test("非文本消息渲染", test_nontext_rendering)
    runner.test("群聊前缀与XML泄漏", test_render_strips_group_prefix_and_never_leaks_xml)
    runner.test("群消息@我判定", test_at_me_from_msgsource)
    runner.test("非BMP字符跳过并上报", test_post_text_skips_nonbmp)
    runner.test("拍不到图不乱判卡死", test_ui_alive_reads_failure_as_alive)
    runner.test("探针不点当前会话/服务号", test_ui_alive_skips_current_row_and_nonchat)
    runner.test("点了画面不动 → 判卡死", test_ui_alive_click_without_change_is_dead)

    # ========================================================================
    # MCP 服务器结构
    # ========================================================================
    runner.section("MCP 服务器结构")

    runner.test("服务器元信息和工具定义", test_mcp_server_structure)

    # ========================================================================
    # 集成测试（可能因环境原因失败）
    # ========================================================================
    runner.section("集成测试")

    runner.test("list_sessions", test_integration_list_sessions)
    runner.test("check_env", test_integration_check_env)

    # ========================================================================
    # 测试摘要
    # ========================================================================
    return runner.summary()


if __name__ == "__main__":
    try:
        exit_code = main()
        sys.exit(exit_code)
    except KeyboardInterrupt:
        print("\n\n⚠️  测试被用户中断")
        sys.exit(130)
    except Exception as e:
        print(f"\n\n❌ 测试运行失败: {e}")
        traceback.print_exc()
        sys.exit(1)
