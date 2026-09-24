/**
 * 宠物感知层的测试。
 *
 * 这一层没有可见输出（它要么冒一句气泡、要么什么都不做），所以错的形态是**静默**的：
 * 阈值取小了用户永远等不到那句话，取大了就变成唠叨。用例守的是那几条边界：
 * 空闲断开、后台会话不参与、配额、冷启动、以及"同一条评分只让它低落一次"。
 *
 * ⚠ `cleanWorkTopic` 那张名单是照 2026-09-24 真实会话标题逐个核对的，
 * 下面的用例就是那份核对结果——**改名单要一起改用例**，否则两边的依据就散了。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '../../storage/local-database.js';
import { createMigratedTestDb } from '../../__tests__/helpers/sqlite-test-db.js';
import {
  CONTINUOUS_WORK_MS,
  CONTINUOUS_WORK_SPARSE_MS,
  IDLE_BREAK_MS,
  INTERRUPTED_TEXT,
  INTERRUPTION_WINDOW_MS,
  LOW_SATISFACTION,
  MAX_PET_SENSING_PER_DAY,
  PET_MOOD_EVENT_STRUGGLING,
  cleanWorkTopic,
  collectPetSensingSignals,
  countRecentInterruptions,
  countScoredUserSessions,
  decidePetSensing,
  readHandledScoreId,
  readLatestSatisfaction,
  readSpokenToday,
  readWorkChain,
  readWorkTopic,
  recordSpoken,
  tiredText,
  writeHandledScoreId,
  type PetSensingSignals,
} from '../pet-sensing';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const PET = 'pet:demo_cartoon_cat';
const MIN = 60_000;

const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

function insertConversation(db: DatabaseAdapter, id: string, title: string | null = null): void {
  // 给了标题就覆盖：调用顺序不受限（用例常常先造消息、后起标题）
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, is_active, created_at, last_msg_at)
     VALUES (?, 'local-user', 'direct', ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = COALESCE(excluded.title, conversations.title)`,
  ).run(id, title, at(60 * MIN), at(1 * MIN));
}

function insertMessage(db: DatabaseAdapter, conversationId: string, role: string, msAgo: number): void {
  insertConversation(db, conversationId);
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content_json, timestamp)
     VALUES (?, ?, ?, '{"type":"text","text":"x"}', ?)`,
  ).run(`m-${conversationId}-${msAgo}-${role}`, conversationId, role, at(msAgo));
}

/**
 * 造一条**真正连续**的工作链：从 `totalMin` 分钟前一直到 1 分钟前，每 `stepMin` 一条。
 * 每步必须小于空闲阈值，否则链会在中间断掉——这正是这一段要守的东西。
 */
function insertChain(db: DatabaseAdapter, conversationId: string, totalMin: number, stepMin = 5): void {
  for (let m = totalMin; m >= 1; m -= stepMin) {
    insertMessage(db, conversationId, m % 10 === 0 ? 'assistant' : 'user', m * MIN);
  }
}

/** 写一条打断流水（与 `autonomous-feedback-signals.ts` 的 appendLog 同形） */
function insertFeedbackLog(db: DatabaseAdapter, conversationId: string, msAgoList: number[]): void {
  const value = JSON.stringify(msAgoList.map((msAgo) => ({ k: 'abort', at: NOW.getTime() - msAgo })));
  db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
    `feedback-log:${conversationId}`,
    value,
    at(0),
  );
}

function insertScore(db: DatabaseAdapter, opts: { id: string; sessionId: string; score: number; msAgo?: number }): void {
  db.prepare(
    `INSERT INTO autonomous_satisfaction_scores
     (id, session_id, agent_id, task_completion, user_feedback, efficiency, knowledge_growth, overall_score, created_at)
     VALUES (?, ?, 'assistant', 0.5, 0.5, 0.5, 0.5, ?, ?)`,
  ).run(opts.id, opts.sessionId, opts.score, at(opts.msAgo ?? 5 * MIN));
}

/** 写宠物自己的 mood（键口径与 `mood.ts` 的 moodStateKey 一致） */
function insertPetMood(db: DatabaseAdapter, valence: number): void {
  db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
    `autonomous.mood:${PET}`,
    JSON.stringify({ energy: 0.6, valence, arousal: 0.5, updatedAt: NOW.getTime() }),
    at(0),
  );
}

