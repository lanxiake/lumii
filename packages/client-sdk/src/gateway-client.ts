/**
 * GatewayClient — 跨平台 Gateway WebSocket 客户端
 *
 * 封装 MtBot Protocol v3 握手、请求/响应关联、事件订阅、自动重连、心跳检测。
 * 通过 SocketFactory 注入传输层，同时支持 Node（ws 包）与浏览器（原生 WebSocket）。
 */

import {
  createRequestRegistry,
  type RequestRegistry,
} from "./request-registry.js";

// ============ 协议类型（内联，零外部依赖） ============

/** 协议信封 */
export type Message =
  | { type: "req"; id: string; method: string; params?: unknown }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: { message: string; code?: string } }
  | { type: "event"; event: string; payload?: unknown };

/** 连接参数（v3 握手） */
export interface ConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    displayName: string;
    version: string;
    platform: string;
    mode: string;
    fingerprint?: string;
  };
  caps?: string[];
  role?: string;
  scopes?: string[];
  auth?: {
    token?: string;
    adminToken?: string;
    deviceId?: string;
  };
}

/** 握手挑战 */
export interface ConnectChallenge {
  nonce: string;
  serverProtocol: number;
  serverTime: number;
}

// ============ Socket 抽象 ============

/** 跨平台的 WebSocket 接口（浏览器 WebSocket 和 Node ws 都可适配） */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  set onopen(cb: (() => void) | null);
  set onclose(cb: ((event: SocketCloseEvent) => void) | null);
  set onerror(cb: ((error: unknown) => void) | null);
  set onmessage(cb: ((event: SocketMessageEvent) => void) | null);
}

export interface SocketCloseEvent {
  code: number;
  reason: string;
}

export interface SocketMessageEvent {
  data: unknown;
}

/** 创建 WebSocket 实例的工厂 */
export type SocketFactory = (url: string, options?: { headers?: Record<string, string> }) => SocketLike;

/** 获取当前系统时间的函数（可注入，默认 Date.now） */
export type Clock = () => number;

// ============ 配置 ============

export interface GatewayClientConfig {
  /** Gateway WebSocket URL */
  url: string;
  /** 创建 WebSocket 的工厂（必填：平台自行提供 Node ws 或浏览器 WebSocket） */
  socketFactory: SocketFactory;
  /** 当前时间函数（可注入，默认 Date.now） */
  clock?: Clock;
  /** 协议版本，默认 3 */
  protocolVersion?: number;
  /** 客户端身份 */
  clientInfo: ConnectParams["client"];
  /** 客户端能力集 */
  caps?: string[];
  /** 认证令牌 */
  token?: string;
  /** 管理员令牌 */
  adminToken?: string;
  /** 设备 ID */
  deviceId?: string;
  /** 连接角色，默认 'user' */
  role?: string;
  /** 连接权限范围，默认 ['user.basic'] */
  scopes?: string[];
  /** 重连间隔（毫秒），默认 3000 */
  reconnectInterval?: number;
  /** 最大重连次数，默认 10 */
  maxReconnectAttempts?: number;
  /** 心跳间隔（毫秒），默认 30000 */
  heartbeatInterval?: number;
  /** 心跳连续失败阈值，默认 3 */
  heartbeatFailThreshold?: number;
  /** 请求超时（毫秒），默认 30000 */
  requestTimeout?: number;
}

/** 连接状态 */
export type ConnectionState = "disconnected" | "connecting" | "connected";

/** 事件监听器 */
export type EventListener = (payload: unknown) => void;
/** 连接状态变更回调 */
export type ConnectionStateListener = (state: ConnectionState) => void;

// ============ GatewayClient ============

export class GatewayClient {
  private readonly config: Required<Omit<GatewayClientConfig, "clock" | "socketFactory">> & {
    clock: Clock;
    socketFactory: SocketFactory;
  };
  private readonly requests: RequestRegistry;
  private readonly eventListeners = new Map<string, Set<EventListener>>();
  private readonly stateListeners = new Set<ConnectionStateListener>();

