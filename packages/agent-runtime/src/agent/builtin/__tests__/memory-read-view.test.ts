/**
 * 记忆读取视图（2026-09-16 修订）
 *
 * 两类 Agent 的读取行为必须分开：
 * - **巡访型**（素材或体检对象来自**全用户**，只读自己名下必然是空的）→ `readView: "user"`：
 *   - `chronicler`（灵栖记事）：日报/周复盘的素材是其他 Agent 干活时写下的痕迹。
 *     09-14/09-15 两天日报连续输出「今天的工作记忆为空」就是这么来的。
 *   - `system-keeper`（灵栖维护）：它的活是记忆体检——去重、找矛盾、清过期。
 *     它平时不参与干活，自己名下几乎是空的，只读自己等于在量空气。
 *   - `info-curator`（灵栖情报）：它要按**用户**的偏好吃穿，而偏好常被别的 Agent 先记下
 *     （主助手记「不想看标题党」、开发记「做端侧推理」）。
 * - **作业型**（平时自己干活、写自己的记忆）→ 缺省 `"own"`：assistant / code-dev。
 *
 * 与 `memory.scope` 的区别是这份测试要守住的关键：scope 是**持久化**语义
 * （记忆存在哪一层、活多久），**不**决定读取可见性。所有面向用户的 Agent 都是
 * `scope: "user"`，若把两者混为一谈，作业型 Agent 会看到别人的记忆。
 *
 * 判据一句话：**这个 Agent 交付的东西，是不是要靠别人写的记忆才能拼出来？**
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_DEFINITIONS, findBuiltInAgent } from "../definitions.js";

/** 平时自己干活、写自己的记忆的作业型 Agent */
const ORDINARY_AGENTS = ["assistant", "code-dev"];

/** 交付物由全用户记忆拼出来的巡访型 Agent */
const CROSS_AGENT_AGENTS = ["chronicler", "system-keeper", "info-curator"];

describe("记忆读取视图 readView", () => {
  it("巡访型 Agent 跨 Agent 读：素材/体检对象来自其他 Agent", () => {
    for (const id of CROSS_AGENT_AGENTS) {
      expect(findBuiltInAgent(id)?.memory?.readView, `${id} 应跨 Agent 读取`).toBe("user");
    }
  });

  it("作业型 Agent 缺省只读自己的记忆", () => {
    for (const id of ORDINARY_AGENTS) {
      const def = findBuiltInAgent(id);
      expect(def, `未找到内置 Agent: ${id}`).toBeDefined();
      expect(def?.memory?.readView ?? "own", `${id} 不应跨 Agent 读取`).toBe("own");
    }
  });

  it("开跨 Agent 视图的正好是这三位巡访型 Agent", () => {
    const crossAgent = BUILTIN_AGENT_DEFINITIONS.filter((d) => d.memory?.readView === "user").map(
      (d) => d.id,
    );
    expect(crossAgent).toEqual(["system-keeper", "chronicler", "info-curator"]);
  });

  it("读取视图与持久化 scope 是两个独立维度：这些 Agent 的 scope 都是 user", () => {
    for (const id of [...ORDINARY_AGENTS, ...CROSS_AGENT_AGENTS]) {
      expect(findBuiltInAgent(id)?.memory?.scope, `${id} 的记忆应持久化在用户级`).toBe("user");
    }
  });
});
