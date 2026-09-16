import { describe, expect, it, vi } from 'vitest';
import {
  buildGoalPrompt,
  getGoalToolAllowlist,
  getAutonomousToolsForAgent,
  finalizeGoal,
} from '../goal-executor';
import { GoalType, GoalStatus, type AutonomousGoal } from '../types';

function makeGoal(type: GoalType): AutonomousGoal {
  return {
    id: 'g1',
    agentId: 'assistant',
    type,
    description: '测试目标描述',
    triggerReason: 'scheduled',
    status: GoalStatus.APPROVED,
    priority: 0.5,
    createdAt: new Date().toISOString(),
  };
}

describe('buildGoalPrompt', () => {
  const types = [
    GoalType.LEARNING,
    GoalType.PROACTIVE_MESSAGE,
    GoalType.CAPABILITY_IMPROVEMENT,
    GoalType.MEMORY_OPTIMIZATION, // 走 default 分支
  ];

  it.each(types)('类型 %s 含「停止/如实」安全出口', (type) => {
    const prompt = buildGoalPrompt(makeGoal(type));
    expect(prompt).toContain('如实');
    expect(prompt).toContain('测试目标描述');
  });

  it('system-maintenance 含冲突解决指令', () => {
    const prompt = buildGoalPrompt(makeGoal(GoalType.SYSTEM_MAINTENANCE));
    expect(prompt).toContain('cloud_sync_read_file');
    expect(prompt).toContain('resolve_sync_conflict');
    expect(prompt).toContain('keep-local');
    expect(prompt).toContain('keep-remote');
    expect(prompt).toContain('per-file');
    expect(prompt).toContain('如实');
  });

  it('审慎状态时含复查护栏', () => {
    const prompt = buildGoalPrompt(makeGoal(GoalType.LEARNING), true);
    expect(prompt).toContain('复查');
  });

  it('非审慎状态时不含复查护栏', () => {
    const prompt = buildGoalPrompt(makeGoal(GoalType.LEARNING), false);
    expect(prompt).not.toContain('复查');
  });
});

describe('getAutonomousToolsForAgent', () => {
  it('system-keeper 走维护白名单：无 bash / file_write / app_*，含记忆与 cron', () => {
    const tools = getAutonomousToolsForAgent('system-keeper', 'learning');
    expect(tools).toContain('profile_memory');
    expect(tools).toContain('memory_manage');
    expect(tools).toContain('cron_create');
    expect(tools).toContain('wiki_read');
    expect(tools).toContain('skill_invoke');
    expect(tools).not.toContain('bash');
    expect(tools).not.toContain('file_write');
    expect(tools).not.toContain('app_act');
    expect(tools).not.toContain('file_edit');
  });

  it('system-keeper 自主档保留体检与排期所需的读类工具', () => {
    const tools = getAutonomousToolsForAgent('system-keeper', 'learning');
    // 场景记忆也是资产，体检要读得到；排期口径（cron_guide）自主建巡检任务时要查
    expect(tools).toContain('scene_memory');
    expect(tools).toContain('cron_guide');
  });

  it('维护白名单是「只读 + 记忆写」的闭集：写盘与代操一律不在其中', () => {
    // 设计 §6.4：自主运行只出建议。这里用黑名单兜住未来误加——
    // 新增工具若属于「改动类」，必须先想清楚它在无人在场时是否安全。
    const forbidden = [
      'bash',
      'file_write',
      'file_edit',
      'file_mkdir',
      'file_move',
      'file_copy',
      'app_act',
      'app_fill_form',
      'spawn_agent',
      'send_message',
      'channel_send',
    ];
    const tools = getAutonomousToolsForAgent('system-keeper', 'learning');
    for (const name of forbidden) {
      expect(tools, `${name} 不应出现在维护自主档`).not.toContain(name);
    }
  });

  it('其他 Agent 沿用通用白名单（行为不变）', () => {
    const tools = getAutonomousToolsForAgent('assistant', 'learning');
    expect(tools).toEqual(getGoalToolAllowlist('learning'));
    expect(tools).toContain('file_write');
  });
});

describe('getGoalToolAllowlist', () => {
  it('白名单含 T1 只读/知识/自组织工具', () => {
    const allowlist = getGoalToolAllowlist('learning');
    expect(allowlist).toContain('web_search');
    expect(allowlist).toContain('memory_search');
    expect(allowlist).toContain('memory_manage');
    expect(allowlist).toContain('message');
    expect(allowlist).toContain('file_read');
    expect(allowlist).toContain('wiki_read');
    expect(allowlist).toContain('todo_write');
    expect(allowlist).toContain('cron_create');
    expect(allowlist).toContain('cron_delete'); // 放行，但带 agent-self:* 前缀守卫
  });

  it('白名单含 T2 预算内可写工具', () => {
    const allowlist = getGoalToolAllowlist('learning');
    expect(allowlist).toContain('file_write');
    expect(allowlist).toContain('file_edit');
  });

  it('白名单不含 T3 高危工具', () => {
    const allowlist = getGoalToolAllowlist('learning');
    expect(allowlist).not.toContain('bash');
    expect(allowlist).not.toContain('spawn_agent');
    expect(allowlist).not.toContain('channel_send');
  });

  it('白名单含云同步冲突解决工具（system-maintenance 专用）', () => {
    const allowlist = getGoalToolAllowlist('system-maintenance');
    expect(allowlist).toContain('cloud_sync_read_file');
    expect(allowlist).toContain('resolve_sync_conflict');
  });
});

describe('finalizeGoal', () => {
  it('success 且 output 非空 → completed', () => {
    const run = vi.fn();
    const db = { prepare: () => ({ run }) } as never;
    finalizeGoal(db, 'g1', { success: true, output: '结果' });
    expect(run).toHaveBeenCalledWith('completed', expect.any(String), 'g1');
  });

  it('空 output → failed（防假 completed）', () => {
    const run = vi.fn();
    const db = { prepare: () => ({ run }) } as never;
    finalizeGoal(db, 'g1', { success: true, output: '   ' });
    expect(run).toHaveBeenCalledWith('failed', expect.any(String), 'g1');
  });

  it('failure → failed', () => {
    const run = vi.fn();
    const db = { prepare: () => ({ run }) } as never;
    finalizeGoal(db, 'g1', { success: false, output: '出错了' });
    expect(run).toHaveBeenCalledWith('failed', expect.any(String), 'g1');
  });
});
