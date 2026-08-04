"""MtBot Windows CLI 入口。

cli-anything harness 主程序：同时支持一次性子命令和交互式 REPL。
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

import click

from cli_anything.mtbot_windows.core.app import get_app_status, reset_app_data, start_app, stop_app
from cli_anything.mtbot_windows.core.conversation import (
    abort_conversation,
    create_conversation,
    list_conversations,
    send_message,
)
from cli_anything.mtbot_windows.core.gateway import GatewayClient, create_gateway_client
from cli_anything.mtbot_windows.core.project import load_project, new_project, project_info, save_project
from cli_anything.mtbot_windows.core.session import Session, default_session_path
from cli_anything.mtbot_windows.core.skills import (
    execute_skill,
    install_skill_from_directory,
    list_skills,
    set_skill_enabled,
)
from cli_anything.mtbot_windows.utils.mtbot_windows_backend import MtBotWindowsBackend
from cli_anything.mtbot_windows.utils.repl_skin import ReplSkin


class CliContext:
    """Click 上下文对象，承载 session、backend、gateway client 等共享状态。"""

    def __init__(self) -> None:
        self.json_mode = False
        self.dry_run = False
        self.repl_mode = False
        self.session_path: str = default_session_path()
        self.session: Session | None = None
        self.backend: MtBotWindowsBackend | None = None
        self.gateway: GatewayClient | None = None
        self.skin = ReplSkin("mtbot_windows", version="1.0.0")

    def ensure_session(self) -> Session:
        if self.session is None:
            if os.path.exists(self.session_path):
                self.session = load_project(self.session_path)
            else:
                self.session = Session(path=self.session_path)
        return self.session

    def ensure_backend(self) -> MtBotWindowsBackend:
        if self.backend is None:
            self.backend = MtBotWindowsBackend()
        return self.backend

    def ensure_gateway(self) -> GatewayClient:
        if self.gateway is None:
            self.gateway = create_gateway_client(backend=self.ensure_backend())
        return self.gateway

    def output(self, data: Any) -> None:
        """根据模式输出人类可读或 JSON 结果。"""
        if self.json_mode:
            click.echo(json.dumps(data, ensure_ascii=False, indent=2))
        else:
            self._pretty_output(data)

    def _pretty_output(self, data: Any) -> None:
        if isinstance(data, dict):
            for key, value in data.items():
                self.skin.status(str(key), str(value))
        elif isinstance(data, list):
            for item in data:
                click.echo(f"  - {item}")
        else:
            click.echo(str(data))

    def save_session(self) -> None:
        if self.session is not None and self.session.data.get("modified"):
            self.session.save()


pass_context = click.make_pass_decorator(CliContext, ensure=True)


def _success(ctx: CliContext, message: str) -> None:
    if not ctx.json_mode:
        ctx.skin.success(message)


def _error(ctx: CliContext, message: str) -> None:
    if ctx.json_mode:
        click.echo(json.dumps({"error": message}, ensure_ascii=False), err=True)
    else:
        ctx.skin.error(message)


@click.group(invoke_without_command=True)
@click.option("--json", "json_mode", is_flag=True, help="输出 JSON 格式（供 AI agent 解析）。")
@click.option("--project", "project_path", default=None, help="项目/会话文件路径。")
@click.option("--app-dir", default=None, help="MtBot Windows 应用目录。")
@click.option("--app-exe", default=None, help="MtBot Windows 可执行文件路径。")
@click.option("--dry-run", is_flag=True, help="执行命令但不保存会话更改。")
@click.pass_context
def cli(
    click_ctx: click.Context,
    json_mode: bool,
    project_path: str | None,
    app_dir: str | None,
    app_exe: str | None,
    dry_run: bool,
) -> None:
    """MtBot Windows 命令行 harness。

    不指定子命令时进入交互式 REPL。
    """
    ctx = click_ctx.ensure_object(CliContext)
    ctx.json_mode = json_mode
    ctx.dry_run = dry_run
    if project_path:
        ctx.session_path = project_path
    ctx.backend = MtBotWindowsBackend(app_dir=app_dir, exe_path=app_exe)

    def _auto_save() -> None:
        if ctx.repl_mode or ctx.dry_run:
            return
        if ctx.session is not None and ctx.session.data.get("modified"):
            try:
                ctx.session.save()
            except Exception as e:
                click.echo(f"警告：自动保存失败: {e}", err=True)

    click_ctx.call_on_close(_auto_save)

    if click_ctx.invoked_subcommand is None:
        ctx.repl_mode = True
        click_ctx.invoke(repl)


@cli.command("repl")
@pass_context
def repl(ctx: CliContext) -> None:
    """进入交互式 REPL。"""
    ctx.skin.print_banner()
    session = ctx.ensure_session()
    pt_session = ctx.skin.create_prompt_session()

    commands_help = {
        "app start": "启动 MtBot Windows 应用",
        "app stop": "停止应用",
        "app status": "查看应用状态",
        "gateway connect": "连接 Gateway",
        "gateway disconnect": "断开 Gateway",
        "gateway health": "检查网关健康状态",
        "project new -o PATH": "创建新项目",
        "project info": "查看项目信息",
        "conversation list": "列出对话",
        "conversation send": "发送消息",
        "skills list": "列出技能",
        "help": "显示命令帮助",
        "quit": "退出 REPL",
    }

    while True:
        try:
            line = ctx.skin.get_input(
                pt_session,
                project_name=os.path.basename(session.path or ""),
                modified=session.data.get("modified", False),
                context="connected" if ctx.gateway and ctx.gateway.is_connected() else "disconnected",
            )
        except (EOFError, KeyboardInterrupt):
            break

        line = line.strip()
        if not line:
            continue
        if line in ("quit", "exit", "q"):
            break
        if line == "help":
            ctx.skin.help(commands_help)
            continue

        # 解析简单命令并委托给 Click
        parts = line.split()
        try:
            cli(parts, standalone_mode=False, obj=ctx)
        except click.ClickException as e:
            _error(ctx, str(e))
        except SystemExit:
            pass
        except Exception as e:
            _error(ctx, f"执行失败: {e}")

    ctx.save_session()
    ctx.skin.print_goodbye()


# ── Project ─────────────────────────────────────────────────────────

@cli.group("project")
@pass_context
def project_group(ctx: CliContext) -> None:
    """项目/会话管理。"""


@project_group.command("new")
@click.option("-o", "--output", required=True, help="输出项目文件路径。")
@click.option("--overwrite", is_flag=True, help="覆盖已存在文件。")
@pass_context
def project_new(ctx: CliContext, output: str, overwrite: bool) -> None:
    """创建新项目文件。"""
    result = new_project(output, overwrite=overwrite)
    ctx.session_path = output
    ctx.session = None
    _success(ctx, f"项目已创建: {result['path']}")
    ctx.output(result)


@project_group.command("info")
@pass_context
def project_info_cmd(ctx: CliContext) -> None:
    """查看当前项目信息。"""
    session = ctx.ensure_session()
    ctx.output(project_info(session))


@project_group.command("save")
@pass_context
def project_save(ctx: CliContext) -> None:
    """保存当前项目。"""
    session = ctx.ensure_session()
    result = save_project(session)
    _success(ctx, f"项目已保存: {result['path']}")
    ctx.output(result)


# ── App ─────────────────────────────────────────────────────────────

@cli.group("app")
@pass_context
def app_group(ctx: CliContext) -> None:
    """应用生命周期管理。"""


@app_group.command("start")
@click.option("--hidden", is_flag=True, help="隐藏窗口启动。")
@click.option("--no-test-mode", is_flag=True, help="不启用测试模式（单实例锁生效）。")
@click.option("--wait-ready", is_flag=True, help="等待进程稳定。")
@click.option("--wait-timeout", default=10.0, help="等待超时秒数。")
@click.option("--extra-arg", multiple=True, help="额外传递给 Electron 的参数。")
@pass_context
def app_start(
    ctx: CliContext,
    hidden: bool,
    no_test_mode: bool,
    wait_ready: bool,
    wait_timeout: float,
    extra_arg: tuple[str, ...],
) -> None:
    """启动 MtBot Windows 应用。"""
    backend = ctx.ensure_backend()
    result = start_app(
        backend,
        hidden=hidden,
        test_mode=not no_test_mode,
        wait_ready=wait_ready,
        wait_timeout=wait_timeout,
        extra_args=list(extra_arg),
    )
    session = ctx.ensure_session()
    session.set_app_info(
        {
            "running": True,
            "pid": result.get("pid"),
            "app_dir": result.get("app_dir"),
            "exe_path": result.get("exe_path"),
        }
    )
    _success(ctx, f"应用已启动 (pid={result['pid']})")
    ctx.output(result)


@app_group.command("stop")
@pass_context
def app_stop_cmd(ctx: CliContext) -> None:
    """停止 MtBot Windows 应用。"""
    backend = ctx.ensure_backend()
    result = stop_app(backend)
    session = ctx.ensure_session()
    session.set_app_info({"running": False, "pid": None})
    _success(ctx, "应用已停止")
    ctx.output(result)


@app_group.command("status")
@pass_context
def app_status(ctx: CliContext) -> None:
    """查看应用状态。"""
    backend = ctx.ensure_backend()
    ctx.output(get_app_status(backend))


@app_group.command("reset")
@click.confirmation_option(prompt="确定要重置所有客户端数据吗？此操作不可恢复。")
@pass_context
def app_reset(ctx: CliContext) -> None:
    """重置客户端数据（危险）。"""
    backend = ctx.ensure_backend()
    result = reset_app_data(backend)
    _success(ctx, "客户端数据已重置")
    ctx.output(result)


# ── Gateway ─────────────────────────────────────────────────────────

@cli.group("gateway")
@pass_context
def gateway_group(ctx: CliContext) -> None:
    """Gateway WebSocket 连接管理。"""


@gateway_group.command("connect")
@click.option("--url", default=None, help="Gateway WebSocket URL。")
@click.option("--token", default=None, help="认证 token。")
@click.option("--timeout", default=10.0, help="握手超时秒数。")
@pass_context
def gateway_connect(ctx: CliContext, url: str | None, token: str | None, timeout: float) -> None:
    """连接 Gateway。"""
    gateway = ctx.ensure_gateway()
    if url:
        gateway.url = url
    if token:
        gateway.token = token
    result = gateway.connect(timeout=timeout)
    session = ctx.ensure_session()
    session.set_gateway_info({"connected": True, "url": gateway.url, "token": gateway.token})
    _success(ctx, f"已连接到 Gateway: {gateway.url}")
    ctx.output(result)


@gateway_group.command("disconnect")
@pass_context
def gateway_disconnect(ctx: CliContext) -> None:
    """断开 Gateway 连接。"""
    if ctx.gateway:
        result = ctx.gateway.disconnect()
        session = ctx.ensure_session()
        session.set_gateway_info({"connected": False})
        _success(ctx, "已断开 Gateway")
        ctx.output(result)
    else:
        _error(ctx, "当前没有 Gateway 连接")


@gateway_group.command("status")
@pass_context
def gateway_status(ctx: CliContext) -> None:
    """查看 Gateway 连接状态。"""
    if ctx.gateway:
        ctx.output({"connected": ctx.gateway.is_connected(), "url": ctx.gateway.url})
    else:
        ctx.output({"connected": False, "url": None})


@gateway_group.command("health")
@click.option("--timeout", default=10.0, help="等待超时秒数。")
@pass_context
def gateway_health(ctx: CliContext, timeout: float) -> None:
    """检查 Gateway 健康状态（TCP 端口可连接）。"""
    backend = ctx.ensure_backend()
    result = backend.wait_for_gateway(timeout=timeout)
    ctx.output(result)


@gateway_group.command("call")
@click.argument("method")
@click.argument("params", required=False)
@click.option("--timeout", default=30.0, help="调用超时秒数。")
@pass_context
def gateway_call(ctx: CliContext, method: str, params: str | None, timeout: float) -> None:
    """调用 Gateway RPC 方法。PARAMS 为 JSON 字符串。"""
    gateway = ctx.ensure_gateway()
    if not gateway.is_connected():
        _error(ctx, "未连接到 Gateway，请先执行 gateway connect")
        return
    parsed = json.loads(params) if params else {}
    result = gateway.call(method, parsed, timeout=timeout)
    ctx.output(result)


# ── Conversation ────────────────────────────────────────────────────

@cli.group("conversation")
@pass_context
def conversation_group(ctx: CliContext) -> None:
    """对话/会话管理。"""


@conversation_group.command("list")
@pass_context
def conversation_list(ctx: CliContext) -> None:
    """列出对话会话。"""
    gateway = ctx.ensure_gateway()
    ctx.output(list_conversations(gateway))


@conversation_group.command("create")
@click.option("--title", default=None, help="会话标题。")
@pass_context
def conversation_create(ctx: CliContext, title: str | None) -> None:
    """创建新对话会话。"""
    gateway = ctx.ensure_gateway()
    ctx.output(create_conversation(gateway, title=title))


@conversation_group.command("send")
@click.option("--session-key", required=True, help="会话 Key。")
@click.option("--message", "-m", required=True, help="消息内容。")
@click.option("--wait-final", is_flag=True, help="等待最终响应。")
@click.option("--timeout", default=60.0, help="等待超时秒数。")
@pass_context
def conversation_send(
    ctx: CliContext, session_key: str, message: str, wait_final: bool, timeout: float
) -> None:
    """向指定会话发送消息。"""
    gateway = ctx.ensure_gateway()
    ctx.output(send_message(gateway, session_key, message, wait_final=wait_final, timeout=timeout))


@conversation_group.command("abort")
@click.option("--session-key", required=True, help="会话 Key。")
@pass_context
def conversation_abort(ctx: CliContext, session_key: str) -> None:
    """中断当前会话生成。"""
    gateway = ctx.ensure_gateway()
    ctx.output(abort_conversation(gateway, session_key))


# ── Skills ──────────────────────────────────────────────────────────

@cli.group("skills")
@pass_context
def skills_group(ctx: CliContext) -> None:
    """技能管理。"""


@skills_group.command("list")
@pass_context
def skills_list(ctx: CliContext) -> None:
    """列出本地已安装技能。"""
    gateway = ctx.ensure_gateway()
    ctx.output(list_skills(gateway))


@skills_group.command("install")
@click.argument("directory")
@pass_context
def skills_install(ctx: CliContext, directory: str) -> None:
    """从目录安装技能。"""
    gateway = ctx.ensure_gateway()
    ctx.output(install_skill_from_directory(gateway, directory))


@skills_group.command("execute")
@click.argument("skill_id")
@click.option("--args", default="{}", help="技能参数 JSON。")
@click.option("--session-key", default=None, help="关联会话 Key。")
@pass_context
def skills_execute(ctx: CliContext, skill_id: str, args: str, session_key: str | None) -> None:
    """执行技能。"""
    gateway = ctx.ensure_gateway()
    parsed = json.loads(args)
    ctx.output(execute_skill(gateway, skill_id, args=parsed, session_key=session_key))


@skills_group.command("enable")
@click.argument("skill_id")
@click.option("--disable", is_flag=True, help="禁用而非启用。")
@pass_context
def skills_enable(ctx: CliContext, skill_id: str, disable: bool) -> None:
    """启用/禁用技能。"""
    gateway = ctx.ensure_gateway()
    ctx.output(set_skill_enabled(gateway, skill_id, enabled=not disable))


# ── System ──────────────────────────────────────────────────────────

@cli.group("system")
@pass_context
def system_group(ctx: CliContext) -> None:
    """系统信息。"""


@system_group.command("info")
@pass_context
def system_info(ctx: CliContext) -> None:
    """查看系统/环境信息。"""
    import platform

    ctx.output({
        "platform": platform.platform(),
        "python": sys.version,
        "cwd": os.getcwd(),
        "mtbot_client_data_dir": str(ctx.ensure_backend().get_data_dir()),
    })


# ── Main ────────────────────────────────────────────────────────────


def main() -> None:
    cli()


if __name__ == "__main__":
    main()