  private ws: SocketLike | null = null;
  private _state: ConnectionState = "disconnected";
  private handshakeComplete = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatFailCount = 0;
  private intentionalDisconnect = false;

  constructor(config: GatewayClientConfig) {
    if (!config.socketFactory) {
      throw new Error("socketFactory is required");
    }
    this.config = {
      url: config.url,
      socketFactory: config.socketFactory,
      clock: config.clock ?? (() => Date.now()),
      protocolVersion: config.protocolVersion ?? 3,
      clientInfo: config.clientInfo,
      caps: config.caps ?? [],
      token: config.token ?? "",
      adminToken: config.adminToken ?? "",
      deviceId: config.deviceId ?? "",
      role: config.role ?? "user",
      scopes: config.scopes ?? ["user.basic"],
      reconnectInterval: config.reconnectInterval ?? 3000,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
      heartbeatFailThreshold: config.heartbeatFailThreshold ?? 3,
      requestTimeout: config.requestTimeout ?? 30000,
    };
    this.requests = createRequestRegistry();
  }

  // ============ 公共 API ============

  /** 当前连接状态 */
  get state(): ConnectionState {
    return this._state;
  }

  /** 是否已连接且握手完成 */
  get connected(): boolean {
    return this._state === "connected" && this.handshakeComplete;
  }

  /** 连接到 Gateway */
  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    if (this.ws && this._state === "connected" && this.handshakeComplete) {
      return;
    }

    this.handshakeComplete = false;
    this.setState("connecting");

    return new Promise<void>((resolve, reject) => {
      try {
        const headers: Record<string, string> = {};
        if (this.config.token) {
          headers["Authorization"] = `Bearer ${this.config.token}`;
        }
        this.ws = this.config.socketFactory(this.config.url, { headers });

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data, resolve, reject);
        };

        this.ws.onclose = (event) => {
          this.handshakeComplete = false;
          this.stopHeartbeat();
          this.setState("disconnected");
          this.requests.rejectAll(new Error("Connection closed"));

          if (this.intentionalDisconnect) {
            return;
          }
          this.scheduleReconnect();
        };

        this.ws.onerror = (_error) => {
          if (!this.handshakeComplete) {
            reject(new Error("WebSocket connection error"));
          }
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /** 断开连接 */
  disconnect(): void {
    this.intentionalDisconnect = true;
    this.stopReconnect();
    this.stopHeartbeat();
    this.requests.rejectAll(new Error("Connection closed"));

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }

    this.handshakeComplete = false;
    this.reconnectAttempts = 0;
    this.heartbeatFailCount = 0;
    this.setState("disconnected");
  }

  /** 发送 RPC 请求 */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.connected || !this.ws) {
      throw new Error("Not connected to Gateway");
    }

    const id = this.requests.createId();
    const message: Message = { type: "req", id, method, params };

    const promise = this.requests.register<T>(id, {
      timeoutMs: this.config.requestTimeout,
      method,
    });

