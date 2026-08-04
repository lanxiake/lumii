/**
 * 客户端便利信封类型
 *
 * Gateway WebSocket 客户端（windows / admin-console 等）使用的扁平化消息信封，
 * 区别于 `frames.ts` 里用于服务端校验的 discriminated `GatewayFrame` union。
 * 这是一个面向客户端读写便利的结构：req / res / event 三种类型的字段并集，
 * 各字段按 type 取舍。两个客户端原先各自重定义了完全相同的副本，现收口于此。
 */

/** 消息类型 (MtBot 协议) */
export type MessageType = "req" | "res" | "event";

/** 客户端消息信封 (MtBot 协议) */
export interface Message {
  type: MessageType;
  id?: string;
  method?: string;
  params?: unknown;
  event?: string;
  ok?: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

/** 连接挑战事件 payload */
export interface ConnectChallenge {
  nonce: string;
  ts: number;
}