function makeSignals(over: Partial<PetSensingSignals> = {}): PetSensingSignals {
  return {
    now: NOW.getTime(),
    interruptions: 0,
    continuousWorkMs: 0,
    workTopic: null,
    activeConversationId: 'conv-1',
    lastSatisfaction: null,
    scoredSessions: 10,
    petMood: { energy: 0.6, valence: 0, arousal: 0.5, updatedAt: NOW.getTime() },
    spokenToday: { interrupted: 0, tired: 0 },
    handledScoreId: null,
    ...over,
  };
}

// ── cleanWorkTopic（T4.5 的"读沉淀"，只做减法） ──

describe('cleanWorkTopic', () => {
  it('真实标题里像"话题"的收下（`·` 之前那截更像话题，取那截）', () => {
    expect(cleanWorkTopic('像素流水线 · 走路帧')).toBe('像素流水线');
    expect(cleanWorkTopic('精灵图生成 · 樱桃 · wave')).toBe('精灵图生成');
    expect(cleanWorkTopic('参考图实验 jump n')).toBe('参考图实验 jump n');
    expect(cleanWorkTopic('AGENT设计实践')).toBe('AGENT设计实践');
  });

  it('截到第一个标点之前（标题常常是被截断的第一句用户话）', () => {
    expect(cleanWorkTopic('google封号，正常使用，写一个申...')).toBe('google封号');
  });

  it('招呼 / 请求语一律丢掉——塞进句子会变成怪话', () => {
    for (const t of [
      '你好',
      '你好呀',
      '请用 Read 工具读取 appsw...',
      '帮我解读这条内容反外国制裁法再执行安...',
      '研究一下，@earendil-wor...',
      '停不要再执行第二个 sleep 了，...',
    ]) {
      expect(cleanWorkTopic(t), t).toBeNull();
    }
  });

  it('太长 / 太短 / 含 ID 的丢掉', () => {
    expect(cleanWorkTopic('[browser-suite] WAIT-03:41:03')).toBeNull();
    expect(cleanWorkTopic('飞书 - ou_ba9a79349951e82ceac99a505f3e2739')).toBeNull();
    expect(cleanWorkTopic('https://example.com/x')).toBeNull();
    expect(cleanWorkTopic('a')).toBeNull();
    expect(cleanWorkTopic('')).toBeNull();
    expect(cleanWorkTopic(null)).toBeNull();
  });

  it('判不出就返回 null——代价只是退回通用句，不猜语义', () => {
    expect(cleanWorkTopic('   ')).toBeNull();
  });
});

// ── readWorkChain（T4.3 / T4.7 的空闲重置） ──

