// ---------------------------------------------------------------------------
// ControlUIClaw SDK — Gateway Client
// ---------------------------------------------------------------------------

import type {
  InitOptions,
  ConnectResult,
  HealthEvent,
  ChatEvent,
  Unsubscribe,
  ConnectionState,
  HelloPayload,
  ConnectParams,
  ClientInfo,
  DeviceIdentity,
  EventFrame,
  ResponseFrame,
  RequestFrame,
  Session,
  SessionsListResult,
  ChatHistoryResult,
} from "./types.js";

import {
  getOrCreateDeviceIdentity,
  buildDeviceAuthPayload,
  signPayload,
} from "./crypto.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extracts human-readable text from any chat message shape. */
function extractText(msg: unknown): string {
  if (typeof msg === "string") return msg;
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, any>;
  if (typeof m.text === "string") return m.text;
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b: any) => (typeof b === "string" ? b : b?.text ?? ""))
      .filter(Boolean)
      .join("");
  }
  if (Array.isArray(m.choices)) {
    return m.choices
      .map((c: any) => c?.delta?.content ?? c?.message?.content ?? "")
      .filter(Boolean)
      .join("");
  }
  return JSON.stringify(msg);
}

/** Generates a new unique session key. */
function createSessionKey(prefix = "agent:main"): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

// ── Pending Request Tracking ───────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// ── Core Client (internal) ─────────────────────────────────────────────────

class CoreClient {
  // Config
  private readonly _url: string;
  private readonly _token: string | undefined;
  private readonly _clientInfo: ClientInfo;
  private readonly _role: string;
  private readonly _scopes: string[];
  private readonly _protocolRange: { min: number; max: number };
  private readonly _caps: string[];
  private readonly _autoReconnect: boolean;
  private readonly _initialBackoffMs: number;
  private readonly _maxBackoffMs: number;
  private readonly _providedIdentity: DeviceIdentity | undefined;

  // State
  private _ws: WebSocket | null = null;
  private _state: ConnectionState = "disconnected";
  private _pending: Map<string, PendingRequest> = new Map();
  private _connectNonce: string | null = null;
  private _backoffMs: number;
  private _closed = true;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _helloPayload: HelloPayload | null = null;
  private _requestTimeoutMs = 30_000;

  // Subscriber sets
  private _healthListeners = new Set<(e: HealthEvent) => void>();
  private _chatListeners = new Set<(e: ChatEvent) => void>();

  constructor(options: InitOptions) {
    this._url = options.url;
    this._token = options.token;
    this._clientInfo = {
      id: "controluiclaw-sdk-client",
      version: "1.0.0",
      platform:
        typeof navigator !== "undefined"
          ? navigator.platform ?? "web"
          : "node",
      mode: "sdk",
      ...options.clientInfo,
    };
    this._role = options.role ?? "operator";
    this._scopes = options.scopes ?? [
      "operator.admin",
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.pairing",
    ];
    this._protocolRange = options.protocol ?? { min: 3, max: 3 };
    this._caps = options.caps ?? ["tool-events"];
    this._autoReconnect = options.autoReconnect ?? true;
    this._initialBackoffMs = options.initialBackoffMs ?? 800;
    this._maxBackoffMs = options.maxBackoffMs ?? 15_000;
    this._backoffMs = this._initialBackoffMs;
    this._providedIdentity = options.deviceIdentity;
  }

  // ── Getters ────────────────────────────────────────────────────────────

