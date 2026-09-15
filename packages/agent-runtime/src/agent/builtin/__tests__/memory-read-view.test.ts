/**
 * 记忆读取视图（2026-09-15 修订）
 *
 * 两类 Agent 的读取行为必须分开：
 * - **汇总型**（灵栖记事 chronicler）：`readView: "user"` —— 跨 Agent 读全用户的记忆。
 *   日报/周复盘的素材来自**其他 Agent** 的工作痕迹（用户在主 Agent 里干活的记录），
 *   只读自己名下必然是空的：09-14/09-15 两天日报连续输出「今天的工作记忆为空」就是这么来的。
 * - **普通 Agent**（assistant / code-dev / system-keeper / info-curator）：缺省 `"own"` ——
 *   只读自己平时工作写下的记忆。
 *
 * 与 `memory.scope` 的区别是这份测试要守住的关键：scope 是**持久化**语义
 * （记忆存在哪一层、活多久），**不**决定读取可见性。所有面向用户的 Agent 都是
 * `scope: "user"`，若把两者混为一谈（此前就是这么错的），普通 Agent 会看到别人的记忆。
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_DEFINITIONS, findBuiltInAgent } from "../definitions.js";

/** 面向用户、日常写入工作记忆的普通 Agent */
const ORDINARY_AGENTS = ["assistant", "code-dev", "system-keeper", "info-curator"];

describe("记忆读取视图 readView", () => {
  it("灵栖记事跨 Agent 读：汇总型 Agent 的素材来自其他 Agent", () => {
    expect(findBuiltInAgent("chronicler")?.memory?.readView).toBe("user");
  });

  it("普通 Agent 缺省只读自己的记忆", () => {
    for (const id of ORDINARY_AGENTS) {
      const def = findBuiltInAgent(id);
      expect(def, `未找到内置 Agent: ${id}`).toBeDefined();
      expect(def?.memory?.readView ?? "own", `${id} 不应跨 Agent 读取`).toBe("own");
    }
  });

  it("只有汇总型 Agent 开了跨 Agent 视图", () => {
    const crossAgent = BUILTIN_AGENT_DEFINITIONS.filter((d) => d.memory?.readView === "user").map(
      (d) => d.id,
    );
    expect(crossAgent).toEqual(["chronicler"]);
  });

  it("读取视图与持久化 scope 是两个独立维度：这些 Agent 的 scope 都是 user", () => {
    for (const id of [...ORDINARY_AGENTS, "chronicler"]) {
      expect(findBuiltInAgent(id)?.memory?.scope, `${id} 的记忆应持久化在用户级`).toBe("user");
    }
  });
});