describe('readWorkChain', () => {
  let db: DatabaseAdapter;

  // 每个用例一副干净的库：这几条守的就是"哪些时间戳能接成一条链"，
  // 共用一副库会让上一条用例留下的消息静默改变结论
  beforeEach(() => {
    db = createMigratedTestDb();
  });

  it('没有消息 → 断链', () => {
    expect(readWorkChain(db, NOW)).toEqual({ startedAt: null, conversationId: null });
  });

  it('连续的消息算一条链，起点是最早那条', () => {
    insertChain(db, 'conv-1', 130);
    const chain = readWorkChain(db, NOW);
    expect(chain.startedAt).toBe(NOW.getTime() - 130 * MIN);
    expect(chain.conversationId).toBe('conv-1');
  });

  it('**中途吃饭一小时再回来 → 链条从回来那一刻重新算**（验收里那条不误报）', () => {
    // 180–70 分钟前在干 → 空 20 分钟（> 15 的阈值）→ 50 分钟前回来接着干
    for (let m = 180; m >= 70; m -= 5) insertMessage(db, 'conv-1', 'user', m * MIN);
    insertChain(db, 'conv-1', 50);
    const chain = readWorkChain(db, NOW);
    // 不可能是 180 分钟——时间戳跨度看着够 2 小时，但中间断过，只能从 50 分钟前算起
    expect(chain.startedAt).toBe(NOW.getTime() - 50 * MIN);
  });

  it('最后一条消息本身就很旧 → 人已经走了，不是"上次那一整段"', () => {
    insertMessage(db, 'conv-1', 'user', 120 * MIN);
    insertMessage(db, 'conv-1', 'assistant', 100 * MIN);
    expect(readWorkChain(db, NOW).startedAt).toBeNull();
  });

  it('空闲阈值就是 15 分钟：刚好卡在边界上算连着', () => {
    insertMessage(db, 'conv-1', 'user', 2 * IDLE_BREAK_MS);
    insertMessage(db, 'conv-1', 'assistant', IDLE_BREAK_MS);
    insertMessage(db, 'conv-1', 'user', 1);
    // 三段之间各差 15 分钟（不大于阈值）→ 整段连着
    expect(readWorkChain(db, NOW).startedAt).toBe(NOW.getTime() - 2 * IDLE_BREAK_MS);
  });

  it('差一毫秒过界就断——边界两侧都要钉住，否则"放宽到 15 分钟"会变成"没有边"', () => {
    insertMessage(db, 'conv-1', 'user', 2 * IDLE_BREAK_MS + 1);
    insertMessage(db, 'conv-1', 'user', IDLE_BREAK_MS);
    insertMessage(db, 'conv-1', 'user', 1);
    expect(readWorkChain(db, NOW).startedAt).toBe(NOW.getTime() - IDLE_BREAK_MS);
  });

  it('后台会话不参与：cron / evolution / pet 的时间戳不接进链里', () => {
    insertMessage(db, 'cron:news-pipeline', 'assistant', 40 * MIN);
    insertMessage(db, 'evolution:main', 'assistant', 20 * MIN);
    insertMessage(db, 'conv-1', 'user', 5 * MIN);
    const chain = readWorkChain(db, NOW);
    expect(chain.startedAt).toBe(NOW.getTime() - 5 * MIN);
    expect(chain.conversationId).toBe('conv-1');
  });

  it('链的落点是**最新**那条消息的会话（气泡要跳回你正在用的那条）', () => {
    insertMessage(db, 'conv-old', 'user', 20 * MIN);
    insertMessage(db, 'conv-new', 'user', 2 * MIN);
    expect(readWorkChain(db, NOW).conversationId).toBe('conv-new');
  });
});

// ── 规则①的信号 ──

describe('countRecentInterruptions', () => {
  it('窗口内的都数上', () => {
    const db = createMigratedTestDb();
    insertFeedbackLog(db, 'conv-1', [1 * MIN, 10 * MIN, 29 * MIN]);
    expect(countRecentInterruptions(db, NOW)).toBe(3);
  });

  it(`超出 ${INTERRUPTION_WINDOW_MS / MIN} 分钟的不算——预判的是"现在卡住了"，不是"今天不顺"`, () => {
    const db = createMigratedTestDb();
    insertFeedbackLog(db, 'conv-1', [31 * MIN, 60 * MIN, 2 * MIN]);
    expect(countRecentInterruptions(db, NOW)).toBe(1);
  });

  it('跨会话累加（用户可能同时在两条会话里被打断）', () => {
    const db = createMigratedTestDb();
    insertFeedbackLog(db, 'conv-1', [5 * MIN]);
    insertFeedbackLog(db, 'conv-2', [6 * MIN, 7 * MIN]);
    expect(countRecentInterruptions(db, NOW)).toBe(3);
  });

  it('后台会话的打断不算在你头上', () => {
    const db = createMigratedTestDb();
    insertFeedbackLog(db, 'cron:agent-self', [5 * MIN, 6 * MIN, 7 * MIN]);
    insertFeedbackLog(db, 'evolution:main', [5 * MIN, 6 * MIN, 7 * MIN]);
    insertFeedbackLog(db, 'pet:demo_cartoon_cat', [5 * MIN, 6 * MIN, 7 * MIN]);
    expect(countRecentInterruptions(db, NOW)).toBe(0);
  });

  it('流水坏掉按 0 算，不抛', () => {
    const db = createMigratedTestDb();
    db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
      'feedback-log:conv-1',
      '不是 JSON',
      at(0),
    );
    expect(countRecentInterruptions(db, NOW)).toBe(0);
  });
});

// ── 规则③的信号 ──

