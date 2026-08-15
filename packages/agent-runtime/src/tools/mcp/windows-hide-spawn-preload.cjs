/**
 * Windows：强制 child_process 默认 windowsHide，避免 npx/node 再拉起的控制台黑窗。
 *
 * 由 mcp-client 以 `node -r <本文件>` 注入到 MCP 进程树的第一层 Node；
 * 该进程内再 spawn 出的子进程也会带上 windowsHide。
 */
"use strict";

(function patchChildProcessHideWindows() {
  if (process.platform !== "win32") return;

  const cp = require("child_process");

  /** 给 options 补上 windowsHide: true（不覆盖调用方已显式设置的值以外，一律强制隐藏） */
  function withHide(options) {
    if (options == null) return { windowsHide: true };
    if (typeof options !== "object") return options;
    return { ...options, windowsHide: true };
  }

  const origSpawn = cp.spawn;
  cp.spawn = function spawn(command, args, options) {
    if (args != null && !Array.isArray(args)) {
      options = args;
      args = undefined;
    }
    return origSpawn.call(this, command, args ?? [], withHide(options));
  };

  const origSpawnSync = cp.spawnSync;
  cp.spawnSync = function spawnSync(command, args, options) {
    if (args != null && !Array.isArray(args)) {
      options = args;
      args = undefined;
    }
    return origSpawnSync.call(this, command, args ?? [], withHide(options));
  };

  const origExecFile = cp.execFile;
  cp.execFile = function execFile(file, args, options, callback) {
    if (typeof args === "function") {
      callback = args;
      args = undefined;
      options = undefined;
    } else if (typeof options === "function") {
      callback = options;
      options = undefined;
    } else if (args != null && !Array.isArray(args) && typeof args === "object") {
      options = args;
      args = undefined;
    }
    return origExecFile.call(this, file, args, withHide(options), callback);
  };

  const origExecFileSync = cp.execFileSync;
  cp.execFileSync = function execFileSync(file, args, options) {
    if (args != null && !Array.isArray(args) && typeof args === "object") {
      options = args;
      args = undefined;
    }
    return origExecFileSync.call(this, file, args, withHide(options));
  };

  const origFork = cp.fork;
  cp.fork = function fork(modulePath, args, options) {
    if (args != null && !Array.isArray(args) && typeof args === "object") {
      options = args;
      args = undefined;
    }
    return origFork.call(this, modulePath, args, withHide(options));
  };

  const origExec = cp.exec;
  cp.exec = function exec(command, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    return origExec.call(this, command, withHide(options), callback);
  };

  const origExecSync = cp.execSync;
  cp.execSync = function execSync(command, options) {
    return origExecSync.call(this, command, withHide(options));
  };
})();
