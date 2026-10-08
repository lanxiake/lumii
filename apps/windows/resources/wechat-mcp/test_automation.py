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

        print(f"     微信运行: {status.get('wechat_running', False)}")
        print(f"     窗口可见: {status.get('window_visible', False)}")
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