describe('评分读取', () => {
  it('只认用户会话的评分：cron / evolution / pet 的自动会话排除在外', () => {
    const db = createMigratedTestDb();
    insertScore(db, { id: 's-cron', sessionId: 'cron:agent-self:1', score: 0.1, msAgo: 1 * MIN });
    insertScore(db, { id: 's-evo', sessionId: 'evolution:main', score: 0.1, msAgo: 2 * MIN });
    insertScore(db, { id: 's-user', sessionId: 'conv-1', score: 0.9, msAgo: 30 * MIN });
    expect(readLatestSatisfaction(db)?.id).toBe('s-user');
    // 后台那些低分**不能**把宠物弄蔫——它们每天自动跑几十轮，与"你今天顺不顺"无关
    expect(decidePetSensing(makeSignals({ lastSatisfaction: readLatestSatisfaction(db) })).moodEvent).toBeNull();
  });

  it('没有评分 → null', () => {
    expect(readLatestSatisfaction(createMigratedTestDb())).toBeNull();
  });

  it('会话条数按 DISTINCT session_id 数，不是按评分条数', () => {
    const db = createMigratedTestDb();
    insertScore(db, { id: 'a', sessionId: 'conv-1', score: 0.9, msAgo: 50 * MIN });
    insertScore(db, { id: 'b', sessionId: 'conv-1', score: 0.9, msAgo: 40 * MIN });
    insertScore(db, { id: 'c', sessionId: 'conv-2', score: 0.9, msAgo: 30 * MIN });
    expect(countScoredUserSessions(db)).toBe(2);
  });
});

// ── readWorkTopic（T4.5） ──

describe('readWorkTopic', () => {
  /** 一条带 project_key 的项目记忆，经来源消息回指到某个会话 */
  function insertProjectMemory(
    db: DatabaseAdapter,
    opts: { id: string; conversationId: string; projectKey: string },
  ): void {
    insertMessage(db, opts.conversationId, 'user', 30 * MIN);
    const messageId = `m-${opts.conversationId}-${30 * MIN}-user`;
    db.prepare(
      `INSERT INTO agent_memories
       (id, agent_id, user_id, category, content, created_at, last_used, project_key, source_message_id)
       VALUES (?, 'assistant', 'local-user', 'project', '项目说明', ?, ?, ?, ?)`,
    ).run(opts.id, at(30 * MIN), at(30 * MIN), opts.projectKey, messageId);
  }

  it('会话归属的项目名优先——那是别的 Agent 干活时留下的显式标记', () => {
    const db = createMigratedTestDb();
    insertConversation(db, 'conv-1', '某个会话标题');
    insertProjectMemory(db, { id: 'm1', conversationId: 'conv-1', projectKey: 'pi框架研究课程' });
    expect(readWorkTopic(db, 'conv-1')).toBe('pi框架研究课程');
  });

  it('项目名判不出（太长/像请求）就退回会话标题', () => {
    const db = createMigratedTestDb();
    insertConversation(db, 'conv-1', '像素流水线');
    insertProjectMemory(db, { id: 'm1', conversationId: 'conv-1', projectKey: '帮我做一个很长很长很长很长的东西' });
    expect(readWorkTopic(db, 'conv-1')).toBe('像素流水线');
  });

  it('**别的会话**的项目名不会串过来', () => {
    const db = createMigratedTestDb();
    insertConversation(db, 'conv-1', '你好呀');
    insertConversation(db, 'conv-2', '别的会话');
    insertProjectMemory(db, { id: 'm1', conversationId: 'conv-2', projectKey: '另一个项目' });
    expect(readWorkTopic(db, 'conv-1')).toBeNull();
  });

  it('没有项目记忆时退回会话标题；标题判不出就 null', () => {
    const db = createMigratedTestDb();
    insertConversation(db, 'conv-1', '你好呀');
    expect(readWorkTopic(db, 'conv-1')).toBeNull();
    expect(readWorkTopic(db, null)).toBeNull();
    expect(readWorkTopic(db, '不存在的会话')).toBeNull();
  });
});

// ── 决策 ──

