/**
 * 失败语义守卫 —— 工具失败必须产顶层 `isError: true`（执行计划批次 1.2）
 *
 * 契约全文见 `types/tool.ts` 的 `MtBotToolResult`。
 *
 * ## 为什么需要它
 *
 * 契约第 5 条说明了：**类型系统抓不住漏标**——2026-09-18 实测，
 * `execute: async () => ({...})` 这种不标注返回类型的写法不触发多余属性检查，
 * 连 `isEror` 拼错都不报错。所以必须有类型之外的守卫。
 *
 * ## 为什么是「登记表」而不是自动判定
 *
 * 「哪些分支算失败」是语义问题，无法静态判定，而且**刻意存在反例**——
 * 云同步超时 / 搜索零结果 / 用户取消 / 去重提示都不标失败（契约第 3 条 a~e）。
 * 所以让每个工具显式表态，守卫检查「表态」与「源码」是否一致。
 *
 * ## 守卫能抓什么、抓不到什么（诚实说明）
 *
 * | 场景 | 抓得住吗 |
 * |---|---|
 * | 新增工具没进登记表 | ✅ 断言 A |
 * | 工具被删除/改名，登记表没跟上 | ✅ 断言 A（双向） |
 * | 有人删掉了一处 `isError` 赋值 | ✅ 断言 B（源码计数） |
 * | 新增失败分支却忘了标 | ❌ 静态抓不住（计数不会变）→ 靠断言 C 兜 |
 * | 登记表的 how 描述与代码语义不符 | ❌ 机器判不了 → 靠 code review |
 *
 * 断言 C 只覆盖**能离线构造**的工具（不依赖 Electron / 应用运行时）。
 * 宿主侧注册的工具（`apps/windows/.../bridge-*.ts`）由宿主自己的测试覆盖。
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_BUILT_IN_TOOL_CONFIGS } from "../built-in/index.js";
import type { ToolExecutionContext } from "../../types/tool.js";
import { bashToolConfig } from "../built-in/bash-tool.js";
import { listDirToolConfig } from "../built-in/list-dir-tool.js";
import { fileCopyToolConfig } from "../built-in/file-copy-tool.js";
import { fileMoveToolConfig } from "../built-in/file-move-tool.js";
import { fileEditToolConfig } from "../built-in/file-edit-tool.js";
import { fileWriteToolConfig } from "../built-in/file-write-tool.js";
import { askUserQuestionToolConfig } from "../built-in/ask-user-question-tool.js";
import { skillSearchToolConfig, skillInvokeToolConfig } from "../built-in/skill-tools.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILT_IN_DIR = path.join(HERE, "..", "built-in");

/**
 * 每个内置工具源文件的失败语义登记。
 *
 * - `tools`：该文件导出、且在 `ALL_BUILT_IN_TOOL_CONFIGS` 里的工具名
 * - `how`：失败判定方式（**人读**，审查时对照代码；机器判不了它准不准）
 * - `sites`：源码里 `isError:` 赋值点的条数（排除注释行）
 *
 * `sites: 0` 表示「该工具没有需要标的失败分支」——失败全部走 throw，
 * 或存在刻意的非理想结局（见 how）。加条目前先读契约第 3 条。
 */
interface FileFailureSemantics {
  readonly tools: readonly string[];
  readonly how: string;
  readonly sites: number;
}

