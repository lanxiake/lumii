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

    # 配置文件不存在 ⇒ **替它建**（那正是客户端自己的 UI 也会做的事）。
    # "不给**没装的**客户端造配置"这条纪律在 `clients()` 的 `detected` 那一层把关，不在这一层。
    q = os.path.join(d, "sub", "new.json")
    assert I.json_client_apply("X", q, "n", ENTRY)[0] == "ok"
    assert json.load(open(q, encoding="utf-8"))["mcpServers"]["n"] == ENTRY
    # 连可写路径都没有 ⇒ skip（不是我们的错，也别抛）
    assert I.json_client_apply("X", None, "n", ENTRY)[0] == "skip"

    shutil.rmtree(d, ignore_errors=True)
    print("ok json_client_refuses_garbage")


def test_jsonc_with_comments_is_refused_not_rewritten():
    """**JSONC 里有注释就拒绝写**——写回是重新序列化，会把用户手写的注释抹掉。

    OpenCode 的 `opencode.json` 和 Zed 的 `settings.json` 都是 JSONC（Zed 出厂设置自带大段注释）。
    宁可不装，也不能洗掉用户写的东西；拒绝时要把**能直接粘的片段**给出去，别只说"不支持"。
    """
    d = tempfile.mkdtemp(prefix="install_")
    p = os.path.join(d, "opencode.json")
    body = ('{\n  // 我的注释：别删我\n  "theme": "dark",\n'
            '  "mcp": {}\n}\n')
    open(p, "w", encoding="utf-8").write(body)
    ent = I.JSON_SHAPES["json_opencode"][1](r"C:\a\x.exe")
    try:
        st, detail = I.json_client_apply("OpenCode", p, "wechat-file", ent, "mcp")
        assert st == "fail", (st, detail)
        assert "丢掉你的注释" in detail, detail
        assert '"mcp"' in detail and "wechat-file" in detail, "得给出可直接粘的片段"
        assert open(p, encoding="utf-8").read() == body, "拒绝就得**一个字节都不动**"

        # 同样内容、把注释去掉 ⇒ 照常写
        open(p, "w", encoding="utf-8").write('{\n  "theme": "dark",\n  "mcp": {}\n}\n')
        assert I.json_client_apply("OpenCode", p, "wechat-file", ent, "mcp")[0] == "ok"
        got = json.load(open(p, encoding="utf-8"))
        assert got["theme"] == "dark", "别人的键要留着"
        assert got["mcp"]["wechat-file"]["command"] == [r"C:\a\x.exe"]

        # 既不是 JSON 也不是 JSONC（尾逗号）⇒ 还是 fail-closed，别假装读懂了
        open(p, "w", encoding="utf-8").write('{"a": 1,}')
        st2, _ = I.json_client_apply("OpenCode", p, "wechat-file", ent, "mcp")
        assert st2 == "fail", st2
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print("ok jsonc_with_comments_is_refused_not_rewritten")


def test_install_skips_undetected_clients():
    """**"客户端在不在"是唯一闸门**：没装的客户端一个字节都不许碰（连目录都不建）。

    顺带钉住新装法的两条：注册的路径**就是这份 exe 自己**（不拷贝），台账里记下装到了哪家。
    """
    d = tempfile.mkdtemp(prefix="install_")
    touched = []
    old = (I.clients, I.own_exe, I._say, I.data_root, I._read_installed, I.skill_apply)
    I.data_root = lambda: os.path.join(d, "lumii")
    I._read_installed = lambda p: {}
    I._say = lambda *a, **k: None
    I.skill_apply = lambda spec, remove=False, exe=None: []
    mine = os.path.join(d, "下载", "wechat-file-mcp.exe")      # "我"就是这份 exe
    I.own_exe = lambda: mine
    I.clients = lambda: [
        {"key": "installed", "label": "装了", "kind": "json_mcp",
         "path": os.path.join(d, "ok.json"), "detected": True},
        {"key": "absent", "label": "没装", "kind": "json_mcp",
         "path": os.path.join(d, "nope", "x.json"), "detected": False}]
    real = I.json_client_apply

    def spy(label, path, name, entry, top_key="mcpServers"):
        touched.append(label)
        assert entry["command"] == mine, f"注册的得是当前这份 exe，实际：{entry}"
        return real(label, path, name, entry, top_key)

    I.json_client_apply = spy
    try:
        I.do_install({"name": "wechat-file", "product": "wechat-file-mcp",
                      "version": "1.0", "label": "X"})
        assert touched == ["装了"], f"只该碰装了的那家，实际：{touched}"
        assert not os.path.isdir(os.path.join(d, "nope")), "没装的那个连目录都不该建"
        # **不拷贝**：状态目录里只该有那份台账（老装法会往里拷一份 10MB 的 exe）
        sdir = I.install_dir("wechat-file-mcp")
        assert sorted(os.listdir(sdir)) == ["installed.json"], os.listdir(sdir)
        rec = json.load(open(I.installed_record_path("wechat-file-mcp"), encoding="utf-8"))
        assert rec["exe"] == mine, rec
        assert rec["clients"] == ["installed"], f"只记真注册成的那家：{rec}"
    finally:
        (I.clients, I.own_exe, I._say, I.data_root, I._read_installed,
         I.skill_apply) = old
        I.json_client_apply = real
        shutil.rmtree(d, ignore_errors=True)
    print("ok install_skips_undetected_clients")


def test_skill_apply_roundtrip():
    """技能包整体拷进 / 整体删掉（**两家客户端各一份**）；源不存在时别把空目录拷出去。"""
    d = tempfile.mkdtemp(prefix="install_")
    src = os.path.join(d, "src", "wechat-file-mcp")
    os.makedirs(os.path.join(src, "refs"))
    open(os.path.join(src, "SKILL.md"), "w", encoding="utf-8").write("hello")
    open(os.path.join(src, "refs", "a.txt"), "w", encoding="utf-8").write("x")

    r1, r2 = os.path.join(d, "claude-skills"), os.path.join(d, "codex-skills")
    old = I.skill_targets
    I.skill_targets = lambda p: [
        {"label": "Claude Code", "kind": "skill_dir", "resolved": r1},
        {"label": "通用 skills", "kind": "skill_dir", "resolved": r2}]
    spec = {"name": "wechat-file", "product": "wechat-file-mcp", "skill": src}
    try:
        rows = I.skill_apply(spec)
        assert [r[0] for r in rows] == ["Claude Code", "通用 skills"], rows
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

        I.skill_targets = lambda p: []                     # 一个客户端都没有
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


