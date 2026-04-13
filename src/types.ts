// ---------------------------------------------------------------------------
// ControlUIClaw SDK — Type Definitions
// ---------------------------------------------------------------------------

/** Connection states used internally. */
export type ConnectionState = "disconnected" | "connecting" | "connected";

// ── Wire Protocol ──────────────────────────────────────────────────────────

export interface RequestFrame {
  type: "req";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string };
}

export interface EventFrame {
  type: "event";
  event: string;
  payload?: Record<string, unknown>;
}

// ── Handshake / Auth ───────────────────────────────────────────────────────

export interface ClientInfo {
  id: string;
  version: string;
  platform: string;
  mode: string;
}

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: string;
}

export interface DeviceAuthFields {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
}

export interface ConnectParams {
  minProtocol: number;
  maxProtocol: number;
  client: ClientInfo;
  role: string;
  scopes: string[];
  caps?: string[];
  auth?: { token?: string };
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
  };
  locale?: string;
  userAgent?: string;
}

export interface HelloPayload {
  protocol: number;
  server?: { version?: string; [key: string]: unknown };
  [key: string]: unknown;
}

// ── Session Types ──────────────────────────────────────────────────────────

export interface Session {
  key: string;
  status?: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  updatedAt?: number;
  createdAt?: number;
  lastMessage?: unknown;
  [key: string]: unknown;
}

export interface SessionsListResult {
  sessions: Session[];
}

// ── Thinking ──────────────────────────────────────────────────────────────

/**
 * Thinking level for extended reasoning.
 *
 * - `"off"`      — no thinking
 * - `"minimal"`  — very brief internal reasoning
 * - `"low"`      — light reasoning
 * - `"medium"`   — moderate reasoning (default when enabled)
 * - `"high"`     — deep reasoning
 * - `"xhigh"`    — maximum reasoning depth
 * - `"adaptive"` — provider picks automatically
 */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive";

// ── Token Usage ───────────────────────────────────────────────────────────

/** Per-message token usage counters. */
export interface TokenUsage {
  /** Input / prompt tokens. */
  input?: number;
  /** Output / completion tokens. */
  output?: number;
  /** Total tokens (input + output when available). */
  totalTokens?: number;
  /** Tokens served from prompt cache. */
  cacheRead?: number;
  /** Tokens written to prompt cache. */
  cacheWrite?: number;
  /** Provider-reported cost (when available). */
  cost?: Record<string, unknown>;
}

// ── Chat Types ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role?: string;
  text?: string;
  content?: string | ContentBlock[];
  choices?: ChatChoice[];
  /** Normalized token usage (present on assistant messages). */
  usage?: TokenUsage;
  /** Model identifier (e.g. "sonnet-4.6") when reported by the gateway. */
  model?: string;
  [key: string]: unknown;
}

export interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
}

export interface ChatChoice {
  delta?: { content?: string };
  message?: { content?: string };
}

export interface ChatHistoryResult {
  messages?: ChatMessage[];
  items?: ChatMessage[];
}

// ── Public API Types ───────────────────────────────────────────────────────

/** Options passed to `ControlUIClaw.init()`. */
export interface InitOptions {
  /** WebSocket URL of the gateway (e.g. wss://host:18789). */
  url: string;

  /** Auth token (optional if device auth alone is sufficient). */
  token?: string;

  /** Client identification sent during handshake. */
  clientInfo?: Partial<ClientInfo>;

  /** Role claimed during handshake. Defaults to "operator". */
  role?: string;

  /** Scopes requested during handshake. */
  scopes?: string[];

  /** Protocol version range. Defaults to { min: 3, max: 3 }. */
  protocol?: { min: number; max: number };

  /** Additional capabilities to advertise. */
  caps?: string[];

  /** Auto-reconnect on disconnect. Defaults to true. */
  autoReconnect?: boolean;

  /** Initial reconnect backoff in ms. Defaults to 800. */
  initialBackoffMs?: number;

  /** Maximum reconnect backoff in ms. Defaults to 15000. */
  maxBackoffMs?: number;

  /** Custom device identity. If omitted, one is auto-generated and cached. */
  deviceIdentity?: DeviceIdentity;

  /**
   * Default thinking level for all chat.send requests.
   * Can be overridden per-message via `sendPrompt()` options.
   * Defaults to `"off"`.
   */
  thinking?: ThinkingLevel;
}

/** Options for `sendPrompt()`. */
export interface SendPromptOptions {
  /**
   * Thinking level for this message.
   * Overrides the default set in `InitOptions.thinking`.
   */
  thinking?: ThinkingLevel;
}

/** Returned by `connect()` — either success or an error. */
export interface ConnectResult {
  ok: boolean;
  protocol?: number;
  serverVersion?: string;
  error?: { code: string; message: string };
}

/**
 * Streamed by `sessionHealth()`.
 *
 * Codes: "connected", "disconnected", "reconnecting", "error"
 * plus any gateway-level error events.
 */
export interface HealthEvent {
  code: string;
  message: string;
}

/**
 * Streamed by `chatEvents()`.
 *
 * - `stream`  — streaming token(s) arrived
 * - `final`   — run completed, full message available
 * - `error`   — run failed
 * - `aborted` — run was cancelled
 */
export interface ChatEvent {
  type: "stream" | "final" | "error" | "aborted";
  runId: string;
  sessionKey: string;
  /** Extracted text (accumulated for delta, full for final). */
  text: string;
  /** Thinking / reasoning text (when extended thinking is enabled). */
  thinking?: string;
  /** Token usage for this event (typically populated on `final`). */
  usage?: TokenUsage;
  /** Model identifier (e.g. "gpt-5.4", "sonnet-4.6") when reported by the gateway. */
  model?: string;
  /** Raw payload from the gateway for advanced use. */
  raw: Record<string, unknown>;
}

/** A function that unsubscribes the listener when called. */
export type Unsubscribe = () => void;