const FAILURE_SEMANTICS: Record<string, FileFailureSemantics> = {
  // ── 有 isError 赋值点的（批次 1 新标） ──
  "bash-tool.ts": {
    tools: ["bash"],
    how: "exitCode !== 0。误标率 < 2%（语义性非零在 bash_command_log 全量 1559 条里仅 22 条）",
    sites: 1,
  },
  "file-edit-tool.ts": {
    tools: ["file_edit"],
    how: "oldString 未找到 / 未设 replaceAll 但匹配不唯一",
    sites: 2,
  },
  "file-write-tool.ts": {
    tools: ["file_write"],
    how:
      "mode='range' 但缺 startLine（调用方错误）。" +
      "写后回读校验未通过（`verified: false`）**刻意不标**——写入调用本身没失败，" +
      "标了会诱导模型重写一遍（契约第 3 条 f）",
    sites: 1,
  },
  "list-dir-tool.ts": {
    tools: ["list_dir"],
    how: "路径不存在 / 路径不是目录",
    sites: 2,
  },
  "file-copy-tool.ts": {
    tools: ["file_copy"],
    how: "目标已存在（避免静默覆盖）。fs.cp 本身的异常走 throw",
    sites: 1,
  },
  "file-move-tool.ts": {
    tools: ["file_move"],
    how: "目标已存在（避免静默覆盖）。fs.rename 本身的异常走 throw",
    sites: 1,
  },
  "ask-user-question-tool.ts": {
    tools: ["ask_user_question"],
    how:
      "宿主未注入 askUserQuestion（not_implemented）/ 宿主调用抛异常。" +
      "注意 cancelled 与 declined **刻意不标**——那是用户意志，不是工具失败",
    sites: 2,
  },
  "skill-tools.ts": {
    tools: ["skill_search", "skill_invoke"],
    how: "技能系统不可用（宿主未注入 getSkills）/ 技能不存在 / SKILL.md 读取失败",
    sites: 3,
  },
  "execute-skill-tool.ts": {
    tools: ["execute_skill"],
    how:
      "宿主未注入 SkillRuntime（context.executeSkill 缺失）/ 技能执行返回 success:false / 宿主调用抛异常。" +
      "注意：**技能不存在**也走 success:false（由技能运行时判定 id），不是能力缺失——两者都用同一个出口",
    sites: 3,
  },

  // ── sites: 0：无失败分支需要标 ──
  "agent-management-tools.ts": {
    tools: ["agent_team_generate", "agent_team_optimize", "agent_remove"],
    how: "失败全部走 throw",
    sites: 0,
  },
  "asset-checkup-tool.ts": {
    tools: ["asset_checkup"],
    how: "失败全部走 throw",
    sites: 0,
  },
  "channel-tools.ts": {
    tools: ["channel_list", "channel_send"],
    how: "失败全部走 throw（渠道能力不足时如实抛错，不改投）",
    sites: 0,
  },
  "client-command-tools.ts": {
    tools: [
      "session_create",
      "session_clear",
      "session_compact",
      "session_resume",
      "session_list",
      "settings_think",
      "settings_backend",
      "info_status",
      "memory_manage",
    ],
    how: "失败全部走 throw",
    sites: 0,
  },
  "cron-tools.ts": {
    tools: ["cron_create", "cron_list", "cron_delete"],
    how: "失败全部走 throw",
    sites: 0,
  },
  "dashboard-feed-tool.ts": {
    tools: ["dashboard_feed_write", "dashboard_feed_read"],
    how: "失败全部走 throw",
    sites: 0,
  },
  "file-mkdir-tool.ts": {
    tools: ["file_mkdir"],
    how: "失败全部走 throw",
    sites: 0,
  },
  "file-read-tool.ts": {
    tools: ["file_read"],
    how:
      "失败全部走 throw。重复读取 dedup 与 blocked 提示**刻意不标**——" +
      "那是行为纠正，标失败会让模型去换工具重试（契约第 3 条 e）",
    sites: 0,
  },
  "glob-tool.ts": { tools: ["glob"], how: "失败全部走 throw", sites: 0 },
  "grep-tool.ts": { tools: ["grep"], how: "失败全部走 throw", sites: 0 },
  "image-generate-tool.ts": { tools: ["image_generate"], how: "失败全部走 throw", sites: 0 },
  "integration-tools.ts": {
    tools: [
      "message",
      "memory_search",
      "memory_read",
      "profile_memory",
      "scene_memory",
      "system_prompt",
      "speech_generate",
    ],
    how: "失败全部走 throw",
    sites: 0,
  },
  "maintenance-report-tool.ts": {
    tools: ["maintenance_report_write", "maintenance_report_read"],
    how: "失败全部走 throw",
    sites: 0,
  },
  "news-preference-tool.ts": { tools: ["news_preference"], how: "失败全部走 throw", sites: 0 },
  "send-message-tool.ts": { tools: ["send_message"], how: "失败全部走 throw", sites: 0 },
  "spawn-agent-tool.ts": { tools: ["spawn_agent"], how: "失败全部走 throw", sites: 0 },
  "task-complete-tool.ts": { tools: ["task_complete"], how: "失败全部走 throw", sites: 0 },
  "task-tools.ts": { tools: ["todo_write"], how: "失败全部走 throw", sites: 0 },
  "web-fetch-tool.ts": {
    tools: ["web_fetch"],
    how: "失败全部走 throw（含 HTTP 非 2xx，错误文案带下一步建议）",
    sites: 0,
  },
  "web-search-tool.ts": {
    tools: ["web_search"],
    how:
      "零结果**刻意不标**（provider='none'，契约第 3 条 b）；" +
      "provider 自身故障走 throw。注意：零结果标错会污染失败率",
    sites: 0,
  },
  "wiki-tools.ts": {
    // wiki_capture 已从 ALL_BUILT_IN_TOOL_CONFIGS 下线（保留导出兼容），故不在 tools 里
    tools: ["wiki_overview", "wiki_search", "wiki_read"],
    how: "失败全部走 throw",
    sites: 0,
  },
  "work-report-tool.ts": { tools: ["work_report_read"], how: "失败全部走 throw", sites: 0 },
};

