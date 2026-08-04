"""MtBot Windows 后端包装器。

负责查找、启动、停止 Electron 应用，并读取其配置/状态文件。
遵循 cli-anything 方法论：CLI 是真实软件的命令行接口，不替代软件本身。
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


class MtBotWindowsNotFoundError(RuntimeError):
    """未找到 MtBot Windows 应用可执行文件。"""

    def __init__(self) -> None:
        super().__init__(
            "未找到 MtBot Windows 应用。请确保以下任一条件满足：\n"
            "  1. 在 mtbot 仓库根目录运行，且 apps/windows 已构建（out/ 或 release/ 存在）\n"
            "  2. 设置 MTBOT_WINDOWS_APP 环境变量指向 Electron 应用目录或可执行文件\n"
            "  3. 安装打包后的应用并设置 MTBOT_WINDOWS_EXE 环境变量\n"
            "\n开发环境可执行：\n"
            "  cd apps/windows && pnpm install && pnpm build\n"
        )


class MtBotWindowsBackend:
    """MtBot Windows Electron 应用后端包装器。"""

    def __init__(self, app_dir: str | None = None, exe_path: str | None = None) -> None:
        self.app_dir = app_dir
        self.exe_path = exe_path
        self._process: subprocess.Popen | None = None

    # ── 路径解析 ──────────────────────────────────────────────────────

    def find_app(self) -> dict[str, str]:
        """解析应用目录和可执行文件路径。

        返回 {"app_dir": ..., "exe_path": ...}。如果无法找到则抛出 MtBotWindowsNotFoundError。
        """
        if self.exe_path:
            exe = Path(self.exe_path)
            if not exe.exists():
                raise MtBotWindowsNotFoundError()
            return {"app_dir": str(exe.parent), "exe_path": str(exe)}

        candidates: list[tuple[str, str | None]] = []

        # 1. 环境变量指定应用目录
        if self.app_dir:
            candidates.append((self.app_dir, None))
        env_app = os.environ.get("MTBOT_WINDOWS_APP")
        if env_app:
            candidates.append((env_app, None))

        # 2. 当前工作目录向上查找 mtbot 仓库结构
        cwd = Path.cwd().resolve()
        for parent in [cwd, *cwd.parents]:
            repo_windows = parent / "apps" / "windows"
            if repo_windows.exists():
                candidates.append((str(repo_windows), None))

        # 3. 用户主目录下的安装位置
        home = Path.home()
        candidates.append((str(home / "AppData" / "Local" / "MtBot Assistant"), None))
        candidates.append((str(home / "AppData" / "Local" / "Programs" / "MtBot Assistant"), None))

        for app_dir, _ in candidates:
            app_path = Path(app_dir)
            if not app_path.exists():
                continue

            # 开发模式：使用 node_modules/.bin/electron 启动当前目录
            if (app_path / "package.json").exists():
                electron_bin = self._find_electron_bin(app_path)
                if electron_bin:
                    return {"app_dir": str(app_path), "exe_path": electron_bin}

            # 打包模式：查找 .exe
            exe_candidate = self._find_packaged_exe(app_path)
            if exe_candidate:
                return {"app_dir": str(app_path), "exe_path": exe_candidate}

        raise MtBotWindowsNotFoundError()

    def _find_electron_bin(self, app_path: Path) -> str | None:
        """查找开发模式 electron 可执行文件。"""
        electron = shutil.which("electron")
        if electron:
            return electron
        candidates = [
            app_path / "node_modules" / ".bin" / "electron.cmd",
            app_path / "node_modules" / ".bin" / "electron.exe",
            app_path / "node_modules" / ".bin" / "electron",
            app_path / ".." / ".." / "node_modules" / ".bin" / "electron.cmd",
        ]
        for c in candidates:
            if c.exists():
                return str(c.resolve())
        return None

    def _find_packaged_exe(self, app_path: Path) -> str | None:
        """查找打包后的 Windows 可执行文件。"""
        exe_name = "MtBot Assistant.exe"
        candidates = [
            app_path / exe_name,
            app_path / "MtBot Assistant.exe",
            app_path / "MtBot-Assistant.exe",
            app_path / "mtbot-assistant.exe",
            app_path / "release" / "win-unpacked" / exe_name,
            app_path / "win-unpacked" / exe_name,
        ]
        for c in candidates:
            if c.exists():
                return str(c)
        # 通配查找
        for pattern in ["*.exe", "MtBot*.exe"]:
            for f in app_path.rglob(pattern):
                if f.is_file():
                    return str(f)
        return None

    # ── 应用生命周期 ──────────────────────────────────────────────────

    def start(
        self,
        hidden: bool = False,
        test_mode: bool = True,
        dev_tools: bool = False,
        extra_args: list[str] | None = None,
        env: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """启动 MtBot Windows 应用。

        Args:
            hidden: 是否以隐藏窗口启动（主窗口不显示）。
            test_mode: 是否启用测试模式（绕过单实例锁）。
            dev_tools: 是否打开开发者工具。
            extra_args: 额外传递给 Electron 应用的参数。
            env: 额外环境变量。

        Returns:
            {"pid": int, "app_dir": str, "exe_path": str, "args": list[str]}
        """
        info = self.find_app()
        app_dir = info["app_dir"]
        exe_path = info["exe_path"]

        if self._process is not None and self._process.poll() is None:
            raise RuntimeError(f"应用已在运行 (pid={self._process.pid})")

        args = [exe_path]
        if test_mode:
            args.append("--test-mode")
        if hidden:
            args.append("--hidden")
        if dev_tools:
            args.append("--dev-tools")
        if extra_args:
            args.extend(extra_args)

        # 开发模式下需要以应用目录为 CWD
        run_env = os.environ.copy()
        if env:
            run_env.update(env)

        popen_kwargs: dict[str, Any] = {
            "args": args,
            "cwd": app_dir,
            "env": run_env,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "text": True,
            "creationflags": subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0,
        }

        self._process = subprocess.Popen(**popen_kwargs)

        return {
            "pid": self._process.pid,
            "app_dir": app_dir,
            "exe_path": exe_path,
            "args": args,
        }

    def stop(self, timeout: int = 10) -> dict[str, Any]:
        """停止正在运行的 MtBot Windows 应用。"""
        if self._process is None:
            return {"stopped": False, "reason": "没有正在管理的进程"}

        proc = self._process
        self._process = None

        try:
            if proc.poll() is not None:
                return {"stopped": False, "reason": "进程已退出", "returncode": proc.returncode}

            proc.terminate()
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            return {"stopped": True, "pid": proc.pid, "returncode": proc.returncode}
        except Exception as e:
            return {"stopped": False, "pid": proc.pid, "error": str(e)}

    def is_running(self) -> bool:
        """检查托管的进程是否仍在运行。"""
        return self._process is not None and self._process.poll() is None

    # ── 状态/配置读取 ─────────────────────────────────────────────────

    def get_data_dir(self) -> Path:
        """获取 MtBot Windows 客户端数据目录。"""
        env_dir = os.environ.get("MTBOT_CLIENT_DATA_DIR")
        if env_dir:
            return Path(env_dir)
        return Path.home() / ".mtbot-client"

    def read_app_config(self) -> dict[str, Any]:
        """读取应用配置文件 app.json。"""
        config_path = self.get_data_dir() / "config" / "app.json"
        if not config_path.exists():
            return {}
        return json.loads(config_path.read_text(encoding="utf-8"))

    def read_server_config(self) -> dict[str, Any]:
        """读取服务器配置文件 server-config.json。"""
        # 优先使用打包后资源目录
        info = self.find_app()
        candidates = [
            Path(info["app_dir"]) / "config" / "server-config.json",
            Path(info["app_dir"]) / "resources" / "config" / "server-config.json",
            Path(info["app_dir"]) / ".." / "config" / "server-config.json",
        ]
        for c in candidates:
            if c.exists():
                return json.loads(c.read_text(encoding="utf-8"))
        return {}

    # ── 网关连接辅助 ──────────────────────────────────────────────────

    def get_default_gateway_url(self) -> str:
        """从配置或环境变量获取默认网关 URL。"""
        env_url = os.environ.get("MTBOT_GATEWAY_URL")
        if env_url:
            return env_url
        cfg = self.read_server_config()
        url = cfg.get("gatewayUrl") or cfg.get("gateway_url")
        if url:
            return str(url)
        return "ws://127.0.0.1:18789"

    def wait_for_gateway(self, url: str | None = None, timeout: float = 10.0) -> dict[str, Any]:
        """等待网关 WebSocket 端口可连接。"""
        target = url or self.get_default_gateway_url()
        parsed = self._parse_ws_url(target)
        host, port = parsed["host"], parsed["port"]

        start = time.time()
        while time.time() - start < timeout:
            try:
                with socket.create_connection((host, port), timeout=1.0):
                    return {"ready": True, "url": target, "elapsed_ms": int((time.time() - start) * 1000)}
            except OSError:
                time.sleep(0.5)

        return {"ready": False, "url": target, "timeout_ms": int(timeout * 1000)}

    @staticmethod
    def _parse_ws_url(url: str) -> dict[str, str | int]:
        """解析 WebSocket URL 获取主机和端口。"""
        # 简单解析 ws://host:port 或 wss://host:port
        url = url.replace("ws://", "").replace("wss://", "")
        if "/" in url:
            url = url.split("/", 1)[0]
        host, _, port_str = url.rpartition(":")
        if not host:
            host = url
            port = 80
        else:
            port = int(port_str)
        return {"host": host, "port": port}


def get_backend(app_dir: str | None = None, exe_path: str | None = None) -> MtBotWindowsBackend:
    """工厂函数：获取 MtBot Windows 后端实例。"""
    return MtBotWindowsBackend(app_dir=app_dir, exe_path=exe_path)
