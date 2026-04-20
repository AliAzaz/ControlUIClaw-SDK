// ---------------------------------------------------------------------------
// ControlUIClaw SDK — Gateway Client
// ---------------------------------------------------------------------------

import {
  Channel,
  type InitOptions,
  type ConnectResult,
  type HealthEvent,
  type ChatEvent,
  type Unsubscribe,
  type ConnectionState,
  type HelloPayload,
  type ConnectParams,
  type ClientInfo,
  type DeviceIdentity,
  type EventFrame,
  type ResponseFrame,
  type RequestFrame,
  type Session,
  type SessionsListResult,
  type ChatHistoryResult,
  type SendPromptOptions,
  type SendImagePromptOptions,
  type TokenUsage,
  type ThinkingLevel,
  type Attachment,
  type ChannelsStatusResult,
  type ChannelLogoutResult,
  type ChannelLogoutOptions,
  type WhatsAppLoginOptions,
  type ChannelStatusEvent,
  type ChannelsChannelData,
  type ChannelAccountSnapshot,
} from "./types";

import {
  getOrCreateDeviceIdentity,
  buildDeviceAuthPayload,
  signPayload,
} from "./crypto";

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

/** Extracts thinking/reasoning text from a chat message payload. */
function extractThinking(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, any>;

  // Direct thinking field on the message
  if (typeof m.thinking === "string") return m.thinking;

  // Content blocks may contain { type: "thinking", thinking: "..." }
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b: any) => b?.type === "thinking" || b?.type === "redacted_thinking")
      .map((b: any) => b?.thinking ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Extracts and normalizes token usage from a chat event payload. */
function extractUsage(payload: Record<string, any>): TokenUsage | undefined {
  const raw = payload?.usage;
  if (!raw || typeof raw !== "object") return undefined;

  const u = raw as Record<string, any>;
  const usage: TokenUsage = {};

  // Normalize: accept both camelCase and snake_case variants
  const input = finiteOrUndef(u.input ?? u.inputTokens ?? u.input_tokens);
  const output = finiteOrUndef(u.output ?? u.outputTokens ?? u.output_tokens);
  if (input !== undefined) usage.input = input;
  if (output !== undefined) usage.output = output;

  const total = finiteOrUndef(u.totalTokens ?? u.total_tokens);
  if (total !== undefined) usage.totalTokens = total;
  else if (input !== undefined && output !== undefined) usage.totalTokens = input + output;

  const cacheRead = finiteOrUndef(u.cacheRead ?? u.cache_read_input_tokens);
  const cacheWrite = finiteOrUndef(u.cacheWrite ?? u.cache_creation_input_tokens);
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;

  if (u.cost && typeof u.cost === "object") usage.cost = u.cost;

  // Return undefined if nothing was populated
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function finiteOrUndef(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Extracts attachment metadata from a chat message.
 *
 * Sources:
 * - Content blocks with `type: "image"` (gateway strips `data`, adds `omitted`/`bytes`)
 * - User message `MediaPaths` / `MediaTypes` fields (filesystem paths on gateway host)
 */
function extractAttachments(msg: Record<string, any>): Attachment[] | undefined {
  const attachments: Attachment[] = [];

  // Image content blocks (present on both user and assistant messages)
  // Formats:
  //   - Anthropic: { type: "image", source: { type: "base64", data: "...", media_type: "image/png" } }
  //   - Simplified: { type: "image", data: "base64...", mimeType: "image/png" }
  //   - Omitted:   { type: "image", omitted: true, bytes: 12345, mimeType: "image/png" }
  //   - OpenAI:    { type: "image_url", image_url: { url: "..." } }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block?.type === "image") {
        const source = block.source as Record<string, unknown> | undefined;
        const mimeType =
          typeof block.mimeType === "string" ? block.mimeType
          : typeof source?.media_type === "string" ? source.media_type
          : "application/octet-stream";
        const bytes = typeof block.bytes === "number" ? block.bytes : 0;

        let dataUrl = "";
        if (source?.type === "base64" && typeof source.data === "string") {
          // Anthropic format — source.data survives sanitization
          const d = source.data as string;
          dataUrl = d.startsWith("data:") ? d : `data:${mimeType};base64,${d}`;
        } else if (typeof block.data === "string") {
          // Simplified format — top-level data (may be stripped by gateway)
          dataUrl = block.data.startsWith("data:")
            ? block.data
            : `data:${mimeType};base64,${block.data}`;
        } else if (typeof block.url === "string") {
          dataUrl = block.url;
        }
        attachments.push({ mimeType, bytes, dataUrl });
      } else if (block?.type === "image_url") {
        // OpenAI format
        const imageUrl = block.image_url as Record<string, unknown> | undefined;
        if (typeof imageUrl?.url === "string") {
          attachments.push({
            mimeType: "image/png",
            bytes: 0,
            dataUrl: imageUrl.url,
          });
        }
      }
    }
  }

  // User-message media fields (MediaPaths + MediaTypes arrays)
  const paths: string[] = Array.isArray(msg.MediaPaths) ? msg.MediaPaths : [];
  const types: string[] = Array.isArray(msg.MediaTypes) ? msg.MediaTypes : [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (typeof path !== "string") continue;
    const mimeType = typeof types[i] === "string" ? types[i] : "application/octet-stream";
    // Try to enrich an existing content-block entry that has no dataUrl yet
    const existing = attachments.find((a) => a.mimeType === mimeType && !a.dataUrl);
    if (existing) {
      existing.dataUrl = path;
    } else {
      attachments.push({ mimeType, bytes: 0, dataUrl: path });
    }
  }

  return attachments.length > 0 ? attachments : undefined;
}

