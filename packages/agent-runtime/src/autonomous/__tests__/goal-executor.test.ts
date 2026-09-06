import { describe, expect, it, vi } from 'vitest';
import { buildGoalPrompt, getGoalToolAllowlist, finalizeGoal } from '../goal-executor';
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

  it('审慎状态时含复查护栏', () => {
    const prompt = buildGoalPrompt(makeGoal(GoalType.LEARNING), true);
    expect(prompt).toContain('复查');
  });

  it('非审慎状态时不含复查护栏', () => {
    const prompt = buildGoalPrompt(makeGoal(GoalType.LEARNING), false);
    expect(prompt).not.toContain('复查');
  });
});

describe('getGoalToolAllowlist', () => {
  it('白名单不含写文件/命令类工具', () => {
    const allowlist = getGoalToolAllowlist('learning');
    expect(allowlist).not.toContain('bash');
    expect(allowlist).not.toContain('file_write');
    expect(allowlist).not.toContain('file_edit');
  });

  it('白名单含只读检索与通知工具', () => {
    const allowlist = getGoalToolAllowlist('learning');
    expect(allowlist).toContain('web_search');
    expect(allowlist).toContain('memory_search');
    expect(allowlist).toContain('notify_user');
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
