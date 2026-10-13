"""mcp_install 单测（全部在临时目录里跑，**不碰任何真实客户端配置**）。运行：python test_mcp_install.py

这套盯的是**写别人的配置文件**这件事的纪律：读不懂就不动、只增删自己的键、别人的内容
一个字节不碰。这几条每一条都对应一种真实的翻车方式（洗完用户手写的几十条配置）。
"""
import json
import os
import pathlib
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
    """技能包目录整体拷进 / 整体删掉；源不存在时 **skip**（别把空目录拷出去）。"""
    d = tempfile.mkdtemp(prefix="install_")
    src = os.path.join(d, "src", "wechat-file")
    os.makedirs(os.path.join(src, "refs"))
    open(os.path.join(src, "SKILL.md"), "w", encoding="utf-8").write("hello")
    open(os.path.join(src, "refs", "a.txt"), "w", encoding="utf-8").write("x")

    root = os.path.join(d, "skills")
    old_root = I.skills_root
    I.skills_root = lambda: root
    try:
        st, dst = I.skill_apply({"name": "wechat-file", "product": "wechat-file-mcp", "skill": src})
        assert st == "ok" and os.path.isfile(os.path.join(dst, "SKILL.md")), (st, dst)
        assert os.path.isfile(os.path.join(dst, "refs", "a.txt")), "子目录没一起拷"
        assert I.skill_apply({"name": "wechat-file", "product": "wechat-file-mcp", "skill": src})[0] == "ok"     # 覆盖装
        assert I.skill_apply({"name": "wechat-file", "product": "wechat-file-mcp", "skill": src}, remove=True)[0] == "ok"
        assert not os.path.isdir(dst), "卸载没删掉技能包"
        assert I.skill_apply({"name": "wechat-file", "product": "wechat-file-mcp", "skill": src}, remove=True)[0] == "skip"
        assert I.skill_apply({"name": "x", "product": "x-mcp", "skill": os.path.join(d, "nope")})[0] == "skip"
    finally:
        I.skills_root = old_root
        shutil.rmtree(d, ignore_errors=True)
    print("ok skill_apply_roundtrip")


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
    old_root, old_say, old_skills = I.data_root, I._say, I.skills_root
    I.data_root = lambda: d
    I.skills_root = lambda: os.path.join(d, "skills")      # **别碰真实的 ~/.claude/skills**
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
        os.makedirs(os.path.join(I.skills_root(), "wechat-file-mcp"), exist_ok=True)
        out.clear()
        I.do_status(spec)
        skill_line = [s for s in out if "技能包" in s]
        assert skill_line and "没装" not in skill_line[0], skill_line
    finally:
        I.data_root, I._say, I.skills_root = old_root, old_say, old_skills
        shutil.rmtree(d, ignore_errors=True)
    print("ok installed_record_roundtrip_and_stale_detection")


def test_check_update_never_lies():
    """联网检查**默认不发生**，且拿不到清单时**不谎报"已是最新"**。

    为什么单独钉这条：这产品卖点是「本地处理、不外传」。自动联网会踩红线（所以只有
    `--check-update` 才会发请求）；而把"拿不到"说成"已是最新"是更坏的失败——用户会安心地
    停在旧版上。
    """
    src = open(I.__file__, encoding="utf-8").read()
    # 只有 `--check-update` 这条路会取远端；`--install` / `--install-status` 里不许出现调用
    assert "fetch_latest_version(" in src
    for fn in ("def do_install", "def do_status"):
        body = src.split(fn, 1)[1].split("\ndef ", 1)[0]
        assert "fetch_latest_version" not in body, f"{fn} 里不该联网"

    old = I.fetch_latest_version
    I.fetch_latest_version = lambda product: ("", "URLError: 没网")
    out, old_say = [], I._say
    I._say = lambda *a, **k: out.append(" ".join(str(x) for x in a))
    try:
        I.do_check_update({"name": "wechat-file", "product": "wechat-file-mcp",
                           "version": "0.5.0", "label": "文件归档"})
        joined = " ".join(out)
        assert "拿不到" in joined and "不代表是最新版" in joined, out
        assert "已是最新" not in joined, out

        out.clear()                                  # 拿到清单 → 正常比对
        I.fetch_latest_version = lambda product: ("0.6.0", "ok")
        I.do_check_update({"name": "wechat-file", "product": "wechat-file-mcp",
                           "version": "0.5.0", "label": "文件归档"})
        assert any("有新版" in s and "0.6.0" in s for s in out), out
    finally:
        I.fetch_latest_version, I._say = old, old_say
    print("ok check_update_never_lies")