/** Generates a new unique session key. */
function createSessionKey(prefix = "agent:main"): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

// ── Title Derivation ────────────────────────────────────────────────────────

const DERIVED_TITLE_MAX_LEN = 60;

/** Truncate a title string, preferring word boundaries. */
function truncateTitle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.6) {
    return cut.slice(0, lastSpace) + "…";
  }
  return cut + "…";
}

/** Format a session key prefix with optional date for fallback titles. */
function formatSessionKeyPrefix(key: string, updatedAt?: number | null): string {
  const prefix = key.slice(0, 8);
  if (updatedAt && updatedAt > 0) {
    const date = new Date(updatedAt).toISOString().slice(0, 10);
    return `${prefix} (${date})`;
  }
  return prefix;
}

/**
 * Derive a human-readable session title, mirroring the openclaw gateway logic.
 *
 * Priority cascade:
 *  1. `displayName` — explicit user-set name
 *  2. `label` — only if it looks like a real label (not raw JSON/metadata)
 *  3. `firstUserMessage` — first user message text, truncated to 60 chars
 *  4. Session key prefix + date fallback
 */
function deriveSessionTitle(
  session: Session,
  firstUserMessage?: string | null,
): string {
  const displayName = session.displayName?.trim();
  if (displayName) return displayName;

  // Only use label if it doesn't look like raw untrusted metadata / JSON blob
  const label = session.label?.trim();
  if (label && !label.startsWith("{") && !label.startsWith("Sender")) {
    return truncateTitle(label, DERIVED_TITLE_MAX_LEN);
  }

  if (firstUserMessage?.trim()) {
    const normalized = firstUserMessage.replace(/\s+/g, " ").trim();
    return truncateTitle(normalized, DERIVED_TITLE_MAX_LEN);
  }

  return formatSessionKeyPrefix(session.key, session.updatedAt);
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
      id: "openclaw-control-ui",
      version: "1.0.0",
      platform:
        typeof navigator !== "undefined"
          ? navigator.platform ?? "web"
          : "node",
      mode: "ui",
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
        const thinking = extractThinking(p?.message);
        const usage = extractUsage(p);
        const model: string | undefined =
          typeof p?.model === "string" ? p.model
          : typeof p?.modelId === "string" ? p.modelId
          : typeof p?.message?.model === "string" ? p.message.model
          : undefined;

        const event: ChatEvent = {
          type: (state === "delta" ? "stream" : state) as ChatEvent["type"],
          runId,
          sessionKey,
          text: state === "error" ? (p?.errorMessage ?? text ?? "Unknown error") : text,
          raw: p,
        };
        if (thinking) event.thinking = thinking;
        if (usage) event.usage = usage;
        if (model) event.model = model;

        // On "final" events, the gateway may not include usage/model directly.
        // Backfill from chat.history which carries per-message usage on assistant msgs.
        if (state === "final" && (!usage || !model) && sessionKey) {
          this._backfillUsageFromHistory(event, sessionKey).then((enriched) => {
            this._emitChat(enriched);
          }).catch(() => {
            // History fetch failed — emit with whatever we have
            this._emitChat(event);
          });
        } else {
          this._emitChat(event);
        }
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

    // Tool lifecycle events → chatEvents stream
    if (frame.event === "session.tool") {
      const p = frame.payload as Record<string, any>;
      const data = p?.data as Record<string, any> | undefined;
      if (data?.phase === "start" && data?.name) {
        const event: ChatEvent = {
          type: "tool",
          runId: p?.runId ?? "",
          sessionKey: p?.sessionKey ?? "",
          text: "",
          tool: {
            phase: data.phase,
            name: data.name,
            toolCallId: data.toolCallId ?? "",
            args: data.args,
          },
          raw: p,
        };
        this._emitChat(event);
      }
      return;
    }

    // Skip ticks, log anything unexpected to health
    if (frame.event !== "tick") {
      this._emitHealth({
        code: "event",
        message: `[${frame.event}] ${JSON.stringify(frame.payload ?? {})}`,
      });
    }
  }

  // ── Internal: backfill usage from chat.history ─────────────────────────

  private async _backfillUsageFromHistory(
    event: ChatEvent,
    sessionKey: string,
  ): Promise<ChatEvent> {
    const history = await this.request<ChatHistoryResult>("chat.history", {
      sessionKey,
      limit: 5,
    });
    const messages = history?.messages ?? history?.items ?? [];
    // Find the last assistant message — it carries per-message usage
    const lastAssistant = [...messages]
      .reverse()
      .find((m: Record<string, any>) => m.role === "assistant");

    if (!lastAssistant) return event;

    const msg = lastAssistant as Record<string, any>;

    // Backfill usage if not already present
    if (!event.usage) {
      const usage = extractUsage(msg);
      if (usage) event.usage = usage;
    }

    // Backfill model if not already present
    if (!event.model) {
      const model =
        typeof msg.model === "string" ? msg.model
        : typeof msg.modelId === "string" ? msg.modelId
        : typeof msg.provider === "string" ? msg.provider
        : undefined;
      if (model) event.model = model;
    }

    return event;
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
  private _defaultThinking: ThinkingLevel;

  private constructor(core: CoreClient, thinking: ThinkingLevel) {
    this._core = core;
    this._defaultThinking = thinking;
  }

  /**
   * Initialize the SDK. Call this once with your gateway URL and token.
   *
   * ```ts
   * const claw = ControlUIClaw.init({ url: "wss://gateway:18789", token: "xxx" });
   *
   * // With thinking enabled by default
   * const claw = ControlUIClaw.init({
   *   url: "wss://gateway:18789",
   *   token: "xxx",
   *   thinking: "medium",
   * });
   * ```
   */
  static init(options: InitOptions): ControlUIClaw {
    return new ControlUIClaw(new CoreClient(options), options.thinking ?? "off");
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

    // Client-side title derivation for sessions missing a usable derivedTitle
    await Promise.all(
      sessions.map(async (s) => {
        if (!s.derivedTitle?.trim()?.includes("(untrusted metadata):")) return;

        // Try to get the first user message from chat history
        let firstUserMessage: string | null = null;
        try {
          const history = await this._core.request<ChatHistoryResult>(
            "chat.history",
            { sessionKey: s.key, limit: 5 },
          );
          const messages = history?.messages ?? [];
          const firstUser = messages.find(
            (m: Record<string, unknown>) =>
              m.role === "user" || m.role === "human",
          );
          if (firstUser) {
            firstUserMessage = extractText(firstUser);
          }
        } catch {
          // chat.history may not be available for all sessions — fall through
        }
        s.derivedTitle = deriveSessionTitle(s, firstUserMessage);
      }),
    );

    return sessions;
  }

  // ── Chat ───────────────────────────────────────────────────────────────

  /**
   * Load chat history for a session.
   * Assistant messages are enriched with normalized `usage` and `model` fields.
   */
  async chatHistory(
    sessionKey: string,
    options?: { limit?: number },
  ): Promise<ChatHistoryResult> {
    const result = await this._core.request<ChatHistoryResult>("chat.history", {
      sessionKey,
      limit: options?.limit ?? 50,
    });
    const messages = result?.messages ?? result?.items ?? [];
    for (const msg of messages) {
      const raw = msg as Record<string, any>;
      // Extract attachments from any message (user or assistant)
      if (!msg.attachments) {
        console.log(msg.attachments);
        const attachments = extractAttachments(raw);
        if (attachments) msg.attachments = attachments;
      }

      // Usage and model are only on assistant messages
      if (msg.role !== "assistant") continue;
      if (!msg.usage) {
        const usage = extractUsage(raw);
        if (usage) msg.usage = usage;
      }
      if (!msg.model) {
        const model =
          typeof raw.model === "string" ? raw.model
          : typeof raw.modelId === "string" ? raw.modelId
          : undefined;
        if (model) msg.model = model;
      }
    }
    return result;
  }

  /**
   * Send a prompt to the given session.
   *
   * ```ts
   * // Basic
   * await claw.sendPrompt(sessionKey, "What is the weather?");
   *
   * // With thinking enabled
   * await claw.sendPrompt(sessionKey, "Solve this step by step", { thinking: "high" });
   * ```
   */
  async sendPrompt(
    sessionKey: string,
    message: string,
    options?: SendPromptOptions,
  ): Promise<void> {
    const thinking = options?.thinking ?? this._defaultThinking;
    const params: Record<string, unknown> = {
      sessionKey,
      message,
      idempotencyKey: crypto.randomUUID(),
    };
    if (thinking && thinking !== "off") {
      params.thinking = thinking;
    }
    await this._core.request("chat.send", params);
  }

  /**
   * Send a message with image attachments to the given session.
   *
   * ```ts
   * // Single image
   * await claw.sendImagePrompt(sessionKey, "What's in this image?", {
   *   images: [{ mimeType: "image/png", data: base64String }],
   * });
   *
   * // Multiple images with thinking enabled
   * await claw.sendImagePrompt(sessionKey, "Compare these two images", {
   *   images: [
   *     { mimeType: "image/jpeg", fileName: "photo1.jpg", data: base64A },
   *     { mimeType: "image/jpeg", fileName: "photo2.jpg", data: base64B },
   *   ],
   *   thinking: "high",
   * });
   * ```
   */
  async sendImagePrompt(
    sessionKey: string,
    message: string,
    options: SendImagePromptOptions,
  ): Promise<void> {
    const thinking = options.thinking ?? this._defaultThinking;
    const attachments = options.images.map((img) => ({
      type: "image",
      mimeType: img.mimeType,
      ...(img.fileName ? { fileName: img.fileName } : {}),
      content: img.data,
    }));
    const params: Record<string, unknown> = {
      sessionKey,
      message,
      attachments,
      idempotencyKey: crypto.randomUUID(),
    };
    if (thinking && thinking !== "off") {
      params.thinking = thinking;
    }
    await this._core.request("chat.send", params);
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

  // ── Channels ───────────────────────────────────────────────────────────

  /**
   * Get the status of all configured channels and their accounts.
   *
   * ```ts
   * const status = await claw.getChannelsStatus();
   * console.log(status.channelOrder); // ["whatsapp", "telegram", ...]
   * console.log(status.channels.whatsapp?.connected);
   *
   * // With health probes
   * const probed = await claw.getChannelsStatus(true, 10000);
   * ```
   */
  async getChannelsStatus(
    probe?: boolean,
    timeoutMs?: number,
  ): Promise<ChannelsStatusResult> {
    const params: Record<string, unknown> = {};
    if (probe !== undefined) params.probe = probe;
    if (timeoutMs !== undefined) params.timeoutMs = timeoutMs;
    return this._core.request<ChannelsStatusResult>("channels.status", params);
  }

  /**
   * Start WhatsApp QR code login and wait for completion.
   *
   * Handles the full login flow: initiates QR pairing, reports progress
   * via the `onStatus` callback, and resolves when connected or rejects
   * on failure/timeout.
   *
   * ```ts
   * await claw.startWhatsAppChannelLogin({
   *   onStatus: (event) => {
   *     switch (event.step) {
   *       case "qr_ready":       renderQr(event.qrDataUrl); break;
   *       case "scanning":       showSpinner("Waiting for scan..."); break;
   *       case "authenticating": showSpinner("Authenticating..."); break;
   *       case "connected":      showSuccess(); break;
   *       case "failed":         showError(event.error); break;
   *     }
   *   },
   *   timeoutMs: 120000,
   * });
   * ```
   */
  async startWhatsAppChannelLogin(options: WhatsAppLoginOptions): Promise<void> {
    const { onStatus, force, timeoutMs, accountId } = options;

    // Step 1: Initiate QR pairing.
    const startParams: Record<string, unknown> = {};
    if (force !== undefined) startParams.force = force;
    if (accountId !== undefined) startParams.accountId = accountId;

    let startResult: Record<string, unknown>;
    try {
      startResult = await this._core.request<Record<string, unknown>>(
        "web.login.start",
        startParams,
        { timeoutMs: 60_000 },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onStatus({ step: "failed", error: message, message: "Failed to start QR login" });
      throw err;
    }

    const pickQr = (r: Record<string, unknown>): string | undefined =>
      typeof r.qrDataUrl === "string"
        ? r.qrDataUrl
        : typeof r.qr === "string"
          ? r.qr
          : undefined;

    const pickMessage = (r: Record<string, unknown>): string | undefined =>
      typeof r.message === "string" ? r.message : undefined;

    const startQr = pickQr(startResult);
    const startMsg = pickMessage(startResult);

    // Gateway declines to start a new QR when the channel is already linked;
    // signal that back through the `onStatus` channel with a `failed` step so
    // the UI can prompt the user to relink (force: true) or disconnect first.
    if (!startQr && startMsg && /already linked|already connected/i.test(startMsg)) {
      onStatus({ step: "failed", error: startMsg, message: startMsg });
      return;
    }

    onStatus({ step: "qr_ready", qrDataUrl: startQr, message: "QR code ready — scan with your phone" });
    onStatus({ step: "scanning", message: "Waiting for QR code scan..." });

    // Step 2: Poll `web.login.wait` with short server-side windows so the gateway
    // can rotate the QR every ~15-20s. Each response either carries a fresh QR
    // (still waiting) or `connected: true`. `overallDeadline` caps the total flow.
    const overallDeadline = Date.now() + (typeof timeoutMs === "number" ? timeoutMs : 120_000);
    const perCallServerTimeoutMs = 15_000;
    // Give the client-side RPC timeout a buffer above the server-side wait.
    const perCallClientTimeoutMs = perCallServerTimeoutMs + 5_000;
    // If the gateway returns immediately with a "no-op" message repeatedly, the
    // login session was never initialised; stop instead of busy-looping.
    let idleResponses = 0;
    const idleLimit = 3;

    while (Date.now() < overallDeadline) {
      const waitParams: Record<string, unknown> = { timeoutMs: perCallServerTimeoutMs };
      if (accountId !== undefined) waitParams.accountId = accountId;

      let waitResult: Record<string, unknown>;
      const callStart = Date.now();
      try {
        waitResult = await this._core.request<Record<string, unknown>>(
          "web.login.wait",
          waitParams,
          { timeoutMs: perCallClientTimeoutMs },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onStatus({ step: "failed", error: message, message: "Login failed" });
        throw err;
      }
      const callDurationMs = Date.now() - callStart;

      if (waitResult.connected) {
        onStatus({ step: "authenticating", message: "Authenticating..." });
        onStatus({ step: "connected", message: "WhatsApp connected" });
        return;
      }

      const rotatedQr = pickQr(waitResult);
      if (rotatedQr) {
        idleResponses = 0;
        onStatus({ step: "qr_ready", qrDataUrl: rotatedQr, message: "QR refreshed — scan now" });
      }

      if (typeof waitResult.error === "string" && waitResult.error) {
        onStatus({ step: "failed", error: waitResult.error, message: "WhatsApp login failed" });
        throw new Error(waitResult.error);
      }

      const noOpMsg = pickMessage(waitResult);
      if (!rotatedQr && callDurationMs < 1_000 && noOpMsg && /no active|not in progress|not started/i.test(noOpMsg)) {
        idleResponses += 1;
        if (idleResponses >= idleLimit) {
          onStatus({ step: "failed", error: noOpMsg, message: noOpMsg });
          return;
        }
      }
    }

    const timeoutErr = "QR login timed out before completion";
    onStatus({ step: "failed", error: timeoutErr, message: "WhatsApp login timed out" });
    throw new Error(timeoutErr);
  }

  /**
   * Apply a deep-merge patch to the gateway config. Uses the `config.patch`
   * RPC contract: a `raw` JSON5 payload plus the `baseHash` returned by
   * `config.get`, so the gateway can detect concurrent edits.
   */
  private async patchConfigDeep(patch: Record<string, unknown>): Promise<void> {
    const snapshot = await this._core.request<{ hash?: string }>("config.get", {});
    const baseHash = typeof snapshot?.hash === "string" ? snapshot.hash : undefined;
    await this._core.request("config.patch", {
      raw: JSON.stringify(patch),
      ...(baseHash ? { baseHash } : {}),
    });
  }

  /**
   * Configure Telegram DM allowlist via config.patch — equivalent to setting
   * `channels.telegram.dmPolicy = "allowlist"` + `channels.telegram.allowFrom = userIds`.
   * The docs recommend this over pairing codes for one-owner bots.
   */
  async setTelegramAllowlist(userIds: number[], accountId?: string): Promise<void> {
    const allowFromPatch = accountId
      ? { accounts: { [accountId]: { dmPolicy: "allowlist" as const, allowFrom: userIds } } }
      : { dmPolicy: "allowlist" as const, allowFrom: userIds };
    await this.patchConfigDeep({ channels: { telegram: allowFromPatch } });
  }

  /**
   * Set a Telegram bot token to connect the Telegram channel.
   *
   * ```ts
   * await claw.setTelegramChannelToken("123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11");
   * ```
   */
  async setTelegramChannelToken(botToken: string, accountId?: string): Promise<void> {
    const telegramPatch = accountId
      ? { accounts: { [accountId]: { botToken } } }
      : { botToken };
    await this.patchConfigDeep({ channels: { telegram: telegramPatch } });
  }

  /**
   * Set a Discord bot token to connect the Discord channel.
   *
   * ```ts
   * await claw.setDiscordChannelToken("MTIzNDU2Nzg5MDEy...");
   * ```
   */
  async setDiscordChannelToken(botToken: string, accountId?: string): Promise<void> {
    const discordPatch = accountId
      ? { accounts: { [accountId]: { botToken } } }
      : { botToken };
    await this.patchConfigDeep({ channels: { discord: discordPatch } });
  }

  /**
   * Set Slack bot and app tokens to connect the Slack channel.
   *
   * ```ts
   * await claw.setSlackChannelTokens("xoxb-...", "xapp-...");
   * ```
   */
  async setSlackChannelTokens(
    botToken: string,
    appToken: string,
    accountId?: string,
  ): Promise<void> {
    const slackPatch = accountId
      ? { accounts: { [accountId]: { botToken, appToken } } }
      : { botToken, appToken };
    await this.patchConfigDeep({ channels: { slack: slackPatch } });
  }

  /**
   * Disconnect a channel and clear its credentials.
   *
   * ```ts
   * await claw.logoutChannel(Channel.WhatsApp);
   * await claw.logoutChannel(Channel.Telegram, { accountId: "bot2" });
   * ```
   */
  async logoutChannel(
    channel: Channel,
    options?: ChannelLogoutOptions,
  ): Promise<ChannelLogoutResult> {
    const params: Record<string, unknown> = { channel };
    if (options?.accountId) params.accountId = options.accountId;
    return this._core.request<ChannelLogoutResult>("channels.logout", params);
  }

  /**
   * Subscribe to real-time channel status changes.
   * Returns an `unsubscribe` function.
   *
   * Channel status is extracted from the gateway health broadcast,
   * which is emitted periodically and on state changes.
   *
   * ```ts
   * const unsub = claw.onChannelStatus((event) => {
   *   const wa = event.channels.whatsapp;
   *   console.log("WhatsApp connected:", wa?.connected);
   * });
   *
   * // Later:
   * unsub();
   * ```
   */
  onChannelStatus(callback: (event: ChannelStatusEvent) => void): Unsubscribe {
    return this._core.onHealth((raw: HealthEvent) => {
      const payload = raw as unknown as Record<string, unknown>;
      if (payload.channels || payload.channelAccounts) {
        callback({
          ts: typeof payload.ts === "number" ? payload.ts : Date.now(),
          channels: (payload.channels ?? {}) as ChannelsChannelData,
          channelAccounts: (payload.channelAccounts ?? {}) as Record<
            string,
            ChannelAccountSnapshot[]
          >,
        });
      }
    });
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

  /**
   * Derive a human-readable title for a session.
   *
   * Uses the same cascading priority as the openclaw gateway:
   *  1. `displayName`
   *  2. `label` (if it looks like a real label, not raw metadata)
   *  3. `firstUserMessage` (truncated to 60 chars)
   *  4. Session key prefix + date
   */
  static deriveSessionTitle(
    session: Session,
    firstUserMessage?: string | null,
  ): string {
    return deriveSessionTitle(session, firstUserMessage);
  }
}