def test_every_write_target_lives_under_home_or_appdata():
    """**结构性守卫**：我们**所有会写东西的地方**都必须只经由 `~` / `%APPDATA%` 解析。

    为什么需要这条（**被咬过两次**）：
      ① `do_install` 里没打桩 `codex_apply` ⇒ 真把 `[mcp_servers.wechat-file]` 写进了用户的
         `~/.codex/config.toml`（那里有明文 API key）；
      ② 后来打了 `deploy_self` 的桩、却**没打 `data_root`** ⇒ `_write_installed` 真把
         `{"exe": "C:\\fake\\x.exe"}` 写进了 `~/.lumii/mcp/wechat-file-mcp/installed.json`。

    **逐点打桩一定会漏**（第二次漏的就是"我们自己的目录"）。这条是**面**上防的：
    把两个根都指到临时目录后，任何一条仍指向真实位置的路径都会当场露出来——
    不管是客户端配置，还是我们自己落的东西。
    """
    d = tempfile.mkdtemp(prefix="install_")
    old = {k: os.environ.get(k) for k in ("USERPROFILE", "HOME", "APPDATA")}
    try:
        os.environ["USERPROFILE"] = d
        os.environ["HOME"] = d
        os.environ["APPDATA"] = os.path.join(d, "AppData", "Roaming")
        roots = [os.path.join(d, "AppData", "Roaming"), d]
        paths = []
        for spec in I.CLIENTS:                     # 注册表里每一条的**每个候选路径**都要在根底下
            for t in spec.get("paths", ()):
                p = I._client_path(t)
                if p:
                    paths.append(p)
            if spec.get("detect"):
                p = I._client_path(spec["detect"])
                if p:
                    paths.append(p)
        for spec in I.SKILL_TARGETS:          # 技能落点也得在根底下
            p = I._client_path(spec.get("root") or spec.get("path") or ())
            if p:
                paths.append(p)
        # **我们自己的写入落点**也得在根底下（第二次就是漏了这一类）
        paths += [I.data_root(), I.install_dir("wechat-file-mcp"),
                  I.installed_record_path("wechat-file-mcp"),
                  I.legacy_install_dir("wechat-file-mcp")]
        bad = [p for p in paths if not p or not any(
            os.path.normcase(p).startswith(os.path.normcase(r)) for r in roots)]
        assert not bad, f"这些路径没走 ~ / %APPDATA%，测试改根也拦不住：{bad}"
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(d, ignore_errors=True)
    print("ok every_write_target_lives_under_home_or_appdata")


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


def test_pick_clients_by_keys():
    """**只用方向键和空格**勾客户端——不打字（用户明确要求）。

    盯三件事：① 不用打字；② 光标**只停在能选的行上**（没装的不停）；③ ↑/↓ 要**看得见地**动
    （只改 `cur` 不重画＝用户按了没动静，正是"上下键不动、只有左右键动"那个报障的根因）。
    `keys` 注入的是规范化记号（`up`/`down`/`toggle`/`all`/`enter`/`quit`），真机上由 `msvcrt`
    逐键读出来——注入路径**绕过渲染**，所以重画得单独断言。
    """
    cs = [{"key": "a", "label": "A", "detected": True},
          {"key": "b", "label": "B", "detected": True},
          {"key": "c", "label": "C", "detected": False}]
    out, old_emit = [], I._emit
    I._emit = lambda s: out.append(s)
    try:
        assert I.pick_clients(cs, keys=["enter"]) == {"a", "b"}, "回车 = 已装的全勾"
        assert I.pick_clients(cs, keys=["toggle", "enter"]) == {"b"}, "空格切掉第一项"
        assert I.pick_clients(cs, keys=["down", "toggle", "enter"]) == {"a"}, "↓ 切第二项"
        assert I.pick_clients(cs, keys=["all", "enter"]) == set(), "a = 全不选"
        assert I.pick_clients(cs, keys=["all", "all", "enter"]) == {"a", "b"}, "再按 a = 全选"
        # 光标只在**可选**行间走：a → b → 绕回 a，从不落到没装的 c 上
        assert I.pick_clients(cs, keys=["down", "down", "toggle", "enter"]) == {"b"}
        assert I.pick_clients(cs, keys=["quit"]) == {"a", "b"}, "Esc = 保持现状退出"
        # ↑/↓ 得**当场**重画：不重画的话屏幕上的 `>` 不动（注入路径没有渲染，只能查 _emit 的文本；
        # 用 quit 收尾＝不许拿后面 enter 那一次重画来顶替）
        out.clear()
        I.pick_clients(cs, keys=["up", "quit"])            # a → 绕回 b（c 没装，不停）
        assert "> [✓] B" in out[-1], "↑/↓ 之后光标得真的画出来"
        # 认不出的键（←/→ 解出来的 "?" 就在这）**不动光标**——以前它跟着 ↓ 走一格，
        # 才显得"只有左右键在选"
        assert I.pick_clients(cs, keys=["x", "toggle", "enter"]) == {"b"}
        # 全都没装 ⇒ 没有可选行，直接返回空，不能卡住
        assert I.pick_clients([{"key": "c", "label": "C", "detected": False}], keys=[]) == set()
        # 预勾选（卸载路径用）+ 退化路径（没真控制台时仍认打字）
        assert I.pick_clients(cs, keys=["enter"], prechecked={"b"}) == {"b"}
        assert I._pick_clients_typed(cs, "t", _once(), {"a", "b"}) == {"a", "b"}
        assert I._pick_clients_typed(cs, "t", _once("2"), {"a", "b"}) == {"a"}
        assert any("↑/↓" in s for s in out), "得把怎么操作写出来"
    finally:
        I._emit = old_emit
    print("ok pick_clients_by_keys")


