import { describe, expect, it } from 'vitest';
import { pickConcernToRaise, markConcernRaised, type Concern } from '../concerns';

const NOW = 1_000_000;

function concern(overrides: Partial<Concern> = {}): Concern {
  return {
    id: 'c1',
    description: '一件事',
    origin: 'session-1',
    arousalWeight: 0.5,
    raisedCount: 0,
    nextRaiseAfter: 0,
    status: 'open',
    ...overrides,
  };
}

describe('pickConcernToRaise', () => {
  it('空列表返回 null', () => {
    expect(pickConcernToRaise([], NOW)).toBeNull();
  });

  it('过滤 closed / 已提满 / 时间未到的牵挂', () => {
    const concerns = [
      concern({ id: 'raised', raisedCount: 2 }),
      concern({ id: 'resolved', status: 'resolved' }),
      concern({ id: 'not-yet', nextRaiseAfter: NOW + 1000 }),
      concern({ id: 'ok', arousalWeight: 0.3 }),
    ];
    expect(pickConcernToRaise(concerns, NOW)?.id).toBe('ok');
  });

  it('按 arousalWeight 降序取最在意的一条', () => {
    const concerns = [
      concern({ id: 'low', arousalWeight: 0.2 }),
      concern({ id: 'high', arousalWeight: 0.8 }),
    ];
    expect(pickConcernToRaise(concerns, NOW)?.id).toBe('high');
  });
});

describe('markConcernRaised', () => {
  it('第 2 次后 dropped', () => {
    const updated = markConcernRaised([concern({ id: 'c1', raisedCount: 1 })], 'c1', NOW);
    expect(updated[0]?.status).toBe('dropped');
    expect(updated[0]?.raisedCount).toBe(2);
  });

  it('第 1 次提起间隔递增到 72h', () => {
    const updated = markConcernRaised([concern({ id: 'c1', raisedCount: 0 })], 'c1', NOW);
    expect(updated[0]?.raisedCount).toBe(1);
    expect(updated[0]?.nextRaiseAfter).toBe(NOW + 72 * 3_600_000);
  });

  it('不影响其它牵挂', () => {
    const updated = markConcernRaised(
      [concern({ id: 'c1' }), concern({ id: 'c2', raisedCount: 1 })],
      'c1',
      NOW,
    );
    expect(updated[1]?.raisedCount).toBe(1);
  });
});