    try {
      this.send(message);
    } catch (error) {
      this.requests.settle(id, false, error instanceof Error ? error : new Error(String(error)));
    }
    return promise;
  }

  /** 订阅事件 */
  on(event: string, listener: EventListener): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
    return () => {
      const listeners = this.eventListeners.get(event);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.eventListeners.delete(event);
        }
      }
    };
  }

  /** 订阅连接状态变更 */
  onStateChange(listener: ConnectionStateListener): () => void {
    this.stateListeners.add(listener);
    listener(this._state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** 更新认证令牌（重启连接时生效） */
  setToken(token: string): void {
    this.config.token = token;
  }

  /** 更新管理员令牌 */
  setAdminToken(token: string): void {
    this.config.adminToken = token;
  }

  // ============ 内部方法 ============

  private setState(state: ConnectionState): void {
    this._state = state;
    for (const listener of this.stateListeners) {
      try {
        listener(state);
      } catch {
        // 静默；不因一个监听器失败中断其他通知
      }
    }
  }

  private send(message: Message): void {
    if (!this.ws) {
      throw new Error("WebSocket not initialized");
    }
    this.ws.send(JSON.stringify(message));
  }

  private sendConnectRequest(): void {
    const id = this.requests.createId();
    const connectParams: ConnectParams = {
      minProtocol: this.config.protocolVersion,
      maxProtocol: this.config.protocolVersion,
      client: this.config.clientInfo,
      caps: this.config.caps,
      role: this.config.role,
      scopes: this.config.scopes,
      auth: this.resolveAuth(),
    };

    const message: Message = { type: "req", id, method: "connect", params: connectParams };

    const timeout = setTimeout(() => {
      this.requests.cancel(id);
    }, this.config.requestTimeout);

    this.requests.track(id, {
      resolve: (_payload) => {
        this.handshakeComplete = true;
        this.startHeartbeat();
        this.setState("connected");
      },
      reject: (error) => {
        const errorMessage = error instanceof Error ? error.message : "";
        const isAuthError =
          errorMessage.includes("unauthorized") || errorMessage.includes("token-invalid");
        this.ws?.close(isAuthError ? 1008 : 1000);
      },
      timeout,
    });

    this.send(message);
  }

  private resolveAuth(): ConnectParams["auth"] {
    const token = this.config.adminToken || this.config.token;
    if (!token && !this.config.deviceId) {
      return undefined;
    }
    return {
      ...(token ? { token, ...(this.config.adminToken ? { adminToken: this.config.adminToken } : {}) } : {}),
      ...(this.config.deviceId ? { deviceId: this.config.deviceId } : {}),
    };
  }

  private handleMessage(
    rawData: unknown,
    connectResolve: () => void,
    connectReject: (error: Error) => void,
  ): void {
    let message: Message;
    try {
      message = typeof rawData === "string" ? JSON.parse(rawData) : JSON.parse(String(rawData));
    } catch {
      return;
    }

    // 握手阶段：connect.challenge → connect 请求
    if (message.type === "event" && message.event === "connect.challenge") {
      this.sendConnectRequest();
      return;
    }

    // 响应：交付给 request registry
    if (message.type === "res" && message.id) {
      const handled = this.requests.settle(
        message.id,
        message.ok,
        message.ok ? message.payload : new Error(message.error?.message ?? "Request failed"),
      );
      if (handled && !this.handshakeComplete) {
        // 第一个 res 可能是握手响应——由 track 的 reject/resolve 处理
        // 握手连接情况：如果请求未命中 registry，但握手未完成且此 id 是 connect 请求：
        // track 中的 resolve/reject 已经被 settle 触发，我们无需额外处理
      }
      if (handled && !this.handshakeComplete && message.ok) {
        // 握手成功（track 的 resolve 会置 handshakeComplete）
      }
      return;
    }

    // 事件：分发给监听器
    if (message.type === "event" && message.event) {
      const listeners = this.eventListeners.get(message.event);
      if (listeners) {
        for (const listener of listeners) {
          try {
            listener(message.payload);
          } catch {
            // 静默；一个监听器失败不影响其他
          }
        }
      }
    }
  }

  // ============ 重连 ============

  private scheduleReconnect(): void {
    if (
      this.intentionalDisconnect ||
      this.reconnectAttempts >= this.config.maxReconnectAttempts
    ) {
      return;
    }

    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.config.reconnectInterval);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ============ 心跳 ============

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatFailCount = 0;

    this.heartbeatTimer = setInterval(() => {
      if (!this.connected) return;
      this.call("system.heartbeat", { ts: this.config.clock() }).catch(() => {
        this.heartbeatFailCount += 1;
        if (this.heartbeatFailCount >= this.config.heartbeatFailThreshold) {
          this.stopHeartbeat();
          this.ws?.close();
        }
      });
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
