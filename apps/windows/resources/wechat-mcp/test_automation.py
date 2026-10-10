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