describe('decidePetSensing —— 说话', () => {
  it('打断够 3 次 → 靠近陪着（文案用设计原话，不带次数）', () => {
    const d = decidePetSensing(makeSignals({ interruptions: 3 }));
    expect(d.speak).toEqual({
      kind: 'interrupted',
      text: INTERRUPTED_TEXT,
      sessionKey: 'conv-1',
    });
  });

  it('差一次就不说', () => {
    expect(decidePetSensing(makeSignals({ interruptions: 2 })).speak).toBeNull();
  });

  /**
   * 五期 T5.1②：规则①那句话可以带一件"可以派它去做"的事。
   *
   * 有建议时气泡上那个按钮的含义就变了（"让我去看看"而不是"回到刚才"），
   * 所以它什么时候**有**、什么时候**没有**，是这条链路上最容易做错的一处。
   */
  describe('建议（T5.1 的意图来源②）', () => {
    it('读到工作主题时带上建议，且主题**逐字**进描述', () => {
      const d = decidePetSensing(makeSignals({ interruptions: 3, workTopic: '像素流水线' }));
      expect(d.speak?.kind).toBe('interrupted');
      expect(d.speak?.proposal?.description).toContain('像素流水线');
    });

    it('读不到主题就不给建议 —— 宁可没有按钮，也不给一个"看什么"都不知道的按钮', () => {
      const d = decidePetSensing(makeSignals({ interruptions: 3, workTopic: null }));
      expect(d.speak?.kind).toBe('interrupted');
      expect(d.speak?.proposal).toBeUndefined();
    });

    it('主题只有空白也不算数', () => {
      const d = decidePetSensing(makeSignals({ interruptions: 3, workTopic: '   ' }));
      expect(d.speak?.proposal).toBeUndefined();
    });

    it('"该歇会儿了"那条**不带**建议 —— 建议休息和派它去干活是两件事', () => {
      const d = decidePetSensing(
        makeSignals({ continuousWorkMs: CONTINUOUS_WORK_MS, workTopic: '像素流水线' }),
      );
      expect(d.speak?.kind).toBe('tired');
      expect(d.speak?.proposal).toBeUndefined();
    });

    it('建议落在它**真的做得到**的事上（查资料/记忆，不是"改代码"）', () => {
      const d = decidePetSensing(makeSignals({ interruptions: 3, workTopic: '像素流水线' }));
      const description = d.speak?.proposal?.description ?? '';
      // 它的白名单只有只读检索（PET_TOOL_ALLOWLIST），描述必须落在那个能力圈里
      expect(description).toMatch(/查|资料|记忆/);
      expect(description).not.toMatch(/改|写|删|跑|执行/);
    });
  });

  it('连续工作满 2 小时 → 提醒休息', () => {
    const d = decidePetSensing(makeSignals({ continuousWorkMs: CONTINUOUS_WORK_MS }));
    expect(d.speak?.kind).toBe('tired');
    expect(d.speak?.text).toContain('走两步');
  });

  it('数据稀疏时阈值放宽到 3 小时（宁可少说），刚过 2 小时不触发', () => {
    const s = { continuousWorkMs: CONTINUOUS_WORK_MS, scoredSessions: 2 };
    expect(decidePetSensing(makeSignals(s)).speak).toBeNull();
    expect(decidePetSensing(makeSignals({ ...s, continuousWorkMs: CONTINUOUS_WORK_SPARSE_MS })).speak?.kind).toBe(
      'tired',
    );
  });

  it('两条同时成立时先管"卡住了"', () => {
    const d = decidePetSensing(
      makeSignals({ interruptions: 5, continuousWorkMs: CONTINUOUS_WORK_MS, scoredSessions: 10 }),
    );
    expect(d.speak?.kind).toBe('interrupted');
  });

  it('**冷启动一条都不说**（验收：全新用户不硬说）', () => {
    const d = decidePetSensing(
      makeSignals({ scoredSessions: 0, interruptions: 9, continuousWorkMs: 4 * 60 * MIN }),
    );
    expect(d.speak).toBeNull();
    expect(d.reason).toContain('cold-start');
  });

  it('没有工作链就没有落点，不说', () => {
    const d = decidePetSensing(makeSignals({ activeConversationId: null, interruptions: 9 }));
    expect(d.speak).toBeNull();
    expect(d.reason).toContain('no-work-chain');
  });

  it('同类一天只说 1 次（说两遍就是唠叨）', () => {
    const said = makeSignals({ interruptions: 9, spokenToday: { interrupted: 1, tired: 0 } });
    expect(decidePetSensing(said).speak).toBeNull();
  });

  it('但换一类还能说——两条规则的配额是分开的', () => {
    const d = decidePetSensing(
      makeSignals({
        interruptions: 9,
        continuousWorkMs: CONTINUOUS_WORK_MS,
        scoredSessions: 10,
        spokenToday: { interrupted: 1, tired: 0 },
      }),
    );
    expect(d.speak?.kind).toBe('tired');
  });

  it('一天总量满了就都不说（上限与两条规则各 1 次正好对齐）', () => {
    const d = decidePetSensing(
      makeSignals({
        interruptions: 9,
        continuousWorkMs: CONTINUOUS_WORK_MS,
        scoredSessions: 10,
        spokenToday: { interrupted: 1, tired: 1 },
      }),
    );
    expect(d.speak).toBeNull();
    expect(MAX_PET_SENSING_PER_DAY).toBe(2);
  });

  it('**它自己蔫着就少说**（验收：会话评分低 → 主动说话概率降低）', () => {
    // valence < 0 → outreachMultiplier 0.5 → 上限 2 降到 1；今天已经说过一次了
    const d = decidePetSensing(
      makeSignals({
        interruptions: 9,
        continuousWorkMs: CONTINUOUS_WORK_MS,
        scoredSessions: 10,
        spokenToday: { interrupted: 1, tired: 0 },
        petMood: { energy: 0.6, valence: -0.5, arousal: 0.5, updatedAt: NOW.getTime() },
      }),
    );
    expect(d.speak).toBeNull();
  });

  it('心情好的时候同一个场景照说', () => {
    const d = decidePetSensing(
      makeSignals({
        interruptions: 9,
        continuousWorkMs: CONTINUOUS_WORK_MS,
        scoredSessions: 10,
        spokenToday: { interrupted: 1, tired: 0 },
      }),
    );
    expect(d.speak?.kind).toBe('tired');
  });

  it('没说话时把当场那几个数报出来（调阈值唯一的证据来源）', () => {
    const d = decidePetSensing(makeSignals({ interruptions: 1, continuousWorkMs: 90 * MIN }));
    expect(d.reason).toContain('interruptions=1/3');
    expect(d.reason).toContain('workMs=90min');
  });
});