def test_fetch_latest_version_parses_manifest():
    """清单**解析**那一半（真机只验到了 404 那条失败路径）。

    解析写错的话会**静默比错版本**：比如把产品名和版本号读反、或者清单里没有这个产品时当成
    "版本是空的" → 空版本按 0 比 ⇒ 永远"已是最新"。所以"清单里没有这个产品"必须能区分出来。
    """
    d = tempfile.mkdtemp(prefix="install_")
    p = os.path.join(d, "wechat-toolkits.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump({"wechat-file-mcp": {"version": "9.9.9", "asset": "x.exe"},
                   "wechat-crm-mcp": "8.8.8"}, f)          # 也支持直接给版本串的简写
    old = I.MANIFEST_URL
    I.MANIFEST_URL = pathlib.Path(p).as_uri()
    try:
        v, why = I.fetch_latest_version("wechat-file-mcp")
        assert (v, why) == ("9.9.9", "ok"), (v, why)
        assert I.fetch_latest_version("wechat-crm-mcp")[0] == "8.8.8", "简写形态也要认"
        v2, why2 = I.fetch_latest_version("wechat-recall-mcp")
        assert v2 == "" and "没有这个产品" in why2, (v2, why2)
        assert I.compare_versions(v2 or "0", "0.6.0") < 0, "读不到不能当成'一样新'"

        os.remove(p)                                     # 清单不存在 = 拿不到，不是"没有这个产品"
        v3, why3 = I.fetch_latest_version("wechat-file-mcp")
        assert v3 == "" and why3, (v3, why3)
    finally:
        I.MANIFEST_URL = old
        shutil.rmtree(d, ignore_errors=True)
    print("ok fetch_latest_version_parses_manifest")


def test_remove_failure_does_not_block_add():
    """「先摘再挂」里的**摘**是尽力而为：目标本来就不存在时 `remove` 会失败，
    但**绝不能因此跳过挂载**。

    真机实测就漏在这儿：卸载过之后再装，`claude mcp remove` 报 "No MCP server named …"，
    拿它的结果当闸门的话 `add` 永远不跑——而用户看着"安装"跑完了以为装上了。
    """
    calls = []
    old = (I.claude_code_apply, I.deploy_self, I.skill_apply, I.json_client_apply, I._say)
    I.claude_code_apply = lambda name, command=None, args=(): (
        calls.append("remove" if command is None else "add"),
        ("fail", "No MCP server named") if command is None else ("ok", "added"))[1]
    I.deploy_self = lambda product: (r"C:\fake\x.exe", "ok")
    I.skill_apply = lambda spec, remove=False: ("ok", r"C:\fake\skill")
    I.json_client_apply = lambda *a, **k: ("skip", "未安装")
    I._say = lambda *a, **k: None
    try:
        rc = I.do_install({"name": "wechat-file", "product": "wechat-file-mcp", "label": "x"})
        assert calls == ["remove", "add"], f"摘失败后必须照样挂，实际：{calls}"
        assert rc == 0, f"摘失败不算安装失败：{rc}"
    finally:
        (I.claude_code_apply, I.deploy_self, I.skill_apply, I.json_client_apply, I._say) = old
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
    sys.frozen, sys._MEIPASS = True, base
    try:
        spec = {"name": "wechat-file", "product": "wechat-file-mcp", "skill": "/nope"}
        src = I.skill_source(spec)
        assert src == os.path.join(base, "skills", "wechat-file-mcp"), src
        # 冻结模式下源找不到 = 构建漏了 --add-data ⇒ **fail**，不能用 skip 蒙混
        sys._MEIPASS = os.path.join(d, "empty")
        st, detail = I.skill_apply(spec)
        assert st == "fail" and "add-data" in detail, (st, detail)
    finally:
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
    test_deploy_self_source_mode()
    test_prune_old()
    test_clean_install_dir_removes_old_leftovers()
    test_subprocess_kwargs_are_python_not_node()
    test_consume_flags_routing()
    test_version_compare()
    test_installed_record_roundtrip_and_stale_detection()
    test_check_update_never_lies()
    test_fetch_latest_version_parses_manifest()
    test_remove_failure_does_not_block_add()
    test_skill_source_uses_skill_id_not_server_name()
    print("ALL PASS")