  get state(): ConnectionState {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state === "connected";
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  connect(): Promise<ConnectResult> {
    if (this._state !== "disconnected") {
      return Promise.resolve({
        ok: false,
        error: { code: "already_connected", message: "Already connected or connecting" },
      });
    }

    this._closed = false;

    return new Promise<ConnectResult>((resolve) => {
      let settled = false;

      const onConnect = () => {
        if (settled) return;
        settled = true;
        resolve({
          ok: true,
          protocol: this._helloPayload?.protocol,
          serverVersion: this._helloPayload?.server?.version,
        });
      };

      const onFail = (msg: string) => {
        if (settled) return;
        settled = true;
        resolve({
          ok: false,
          error: { code: "connection_failed", message: msg },
        });
      };

      // One-shot internal hooks for the first connect attempt
      this._onceConnected = onConnect;
      this._onceError = onFail;
      this._onceDisconnected = (code, reason) =>
        onFail(`Connection closed before handshake (${code}: ${reason})`);

      this._openSocket();
    });
  }

  disconnect(): void {
    this._closed = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._flushPending(new Error("Client disconnected"));
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._setState("disconnected");
    this._emitHealth({ code: "disconnected", message: "Client disconnected" });
  }

  // ── Requests ───────────────────────────────────────────────────────────

  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Not connected"));
    }
    const id = crypto.randomUUID();
    const frame: RequestFrame = { type: "req", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? this._requestTimeoutMs;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._ws!.send(JSON.stringify(frame));
    });
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  onHealth(cb: (e: HealthEvent) => void): Unsubscribe {
    this._healthListeners.add(cb);
    return () => this._healthListeners.delete(cb);
  }

  onChat(cb: (e: ChatEvent) => void): Unsubscribe {
    this._chatListeners.add(cb);
    return () => this._chatListeners.delete(cb);
  }

  // ── Internal: emit to subscribers ──────────────────────────────────────

  private _emitHealth(e: HealthEvent): void {
    for (const fn of this._healthListeners) {
      try { fn(e); } catch (err) { console.error("[controluiclaw-sdk] health listener error:", err); }
    }
  }

  private _emitChat(e: ChatEvent): void {
    for (const fn of this._chatListeners) {
      try { fn(e); } catch (err) { console.error("[controluiclaw-sdk] chat listener error:", err); }
    }
  }

  // ── Internal: one-shot connect hooks ───────────────────────────────────

  private _onceConnected: (() => void) | null = null;
  private _onceError: ((msg: string) => void) | null = null;
  private _onceDisconnected: ((code: number, reason: string) => void) | null = null;

  private _clearOnceHooks(): void {
    this._onceConnected = null;
    this._onceError = null;
    this._onceDisconnected = null;
  }

  // ── Internal: WebSocket lifecycle ──────────────────────────────────────

  private _setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
  }

  private _openSocket(): void {
    if (this._closed) return;
    this._setState("connecting");
    this._emitHealth({ code: "connecting", message: `Connecting to ${this._url}...` });

    const ws = new WebSocket(this._url);
    this._ws = ws;

    ws.addEventListener("message", (ev) => this._handleMessage(ev.data));

    ws.addEventListener("close", (ev) => {
      this._flushPending(new Error(`WebSocket closed (${ev.code})`));
      this._setState("disconnected");

      // Fire one-shot hook if still pending
      const onceDc = this._onceDisconnected;
      this._clearOnceHooks();
      onceDc?.(ev.code, ev.reason);

      this._emitHealth({
        code: "disconnected",
        message: `Disconnected (${ev.code}${ev.reason ? ": " + ev.reason : ""})`,
      });

      if (!this._closed && this._autoReconnect) {
        this._emitHealth({ code: "reconnecting", message: `Reconnecting in ${this._backoffMs}ms...` });
        this._scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      const onceErr = this._onceError;
      this._clearOnceHooks();
      onceErr?.("WebSocket error");

      this._emitHealth({ code: "error", message: "WebSocket error" });
    });
  }

  private _scheduleReconnect(): void {
    const delay = this._backoffMs;
    this._backoffMs = Math.min(delay * 1.7, this._maxBackoffMs);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._openSocket();
    }, delay);
  }

  private _flushPending(err: Error): void {
    for (const [, p] of this._pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  // ── Internal: message handling ─────────────────────────────────────────

  private async _handleMessage(raw: string): Promise<void> {
    let frame: any;
    try { frame = JSON.parse(raw); } catch { return; }

    if (frame.type === "event") {
      this._handleEvent(frame as EventFrame);
      return;
    }

    if (frame.type === "res") {
      const res = frame as ResponseFrame;
      const pending = this._pending.get(res.id);
      if (!pending) return;
      this._pending.delete(res.id);
      if (pending.timer) clearTimeout(pending.timer);
      res.ok
        ? pending.resolve(res.payload)
        : pending.reject(new Error(res.error?.message ?? "Request failed"));
    }
  }

  private _handleEvent(frame: EventFrame): void {
    // Handshake challenge
    if (frame.event === "connect.challenge") {
      this._connectNonce = (frame.payload as any)?.nonce ?? null;
      this._sendHandshake();
      return;
    }

    // Chat events → chatEvents stream
    if (frame.event === "chat") {
      const p = frame.payload as Record<string, any>;
      const state: string = p?.state ?? "";
      const runId: string = p?.runId ?? "";
      const sessionKey: string = p?.sessionKey ?? "";
      const text = extractText(p?.message);

      if (state === "delta" || state === "final" || state === "error" || state === "aborted") {
        this._emitChat({
          type: (state === "delta" ? "stream" : state) as ChatEvent["type"],
          runId,
          sessionKey,
          text: state === "error" ? (p?.errorMessage ?? text ?? "Unknown error") : text,
          raw: p,
        });
      }
      return;
    }

    // Session changes → health stream
    if (frame.event === "sessions.changed") {
      this._emitHealth({ code: "sessions_changed", message: "Sessions list updated" });
      return;
    }

    // Gateway-level errors that arrive as events → health stream
    if (frame.event === "error" || frame.event === "session.error") {
      const p = frame.payload as Record<string, any>;
      this._emitHealth({
        code: "error",
        message: p?.message ?? p?.errorMessage ?? JSON.stringify(p),
      });
      return;
    }

    // Skip ticks, log anything unexpected to health
    if (frame.event !== "tick" && frame.event !== "session.tool") {
      this._emitHealth({
        code: "event",
        message: `[${frame.event}] ${JSON.stringify(frame.payload ?? {})}`,
      });
    }
  }

  // ── Internal: handshake ────────────────────────────────────────────────

  private async _sendHandshake(): Promise<void> {
    try {
      const identity =
        this._providedIdentity ?? (await getOrCreateDeviceIdentity());
      const signedAtMs = Date.now();
      const nonce = this._connectNonce ?? "";

      const authPayloadStr = buildDeviceAuthPayload({
        deviceId: identity.deviceId,
        clientId: this._clientInfo.id,
        clientMode: this._clientInfo.mode,
        role: this._role,
        scopes: this._scopes,
        signedAtMs,
        token: this._token ?? null,
        nonce,
      });

      const signature = await signPayload(identity.privateKey, authPayloadStr);

      const connectParams: ConnectParams = {
        minProtocol: this._protocolRange.min,
        maxProtocol: this._protocolRange.max,
        client: this._clientInfo,
        role: this._role,
        scopes: this._scopes,
        caps: this._caps,
        auth: this._token ? { token: this._token } : undefined,
        device: {
          id: identity.deviceId,
          publicKey: identity.publicKey,
          signature,
          signedAt: signedAtMs,
          nonce,
        },
        locale:
          typeof navigator !== "undefined"
            ? navigator.language ?? "en-US"
            : "en-US",
        userAgent:
          typeof navigator !== "undefined" ? navigator.userAgent : "controluiclaw-sdk",
      };

      const hello = await this.request<HelloPayload>(
        "connect",
        connectParams as unknown as Record<string, unknown>,
      );

      this._helloPayload = hello;
      this._backoffMs = this._initialBackoffMs;
      this._setState("connected");

      // Fire one-shot hook
      const onceConn = this._onceConnected;
      this._clearOnceHooks();
      onceConn?.();

      this._emitHealth({
        code: "connected",
        message: `Connected — protocol v${hello.protocol}, server ${hello.server?.version ?? "unknown"}`,
      });

      // Auto-subscribe to session events
      this.request("sessions.subscribe").catch(() => {});
    } catch (err: any) {
      const msg = `Handshake failed: ${err?.message ?? err}`;

      const onceErr = this._onceError;
      this._clearOnceHooks();
      onceErr?.(msg);

      this._emitHealth({ code: "error", message: msg });
      this._ws?.close();
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export class ControlUIClaw {
  private _core: CoreClient;

  private constructor(core: CoreClient) {
    this._core = core;
  }

  /**
   * Initialize the SDK. Call this once with your gateway URL and token.
   *
   * ```ts
   * const claw = ControlUIClaw.init({ url: "wss://gateway:18789", token: "xxx" });
   * ```
   */
  static init(options: InitOptions): ControlUIClaw {
    return new ControlUIClaw(new CoreClient(options));
  }

  /** Current connection state. */
  get state(): ConnectionState {
    return this._core.state;
  }

  /** Whether the client is connected and handshake is complete. */
  get isConnected(): boolean {
    return this._core.isConnected;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Connect to the gateway. Call when the page becomes visible.
   * Returns a result object — never throws.
   *
   * ```ts
   * const result = await claw.connect();
   * if (!result.ok) console.error(result.error);
   * ```
   */
  connect(): Promise<ConnectResult> {
    return this._core.connect();
  }

  /**
   * Disconnect from the gateway.
   */
  disconnect(): void {
    this._core.disconnect();
  }

  // ── Sessions ───────────────────────────────────────────────────────────

  /**
   * Fetch all sessions from the gateway, sorted newest-first.
   */
  async listSessions(options?: { limit?: number }): Promise<Session[]> {
    const result = await this._core.request<SessionsListResult>(
      "sessions.list",
      {
        limit: options?.limit ?? 50,
        includeDerivedTitles: true,
        includeLastMessage: true,
      },
    );
    const sessions = result?.sessions ?? [];
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return sessions;
  }

  // ── Chat ───────────────────────────────────────────────────────────────

  /**
   * Load chat history for a session.
   */
  async chatHistory(
    sessionKey: string,
    options?: { limit?: number },
  ): Promise<ChatHistoryResult> {
    return this._core.request<ChatHistoryResult>("chat.history", {
      sessionKey,
      limit: options?.limit ?? 50,
    });
  }

  /**
   * Send a prompt to the given session.
   *
   * ```ts
   * await claw.sendPrompt(sessionKey, "What is the weather?");
   * ```
   */
  async sendPrompt(sessionKey: string, message: string): Promise<void> {
    await this._core.request("chat.send", {
      sessionKey,
      message,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  // ── Streams ────────────────────────────────────────────────────────────

  /**
   * Subscribe to session health / connection status events.
   * Returns an `unsubscribe` function.
   *
   * Events include: connected, disconnected, reconnecting, error,
   * sessions_changed, and any gateway-level errors (e.g. billing).
   *
   * ```ts
   * const unsub = claw.sessionHealth((event) => {
   *   // { code: "error", message: "billing error — your API key ..." }
   *   // { code: "connected", message: "Connected — protocol v3 ..." }
   *   // { code: "disconnected", message: "..." }
   *   console.log(event.code, event.message);
   * });
   *
   * // Later:
   * unsub();
   * ```
   */
  sessionHealth(callback: (event: HealthEvent) => void): Unsubscribe {
    return this._core.onHealth(callback);
  }

  /**
   * Subscribe to chat events (stream chunks, final completions, errors, aborts).
   * Returns an `unsubscribe` function.
   *
   * ```ts
   * const unsub = claw.chatEvents((event) => {
   *   switch (event.type) {
   *     case "stream":  // streaming chunk
   *     case "final":   // completed response
   *     case "error":   // run error
   *     case "aborted": // run cancelled
   *   }
   *   console.log(event.type, event.runId, event.text);
   * });
   * ```
   */
  chatEvents(callback: (event: ChatEvent) => void): Unsubscribe {
    return this._core.onChat(callback);
  }

  // ── Utilities ──────────────────────────────────────────────────────────

  /**
   * Generic gateway request for any method not covered above.
   */
  request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    return this._core.request<T>(method, params);
  }

  /** Generate a new unique session key. */
  static createSessionKey(prefix?: string): string {
    return createSessionKey(prefix);
  }

  /** Extract readable text from any chat message shape. */
  static extractText(msg: unknown): string {
    return extractText(msg);
  }
}
