/**
 * Task 5 P0：整理防护补强测试
 *
 * 验证：缩水过半拒绝机制 + backup 行为
 */

import { describe, it, expect } from "vitest";
import { consolidateUserMemory } from "../memory-consolidation.js";

describe("整理防护：缩水过半拒绝", () => {
  it("LLM 返回缩水 > 50% 时拒绝写入", async () => {
    const existing =
      "- 用户是架构师，专注后端系统设计与分布式架构\n- 偏好简洁回复，不喜欢冗长解释和废话\n- 工作中主要使用 TypeScript 和 Python 做开发\n- 住在成都，周末喜欢骑车去龙泉山爬山\n- 常用工具包括 VS Code、Docker、K8s、Terraform\n- 正在学习 Rust，准备用于性能关键模块重写\n- 项目中使用 PostgreSQL 作为主数据库，Redis 做缓存\n- 喜欢在周末阅读技术博客和研究开源项目源码\n- 偏好函数式编程风格，尽量少用面向对象设计模式"; // > 200 字符
    const callLLM = async () => "- 用户：成都架构师，TS/Python"; // 缩水 > 50%，但 >= 10 字符

    const result = await consolidateUserMemory({
      existingContent: existing,
      newCandidates: [],
      callLLM,
      forceConsolidate: true,
    });

    expect(result.merged).toBe(false);
    expect(result.rejectionReason).toBe("shrinkage");
    expect(result.content).toBe(existing); // 返回原始内容，未被替换
  });

  it("LLM 返回正常精简时通过", async () => {
    const existing = "- 用户是架构师\n- 偏好简洁回复\n- 工作中用 TS/Python\n- 住在成都\n- 喜欢骑车爬山";
    const callLLM = async () =>
      "- 用户：成都架构师，工作 TS/Python\n- 偏好简洁回复，喜欢骑车爬山"; // 缩水 < 50%

    const result = await consolidateUserMemory({
      existingContent: existing,
      newCandidates: [],
      callLLM,
      forceConsolidate: true,
    });

    expect(result.merged).toBe(true);
    expect(result.rejectionReason).toBeUndefined();
    expect(result.content).not.toBe(existing);
  });

  it("现有内容 <= 200 字时不触发缩水检查", async () => {
    const existing = "- 简短内容";
    const callLLM = async () => ""; // 空输出

    const result = await consolidateUserMemory({
      existingContent: existing,
      newCandidates: [],
      callLLM,
      forceConsolidate: true,
    });

    // 空输出会被其他防护拦住（最小长度检查），但不会触发缩水拒绝
    expect(result.rejectionReason).not.toBe("shrinkage");
  });
});