def test_pick_one_by_keys():
    """单选菜单（已装过时的"重装/卸载/退出"岔路）：↑/↓ 移动、回车选定。"""
    out, old_emit = [], I._emit
    I._emit = lambda s: out.append(s)
    try:
        opts = ["重装", "卸载", "退出"]
        assert I.pick_one("做什么？", opts, keys=["enter"]) == 0, "回车 = 默认项"
        assert I.pick_one("做什么？", opts, keys=["down", "enter"]) == 1
        assert I.pick_one("做什么？", opts, keys=["up", "enter"]) == 2, "↑ 从第一项绕到最后一项"
        assert I.pick_one("做什么？", opts, default=2, keys=["enter"]) == 2
        assert I.pick_one("做什么？", opts, keys=["quit"]) == 2, "Esc 落到「退出」（安全侧）"
    finally:
        I._emit = old_emit
    print("ok pick_one_by_keys")


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
        assert I.interactive(spec, ask=lambda p: True, keys=["toggle", "enter"]) == 0
        assert calls == [("install", set()), "pause"], f"勾选结果要原样传给 do_install：{calls}"

        # 拒绝确认 ⇒ 连装都不该跑
        calls.clear()
        assert I.interactive(spec, ask=lambda p: False, keys=["enter"]) == 0
        assert calls == ["pause"], f"拒绝了就什么都不该做：{calls}"

        # 回车走默认（勾上已装的 A）
        calls.clear()
        assert I.interactive(spec, ask=lambda p: True, keys=["enter"]) == 0
        assert calls == [("install", {"a"}), "pause"], calls
        assert not ran, "没声明 daemon_install 的产品不该去碰自启"

        # 带常驻的产品：装完会问一句，同意就调自启
        calls.clear(), ran.clear()
        I.interactive({**spec, "daemon_install": "--install-autostart"},
                      ask=lambda p: True, keys=["enter"])
        assert ran and ran[0][-1] == "--install-autostart", f"该顺带装常驻：{ran}"

        # 一个客户端都没检测到 ⇒ 只部署，不注册，且不该卡在菜单上
        calls.clear()
        I.clients = lambda: [{"key": "a", "label": "A", "kind": "json",
                              "path": "p", "detected": False}]
        assert I.interactive(spec, ask=lambda p: True, keys=["enter"]) == 0
        assert calls == [("install", set()), "pause"], calls
    finally:
        (I.do_install, I._say, I._pause, I._own_command, I.subprocess.run, I.install_dir,
         I.clients) = old
        shutil.rmtree(d, ignore_errors=True)
    print("ok interactive_wizard")


def test_wizard_uninstall_branch():
    """已经装过时，向导要先给岔路；选「卸载」→ **只摘你勾的那些客户端**（不是全摘）。

    卸载那条路必须支持"只卸某个客户端"——装的时候能挑，卸的时候只能全摘，是不对称的。
    """
    d = tempfile.mkdtemp(prefix="install_")
    calls = []
    old = (I.do_install, I.do_uninstall, I._say, I._pause, I.install_dir, I.clients,
           I._read_installed, I.data_root, I.pick_one)
    I.data_root = lambda: d
    I._say = lambda *a, **k: None
    I._pause = lambda: calls.append("pause")
    I.install_dir = lambda p: os.path.join(d, p)
    I._read_installed = lambda p: {"version": "1.0"}          # 假装已经装过
    I.do_install = lambda spec, only=None: (calls.append(("install", only)), 0)[1]
    I.do_uninstall = lambda spec, only=None: (calls.append(("uninstall", only)), 0)[1]
    I.clients = lambda: [{"key": "a", "label": "A", "kind": "json", "path": "p", "detected": True},
                         {"key": "b", "label": "B", "kind": "json", "path": "p", "detected": True}]
    spec = {"name": "wechat-file", "product": "wechat-file-mcp", "version": "1.0", "label": "X"}
    try:
        # 岔路选「卸载」；卸载菜单里空格切掉 A，只留 B
        I.pick_one = lambda title, opts, keys=None, default=0: 1
        I.interactive(spec, ask=lambda p: True, keys=["toggle", "enter"])
        assert ("uninstall", {"b"}) in calls, f"该只摘 B，实际：{calls}"
        assert not [c for c in calls if isinstance(c, tuple) and c[0] == "install"], calls

        # 岔路选「重装」：走正常安装，勾选菜单回车 = 全勾
        calls.clear()
        I.pick_one = lambda title, opts, keys=None, default=0: 0
        I.interactive(spec, ask=lambda p: True, keys=["enter"])
        assert ("install", {"a", "b"}) in calls, calls

        # 岔路选「退出」：什么都不做
        calls.clear()
        I.pick_one = lambda title, opts, keys=None, default=0: 2
        I.interactive(spec, ask=lambda p: True, keys=["enter"])
        assert calls == ["pause"], f"选退出就该什么都不做：{calls}"

        # 没装过 ⇒ **不出现岔路**（首次用户不该为常见路径多按一次键）
        calls.clear()
        I._read_installed = lambda p: {}
        I.pick_one = lambda *a, **k: (_ for _ in ()).throw(AssertionError("首次不该问岔路"))
        I.interactive(spec, ask=lambda p: True, keys=["enter"])
        assert ("install", {"a", "b"}) in calls, calls
    finally:
        (I.do_install, I.do_uninstall, I._say, I._pause, I.install_dir, I.clients,
         I._read_installed, I.data_root, I.pick_one) = old
        shutil.rmtree(d, ignore_errors=True)
    print("ok wizard_uninstall_branch")


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


def test_own_exe_in_source_mode():
    """源码模式下没有"这份 exe"——`own_exe()` 给 `None`，调用方退回"解释器 + 脚本路径"。

    老装法在这里拷 `sys.executable`（那时是 python.exe），拷过去是错的；新装法连拷都不拷。
    """
    assert not getattr(sys, "frozen", False), "这条只在源码模式有意义"
    assert I.own_exe() is None
    cmd, args = I._own_command()
    assert "thon" in os.path.basename(cmd) and args, (cmd, args)
    print("ok own_exe_in_source_mode")


class _R:
    def __init__(self, rc=0):
        self.returncode, self.stdout, self.stderr = rc, b"", b""


def _uninstall_fixture(report):
    """卸载用例的公共布景：一份"用户的 exe"+一条记着它的台账，桩掉一切对外副作用。"""
    d = tempfile.mkdtemp(prefix="install_")
    exe = os.path.join(d, "下载", "wechat-recall-mcp.exe")
    os.makedirs(os.path.dirname(exe))
    open(exe, "w").close()
    spec = {"name": "wechat-recall", "product": "wechat-recall-mcp", "version": "1.0",
            "label": "撤回防护", "daemon_uninstall": "--uninstall-autostart"}
    old = (I.data_root, I.own_exe, I._say, I.clients, I.skill_apply, I.unregister_client,
           I.legacy_install_dir, I.subprocess.run)
    I.data_root = lambda: os.path.join(d, "lumii")
    I.own_exe = lambda: exe
    I._say = lambda *a, **k: None
    I.legacy_install_dir = lambda p: os.path.join(d, "老地方", p)
    I.clients = lambda: [{"key": "a", "label": "A", "kind": "json_mcp", "path": "p",
                          "detected": True},
                         {"key": "b", "label": "B", "kind": "json_mcp", "path": "p",
                          "detected": True}]
    I.unregister_client = lambda c, n: (report.append(("摘", c["key"])), ("ok", ""))[1]
    I.skill_apply = lambda spec, remove=False, exe=None: (
        report.append(("技能", remove)), [("Claude Code", "ok", "")])[1]
    I.subprocess.run = lambda cmd, **k: (report.append(("守护", cmd[-1])), _R())[1]
    I._write_installed("wechat-recall-mcp", spec, exe, clients=["a", "b"])
    return d, exe, spec, old