describe('decidePetSensing —— 情绪（规则③）', () => {
  it('评分低于阈值 → 写宠物自己的 mood，事件名不与它自己的失败共用', () => {
    const d = decidePetSensing(
      makeSignals({ lastSatisfaction: { id: 's1', score: LOW_SATISFACTION - 0.1 } }),
    );
    expect(d.moodEvent).toEqual({ event: PET_MOOD_EVENT_STRUGGLING, scoreId: 's1' });
  });

  it('刚好等于阈值不算低（判据是 < 不是 ≤）', () => {
    const d = decidePetSensing(makeSignals({ lastSatisfaction: { id: 's1', score: LOW_SATISFACTION } }));
    expect(d.moodEvent).toBeNull();
  });

  it('同一条评分只消费一次——否则每一拍都再低落一点', () => {
    const d = decidePetSensing(
      makeSignals({ lastSatisfaction: { id: 's1', score: 0.2 }, handledScoreId: 's1' }),
    );
    expect(d.moodEvent).toBeNull();
  });

  it('mood 与说话互不占额度：低分那一拍照样能开口', () => {
    const d = decidePetSensing(
      makeSignals({ interruptions: 3, lastSatisfaction: { id: 's1', score: 0.3 } }),
    );
    expect(d.moodEvent?.event).toBe(PET_MOOD_EVENT_STRUGGLING);
    expect(d.speak?.kind).toBe('interrupted');
  });
});

describe('tiredText', () => {
  it('有主题就把主题嵌进去（验收：话里带得出你在做什么）', () => {
    expect(tiredText(CONTINUOUS_WORK_MS, '像素流水线')).toContain('像素流水线');
  });

  it('没主题退回通用句，不说半句', () => {
    const t = tiredText(CONTINUOUS_WORK_MS, null);
    expect(t).not.toContain('「');
    expect(t).toContain('走两步');
  });

  it('小时数按实际时长走，且不会说出"一个多小时"', () => {
    expect(tiredText(2 * 60 * MIN, null)).toContain('两个多小时');
    expect(tiredText(3 * 60 * MIN, null)).toContain('三个多小时');
    expect(tiredText(60 * MIN, null)).toContain('两个多小时');
  });
});