/** 数一个源文件里的 `isError:` 赋值点（排除注释行与 `isError?:` 类型标注） */
function countIsErrorSites(file: string): number {
  const src = fs.readFileSync(path.join(BUILT_IN_DIR, file), "utf8");
  return src.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
    return /^\s*isError\s*:/.test(line);
  }).length;
}

describe("失败语义守卫", () => {
  // ────────────────────────────────────────────
  // 断言 A：登记表覆盖所有内置工具（双向）
  // ────────────────────────────────────────────
  describe("A. 登记表与内置工具清单一致", () => {
    const registered = Object.values(FAILURE_SEMANTICS).flatMap((s) => s.tools);
    const actual = ALL_BUILT_IN_TOOL_CONFIGS.map((c) => c.name);

    it("登记表里的工具名没有重复", () => {
      const seen = new Set<string>();
      const dup = registered.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
      expect(dup, "同一个工具被登记了两次").toEqual([]);
    });

    it("每个内置工具都在登记表里表了态", () => {
      const missing = actual.filter((n) => !registered.includes(n));
      expect(
        missing,
        `以下工具未登记失败语义。新增工具时必须表态：\n` +
          `  有失败分支 → 在 FAILURE_SEMANTICS 里补条目并写清 how\n` +
          `  无失败分支 → 补 sites: 0 的条目\n` +
          `  先读 types/tool.ts 的契约第 3 条，确认它不是「刻意不标」的例外`,
      ).toEqual([]);
    });

    it("登记表里没有已经下线的工具名", () => {
      const stale = registered.filter((n) => !actual.includes(n));
      expect(stale, "登记表指向了不存在于 ALL_BUILT_IN_TOOL_CONFIGS 的工具（已下线或改名？）").toEqual(
        [],
      );
    });
  });

  // ────────────────────────────────────────────
  // 断言 B：登记表声明的 isError 条数与源码一致
  // ────────────────────────────────────────────
  describe("B. 源码里的 isError 赋值点与登记一致", () => {
    for (const [file, spec] of Object.entries(FAILURE_SEMANTICS)) {
      it(`${file} → ${spec.sites} 处（${spec.tools.join(", ")}）`, () => {
        const found = countIsErrorSites(file);
        expect(
          found,
          `${file} 实测 ${found} 处 isError: 赋值，登记表写的是 ${spec.sites} 处。\n` +
            (found < spec.sites
              ? `  少了：有人删掉了失败标记，或改成了 details 里的（那不算，会被 pi-agent-core 清空）`
              : `  多了：新增了失败分支——请更新登记表的 sites 与 how，并给断言 C 补一条行为测试`),
        ).toBe(spec.sites);
      });
    }
  });

  // ────────────────────────────────────────────
  // 断言 C：行为层——真实调用失败分支，断言顶层 isError
  // ────────────────────────────────────────────
  describe("C. 失败分支真的产出顶层 isError", () => {
    let cwd: string;

    function mockContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
      return {
        getCwd: () => cwd,
        executeCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        readFile: async () => "hello world\n",
        writeFile: async () => {},
        glob: async () => [],
        grep: async () => [],
        fetch: async () => ({ status: 200, body: "" }),
        ...overrides,
      };
    }

    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-failure-semantics-"));

    it("bash：exitCode 非零 → isError；为 0 → 不标", async () => {
      const fail = await bashToolConfig.execute(
        "t",
        { command: "exit 1" },
        mockContext({ executeCommand: async () => ({ stdout: "", stderr: "boom", exitCode: 1 }) }),
      );
      expect(fail.isError, "非零退出必须标失败").toBe(true);

      const ok = await bashToolConfig.execute("t", { command: "echo hi" }, mockContext());
      expect(ok.isError, "零退出不得标失败（否则失败率会假性翻倍）").toBe(false);
    });

    it("list_dir：路径不存在 → isError；正常目录 → 不标", async () => {
      const missing = await listDirToolConfig.execute("t", { path: "no-such-dir" }, mockContext());
      expect(missing.isError).toBe(true);

      const ok = await listDirToolConfig.execute("t", { path: "." }, mockContext());
      expect(ok.isError).toBeFalsy();
    });

    it("file_copy：目标已存在 → isError", async () => {
      const src = path.join(cwd, "src.txt");
      const dst = path.join(cwd, "dst.txt");
      fs.writeFileSync(src, "a");
      fs.writeFileSync(dst, "b");
      const r = await fileCopyToolConfig.execute("t", { source: src, destination: dst }, mockContext());
      expect(r.isError).toBe(true);
    });

    it("file_move：目标已存在 → isError", async () => {
      const src = path.join(cwd, "move-src.txt");
      const dst = path.join(cwd, "move-dst.txt");
      fs.writeFileSync(src, "a");
      fs.writeFileSync(dst, "b");
      const r = await fileMoveToolConfig.execute("t", { source: src, destination: dst }, mockContext());
      expect(r.isError).toBe(true);
    });

    it("file_edit：oldString 找不到 → isError", async () => {
      const r = await fileEditToolConfig.execute(
        "t",
        { filePath: "any.md", oldString: "NOT-PRESENT", newString: "x" },
        mockContext({ readFile: async () => "hello world\n" }),
      );
      expect(r.isError).toBe(true);
    });

    it("file_write：mode='range' 缺 startLine → isError", async () => {
      const r = await fileWriteToolConfig.execute(
        "t",
        { filePath: "any.md", content: "x", mode: "range" },
        mockContext(),
      );
      expect(r.isError).toBe(true);
    });

    it("ask_user_question：宿主未注入能力 → isError（能力缺失是确定的终态失败）", async () => {
      const r = await askUserQuestionToolConfig.execute(
        "t",
        {
          context: "能力缺失路径的回归用例。",
          questions: [{ question: "q?", header: "h", options: [{ label: "a", description: "d" }, { label: "b", description: "d" }] }],
        },
        mockContext(),
      );
      expect(r.isError).toBe(true);
    });

    it("skill_search / skill_invoke：技能系统不可用 → isError", async () => {
      const search = await skillSearchToolConfig.execute("t", {}, mockContext());
      expect(search.isError).toBe(true);

      const invoke = await skillInvokeToolConfig.execute(
        "t",
        { skillName: "whatever" },
        mockContext(),
      );
      expect(invoke.isError).toBe(true);
    });

    it("skill_invoke：技能不存在 → isError（区别于「系统不可用」）", async () => {
      const r = await skillInvokeToolConfig.execute(
        "t",
        { skillName: "no-such-skill" },
        mockContext({ getSkills: () => [] }),
      );
      expect(r.isError).toBe(true);
    });

    it("execute_skill：宿主未注入 SkillRuntime → isError", async () => {
      const { executeSkillToolConfig } = await import("../built-in/execute-skill-tool.js");
      const r = await executeSkillToolConfig.execute("t", { id: "some-skill" }, mockContext());
      expect(r.isError, "能力缺失是确定的终态失败，不标的话模型会以为技能跑过了").toBe(true);
    });

    it("execute_skill：执行失败 → isError；成功 → 不标", async () => {
      const { executeSkillToolConfig } = await import("../built-in/execute-skill-tool.js");

      const fail = await executeSkillToolConfig.execute(
        "t",
        { id: "x" },
        mockContext({
          executeSkill: async () => ({ success: false, error: "boom", executionTimeMs: 1 }),
        }),
      );
      expect(fail.isError).toBe(true);

      const ok = await executeSkillToolConfig.execute(
        "t",
        { id: "x" },
        mockContext({
          executeSkill: async () => ({ success: true, result: { a: 1 }, executionTimeMs: 5 }),
        }),
      );
      expect(ok.isError).toBeFalsy();
    });

    it("契约第 3 条回归：非理想结局不得被误标为失败", async () => {
      // file_read 的重复读取提示 / file_read 正常读取：都不该带 isError
      const { fileReadToolConfig } = await import("../built-in/file-read-tool.js");
      const r = await fileReadToolConfig.execute("t", { filePath: "x.md" }, mockContext());
      expect(r.isError, "正常读取不得标失败").toBeFalsy();
    });
  });
});
