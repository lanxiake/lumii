/**
 * MessageBus — 进程内消息总线
 *
 * 每个 Agent 拥有独立邮箱（FIFO 队列）。
 * 基于 Mailbox 的异步消息传递模型。
 */

import { EventEmitter } from "node:events";

/** 进入 Mailbox 的单条消息 */
export interface AgentBusMessage {
  /** 消息唯一 ID */
  readonly id: string;
  /** 发送方 agentId */
  readonly from: string;
  /** 消息文本（纯文本或序列化的结构化消息） */
  readonly text: string;
  /** 可选摘要，用于 UI 预览 */
  readonly summary?: string;
  /** ISO 8601 时间戳 */
  readonly timestamp: string;
}

type MailboxListener = (agentId: string, message: AgentBusMessage) => void;

/**
 * 进程内消息总线。
 *
 * 线程安全保证：所有操作都在 Node.js 主线程执行，无需额外锁机制。
 */
export class MessageBus {
  private readonly mailboxes = new Map<string, AgentBusMessage[]>();
  private readonly emitter = new EventEmitter();

  /** 注册一个 Agent，创建其 Mailbox */
  register(agentId: string): void {
    if (!this.mailboxes.has(agentId)) {
      this.mailboxes.set(agentId, []);
    }
  }

  /** 注销一个 Agent，删除其 Mailbox 及未读消息 */
  unregister(agentId: string): void {
    this.mailboxes.delete(agentId);
  }

  /** 检查 Agent 是否已注册 */
  has(agentId: string): boolean {
    return this.mailboxes.has(agentId);
  }

  /**
   * 发送消息到指定 Agent 的 Mailbox。
   * 若 to === '*'，则广播到所有已注册 Agent（排除发送方自身）。
   */
  send(to: string, message: AgentBusMessage): void {
    if (to === "*") {
      for (const [agentId, mailbox] of this.mailboxes) {
        if (agentId !== message.from) {
          mailbox.push(message);
          this.emitter.emit("message", agentId, message);
        }
      }
      return;
    }

    const mailbox = this.mailboxes.get(to);
    if (!mailbox) {
      throw new Error(`Agent "${to}" is not registered. Cannot deliver message.`);
    }
    mailbox.push(message);
    this.emitter.emit("message", to, message);
  }

  /**
   * 读取并清空指定 Agent 的 Mailbox，返回所有待处理消息。
   */
  drain(agentId: string): readonly AgentBusMessage[] {
    const mailbox = this.mailboxes.get(agentId);
    if (!mailbox || mailbox.length === 0) return [];
    const messages = [...mailbox];
    this.mailboxes.set(agentId, []);
    return messages;
  }

  /** 查看 Mailbox 中的待处理消息数量（不消费） */
  pendingCount(agentId: string): number {
    return this.mailboxes.get(agentId)?.length ?? 0;
  }

  /** 订阅新消息到达事件 */
  subscribe(listener: MailboxListener): () => void {
    this.emitter.on("message", listener);
    return () => {
      this.emitter.off("message", listener);
    };
  }

  /** 销毁所有 Mailbox，清理事件监听 */
  destroy(): void {
    this.mailboxes.clear();
    this.emitter.removeAllListeners();
  }
}