// ── 状态读写 ──

describe('pet.sensing 的状态键', () => {
  it('当天计数按本地日界，跨天自动归零', () => {
    const db = createMigratedTestDb();
    recordSpoken(db, PET, 'tired', NOW);
    expect(readSpokenToday(db, PET, NOW).tired).toBe(1);
    const tomorrow = new Date(NOW.getTime() + 24 * 60 * MIN);
    expect(readSpokenToday(db, PET, tomorrow)).toEqual({ interrupted: 0, tired: 0 });
  });

  it('已处理评分 id 能读回', () => {
    const db = createMigratedTestDb();
    expect(readHandledScoreId(db, PET)).toBeNull();
    writeHandledScoreId(db, PET, 's1');
    expect(readHandledScoreId(db, PET)).toBe('s1');
  });

  /**
   * ★ 2026-09-24 新增：两个键都必须**按宠物分账**。
   *
   * 「换模型 = 换宠物」（`petAgentId(configId)`）是既有口径——mood / 性格 / 出生快照 /
   * token 账全都分了，只有 `pet.sensing` 这两个键漏了。后果不是"多算一点"：
   * 切一次模型，新宠物当天的配额已被旧宠物吃掉（`MAX_PET_SENSING_PER_DAY = 2`），
   * 而 `handled-score` 记着旧宠物消费过的评分 id，新宠物**永远不会**因那条低分而低落。
   * 单宠物时完全看不出来，切模型即复现。
   */
  it('★ 两只宠物各记各的账（换模型不串）', () => {
    const db = createMigratedTestDb();
    const other = 'pet:mao_pro';

    recordSpoken(db, PET, 'tired', NOW);
    recordSpoken(db, PET, 'tired', NOW);
    recordSpoken(db, other, 'interrupted', NOW);

    expect(readSpokenToday(db, PET, NOW)).toEqual({ interrupted: 0, tired: 2 });
    expect(readSpokenToday(db, other, NOW)).toEqual({ interrupted: 1, tired: 0 });

    // 评分游标同理：一只消费过的不影响另一只
    writeHandledScoreId(db, PET, 's1');
    expect(readHandledScoreId(db, PET)).toBe('s1');
    expect(readHandledScoreId(db, other)).toBeNull();
  });
});

// ── 端到端（读库 → 决策） ──

describe('collectPetSensingSignals', () => {
  it('把用户侧与宠物侧拼成一份信号', () => {
    const db = createMigratedTestDb();
    insertFeedbackLog(db, 'conv-1', [1 * MIN, 2 * MIN, 3 * MIN]);
    insertChain(db, 'conv-1', 100);
    insertConversation(db, 'conv-1', '像素流水线');
    insertScore(db, { id: 's1', sessionId: 'conv-1', score: 0.3, msAgo: 4 * MIN });
    insertPetMood(db, -0.4);

    const signals = collectPetSensingSignals(db, PET, NOW);
    expect(signals.interruptions).toBe(3);
    expect(signals.continuousWorkMs).toBe(100 * MIN);
    expect(signals.workTopic).toBe('像素流水线');
    expect(signals.activeConversationId).toBe('conv-1');
    expect(signals.lastSatisfaction).toEqual({ id: 's1', score: 0.3 });
    expect(signals.scoredSessions).toBe(1);
    expect(signals.petMood.valence).toBe(-0.4);

    const d = decidePetSensing(signals);
    expect(d.speak?.text).toBe(INTERRUPTED_TEXT);
    expect(d.moodEvent?.scoreId).toBe('s1');
  });

  it('读的是**宠物自己的** mood，不是助手的', () => {
    const db = createMigratedTestDb();
    db.prepare(`INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
      'autonomous.mood:assistant',
      JSON.stringify({ energy: 0.9, valence: -0.9, arousal: 0.9, updatedAt: NOW.getTime() }),
      at(0),
    );
    // 助手蔫着，宠物没写过 → 宠物是基线（valence 0 → 上限不降）
    expect(collectPetSensingSignals(db, PET, NOW).petMood.valence).toBe(0);
  });
});
