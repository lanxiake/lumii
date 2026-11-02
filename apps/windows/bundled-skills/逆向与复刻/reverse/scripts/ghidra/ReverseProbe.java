// 逆向分析探针：把 Ghidra 静态分析结果输出成 reverse 技能能直接写进 evidence.md 的形态。
//
// 用法（由 SKILL.md 的 Ghidra 段落调用）：
//   analyzeHeadless <projDir> <projName> -import <target> \
//     -scriptPath <技能目录>/scripts/ghidra \
//     -postScript ReverseProbe.java <outFile> [--decompile N]
//
// 输出是**稳定的键值行**（`KEY=value`），不做 markdown——格式由技能负责，
// 这个脚本只保证「同一文件跑两次结果一致」，好让 journal/证据可复查。
//
// 刻意不做的事：
// - 不猜语义（不写「这是个下载器」）——只报结构（函数、导入、字符串、可选反编译）；
// - 不自动解壳（脱壳要交互，硬做只会得到假结论）；
// - 不打印全部 340 个导入——按「高危能力」分类后给出代表项，全量另存。

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;

import java.io.*;
import java.util.*;
import java.util.regex.Pattern;

public class ReverseProbe extends GhidraScript {

    /**
     * 导入名 → 能力标签。用来把几百个导入压成「这程序会联网/起进程/写注册表」这种可读结论。
     *
     * **模式必须锚定全名或明确前缀**：早先用 `connect$` 这种松散匹配，
     * 真机上把 `SCardDisconnect`（智能卡）归进了 network——能力标签一旦错，
     * 整段结论都会跟着错，宁可少标也不要错标。
     */
    private static final String[][] CAPABILITIES = {
        { "network",  "^(InternetOpen|InternetOpenUrl|InternetConnect|InternetReadFile|HttpOpenRequest|HttpSendRequest|URLDownloadToFile|WinHttp|WinInet|WS2_32|WSASocket|WSAConnect|getaddrinfo|gethostbyname|DnsQuery)" },
        { "socket",   "^(socket|connect|send|recv|bind|listen|accept|closesocket)$" },
        { "process",  "^(CreateProcess|ShellExecute|WinExec|system|_popen|execve|execvp|posix_spawn)" },
        { "registry", "^(RegOpenKey|RegSetValue|RegCreateKey|RegDeleteKey|RegQueryValue|RegEnumKey)" },
        { "crypto",   "^(Crypt|BCrypt|NCrypt|EVP_|AES_|SHA256|SHA1|MD5_|RtlEncrypt|RtlDecrypt)" },
        { "file",     "^(WriteFile|DeleteFile|MoveFile|CopyFile|fopen|fwrite|unlink|remove)$" },
        { "debugger", "^(IsDebuggerPresent|NtQueryInformationProcess|CheckRemoteDebuggerPresent|ptrace)$" },
        { "inject",   "^(VirtualAlloc|VirtualProtect|WriteProcessMemory|CreateRemoteThread|NtMapViewOfSection|dlopen)$" },
        { "service",  "^(CreateService|StartService|OpenSCManager|RegisterServiceCtrlHandler)" },
        { "clipboard", "^(OpenClipboard|GetClipboardData|SetClipboardData)" },
        { "screenshot", "^(BitBlt|GetDC|CreateCompatibleBitmap)$" },
        { "keyboard", "^(SetWindowsHookEx|GetAsyncKeyState|GetKeyState)$" },
    };

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        String outPath = args.length > 0 ? args[0] : null;
        int decompileN = 0;
        for (int i = 1; i < args.length; i++) {
            if ("--decompile".equals(args[i]) && i + 1 < args.length) {
                decompileN = Integer.parseInt(args[++i]);
            }
        }

        StringBuilder sb = new StringBuilder();
        line(sb, "PROGRAM", currentProgram.getName());
        line(sb, "FORMAT", currentProgram.getExecutableFormat());
        line(sb, "ARCH", currentProgram.getLanguageID().toString());
        line(sb, "IMAGEBASE", currentProgram.getImageBase().toString());
        line(sb, "COMPILER", String.valueOf(currentProgram.getCompilerSpec().getCompilerSpecID()));

        FunctionManager fm = currentProgram.getFunctionManager();
        int funcCount = 0;
        for (Function f : fm.getFunctions(true)) funcCount++;
        line(sb, "FUNCTIONS", String.valueOf(funcCount));

        // ── 导入表：全量落表，按能力分类给代表项 ────────────────────────────
        List<String> imports = new ArrayList<>();
        SymbolTable st = currentProgram.getSymbolTable();
        for (Symbol s : st.getExternalSymbols()) imports.add(s.getName());
        Collections.sort(imports);
        line(sb, "IMPORTS", String.valueOf(imports.size()));

        for (String[] cap : CAPABILITIES) {
            Pattern p = Pattern.compile(cap[1]);
            List<String> hit = new ArrayList<>();
            for (String name : imports) if (p.matcher(name).find()) hit.add(name);
            if (hit.isEmpty()) continue;
            line(sb, "CAPABILITY." + cap[0], String.valueOf(hit.size()));
            // 代表项最多 6 个，避免把 evidence 撑爆；全量在 IMPORTS_ALL 段
            line(sb, "CAPABILITY." + cap[0] + ".SAMPLE", String.join(",", hit.subList(0, Math.min(6, hit.size()))));
        }
        section(sb, "IMPORTS_ALL");
        for (String name : imports) sb.append(name).append('\n');