def _uninstall_teardown(d, old):
    (I.data_root, I.own_exe, I._say, I.clients, I.skill_apply, I.unregister_client,
     I.legacy_install_dir, I.subprocess.run) = old
    shutil.rmtree(d, ignore_errors=True)


def test_uninstall_keeps_the_exe_and_drops_only_our_ledger():
    """**卸载不许删 exe**——那是用户自己下载、自己放着的文件；我们只收自己的台账。

    老装法把 exe 拷进 `~/.lumii/mcp/`，删掉无所谓；现在注册进客户端的就是用户手上那份，
    删了等于把人家的安装弄坏，而且客户端配置还在指着它。
    """
    report = []
    d, exe, spec, old = _uninstall_fixture(report)
    try:
        assert I.do_uninstall(spec) == 0
        assert os.path.isfile(exe), "**卸载把用户的 exe 删了**"
        assert not os.path.isfile(I.installed_record_path("wechat-recall-mcp")), "台账该收掉"
        assert not os.path.isdir(I.data_root()), "自己建的目录该收干净"
        assert ("摘", "a") in report and ("摘", "b") in report, report
        assert ("技能", True) in report, report
        assert ("守护", "--uninstall-autostart") in report, report
    finally:
        _uninstall_teardown(d, old)
    print("ok uninstall_keeps_the_exe_and_drops_only_our_ledger")


def test_partial_uninstall_keeps_skills_and_daemon():
    """只从**某些**客户端里摘 ⇒ 技能包与常驻守护都不许动（用户只是想从那一家退出来）。"""
    report = []
    d, exe, spec, old = _uninstall_fixture(report)
    try:
        assert I.do_uninstall(spec, only={"a"}) == 0
        assert ("摘", "a") in report and ("摘", "b") not in report, report
        assert not [r for r in report if r[0] in ("技能", "守护")], f"部分卸载误动了：{report}"
        assert os.path.isfile(I.installed_record_path("wechat-recall-mcp")), "还有别家指着它，台账得留"
        assert os.path.isfile(exe)
    finally:
        _uninstall_teardown(d, old)
    print("ok partial_uninstall_keeps_skills_and_daemon")


def test_legacy_copy_is_claimed_by_the_ledger_only():
    """老装法拷到 `~/.lumii/mcp/<产品>/` 的那份：**只认老台账记着的路径**才删。

    那个目录里可能躺着**别人放的东西**（主产品的 exe 就是 App 自己部署在那儿的），
    按文件名认领会误删别的产品/App 的东西。
    """
    d = tempfile.mkdtemp(prefix="install_")
    ldir = os.path.join(d, "mcp", "wechat-file-mcp")
    old = (I.legacy_install_dir, I.own_exe)
    I.legacy_install_dir = lambda p: os.path.join(d, "mcp", p)
    I.own_exe = lambda: os.path.join(d, "下载", "wechat-file-mcp.exe")
    try:
        os.makedirs(ldir)
        victim = os.path.join(ldir, "wechat-file-mcp.exe")
        open(victim, "w").close()
        # ① 没有老台账 ⇒ 一个字节都不认领（那份 exe 可能就是 App 部署的）
        assert I._drop_legacy_copy("wechat-file-mcp") == []
        assert os.path.isfile(victim), "没台账就不许按文件名认领"
        # ② 台账记的**不是**这个目录里的东西 ⇒ 同样不动
        I._write_cfg(os.path.join(ldir, "installed.json"), {"exe": r"C:\别处\x.exe"})
        assert I._drop_legacy_copy("wechat-file-mcp") == []
        assert os.path.isfile(victim), "台账指向别处，就不该删这儿的文件"
        # ③ 台账记着它 ⇒ 连 `*.old-*` 残留与老台账一起清掉，目录空了就 rmdir
        open(victim + ".old-1", "w").close()
        I._write_cfg(os.path.join(ldir, "installed.json"), {"exe": victim})
        gone = I._drop_legacy_copy("wechat-file-mcp")
        assert sorted(gone) == ["installed.json", "wechat-file-mcp.exe",
                                "wechat-file-mcp.exe.old-1"], gone
        assert not os.path.isdir(ldir), "清干净了就 rmdir"
    finally:
        (I.legacy_install_dir, I.own_exe) = old
        shutil.rmtree(d, ignore_errors=True)
    print("ok legacy_copy_is_claimed_by_the_ledger_only")


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
    """装了要登记版本；`--install-status` 靠它对账——**不去启动那份 exe**（onefile 冷启动 1–3s）。"""
    d = tempfile.mkdtemp(prefix="install_")
    old_root, old_say, old_skills, old_codex = I.data_root, I._say, I.skill_targets, I.CODEX_CONFIG
    old_clients, old_legacy = I.clients, I.legacy_install_dir
    I.data_root = lambda: d
    I.legacy_install_dir = lambda p: os.path.join(d, "老地方", p)   # 别去读真机上那份老台账
    # **别碰真实的 ~/.claude/skills 与 ~/.codex/config.toml**；
    # `clients()` 也打桩——否则 `do_status` 会去 spawn 真的 `claude mcp get`（慢且碰真实配置）
    I.skill_targets = lambda p: [
        {"label": "Claude Code", "kind": "skill_dir",
         "resolved": os.path.join(d, "skills")}]
    I.CODEX_CONFIG = (d, "codex-config.toml")
    I.clients = lambda: [{"key": "claude-code", "label": "Claude Code", "kind": "claude_code",
                          "path": None, "detected": False}]
    out = []
    I._say = lambda *a, **k: out.append(" ".join(str(x) for x in a))
    try:
        spec = {"name": "wechat-file", "product": "wechat-file-mcp", "version": "0.5.0",
                "label": "文件归档", "skill": "/nope"}
        os.makedirs(I.install_dir("wechat-file-mcp"))
        exe = os.path.join(d, "下载", "wechat-file-mcp.exe")     # 得**真存在**，否则先撞上下面那条
        os.makedirs(os.path.dirname(exe))
        open(exe, "w").close()
        I._write_installed("wechat-file-mcp", spec, exe)
        assert I._read_installed("wechat-file-mcp")["version"] == "0.5.0"

        # 跑的是新版、装的是旧版 ⇒ 必须**报出来**（这正是"没人提醒你该升"的那个洞）
        out.clear()
        I.do_status({**spec, "version": "0.6.0"})
        assert any("重跑 --install" in s for s in out), out

        out.clear()                                  # 一致 ⇒ 不告警
        I.do_status(spec)
        assert any("与当前一致" in s for s in out), out
        assert not any("重跑 --install" in s for s in out), out

        # 新装法独有的失效模式：注册进客户端的就是**这份 exe 本身**，挪走/删掉就废了。
        # 状态必须把这条点出来——否则用户看到全绿，客户端那边却永远连不上。
        os.remove(exe)
        out.clear()
        I.do_status(spec)
        assert any("注册的路径已经不在了" in s for s in out), out

        # 技能包那一行必须按**技能 id**（= product）找目录，不是按服务名。
        # 真机踩过：明明装了却报"没装"（和 skill_apply 同一个坑的第二处，别各写各的）。
        os.makedirs(os.path.join(d, "skills", "wechat-file-mcp"), exist_ok=True)
        out.clear()
        I.do_status(spec)
        skill_line = [s for s in out if "技能·" in s]
        assert skill_line and "没装" not in skill_line[0], skill_line
    finally:
        (I.data_root, I._say, I.skill_targets, I.CODEX_CONFIG, I.clients,
         I.legacy_install_dir) = (
            old_root, old_say, old_skills, old_codex, old_clients, old_legacy)
        shutil.rmtree(d, ignore_errors=True)
    print("ok installed_record_roundtrip_and_stale_detection")


