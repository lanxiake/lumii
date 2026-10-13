"""mcp_install 单测（全部在临时目录里跑，**不碰任何真实客户端配置**）。运行：python test_mcp_install.py

这套盯的是**写别人的配置文件**这件事的纪律：读不懂就不动、只增删自己的键、别人的内容
一个字节不碰。这几条每一条都对应一种真实的翻车方式（洗完用户手写的几十条配置）。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:                                # Windows 控制台常是 GBK
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import mcp_install as I

ENTRY = {"type": "stdio", "command": "C:\\a\\b.exe", "args": [], "env": {}}


def test_json_client_add_remove():
    """增 / 重复增（幂等）/ 删 / 重复删 —— 且**同文件里的其它内容一动不动**。"""
    d = tempfile.mkdtemp(prefix="install_")
    p = os.path.join(d, "mcp.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump({"mcpServers": {"别人加的": {"command": "x"}}, "别的键": [1, 2]}, f)

    assert I.json_client_apply("X", p, "wechat-file", ENTRY)[0] == "ok"
    got = json.load(open(p, encoding="utf-8"))
    assert got["mcpServers"]["wechat-file"] == ENTRY, got
    assert got["mcpServers"]["别人加的"] == {"command": "x"}, "别人的注册项被动过"
    assert got["别的键"] == [1, 2], "同一文件里的其它键被动过"

    assert I.json_client_apply("X", p, "wechat-file", ENTRY)[0] == "ok"      # 幂等
    assert json.load(open(p, encoding="utf-8"))["mcpServers"]["wechat-file"] == ENTRY

    assert I.json_client_apply("X", p, "wechat-file", None)[0] == "ok"       # 注销
    got = json.load(open(p, encoding="utf-8"))
    assert "wechat-file" not in got["mcpServers"] and got["别的键"] == [1, 2]
    assert I.json_client_apply("X", p, "wechat-file", None)[0] == "skip"     # 再删 = skip

    shutil.rmtree(d, ignore_errors=True)
    print("ok json_client_add_remove")


def test_json_client_refuses_garbage():
    """读不出来的配置**一个字节都不动**——宁可不装，也不能洗掉用户手写的配置。

    这是本模块最重要的一条：客户端配置是用户自己攒出来的，我们只是**顺路加一条**的客人。
    """
    d = tempfile.mkdtemp(prefix="install_")
    p = os.path.join(d, "mcp.json")

    junk = '{"mcpServers": {"a": 1},}'          # 尾逗号 = 非法 JSON（用户手改常见形态）
    open(p, "w", encoding="utf-8").write(junk)
    st, detail = I.json_client_apply("X", p, "wechat-file", ENTRY)
    assert st == "fail" and "没动" in detail, (st, detail)
    assert open(p, encoding="utf-8").read() == junk, "非法配置被改了！"

    open(p, "w", encoding="utf-8").write("[1,2,3]")          # 顶层不是对象
    assert I.json_client_apply("X", p, "wechat-file", ENTRY)[0] == "fail"
    assert open(p, encoding="utf-8").read() == "[1,2,3]"

    # 没装的客户端 = skip（不去造一个目录出来）
    assert I.json_client_apply("X", os.path.join(d, "nope.json"), "n", ENTRY)[0] == "skip"

    shutil.rmtree(d, ignore_errors=True)
    print("ok json_client_refuses_garbage")


def test_skill_apply_roundtrip():
    """技能包整体拷进 / 整体删掉（**两家客户端各一份**）；源不存在时别把空目录拷出去。"""
    d = tempfile.mkdtemp(prefix="install_")
    src = os.path.join(d, "src", "wechat-file-mcp")
    os.makedirs(os.path.join(src, "refs"))
    open(os.path.join(src, "SKILL.md"), "w", encoding="utf-8").write("hello")
    open(os.path.join(src, "refs", "a.txt"), "w", encoding="utf-8").write("x")

    r1, r2 = os.path.join(d, "claude-skills"), os.path.join(d, "codex-skills")
    old = I.skill_targets
    I.skill_targets = lambda: [("Claude Code", r1), ("Codex", r2)]
    spec = {"name": "wechat-file", "product": "wechat-file-mcp", "skill": src}
    try:
        rows = I.skill_apply(spec)
        assert [r[0] for r in rows] == ["Claude Code", "Codex"], rows
        assert all(r[1] == "ok" for r in rows), rows
        for r in (r1, r2):
            got = os.path.join(r, "wechat-file-mcp")
            assert os.path.isfile(os.path.join(got, "SKILL.md")), got
            assert os.path.isfile(os.path.join(got, "refs", "a.txt")), "子目录没一起拷"
        assert all(r[1] == "ok" for r in I.skill_apply(spec)), "覆盖装不该报错"
        assert all(r[1] == "ok" for r in I.skill_apply(spec, remove=True))
        assert not os.path.isdir(os.path.join(r1, "wechat-file-mcp"))
        assert all(r[1] == "skip" for r in I.skill_apply(spec, remove=True)), "再删 = skip"

        # 源不存在：源码模式 skip（别把空目录拷出去）
        rows = I.skill_apply({"name": "x", "product": "x-mcp", "skill": os.path.join(d, "nope")})
        assert all(r[1] == "skip" for r in rows), rows

        I.skill_targets = lambda: []                     # 一个客户端都没有
        rows = I.skill_apply(spec)
        assert len(rows) == 1 and rows[0][1] == "skip", rows
    finally:
        I.skill_targets = old
        shutil.rmtree(d, ignore_errors=True)
    print("ok skill_apply_roundtrip")


def test_codex_toml_roundtrip():
    """Codex 是 **TOML**，且它的配置里可能有**明文 API key**——所以纪律比 JSON 那两家更硬。

    这条盯三件事：① 反斜杠路径必须转义（不转会写出**非法 TOML**）；
    ② 写进去的能被 `tomllib` 读回来；③ **别人的内容一个字节不碰**（尤其那串 key）。
    """
    import tomllib
    d = tempfile.mkdtemp(prefix="install_")
    p = os.path.join(d, "config.toml")
    key = "sk-SECRET-me"
    # ⚠️ 裸键只允许 ASCII：`[mcp_servers.别人]` 是**非法 TOML**（第一版夹具就栽在这，
    #    反过来证明"写完读回来验"那道守卫真会拦住写到非法 TOML 的情况）
    original = (f'model = "gpt-5.6"\n\n[mcp_servers.other]\ncommand = "npx"\n\n'
                f'[model_providers.custom]\nexperimental_bearer_token = "{key}"\n')
    open(p, "w", encoding="utf-8", newline="").write(original)

    old = I.CODEX_CONFIG
    I.CODEX_CONFIG = (d, "config.toml")              # `_client_path` 原样拼绝对路径段
    entry = {"command": r"C:\Users\a b\.lumii\mcp\wechat-file-mcp\wechat-file-mcp.exe"}
    try:
        st, detail = I.codex_apply("wechat-file", entry)
        assert st == "ok", (st, detail)
        got = open(p, encoding="utf-8").read()
        data = tomllib.loads(got)                     # 必须能读回来
        assert data["mcp_servers"]["wechat-file"]["command"] == entry["command"], "路径被写坏了"
        assert data["mcp_servers"]["other"]["command"] == "npx", "别人的段被动过"
        assert data["model_providers"]["custom"]["experimental_bearer_token"] == key, "API key 被动过！"

        assert I.codex_apply("wechat-file", entry)[0] == "ok"      # 幂等：不该出现两段
        assert open(p, encoding="utf-8").read().count("[mcp_servers.wechat-file]") == 1
    finally:
        I.CODEX_CONFIG = old
        shutil.rmtree(d, ignore_errors=True)
    print("ok codex_toml_roundtrip")


def test_all_client_paths_under_home_or_appdata():
    """**结构性守卫**：每个客户端路径都必须只经由 `~` / `%APPDATA%` 解析。

    为什么需要这条：踩过一次——`test_remove_failure_does_not_block_add` 最初没打桩
    `codex_apply`，于是 `do_install` **真把一段 `[mcp_servers.wechat-file]` 写进了**
    `~/.codex/config.toml`（那里面还有用户的明文 API key）。打桩是逐点防的、会漏；
    这条是**面**上防的：把两个根都指到临时目录后，任何一条仍指向真实位置的路径都会当场露出来。
    """
    d = tempfile.mkdtemp(prefix="install_")
    old = {k: os.environ.get(k) for k in ("USERPROFILE", "HOME", "APPDATA")}
    try:
        os.environ["USERPROFILE"] = d
        os.environ["HOME"] = d
        os.environ["APPDATA"] = os.path.join(d, "AppData", "Roaming")
        roots = [os.path.join(d, "AppData", "Roaming"), d]
        paths = [I._client_path(parts) for _, parts in I.JSON_CLIENTS]
        paths.append(I._client_path(I.CODEX_CONFIG))
        paths += [I._client_path(r) for _, r, _ in I.SKILL_TARGETS]
        bad = [p for p in paths if not p or not any(
            os.path.normcase(p).startswith(os.path.normcase(r)) for r in roots)]
        assert not bad, f"这些客户端路径没走 ~ / %APPDATA%，测试改根也拦不住：{bad}"
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(d, ignore_errors=True)
    print("ok all_client_paths_under_home_or_appdata")


def test_is_interactive_rejects_nul_stdin():
    """**双击 ⇒ 向导；客户端 ⇒ 服务器**，而判据不能是 `isatty()`。

    踩过：Windows 上 `NUL` 是**字符设备**，`sys.stdin.isatty()` 对它返回**真**。客户端若拿
    `NUL` 当 stdin 拉起服务器，服务器就会被弹成一个**安装向导**——然后 stdio 传输彻底堵死
    （服务器在等回车，客户端在等 JSON）。
    真正的判据是 `GetConsoleMode`。这条用**真子进程 + stdin=NUL** 把它钉死，并顺带钉住
    "只靠 isatty 会误判"这个前提（前提没了这条测试也就没意义了）。
    """
    probe = ("import sys;sys.path.insert(0, %r);import mcp_install as I;"
             "print(I.is_interactive())") % os.path.dirname(os.path.abspath(I.__file__))
    with open(os.devnull, "rb") as nul:
        r = subprocess.run([sys.executable, "-c", probe], stdin=nul,
                           capture_output=True, timeout=120, **I._quiet_kwargs())
    assert r.stdout.strip() == b"False", f"stdin=NUL 时必须是'客户端'：{r.stdout!r} {r.stderr!r}"

    with open(os.devnull, "rb") as nul:                     # 前提：isatty 单独用会误判
        r2 = subprocess.run([sys.executable, "-c", "import sys;print(sys.stdin.isatty())"],
                            stdin=nul, capture_output=True, timeout=120, **I._quiet_kwargs())
    if os.name == "nt":
        assert r2.stdout.strip() == b"True", \
            "前提变了（本机 NUL 不再让 isatty 为真）——那这条测试的动机要重写"

    # 测试进程自己：stdin 不是控制台 ⇒ 当客户端
    assert I.is_interactive() is False, "非控制台 stdin 一律当客户端（安全侧）"
    print("ok is_interactive_rejects_nul_stdin")


def _once(*answers):
    """按顺序喂答案，喂完就一直给空串（= 回车确认）。

    ⚠️ **不能用固定返回**：`lambda p: "2"` 会每轮都把第 2 项切换一次，来回切、**永不退出**。
    菜单的退出条件是"用户不再输入"，所以测试必须模拟"输一次然后回车"。
    """
    box = list(answers)
    return lambda p: box.pop(0) if box else ""


def test_choose_clients_menu():
    """勾选客户端：回车 = 默认全勾（已装的），输入序号切换，没装的点不动。"""
    out, old_say = [], I._say
    I._say = lambda *a, **k: out.append(" ".join(str(x) for x in a))
    cs = [{"key": "a", "label": "A", "detected": True},
          {"key": "b", "label": "B", "detected": True},
          {"key": "c", "label": "C", "detected": False}]
    try:
        assert I._choose_clients(cs, ask_raw=_once()) == {"a", "b"}, "回车 = 已装的全勾"
        assert I._choose_clients(cs, ask_raw=_once("2")) == {"a"}, "输入 2 = 切掉 B"
        assert I._choose_clients(cs, ask_raw=_once("3,1")) == {"b"}, "逗号分隔；其中 3 没装、忽略"
        assert I._choose_clients(cs, ask_raw=_once("1 2")) == set(), "两个都切掉"
        assert I._choose_clients(cs, ask_raw=_once("3")) == {"a", "b"}, "没装的点了不生效"
        assert any("没装" in s for s in out), "该说明为什么点它没反应"
        assert I._choose_clients(cs, ask_raw=_once("99 乱写")) == {"a", "b"}, "越界/乱输入忽略"
        assert I._choose_clients(cs, ask_raw=lambda p: None) == {"a", "b"}, "EOF 当回车，不卡住"
    finally:
        I._say = old_say
    print("ok choose_clients_menu")


def test_interactive_wizard():
    """双击向导：**勾选客户端** → 确认才动手 → 拒绝就一个字节不改 → 常驻产品顺带问自启。"""
    d = tempfile.mkdtemp(prefix="install_")
    calls, ran = [], []
    old = (I.do_install, I._say, I._pause, I._own_command, I.subprocess.run, I.install_dir,
           I.clients)
    I._say = lambda *a, **k: None
    I._pause = lambda: calls.append("pause")
    I.do_install = lambda spec, only=None: (calls.append(("install", only)), 0)[1]
    I.install_dir = lambda p: os.path.join(d, p)
    I.clients = lambda: [{"key": "a", "label": "A", "kind": "json", "path": "p", "detected": True},
                         {"key": "b", "label": "B", "kind": "json", "path": "p", "detected": False}]

    class R:
        returncode = 0
        stderr = b""

    I._own_command = lambda: ("EXE", [])
    I.subprocess.run = lambda cmd, **k: (ran.append(cmd), R())[1]
    spec = {"name": "wechat-file", "product": "wechat-file-mcp", "version": "1.0", "label": "X"}
    try:
        # 在菜单里切掉 A（唯一装了的）→ 于是谁都不注册
        assert I.interactive(spec, ask=lambda p: True, ask_raw=_once("1")) == 0
        assert calls == [("install", set()), "pause"], f"勾选结果要原样传给 do_install：{calls}"

        # 拒绝确认 ⇒ 连装都不该跑
        calls.clear()
        assert I.interactive(spec, ask=lambda p: False, ask_raw=_once()) == 0
        assert calls == ["pause"], f"拒绝了就什么都不该做：{calls}"

        # 回车走默认（勾上已装的 A）
        calls.clear()
        assert I.interactive(spec, ask=lambda p: True, ask_raw=_once()) == 0
        assert calls == [("install", {"a"}), "pause"], calls
        assert not ran, "没声明 daemon_install 的产品不该去碰自启"

        # 带常驻的产品：装完会问一句，同意就调自启
        calls.clear(), ran.clear()
        I.interactive({**spec, "daemon_install": "--install-autostart"},
                      ask=lambda p: True, ask_raw=_once())
        assert ran and ran[0][-1] == "--install-autostart", f"该顺带装常驻：{ran}"

        # 一个客户端都没检测到 ⇒ 只部署，不注册，且不该卡在菜单上
        calls.clear()
        I.clients = lambda: [{"key": "a", "label": "A", "kind": "json",
                              "path": "p", "detected": False}]
        assert I.interactive(spec, ask=lambda p: True, ask_raw=_once()) == 0
        assert calls == [("install", set()), "pause"], calls
    finally:
        (I.do_install, I._say, I._pause, I._own_command, I.subprocess.run, I.install_dir,
         I.clients) = old
        shutil.rmtree(d, ignore_errors=True)
    print("ok interactive_wizard")


def test_ask_and_pause_never_hang():
    """问句与暂停在 EOF/异常下**不能卡住**——那是个没人看得到的窗口，卡住就是僵死进程。"""
    out, old_say = [], I._say
    I._say = lambda *a, **k: out.append(" ".join(str(x) for x in a))
    old_input = I.input if hasattr(I, "input") else None
    import builtins
    real_input = builtins.input
    try:
        for boom in (EOFError(), KeyboardInterrupt()):
            def raiser(*a, **k):
                raise boom
            builtins.input = raiser
            assert I._ask("继续？") is True, "读不到输入 ⇒ 按默认（是）"
            assert I._ask("继续？", default_yes=False) is False
            I._pause()                                   # 只要求"不抛、不卡"

        builtins.input = lambda *a, **k: ""              # 直接回车 ⇒ 取默认
        assert I._ask("继续？") is True
        assert I._ask("继续？", default_yes=False) is False
        builtins.input = lambda *a, **k: "n"
        assert I._ask("继续？") is False
    finally:
        builtins.input = real_input
        I._say = old_say
    print("ok ask_and_pause_never_hang")


def test_say_never_crashes_on_encoding():
    """stdout 编不出某个字符时，`_say` 必须**降级**而不是抛。

    真机撞见过：控制台是 GBK 时 `✓` 会 `UnicodeEncodeError`——而向导已经走到一半
    （exe 拷完了、客户端还没注册）。装到一半崩掉比装不上更糟。
    """
    class GBKOut:
        encoding = "gbk"

        def __init__(self):
            self.buf = []

        def write(self, s):
            s.encode("gbk")                     # 模仿真 stdout：编不出来就抛
            self.buf.append(s)

        def flush(self):
            pass

    old = sys.stdout
    sys.stdout = GBKOut()
    try:
        I._say("勾选 [✓] 完成")                  # 不该抛
        assert sys.stdout.buf, "降级之后仍然要把话说出来（别静默吞掉）"
        assert "?" in "".join(sys.stdout.buf), sys.stdout.buf
        I._say("纯中文没问题")                    # 能编的照常
    finally:
        sys.stdout = old
    print("ok say_never_crashes_on_encoding")


def test_codex_appends_isolated_section():
    """`[mcp_servers.x]` 整段删除：**含它的子表**，且不碰紧邻的下一段。"""
    text = ('a = 1\n\n[mcp_servers.x]\ncommand = "c"\n\n[mcp_servers.x.args]\nk = 1\n\n'
            '[mcp_servers.y]\ncommand = "d"\n')
    out = I._toml_drop_section(text, "[mcp_servers.x]")
    assert "[mcp_servers.x]" not in out and "[mcp_servers.x.args]" not in out, out
    assert "[mcp_servers.y]" in out and 'command = "d"' in out, out
    assert out.startswith("a = 1"), out
    assert I._toml_drop_section(text, "[mcp_servers.不存在]") == text, "没有的段不该改动文本"
    print("ok codex_appends_isolated_section")


def test_deploy_self_source_mode():
    """源码模式下**不拷贝自身**——`sys.executable` 那时是 python.exe，拷过去是错的。"""
    assert not getattr(sys, "frozen", False), "这条只在源码模式有意义"
    exe, how = I.deploy_self("wechat-file-mcp")
    assert exe is None and "源码模式" in how, (exe, how)
    print("ok deploy_self_source_mode")


def test_prune_old():
    """覆盖部署留下的 `*.old-*` 要清到只剩最近两个（否则每次升级涨一份 10MB）。"""
    d = tempfile.mkdtemp(prefix="install_")
    for i in range(5):
        open(os.path.join(d, f"p.exe.old-{i}"), "w").close()
    open(os.path.join(d, "p.exe"), "w").close()
    I._prune_old(d, "p")
    left = sorted(f for f in os.listdir(d) if ".old-" in f)
    assert left == ["p.exe.old-3", "p.exe.old-4"], left
    assert os.path.isfile(os.path.join(d, "p.exe")), "当前在用的 exe 不能被当成残留删掉"
    shutil.rmtree(d, ignore_errors=True)
    print("ok prune_old")


def test_clean_install_dir_removes_old_leftovers():
    """卸载要把部署目录**连同 `*.old-*` 残留**清掉（那是升级让位出来的旧 exe，11MB 一个）；
    但目录里还有别人的东西时**只删自己的**，不 `rmdir`（别误删）。"""
    d = tempfile.mkdtemp(prefix="install_")
    old_root = I.data_root
    I.data_root = lambda: d
    try:
        idir = I.install_dir("wechat-file-mcp")
        os.makedirs(idir)
        for f in ("wechat-file-mcp.exe", "wechat-file-mcp.exe.old-1", "wechat-file-mcp.exe.old-2"):
            open(os.path.join(idir, f), "w").close()
        I._clean_install_dir("wechat-file-mcp")
        assert not os.path.isdir(idir), "部署目录该被一起清掉"

        os.makedirs(idir)                                  # 目录里还有别的东西 ⇒ 不 rmdir
        open(os.path.join(idir, "wechat-file-mcp.exe"), "w").close()
        open(os.path.join(idir, "用户放的东西.txt"), "w").close()
        I._clean_install_dir("wechat-file-mcp")
        assert os.path.isdir(idir), "目录里还有别人的东西，不许 rmdir"
        assert os.path.isfile(os.path.join(idir, "用户放的东西.txt")), "误删了别人的文件"
        assert not os.path.isfile(os.path.join(idir, "wechat-file-mcp.exe"))
    finally:
        I.data_root = old_root
        shutil.rmtree(d, ignore_errors=True)
    print("ok clean_install_dir_removes_old_leftovers")


def test_subprocess_kwargs_are_python_not_node():
    """子进程参数必须是 **Python** 的写法。

    踩过：`windowsHide` 是 Node 的 `spawnSync` 参数，Python 的 `subprocess.run` 不认 →
    真机第一次跑 `--install-status` 直接 `TypeError`。这条把 kwargs 真喂给 `subprocess.run`
    跑一次，是**真跑**不是形式检查。
    """
    kw = I._quiet_kwargs()
    assert "windowsHide" not in kw, "windowsHide 是 Node 的参数，Python 不认"
    r = subprocess.run([sys.executable, "-c", "print('ok')"],
                       capture_output=True, timeout=60, **kw)
    assert r.returncode == 0 and b"ok" in r.stdout, (r.returncode, r.stderr)

    # `_run` 成功与失败都必须返回二元组——否则 `r, err = _run(...)` 会解包失败
    got, err = I._run([sys.executable, "-c", "print('hi')"], 60)
    assert got is not None and got.returncode == 0 and err == "", (got, err)
    got2, err2 = I._run(["这一定不是一个存在的可执行文件"], 10)
    assert got2 is None and err2, (got2, err2)
    print("ok subprocess_kwargs_are_python_not_node")


def test_consume_flags_routing():
    """三个开关各路由到各自动作；**没有开关时必须返回 False**（否则 MCP 根本起不来）。"""
    hit = []
    old = I.FLAGS
    I.FLAGS = {"--install": lambda s: (hit.append("install"), 0)[1],
               "--uninstall": lambda s: (hit.append("uninstall"), 0)[1],
               "--install-status": lambda s: (hit.append("status"), 0)[1]}
    try:
        assert I.consume_flags(["--install"], {}) == 0 and hit == ["install"]
        assert I.consume_flags(["--uninstall"], {}) == 0 and hit[-1] == "uninstall"
        assert I.consume_flags(["--install-status"], {}) == 0 and hit[-1] == "status"
        # 没命中必须返回 None（False 会让 MCP 循环起不来：`if rc is not None` 就吃掉了）
        assert I.consume_flags([], {}) is None, "空 argv 不许被吞"
        assert I.consume_flags(["--version"], {}) is None, "别抢 --version 的活"
        # 装失败要以非零码退出
        I.FLAGS["--install"] = lambda s: 1
        assert I.consume_flags(["--install"], {}) == 1
    finally:
        I.FLAGS = old
    print("ok consume_flags_routing")


def test_version_compare():
    """版本比较：段数不同、有非数字段、空值都不能炸，且**解析不了时判成"一样"**。"""
    assert I.compare_versions("0.5.0", "0.4.0") == 1
    assert I.compare_versions("0.4.0", "0.5.0") == -1
    assert I.compare_versions("0.5.0", "0.5.0") == 0
    assert I.compare_versions("0.5", "0.5.0") == 0, "段数不同要按补零比"
    assert I.compare_versions("0.10.0", "0.9.9") == 1, "别按字符串比（'10' < '9'）"
    assert I.compare_versions("", "") == 0
    assert I.compare_versions("1.0.0-beta", "1.0.0") == 0, "非数字段当 0，宁可判成一样也别误报有新版"
    print("ok version_compare")


def test_installed_record_roundtrip_and_stale_detection():
    """装了要登记版本；`--install-status` 靠它对账——**不去启动部署副本**（onefile 冷启动 1–3s）。"""
    d = tempfile.mkdtemp(prefix="install_")
    old_root, old_say, old_skills, old_codex = I.data_root, I._say, I.skill_targets, I.CODEX_CONFIG
    old_clients = I.clients
    I.data_root = lambda: d
    # **别碰真实的 ~/.claude/skills 与 ~/.codex/config.toml**；
    # `clients()` 也打桩——否则 `do_status` 会去 spawn 真的 `claude mcp get`（慢且碰真实配置）
    I.skill_targets = lambda: [("Claude Code", os.path.join(d, "skills"))]
    I.CODEX_CONFIG = (d, "codex-config.toml")
    I.clients = lambda: [{"key": "claude-code", "label": "Claude Code", "kind": "claude_code",
                          "path": None, "detected": False}]
    out = []
    I._say = lambda *a, **k: out.append(" ".join(str(x) for x in a))
    try:
        spec = {"name": "wechat-file", "product": "wechat-file-mcp", "version": "0.5.0",
                "label": "文件归档", "skill": "/nope"}
        os.makedirs(I.install_dir("wechat-file-mcp"))
        I._write_installed("wechat-file-mcp", spec, r"C:\fake\x.exe")
        assert I._read_installed("wechat-file-mcp")["version"] == "0.5.0"

        # 跑的是新版、装的是旧版 ⇒ 必须**报出来**（这正是"没人提醒你该升"的那个洞）
        out.clear()
        I.do_status({**spec, "version": "0.6.0"})
        assert any("重跑 --install" in s for s in out), out

        out.clear()                                  # 一致 ⇒ 不告警
        I.do_status(spec)
        assert any("与当前一致" in s for s in out), out
        assert not any("重跑 --install" in s for s in out), out

        # 技能包那一行必须按**技能 id**（= product）找目录，不是按服务名。
        # 真机踩过：明明装了却报"没装"（和 skill_apply 同一个坑的第二处，别各写各的）。
        os.makedirs(os.path.join(d, "skills", "wechat-file-mcp"), exist_ok=True)
        out.clear()
        I.do_status(spec)
        skill_line = [s for s in out if "技能包" in s]
        assert skill_line and "没装" not in skill_line[0], skill_line
    finally:
        (I.data_root, I._say, I.skill_targets, I.CODEX_CONFIG, I.clients) = (
            old_root, old_say, old_skills, old_codex, old_clients)
        shutil.rmtree(d, ignore_errors=True)
    print("ok installed_record_roundtrip_and_stale_detection")


# 注：这里原本有 `--check-update` 与发布清单解析两条测试。
# 2026-10-13 把那半个联网功能摘掉了（本产品不做对外发布，没有发布通道 ⇒ 永远 404），
# 测试随之删除。**本模块现在一条网络请求都不发**——与红线「本地处理、不外传」一致。


def test_no_network_code_in_install_or_license():
    """**结构性守卫**：安装与授权这条路上，一条网络请求都不许有。

    产品红线是「本地处理、**不外传**」（设计 §10）。这里原本有个 `--check-update`（查远端有没有
    新版），2026-10-13 因为**不做对外发布**摘掉了——没有发布通道 ⇒ 它永远只能返回 404，
    是个"注定失败的按钮"。这条测试钉住"别再长回来一个偷偷联网的东西"：
    联网代码一旦混进来，用户的机器码/会话内容就有被带出去的可能，而那是不可逆的。
    """
    here = os.path.dirname(os.path.abspath(I.__file__))
    for mod in ("mcp_install.py", "mcp_license.py"):
        src = open(os.path.join(here, mod), encoding="utf-8").read()
        for bad in ("urllib", "urlopen", "requests.", "socket.", "http://", "https://"):
            assert bad not in src, f"{mod} 里出现了网络代码「{bad}」——与「不外传」冲突"
    print("ok no_network_code_in_install_or_license")


def test_remove_failure_does_not_block_add():
    """「先摘再挂」里的**摘**是尽力而为：目标本来就不存在时 `remove` 会失败，
    但**绝不能因此跳过挂载**。

    真机实测就漏在这儿：卸载过之后再装，`claude mcp remove` 报 "No MCP server named …"，
    拿它的结果当闸门的话 `add` 永远不跑——而用户看着"安装"跑完了以为装上了。
    """
    calls = []
    # `codex_apply` **必须一起打桩**：它写的是 `~/.codex/config.toml`，而那个文件里有真实 API key
    old = (I.claude_code_apply, I.deploy_self, I.skill_apply, I.json_client_apply, I.codex_apply, I._say)
    I.claude_code_apply = lambda name, command=None, args=(): (
        calls.append("remove" if command is None else "add"),
        ("fail", "No MCP server named") if command is None else ("ok", "added"))[1]
    I.deploy_self = lambda product: (r"C:\fake\x.exe", "ok")
    I.skill_apply = lambda spec, remove=False: [("Claude Code", "ok", r"C:\fake\skill")]
    I.json_client_apply = lambda *a, **k: ("skip", "未安装")
    I.codex_apply = lambda *a, **k: ("skip", "未安装")
    I._say = lambda *a, **k: None
    try:
        rc = I.do_install({"name": "wechat-file", "product": "wechat-file-mcp", "label": "x"})
        assert calls == ["remove", "add"], f"摘失败后必须照样挂，实际：{calls}"
        assert rc == 0, f"摘失败不算安装失败：{rc}"
    finally:
        (I.claude_code_apply, I.deploy_self, I.skill_apply, I.json_client_apply,
         I.codex_apply, I._say) = old
    print("ok remove_failure_does_not_block_add")


def test_skill_source_uses_skill_id_not_server_name():
    """技能包目录名是**技能 id**（`wechat-file-mcp`），不是 MCP 服务名（`wechat-file`）。

    实测第一次真装就栽在这：拿服务名去找 `_MEIPASS/skills/wechat-file`，那儿没有——
    技能包静默没装上，而其余步骤全绿。两个名字不同，别混。
    """
    d = tempfile.mkdtemp(prefix="install_")
    base = os.path.join(d, "MEI")
    os.makedirs(os.path.join(base, "skills", "wechat-file-mcp"))
    open(os.path.join(base, "skills", "wechat-file-mcp", "SKILL.md"), "w").close()

    old_frozen, old_meipass = getattr(sys, "frozen", None), getattr(sys, "_MEIPASS", None)
    old_targets = I.skill_targets
    I.skill_targets = lambda: [("Claude Code", os.path.join(d, "skills"))]
    sys.frozen, sys._MEIPASS = True, base
    try:
        spec = {"name": "wechat-file", "product": "wechat-file-mcp", "skill": "/nope"}
        src = I.skill_source(spec)
        assert src == os.path.join(base, "skills", "wechat-file-mcp"), src
        # 冻结模式下源找不到 = 构建漏了 --add-data ⇒ **fail**，不能用 skip 蒙混
        sys._MEIPASS = os.path.join(d, "empty")
        rows = I.skill_apply(spec)
        assert all(r[1] == "fail" and "add-data" in r[2] for r in rows), rows
    finally:
        I.skill_targets = old_targets
        if old_frozen is None:
            del sys.frozen
        else:
            sys.frozen = old_frozen
        if old_meipass is None:
            del sys._MEIPASS
        else:
            sys._MEIPASS = old_meipass
        shutil.rmtree(d, ignore_errors=True)
    print("ok skill_source_uses_skill_id_not_server_name")


if __name__ == "__main__":
    test_json_client_add_remove()
    test_json_client_refuses_garbage()
    test_skill_apply_roundtrip()
    test_codex_toml_roundtrip()
    test_all_client_paths_under_home_or_appdata()
    test_is_interactive_rejects_nul_stdin()
    test_choose_clients_menu()
    test_interactive_wizard()
    test_ask_and_pause_never_hang()
    test_say_never_crashes_on_encoding()
    test_codex_appends_isolated_section()
    test_deploy_self_source_mode()
    test_prune_old()
    test_clean_install_dir_removes_old_leftovers()
    test_subprocess_kwargs_are_python_not_node()
    test_consume_flags_routing()
    test_version_compare()
    test_installed_record_roundtrip_and_stale_detection()
    test_no_network_code_in_install_or_license()
    test_remove_failure_does_not_block_add()
    test_skill_source_uses_skill_id_not_server_name()
    print("ALL PASS")