        // ── 字符串：只取「像线索」的（URL / 路径 / 密钥前缀 / 报错文案关键词）──
        // **要排除导入符号名**：Ghidra 会把外部符号也挂成 defined data，
        // 不过滤的话「GetLastError / RtlQueryFeatureConfiguration」会混进字符串线索里，
        // 看着像发现了什么、其实一个字节的字符串都没读到（notepad 实测就这么被污染过）。
        Set<String> importNames = new HashSet<>(imports);
        DataIterator di = currentProgram.getListing().getDefinedData(true);
        int sampleLimit = 200;
        int shown = 0;
        section(sb, "STRINGS_OF_INTEREST");
        Set<String> seen = new HashSet<>();
        while (di.hasNext() && shown < sampleLimit) {
            Data d = di.next();
            if (!d.hasStringValue()) continue;
            Object v = d.getValue();
            if (v == null) continue;
            String s = v.toString().trim();
            if (s.length() < 6 || s.length() > 500) continue;
            if (importNames.contains(s)) continue;
            if (s.matches("(?i)^[a-z0-9_.-]+\\.dll$")) continue;
            if (!isInteresting(s)) continue;
            if (!seen.add(s)) continue;
            sb.append(s.replace('\n', ' ')).append('\n');
            shown++;
        }
        line(sb, "STRINGS_SHOWN", String.valueOf(shown));

        // ── 可选：反编译「最像业务入口」的前 N 个函数 ────────────────────────
        // 排序不能只看引用数：编译器/CRT 注入的 helper（`__security_check_cookie`、
        // `__GSHandlerCheck`）引用数极高，真机上会把 N 个名额全占掉，一个业务函数都看不到。
        // 做法：先扣掉 helper 分，再按引用数排。
        if (decompileN > 0) {
            DecompInterface dec = new DecompInterface();
            dec.openProgram(currentProgram);
            List<Function> ranked = new ArrayList<>();
            for (Function f : fm.getFunctions(true)) {
                if (f.isThunk() || f.isExternal()) continue;
                if (isCompilerHelper(f.getName())) continue;
                ranked.add(f);
            }
            ranked.sort((a, b) -> Integer.compare(refCount(b), refCount(a)));
            section(sb, "DECOMPILED");
            int done = 0;
            for (Function f : ranked) {
                if (done >= decompileN) break;
                DecompileResults r = dec.decompileFunction(f, 60, monitor);
                if (r == null || !r.decompileCompleted()) continue;
                line(sb, "FUNCTION", f.getName() + " @ " + f.getEntryPoint() + " refs=" + refCount(f));
                sb.append(r.getDecompiledFunction().getC());
                sb.append("\n---\n");
                done++;
            }
            line(sb, "DECOMPILED_COUNT", String.valueOf(done));
            dec.dispose();
        }

        String text = sb.toString();
        if (outPath != null) {
            try (Writer w = new OutputStreamWriter(new FileOutputStream(outPath), "UTF-8")) {
                w.write(text);
            }
            println("WROTE=" + outPath);
            println("BYTES=" + text.getBytes("UTF-8").length);
        } else {
            print(text);
        }
    }

    private int refCount(Function f) {
        int n = 0;
        ReferenceIterator it = currentProgram.getReferenceManager().getReferencesTo(f.getEntryPoint());
        while (it.hasNext()) { it.next(); n++; }
        return n;
    }

    /**
     * 编译器 / CRT / 安全运行时注入的样板函数。
     *
     * 真机实测（notepad.exe）：按引用数排前两名是 `__security_check_cookie`(76) 与
     * `__GSHandlerCheck`(70)，全是 MSVC 的栈保护样板。不排除的话 `--decompile 3`
     * 只反编译出三个样板函数，用户会以为「这程序没什么逻辑」。
     */
    private static boolean isCompilerHelper(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        String[] prefixes = {
            "__", "_security_", "security_", "_rt_", "crt_", "??",
            "libm_", "wmemcpy", "memcpy", "memset", "_init", "_fini",
        };
        for (String p : prefixes) if (n.startsWith(p)) return true;
        String[] contains = {
            "chkstk", "stack_chk", "gs_handler", "security_cookie", "guard_",
            "_crt_", "unwind", "_chandler", "report_gsfailure",
        };
        for (String c : contains) if (n.contains(c)) return true;
        return false;
    }

    /** 「值得抄进证据」的字符串：URL、绝对路径、密钥前缀、典型报错/配置键。 */
    private static boolean isInteresting(String s) {
        String lower = s.toLowerCase(Locale.ROOT);
        if (lower.startsWith("http://") || lower.startsWith("https://") || lower.contains("://")) return true;
        if (s.matches("(?i)[a-z]:\\\\.+") || s.startsWith("/usr/") || s.startsWith("/etc/")) return true;
        String[] needles = {
            "api_key", "apikey", "token", "secret", "password", "passwd", "auth",
            "error", "failed", "cannot", "denied", "invalid",
            "user-agent", "content-type", "accept",
            "usage:", "version", "config", "license", "registered",
        };
        for (String n : needles) if (lower.contains(n)) return true;
        return false;
    }

    private static void line(StringBuilder sb, String k, String v) {
        sb.append(k).append('=').append(v).append('\n');
    }

    private static void section(StringBuilder sb, String name) {
        sb.append("--- ").append(name).append(" ---\n");
    }
}