# 注：这里原本有 `--check-update` 与发布清单解析两条测试。
# 2026-10-13 把那半个联网功能摘掉了（本产品不做对外发布，没有发布通道 ⇒ 永远 404），
# 测试随之删除。**本模块现在一条网络请求都不发**——与红线「本地处理、不外传」一致。


def test_per_client_json_shapes():
    """各家 JSON 的**顶层键和条目形状都不一样**——照抄一种会写出对方读不懂的配置。

    调研（2026-10-13）拍到的差异：
      - 大多数：顶层 `mcpServers`，条目 `{type,command,args,env}`
      - VS Code：顶层 **`servers`**，条目**没有 env**
      - Zed：顶层 **`context_servers`**，条目**没有 type**
      - OpenCode：顶层 **`mcp`**，`command` 是**数组**（argv），env 叫 **`environment`**，还要 `enabled`
    """
    d = tempfile.mkdtemp(prefix="install_")
    exe = r"C:\a\wechat-file-mcp.exe"
    try:
        for kind, top, checks in (
            ("json_mcp", "mcpServers",
             lambda e: e["command"] == exe and e["type"] == "stdio" and e["args"] == []),
            ("json_servers", "servers",
             lambda e: e["command"] == exe and e["type"] == "stdio" and "env" not in e),
            ("json_context", "context_servers",
             lambda e: e["command"] == exe and "type" not in e),
            ("json_opencode", "mcp",
             lambda e: e["command"] == [exe] and e["type"] == "local"
                       and e["environment"] == {} and e["enabled"] is True),
        ):
            p = os.path.join(d, f"{kind}.json")
            ent = I.JSON_SHAPES[kind][1](exe)
            assert I.json_client_apply(kind, p, "wechat-file", ent, top)[0] == "ok"
            data = json.load(open(p, encoding="utf-8"))
            assert top in data and "wechat-file" in data[top], (kind, data)
            got = data[top]["wechat-file"]
            assert checks(got), (kind, got)          # 形状对得上
            # 注销也得认同一个顶层键
            assert I.json_client_apply(kind, p, "wechat-file", None, top)[0] == "ok"
            assert "wechat-file" not in json.load(open(p, encoding="utf-8"))[top], kind
        # 顶层键确实是**四家不同的**（不是照抄一个）
        assert len({I.JSON_SHAPES[k][0] for k in
                    ("json_mcp", "json_servers", "json_context", "json_opencode")}) == 4
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print("ok per_client_json_shapes")


def test_client_registry_is_sane():
    """注册表本身的两条硬要求：键唯一、**每家都给了路径或 CLI**（否则那条永远没法装）。"""
    keys = [c["key"] for c in I.CLIENTS]
    assert len(keys) == len(set(keys)), f"key 撞了：{keys}"
    for spec in I.CLIENTS:
        if spec["kind"] == "claude_code":
            continue
        assert spec.get("paths"), f"{spec['key']} 没有可用路径"
        assert spec["kind"] in I.JSON_SHAPES or spec["kind"] == "toml_codex", spec["kind"]
    # 刻意没做的必须留下**理由**，不然以后有人会以为漏了
    src = open(I.__file__, encoding="utf-8").read()
    for skipped, why in (("Continue", "YAML"), ("Aider", "MCP"),
                         ("JetBrains", "配置文件"), ("Windsurf", "顶层键")):
        assert skipped in src, f"跳过的 {skipped} 该在注释里写明理由"
    print("ok client_registry_is_sane")


def test_merge_block_is_reversible_and_delimited():
    """往**用户自己的指令文件**里合并一段——必须可逆、可辨识、不碰别的内容。

    这是三种落点里唯一会动到"用户自己写的文件"的一种（skills 目录、规则文件都是往空位放）。
    所以三条硬要求：**追加不插中间**、**带分隔标记**（卸载时精确摘掉）、**改前备份**。
    """
    d = tempfile.mkdtemp(prefix="install_")
    p = os.path.join(d, "AGENTS.md")
    mine = "# 我的个人规则\n\n- 永远用中文回答\n"
    open(p, "w", encoding="utf-8").write(mine)
    B, E = (I.BLOCK_BEGIN.format(p="wechat-file-mcp"), I.BLOCK_END.format(p="wechat-file-mcp"))
    try:
        assert I.merge_block_apply(p, "wechat-file-mcp", "## 某 MCP\n用法…\n")[0] == "ok"
        got = open(p, encoding="utf-8").read()
        assert got.startswith("# 我的个人规则"), "用户原有内容要原样在前面（追加，不插中间）"
        assert "- 永远用中文回答" in got and B in got and E in got
        assert os.path.isfile(p + ".bak"), "改前要备份"

        # 幂等：再合并一次**原地替换**，不该出现两段
        I.merge_block_apply(p, "wechat-file-mcp", "## 某 MCP\n用法…（改过）\n")
        got2 = open(p, encoding="utf-8").read()
        assert got2.count(B) == 1 and "改过" in got2, got2

        # 卸载：只摘我们那段，**用户的内容一个字节不动**
        assert I.merge_block_apply(p, "wechat-file-mcp", None)[0] == "ok"
        back = open(p, encoding="utf-8").read()
        assert "某 MCP" not in back and B not in back and E not in back, back
        assert back.startswith("# 我的个人规则") and "- 永远用中文回答" in back, back
        assert I.merge_block_apply(p, "wechat-file-mcp", None)[0] == "skip"

        # 文件本来不存在 ⇒ **新建**（客户端装了、文件还没建过，这是正常情况）
        q = os.path.join(d, "sub", "AGENTS.md")
        assert I.merge_block_apply(q, "wechat-file-mcp", "正文")[0] == "ok"
        assert B in open(q, encoding="utf-8").read()
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print("ok merge_block_is_reversible_and_delimited")


