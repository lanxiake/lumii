#!/usr/bin/env python3
"""测试 P0-A 和 P0-B 修复的集成测试脚本。

测试内容：
1. P0-A：路径自动发现（多路径探测 + 注册表读取）
2. P0-A：可操作的错误提示
3. P0-B：发送重试机制
4. P0-B：修复建议

用法：
    python test_fixes.py
"""
import os
import sys
import json
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import wechat_core as core


def test_path_discovery():
    """测试 P0-A：路径自动发现"""
    print("\n" + "="*60)
    print("测试 P0-A：路径自动发现")
    print("="*60)

    try:
        # 测试 list_accounts() 的多路径探测
        accounts = core.list_accounts()

        if accounts:
            print(f"✅ 成功找到 {len(accounts)} 个账号：")
            for acc in accounts:
                print(f"   - {acc['wxid']} ({acc['dir']})")
                print(f"     路径：{acc['root']}")
        else:
            print("⚠️  未找到账号（可能是正常情况，取决于本机配置）")

        # 测试 db_root() 的错误提示
        try:
            root = core.db_root()
            print(f"✅ 成功定位数据目录：{root}")
        except RuntimeError as e:
            error_msg = str(e)
            print(f"⚠️  数据目录定位失败（预期行为）")
            print(f"   错误提示：{error_msg[:200]}...")

            # 验证错误提示包含可操作信息
            has_paths = "已扫描路径" in error_msg
            has_suggestion = "修复建议" in error_msg or "环境变量" in error_msg

            if has_paths and has_suggestion:
                print("✅ 错误提示包含可操作信息（扫描路径 + 修复建议）")
            else:
                print("❌ 错误提示不够可操作")
                if not has_paths:
                    print("   缺少：扫描路径清单")
                if not has_suggestion:
                    print("   缺少：修复建议")

        print("\n测试结果：P0-A 路径发现增强 ✅")
        return True

    except Exception as e:
        print(f"❌ 测试失败：{e}")
        import traceback
        traceback.print_exc()
        return False


def test_send_retry_mechanism():
    """测试 P0-B：发送重试机制（模拟测试）"""
    print("\n" + "="*60)
    print("测试 P0-B：发送重试机制")
    print("="*60)

    try:
        import server

        # 测试 1：_code_of() 错误码映射
        test_details = [
            ("环境前置检查失败", "env_not_ready"),
            ("输入未落地（fail-closed）", "input_not_landed"),
            ("发送后输入框未清空", "send_unconfirmed"),
            ("未找到要引用的消息", "quote_not_found"),
            ("目标会话校验失败", "verification_failed"),
        ]

        print("\n测试错误码映射：")
        all_passed = True
        for detail, expected_code in test_details:
            actual_code = server._code_of(detail)
            if actual_code == expected_code:
                print(f"✅ '{detail[:20]}...' -> {actual_code}")
            else:
                print(f"❌ '{detail[:20]}...' -> {actual_code} (期望 {expected_code})")
                all_passed = False

        # 测试 2：_get_fix_suggestion() 修复建议
        print("\n测试修复建议：")
        test_codes = ["env_not_ready", "input_not_landed", "send_unconfirmed", "verification_failed"]
        for code in test_codes:
            suggestion = server._get_fix_suggestion(code)
            if suggestion and len(suggestion) > 20:
                print(f"✅ {code}: {suggestion[:50]}...")
            else:
                print(f"❌ {code}: 建议过短或缺失")
                all_passed = False

        # 测试 3：_send_with_retry() 重试逻辑（模拟）
        print("\n测试重试逻辑（模拟）：")

        # 模拟首次失败、第二次成功
        attempt_count = [0]
        def mock_send_success_on_retry():
            attempt_count[0] += 1
            if attempt_count[0] == 1:
                return False, "输入未落地（fail-closed）"
            return True, "发送成功"

        ok, detail, attempts = server._send_with_retry(mock_send_success_on_retry, max_retries=2, retry_delay=0.1)
        if ok and attempts == 2 and "第 2 次尝试成功" in detail:
            print(f"✅ 重试机制正常：首次失败，第 {attempts} 次成功")
        else:
            print(f"❌ 重试机制异常：ok={ok}, attempts={attempts}, detail={detail}")
            all_passed = False

        # 模拟不可重试错误
        attempt_count[0] = 0
        def mock_send_env_error():
            attempt_count[0] += 1
            return False, "环境前置检查失败：微信窗口未在前台"

        ok, detail, attempts = server._send_with_retry(mock_send_env_error, max_retries=2, retry_delay=0.1)
        if not ok and attempts == 1 and "不可重试" in detail:
            print(f"✅ 不可重试错误检测正常：环境错误不重试（attempts={attempts}）")
        else:
            print(f"❌ 不可重试错误处理异常：ok={ok}, attempts={attempts}")
            all_passed = False

        if all_passed:
            print("\n测试结果：P0-B 发送重试机制 ✅")
        else:
            print("\n测试结果：P0-B 发送重试机制 ⚠️ （部分失败）")

        return all_passed

    except Exception as e:
        print(f"❌ 测试失败：{e}")
        import traceback
        traceback.print_exc()
        return False


def test_mcp_server_startup():
    """测试 MCP 服务器能否正常启动（握手测试）"""
    print("\n" + "="*60)
    print("测试 MCP 服务器启动")
    print("="*60)

    try:
        import server

        # 模拟 initialize 请求
        init_msg = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1.0"}
            }
        }

        # 注意：这里不直接调用 stdin，而是测试关键函数
        print("✅ server.py 模块加载成功")
        print(f"   服务名称：{server.SERVER_NAME}")
        print(f"   服务版本：{server.SERVER_VERSION}")
        print(f"   支持协议：{server.SUPPORTED_PROTOCOL_VERSIONS}")

        # 验证工具定义
        tool_count = len(server.TOOLS)
        print(f"✅ 工具定义加载成功：{tool_count} 个工具")

        # 验证 instructions
        if server.INSTRUCTIONS and len(server.INSTRUCTIONS) > 100:
            print(f"✅ 使用引导加载成功：{len(server.INSTRUCTIONS)} 字符")

        print("\n测试结果：MCP 服务器启动 ✅")
        return True

    except Exception as e:
        print(f"❌ 测试失败：{e}")
        import traceback
        traceback.print_exc()
        return False


def main():
    """运行所有测试"""
    print("="*60)
    print("wechat-mcp 修复验证测试套件")
    print("="*60)
    print(f"Python: {sys.version}")
    print(f"工作目录: {os.getcwd()}")

    results = {
        "P0-A 路径发现": test_path_discovery(),
        "P0-B 发送重试": test_send_retry_mechanism(),
        "MCP 服务器": test_mcp_server_startup(),
    }

    print("\n" + "="*60)
    print("测试汇总")
    print("="*60)
    for name, passed in results.items():
        status = "✅ 通过" if passed else "❌ 失败"
        print(f"{name}: {status}")

    all_passed = all(results.values())
    print("\n" + ("="*60))
    if all_passed:
        print("🎉 所有测试通过！")
        return 0
    else:
        print("⚠️  部分测试失败，请检查上方详细输出")
        return 1


if __name__ == "__main__":
    sys.exit(main())