def test_pointer_block_and_rule_file():
    """**指令文件里只放一小段**（那些文件每轮都进上下文），且要点必须齐：路径 + 错误码怎么读。

    为什么不塞整份技能：skills 是渐进披露、用到才进上下文；`AGENTS.md`/`GEMINI.md` 不是。
    把几百行塞进去等于每轮都在烧用户的 token。
    """
    d = tempfile.mkdtemp(prefix="install_")
    spec = {"name": "wechat-file", "product": "wechat-file-mcp", "label": "微信文件归档"}
    exe = r"C:\Users\a\.lumii\mcp\wechat-file-mcp\wechat-file-mcp.exe"
    ptr = I.pointer_block(spec, exe)
    assert exe in ptr, "得写清 exe 在哪（这就是'让 AI 自己配'的前提）"
    for code in ("target_not_found", "env_not_ready", "bad_args", "expired"):
        assert code in ptr, f"错误码 {code} 的处置要写进去"
    assert "本地处理" in ptr and len(ptr) < 1500, f"指路块要短（{len(ptr)} 字）"

    # 规则文件：写的是**纯正文**（不带 SKILL.md 的 frontmatter），且 `{{EXE}}` 要落成真路径
    src = os.path.join(d, "src", "wechat-file-mcp")
    os.makedirs(src)
    with open(os.path.join(src, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write("---\nname: wechat-file-mcp\ndescription: x\n---\n\n# 正文\ncli: \"{{EXE}}\"\n")
    body = I.skill_body({"name": "wechat-file", "product": "wechat-file-mcp", "skill": src})
    assert body.startswith("# 正文"), f"frontmatter 要剥掉：{body[:40]!r}"
    assert "name: wechat-file-mcp" not in body

    out = os.path.join(d, "rules", "x.md")
    assert I._write_rule(out, body.replace("{{EXE}}", exe))[0] == "ok"
    got = open(out, encoding="utf-8").read()
    assert exe in got and "{{" not in got
    assert I._remove_file(out)[0] == "ok" and not os.path.isfile(out)
    assert I._remove_file(out)[0] == "skip", "再删 = skip"
    shutil.rmtree(d, ignore_errors=True)
    print("ok pointer_block_and_rule_file")


def test_fill_skill_bakes_the_deployed_path():
    """技能里要落**部署后的真实路径**——AI 客户端读技能就能自己把 MCP 配好，用户不必知道 exe 在哪。

    两个语法各一份：散文/shell 用 `{{EXE}}`，**JSON 片段用 `{{EXE_JSON}}`（反斜杠双写）**
    ——不双写那段 JSON 是**非法**的，而 AI 很可能直接照抄。
    """
    d = tempfile.mkdtemp(prefix="install_")
    os.makedirs(os.path.join(d, "sub"))
    p = os.path.join(d, "SKILL.md")
    with open(p, "w", encoding="utf-8") as f:
        f.write('cli: -- "{{EXE}}"\njson: "command": "{{EXE_JSON}}"\n普通行\n')
    with open(os.path.join(d, "sub", "ref.md"), "w", encoding="utf-8") as f:
        f.write("x {{EXE}} y")
    exe = r"C:\Users\a\.lumii\mcp\wechat-file-mcp\wechat-file-mcp.exe"
    try:
        assert I.fill_skill(d, exe) == 2, "两个文件都该被填"
        got = open(p, encoding="utf-8").read()
        assert exe in got, got
        assert exe.replace("\\", "\\\\") in got, "JSON 版必须双写反斜杠"
        assert "{{" not in got, got
        assert "普通行" in got, "别的行不该动"
        assert exe in open(os.path.join(d, "sub", "ref.md"), encoding="utf-8").read(), "子目录也要走到"

        # 没有可写的路径（源码模式）⇒ 一个都不填，占位符原样留着：宁可露馅，也别悄悄填个空的
        open(p, "w", encoding="utf-8").write("x {{EXE}} y")
        assert I.fill_skill(d, "") == 0
        assert "{{EXE}}" in open(p, encoding="utf-8").read()
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print("ok fill_skill_bakes_the_deployed_path")


def test_no_network_code_in_install_or_expiry():
    """**结构性守卫**：安装与有效期这条路上，一条网络请求都不许有。

    产品红线是「本地处理、**不外传**」（设计 §10）。这里原本有个 `--check-update`（查远端有没有
    新版），2026-10-13 因为**不做对外发布**摘掉了——没有发布通道 ⇒ 它永远只能返回 404，
    是个"注定失败的按钮"。这条测试钉住"别再长回来一个偷偷联网的东西"：
    联网代码一旦混进来，用户的会话内容就有被带出去的可能，而那是不可逆的。
    """
    here = os.path.dirname(os.path.abspath(I.__file__))
    for mod in ("mcp_install.py", "builtin_expiry.py"):
        src = open(os.path.join(here, mod), encoding="utf-8").read()
        for bad in ("urllib", "urlopen", "requests.", "socket.", "http://", "https://"):
            assert bad not in src, f"{mod} 里出现了网络代码「{bad}」——与「不外传」冲突"
    print("ok no_network_code_in_install_or_expiry")


def test_remove_failure_does_not_block_add():
    """「先摘再挂」里的**摘**是尽力而为：目标本来就不存在时 `remove` 会失败，
    但**绝不能因此跳过挂载**。

    真机实测就漏在这儿：卸载过之后再装，`claude mcp remove` 报 "No MCP server named …"，
    拿它的结果当闸门的话 `add` 永远不跑——而用户看着"安装"跑完了以为装上了。
    """
    calls = []
    d = tempfile.mkdtemp(prefix="install_")
    # 三个都要打桩，缺一个就会真写进用户目录：
    #   `codex_apply` → `~/.codex/config.toml`（有明文 API key）
    #   `data_root`   → `~/.lumii/...`（**踩过**：`_write_installed` 真写了个 "C:\fake\x.exe" 进去）
    #   `own_exe`     → 真把"这份 exe"写进用户目录
    old = (I.claude_code_apply, I.own_exe, I.skill_apply, I.json_client_apply, I.codex_apply,
           I._say, I.data_root)
    I.data_root = lambda: d
    I.claude_code_apply = lambda name, command=None, args=(): (
        calls.append("remove" if command is None else "add"),
        ("fail", "No MCP server named") if command is None else ("ok", "added"))[1]
    I.own_exe = lambda: r"C:\fake\x.exe"
    I.skill_apply = lambda spec, remove=False, exe=None: [("Claude Code", "ok", r"C:\fake\skill")]
    I.json_client_apply = lambda *a, **k: ("skip", "未安装")
    I.codex_apply = lambda *a, **k: ("skip", "未安装")
    I._say = lambda *a, **k: None
    try:
        rc = I.do_install({"name": "wechat-file", "product": "wechat-file-mcp", "label": "x"})
        assert calls == ["remove", "add"], f"摘失败后必须照样挂，实际：{calls}"
        assert rc == 0, f"摘失败不算安装失败：{rc}"
    finally:
        (I.claude_code_apply, I.own_exe, I.skill_apply, I.json_client_apply,
         I.codex_apply, I._say, I.data_root) = old
        shutil.rmtree(d, ignore_errors=True)
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
    I.skill_targets = lambda p: [
        {"label": "Claude Code", "kind": "skill_dir",
         "resolved": os.path.join(d, "skills")}]
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


def test_skill_landing_name_comes_from_frontmatter():
    """技能**落点的名字**取自 `SKILL.md` 的 frontmatter `name`（不是产品名），并清掉老名字那份。

    pro 版三个名字各不相同：服务名 `wechat-local` / 产品名 `wechat-mcp` / 技能名 `wechat-mcp-pro`。
    按产品名落过的后果实测过：本机 `~/.claude/skills/wechat-mcp-pro` 是 App 装的、安装器去
    `wechat-mcp` 找——状态里报"没装"，卸载也摘不掉；两份并存时客户端还会同时读到。
    """
    d = tempfile.mkdtemp(prefix="install_")
    src = os.path.join(d, "MEI", "skills", "wechat-mcp")
    os.makedirs(src)
    with open(os.path.join(src, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write("---\nname: wechat-mcp-pro\ndescription: x\n---\n\n# 正文\n")
    dst = os.path.join(d, "skills")
    old_targets, old_frozen = I.skill_targets, getattr(sys, "frozen", None)
    I.skill_targets = lambda sid: [{"label": "Claude Code", "kind": "skill_dir",
                                    "root": (d, "skills"), "resolved": dst}]
    sys.frozen = True                                       # 让 skill_source 走 `_MEIPASS`
    old_meipass = getattr(sys, "_MEIPASS", None)
    sys._MEIPASS = os.path.join(d, "MEI")
    spec = {"name": "wechat-local", "product": "wechat-mcp", "version": "1.0", "label": "P"}
    try:
        assert I.skill_id(spec) == "wechat-mcp-pro", I.skill_id(spec)
        os.makedirs(os.path.join(dst, "wechat-mcp"))        # 老装法按产品名落的那份
        open(os.path.join(dst, "wechat-mcp", "旧文件.md"), "w").close()
        rows = I.skill_apply(spec)
        assert rows[0][1] == "ok" and rows[0][2] == os.path.join(dst, "wechat-mcp-pro"), rows
        assert os.path.isfile(os.path.join(dst, "wechat-mcp-pro", "SKILL.md"))
        assert not os.path.isdir(os.path.join(dst, "wechat-mcp")), "老名字那份该被清掉（否则两份都被读）"
        # 卸载：按同一个名字摘，摘得掉（老装法在这儿报"本来就没装"）
        assert I.skill_apply(spec, remove=True)[0][1] == "ok"
        assert not os.path.isdir(os.path.join(dst, "wechat-mcp-pro"))
    finally:
        I.skill_targets = old_targets
        del sys.frozen
        if old_frozen is not None:
            sys.frozen = old_frozen
        if old_meipass is None:
            del sys._MEIPASS
        else:
            sys._MEIPASS = old_meipass
        shutil.rmtree(d, ignore_errors=True)
    print("ok skill_landing_name_comes_from_frontmatter")


def test_wizard_shows_wechat_version_range():
    """双击引导必须写明**适配的微信版本范围**，且与 `wechat_core` 同源。

    抄一份常量就会漂，而漂的方向恰好是最坏的那种：引导里说"支持"，装完每条工具结果
    都挂一句「这版没验过」。所以判据不是"引导里有版本号"，是**引导里的那串等于
    `wechat_core.VERIFIED_VERSION_PREFIXES` 渲染出来的那串**。
    """
    lines = []
    old = (I._say, I._pause, I.do_install, I.clients, I.own_exe)
    I._say = lambda *a, **k: lines.append(" ".join(str(x) for x in a))
    I._pause = lambda: None
    I.do_install = lambda spec, only=None: 0
    I.clients = lambda: []
    I.own_exe = lambda: ""
    try:
        I.interactive({"name": "wechat-local", "product": "wechat-mcp",
                       "version": "0.8.0", "label": "X"}, ask=lambda p: True, keys=["enter"])
    finally:
        (I._say, I._pause, I.do_install, I.clients, I.own_exe) = old

    compat = I.wechat_compat_line()
    assert compat, "取不到 wechat_core 的已验版本（共享层不在 sys.path？）"
    text = "\n".join(lines)
    assert f"适配的微信版本：{compat}" in text, f"引导里没写适配版本：\n{text}"

    import wechat_core
    assert compat == "、".join(f"{p}.x" for p in wechat_core.VERIFIED_VERSION_PREFIXES), \
        f"引导的版本串与 wechat_core 漂了：{compat}"
    print("ok wizard_shows_wechat_version_range")


def test_lumii_is_a_registered_client_and_skill_target():
    """灵栖既是 MCP 客户端，也是技能落点。

    它是这套工具的"主客户端"，用户装的时候最可能就在灵栖里用；漏了它，向导就只会在
    第三方客户端里找落点。两处路径都必须是灵栖真实读的那两条：
      · MCP：`~/.lumii/config/mcp-servers.json`（`mcp-config.ts::getMcpConfigPath`）
      · 技能：`~/.lumii/workspace/skills/<技能 id>`（`directory-manager.ts`）
    """
    lumii = next((c for c in I.CLIENTS if c["key"] == "lumii"), None)
    assert lumii, "CLIENTS 里没有 lumii —— 向导不会把灵栖列为选项"
    assert lumii["kind"] == "json_mcp", lumii
    path = I._client_path(lumii["paths"][0])
    assert os.path.normcase(path).endswith(
        os.path.normcase(os.path.join(".lumii", "config", "mcp-servers.json"))), path
    # 判据别用 `~/.lumii`：四件套自己的数据目录（撤回归档等）也会建它，会误判成"装了灵栖"
    mark = I._client_path(lumii["detect"])
    assert os.path.normcase(mark).endswith(os.path.normcase(os.path.join(".lumii", "config"))), mark

    target = next((t for t in I.SKILL_TARGETS if t["label"] == "Lumii"), None)
    assert target, "SKILL_TARGETS 里没有 Lumii —— 技能不会装进灵栖"
    assert target["kind"] == "skill_dir", target
    root = I._client_path(target["root"])
    assert os.path.normcase(root).endswith(
        os.path.normcase(os.path.join(".lumii", "workspace", "skills"))), root

    # 技能默认目录与真正安装走同一处解析（别另抄一份）
    dirs = dict(I.skill_dir_defaults("wechat-crm-mcp"))
    assert dirs["Lumii"] == os.path.join(root, "wechat-crm-mcp"), dirs
    print("ok lumii_is_a_registered_client_and_skill_target")


def test_wizard_prints_manual_fallback_and_skill_dirs():
    """引导页必须能"整页复制给 AI，让它自己装"。

    所以页面上得有三样机器可用的东西：**MCP 名称**、**可直接粘贴的配置片段**（带真实 exe
    路径，反斜杠要转义）、**技能默认目录**。只写"装不上就找 AI"而页面上没有这些，
    AI 拿到也装不了。

    技能目录的判据不是"字符串出现在输出里"，而是**与 `skill_dir_defaults` 完全一致**——
    它和 `skill_apply` 共用 `_named_path`，另抄一份就会漂。
    """
    lines = []
    exe = r"C:\tools\wechat-mcp\wechat-mcp.exe"
    old = (I._say, I._pause, I.do_install, I.clients, I.own_exe)
    I._say = lambda *a, **k: lines.append(" ".join(str(x) for x in a))
    I._pause = lambda: None
    I.do_install = lambda spec, only=None: 0
    I.clients = lambda: []
    I.own_exe = lambda: exe
    spec = {"name": "wechat-local", "product": "wechat-mcp",
            "version": "0.8.0", "label": "X"}
    try:
        I.interactive(spec, ask=lambda p: True, keys=["enter"])
    finally:
        (I._say, I._pause, I.do_install, I.clients, I.own_exe) = old

    text = "\n".join(lines)
    assert "接下来会做四件事" in text, text
    assert "复制给 AI 客户端" in text, "第 4 条兜底说明没打出来"
    assert "MCP 名称：wechat-local" in text, text
    # 配置片段必须是**合法 JSON**（反斜杠双写），不能只是"看起来像"
    blob = next((ln for ln in lines if "配置片段：" in ln), "")
    assert blob, text
    cfg = json.loads(blob.split("配置片段：", 1)[1])
    assert cfg["mcpServers"]["wechat-local"]["command"] == exe, cfg
    for client_label, dst in I.skill_dir_defaults(I.skill_id(spec)):
        assert f"{client_label}：{dst}" in text, f"技能默认目录少了 {client_label}：{text}"
    print("ok wizard_prints_manual_fallback_and_skill_dirs")


def test_docs_state_wechat_version_range():
    """**文档漂移守卫**：五件套的安装说明里写的微信版本范围，必须与代码同源。

    值不值得一条：`VERIFIED_VERSION_PREFIXES` 改了（加了新版本、或发现某版其实不行），
    README 与技能包**不会报错**——它们只会静静地继续讲老话，而这两处恰好是用户决定
    「装不装、敢不敢信跑出来的数」的地方。判据取 `wechat_compat_line()`（同一个单一来源），
    并按**路径**扫文件而不是点名，免得以后再加档位时漏一个。
    """
    compat = I.wechat_compat_line()
    assert compat, "取不到 wechat_core 的已验版本（共享层不在 sys.path？）"
    res = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # resources/
    docs = []
    for d in sorted(os.listdir(res)):
        if not d.startswith("wechat-") or not os.path.isdir(os.path.join(res, d)):
            continue
        docs.append(os.path.join(res, d, "README.md"))
        sk = os.path.join(res, d, "skills")
        for e in (sorted(os.listdir(sk)) if os.path.isdir(sk) else []):
            docs.append(os.path.join(sk, e, "SKILL.md"))
    docs = [p for p in docs if os.path.exists(p)]
    # 一份都没扫到也算"通过"——那是最坏的一种绿，所以门槛写死
    assert len(docs) >= 9, f"只扫到 {len(docs)} 份安装说明，产物树变了？{docs}"
    miss = [os.path.relpath(p, res) for p in docs
            if compat not in open(p, encoding="utf-8").read()]
    assert not miss, f"这些安装说明里没写已适配的微信版本 {compat}：{miss}"
    print(f"ok 安装说明版本对账：{len(docs)} 份都写了 {compat}")


if __name__ == "__main__":
    test_json_client_add_remove()
    test_json_client_refuses_garbage()
    test_jsonc_with_comments_is_refused_not_rewritten()
    test_install_skips_undetected_clients()
    test_skill_apply_roundtrip()
    test_codex_toml_roundtrip()
    test_every_write_target_lives_under_home_or_appdata()
    test_is_interactive_rejects_nul_stdin()
    test_pick_clients_by_keys()
    test_pick_one_by_keys()
    test_interactive_wizard()
    test_wizard_uninstall_branch()
    test_ask_and_pause_never_hang()
    test_say_never_crashes_on_encoding()
    test_codex_appends_isolated_section()
    test_own_exe_in_source_mode()
    test_uninstall_keeps_the_exe_and_drops_only_our_ledger()
    test_partial_uninstall_keeps_skills_and_daemon()
    test_legacy_copy_is_claimed_by_the_ledger_only()
    test_subprocess_kwargs_are_python_not_node()
    test_consume_flags_routing()
    test_version_compare()
    test_installed_record_roundtrip_and_stale_detection()
    test_per_client_json_shapes()
    test_client_registry_is_sane()
    test_merge_block_is_reversible_and_delimited()
    test_pointer_block_and_rule_file()
    test_fill_skill_bakes_the_deployed_path()
    test_no_network_code_in_install_or_expiry()
    test_remove_failure_does_not_block_add()
    test_skill_source_uses_skill_id_not_server_name()
    test_skill_landing_name_comes_from_frontmatter()
    test_wizard_shows_wechat_version_range()
    test_lumii_is_a_registered_client_and_skill_target()
    test_wizard_prints_manual_fallback_and_skill_dirs()
    test_docs_state_wechat_version_range()
    print("ALL PASS")
